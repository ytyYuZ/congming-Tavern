/**
 * Tauri-backed `fetch` — the transport the desktop shell hands to the provider
 * adapter (`docs/02-技术架构.md` §6, HANDOFF §9 item 9).
 *
 * WHY THIS EXISTS. A browser cannot be assumed to reach every provider: CORS is
 * decided by the provider's server, and some of them answer no preflight at all.
 * `OpenAICompatibleProvider` takes its `fetch` through an option precisely so a
 * native transport can be swapped in, and this is it: requests go over Tauri IPC to
 * Rust, which makes the call from outside the webview where CORS does not apply.
 *
 * THE ONE HARD CONSTRAINT: THE RESULT MUST BE A REAL `Response`. The SSE parser in
 * `packages/providers/src/llm/sse.ts` consumes `Response.body` as a
 * `ReadableStream<Uint8Array>` and the adapter wraps it in a streaming
 * `TextDecoder`, so anything that only *looks* like a response (a plain object with
 * a `text()`) would break the zero-dependency parser this repo owns. The body is
 * therefore built from the channel's `chunk` events, which carry raw bytes as
 * base64 — never decoded text, because an SSE frame can split a multi-byte UTF-8
 * character across two chunks.
 *
 * WHY THE SIGNAL CALLS `llm_cancel`. Cancellation is not cosmetic: an LLM that
 * keeps generating after the user pressed stop costs the user money. `init.signal`
 * is the only cancellation channel the port offers, so an abort must reach Rust
 * (`llm_cancel`) *and* tear down the local stream with an `AbortError`-shaped
 * `DOMException`, because that is what the adapter's `signal.aborted` checks and
 * what its `catch` blocks are written against.
 *
 * WHY THERE IS A SEAM. `createTauriFetch` takes an `EventSink` rather than calling
 * `invoke` directly, so the whole request/response pipeline can be tested against a
 * fake backend with no Tauri runtime — and so a future transport (a plain HTTP
 * proxy, say) can reuse the same framing.
 */
import type { FetchLike } from '@smarttavern/providers';
import { isTransportErrorKind, type LlmStreamEvent, type LlmStreamRequest } from './events';

/** What {@link createTauriEventSink} needs from `@tauri-apps/api/core`. */
interface TauriInvoke {
  (cmd: 'llm_stream', args: LlmStreamArgs): Promise<void>;
  (cmd: 'llm_cancel', args: { requestId: string }): Promise<void>;
}

interface LlmStreamArgs extends LlmStreamRequest {
  onEvent: unknown;
}

/** The seam: something that can start a stream and hear its events. */
export interface EventSink {
  /**
   * Start the stream and report every event through `onEvent`, in order.
   *
   * Resolves when the Rust side has the request, NOT when the stream ends: the
   * events arrive later, and the returned `Response`'s body is what carries them.
   */
  start(request: LlmStreamRequest, onEvent: (event: unknown) => void): Promise<void>;
  /** Ask the Rust side to drop the upstream connection. */
  cancel(requestId: string): Promise<void>;
}

/** Extra knobs this transport understands on top of `RequestInit`. */
export interface TauriFetchInit extends RequestInit {
  /**
   * Whole-request budget, in milliseconds, forwarded to Rust. `RequestInit` has no
   * such field (browsers have no request timeout), which is why this is declared
   * rather than read off the standard type.
   */
  timeoutMs?: number;
}

/**
 * Build a `FetchLike` that goes through Rust.
 *
 * `sink` defaults to a Tauri IPC sink built from `invoke`; it is a parameter so the
 * tests can drive the entire pipeline without a running shell.
 */
export function createTauriFetch(sink?: EventSink): FetchLike {
  const events = sink ?? createTauriEventSink();

  return async function tauriFetch(url: string, init: RequestInit): Promise<Response> {
    const requestId = nextRequestId();
    const request: LlmStreamRequest = {
      requestId,
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: normalizeHeaders(init.headers),
      body: requestBodyToString(init.body),
      ...timeoutOf(init),
    };

    const signal = init.signal ?? null;
    if (signal?.aborted === true) {
      // Fetch rejects rather than returning a response for an already-aborted
      // signal, and the adapter relies on that to yield nothing at all.
      throw createAbortError();
    }

    // The channel can deliver events faster than the body is read, so they are
    // buffered in arrival order rather than collapsed into "the latest one". A
    // single shared promise would hand the same chunk to every `pull` and corrupt
    // the body; this queue hands each event out exactly once.
    const queue = new EventQueue();

    const onEvent = (raw: unknown): void => {
      const event = parseEvent(raw);
      if (event === undefined) {
        // An event we cannot read is a transport failure, not a silent no-op:
        // guessing would hide a version mismatch between the two halves.
        throw new TypeError('the desktop shell sent an event this build cannot read');
      }
      queue.push(event);
    };

    const started = Promise.resolve().then(() => events.start(request, onEvent));

    // Await the response head before constructing the Response, because the status
    // and headers are only known once Rust has them. A `start` rejection (the
    // command itself failed) is a transport failure and propagates as a throw,
    // which is exactly how `fetch` reports "no response at all".
    const first = await Promise.race([
      queue.next(),
      started.then<never>(() => {
        throw new TypeError('the desktop transport stopped without reporting a response');
      }),
    ]);

    if (first.type === 'error') throw transportErrorToException(first);
    if (first.type !== 'response') {
      throw new TypeError(`the desktop shell reported \`${first.type}\` before a response head`);
    }

    const stream = framedStream(queue, first, started);
    return new Response(stream, {
      status: first.status,
      headers: first.headers,
      statusText: '',
    });

    /** Frame the events after the head into a byte stream a `TextDecoder` can read. */
    function framedStream(
      source: EventQueue,
      response: Extract<LlmStreamEvent, { type: 'response' }>,
      startup: Promise<void>,
    ): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = (): void => {
            // Fire and forget: the local stream must fail now, and the upstream
            // request is stopped as soon as the command is delivered.
            void events.cancel(requestId).catch(() => undefined);
            controller.error(createAbortError());
          };
          if (signal !== null) {
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }
          // `start` only reports a start-up failure; the head is already consumed,
          // so everything the queue still holds is body.
          void startup.catch((cause: unknown) => {
            controller.error(cause instanceof Error ? cause : new TypeError(String(cause)));
          });
          void response;
        },
        async pull(controller) {
          for (;;) {
            const event = await source.next();
            switch (event.type) {
              case 'chunk': {
                if (event.dataBase64 === '') continue;
                controller.enqueue(decodeBase64(event.dataBase64));
                return;
              }
              case 'end': {
                controller.close();
                return;
              }
              case 'error': {
                if (event.kind === 'cancelled') {
                  controller.error(createAbortError());
                  return;
                }
                controller.error(transportErrorToException(event));
                return;
              }
              case 'response': {
                // A second head means the other side is confused; treat it as a
                // protocol failure rather than reinterpreting the stream.
                controller.error(
                  new TypeError('the desktop shell reported a second response head'),
                );
                return;
              }
              default: {
                return;
              }
            }
          }
        },
        cancel() {
          // The consumer stopped early (`reader.cancel()` in the adapter). The
          // upstream must stop too, or the provider keeps billing for tokens
          // nobody will read.
          void events.cancel(requestId).catch(() => undefined);
        },
      });
    }
  };
}

/**
 * An ordered, one-shot buffer between the IPC channel and the response body.
 *
 * It exists because the two run at different speeds and `ReadableStream.pull` may
 * only be called again once the previous call has settled: a single shared promise
 * (the obvious first implementation) would return the same event to every `pull`.
 */
class EventQueue {
  private readonly buffered: LlmStreamEvent[] = [];
  private readonly waiting: ((event: LlmStreamEvent) => void)[] = [];

  push(event: LlmStreamEvent): void {
    const waiter = this.waiting.shift();
    if (waiter !== undefined) {
      waiter(event);
      return;
    }
    this.buffered.push(event);
  }

  /** The next event, in arrival order. Never resolves to the same event twice. */
  next(): Promise<LlmStreamEvent> {
    const queued = this.buffered.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<LlmStreamEvent>((resolve) => {
      this.waiting.push(resolve);
    });
  }
}

/**
 * The real sink: Tauri IPC.
 *
 * `@tauri-apps/api/core` is imported lazily and only from here, so this module (and
 * therefore any test of it) does not need a webview to exist. The channel is the
 * module's own `Channel` so that a real command receives exactly what Tauri
 * expects on the wire, including the raw-byte handling of `Chunk`.
 */
export function createTauriEventSink(): EventSink {
  return {
    async start(request, onEvent) {
      const { Channel, invoke } = await import('@tauri-apps/api/core');
      const channel = new Channel<LlmStreamEvent>();
      channel.onmessage = (message) => onEvent(message);
      const invokeFn = invoke as unknown as TauriInvoke;
      await invokeFn('llm_stream', { ...request, onEvent: channel });
    },
    async cancel(requestId) {
      const { invoke } = await import('@tauri-apps/api/core');
      const invokeFn = invoke as unknown as TauriInvoke;
      await invokeFn('llm_cancel', { requestId });
    },
  };
}

/* ─────────────────────────────── normalising ─────────────────────────────── */

/**
 * `HeadersInit` in all three shapes it comes in — `Headers`, `[name, value][]` and
 * a plain record — to the ordered pairs Rust wants. All three are real inputs:
 * `OpenAICompatibleProvider` passes a record, the platform passes a `Headers`, and
 * a `URLSearchParams` style caller passes an array.
 */
export function normalizeHeaders(init: HeadersInit | undefined): [string, string][] {
  if (init === undefined) return [];
  if (Array.isArray(init)) {
    return init.map((entry) => {
      const pair = entry as [unknown, unknown];
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError('a header entry must be a [name, value] pair');
      }
      return [String(pair[0]), String(pair[1])];
    });
  }
  if (typeof (init as Iterable<[string, string]>)[Symbol.iterator] === 'function') {
    // `Headers`, `Map` and any iterable of pairs.
    return [...(init as Iterable<[string, string]>)].map(([name, value]) => [
      String(name),
      String(value),
    ]);
  }
  return Object.entries(init as Record<string, string>).map(([name, value]) => [
    name,
    String(value),
  ]);
}

/**
 * A request body as the UTF-8 string Rust forwards verbatim.
 *
 * The provider adapter sends `JSON.stringify(...)`, so the `undefined` case is the
 * only one that really happens (`GET /models` has no body); the rest exist so a
 * different caller cannot silently get an empty body.
 */
export function requestBodyToString(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return body.toString();
  }
  throw new TypeError('the desktop transport only sends string or byte request bodies');
}

/** Read `timeoutMs` off an init without widening the public `RequestInit` shape. */
function timeoutOf(init: RequestInit): { timeoutMs?: number } {
  const value = (init as TauriFetchInit).timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { timeoutMs: Math.round(value) }
    : {};
}

/* ─────────────────────────────── event parsing ───────────────────────────── */

/**
 * Validate one untrusted IPC message against the contract.
 *
 * This is the desktop side's ONLY defence against the two halves drifting: an
 * unrecognised `type` or a missing field returns `undefined` and becomes a visible
 * `TypeError` rather than, say, an empty chunk that looks like a quiet stream.
 *
 * The property accesses are bracket-style because `noPropertyAccessFromIndexSignature`
 * (tsconfig.base.json) requires it for an index-signature type, and Biome's
 * `useLiteralKeys` asks for the opposite; the compiler wins, so each access is
 * suppressed here rather than switching style and breaking the build.
 */
export function parseEvent(raw: unknown): LlmStreamEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  // biome-ignore lint/complexity/useLiteralKeys: see the note above — noPropertyAccessFromIndexSignature requires brackets.
  switch (record['type']) {
    case 'response': {
      // biome-ignore lint/complexity/useLiteralKeys: bracket access is required by noPropertyAccessFromIndexSignature.
      const status = record['status'];
      // biome-ignore lint/complexity/useLiteralKeys: bracket access is required by noPropertyAccessFromIndexSignature.
      const headers = record['headers'];
      if (typeof status !== 'number' || !isHeaderPairs(headers)) return undefined;
      return { type: 'response', status, headers };
    }
    case 'chunk': {
      // biome-ignore lint/complexity/useLiteralKeys: bracket access is required by noPropertyAccessFromIndexSignature.
      const dataBase64 = record['dataBase64'];
      if (typeof dataBase64 !== 'string') return undefined;
      return { type: 'chunk', dataBase64 };
    }
    case 'end':
      return { type: 'end' };
    case 'error': {
      // biome-ignore lint/complexity/useLiteralKeys: bracket access is required by noPropertyAccessFromIndexSignature.
      const kind = record['kind'];
      // Deliberately not named `message`: `Record<string, unknown>.message` reads as
      // an error object's own `message`, which is exactly the confusion this parser
      // must not have.
      // biome-ignore lint/complexity/useLiteralKeys: bracket access is required by noPropertyAccessFromIndexSignature.
      const sentence = record['message'];
      if (!isTransportErrorKind(kind) || typeof sentence !== 'string') return undefined;
      return { type: 'error', kind, message: sentence };
    }
    default:
      return undefined;
  }
}

function isHeaderPairs(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    )
  );
}

/* ──────────────────────────────── primitives ─────────────────────────────── */

/**
 * `atob` with a `Uint8Array` out, implemented locally rather than reached for as a
 * global: `atob` is missing on the Node versions this repo's tests can run under,
 * and a base64 decode is too small to justify a dependency (the Rust side has the
 * matching hand-written encoder, for the same reason).
 */
export function decodeBase64(encoded: string): Uint8Array {
  if (encoded === '') return new Uint8Array(0);
  const alphabet = BASE64_ALPHABET;
  const clean = encoded.endsWith('==')
    ? encoded.slice(0, -2)
    : encoded.endsWith('=')
      ? encoded.slice(0, -1)
      : encoded;
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const character of clean) {
    const value = alphabet.indexOf(character);
    if (value === -1) throw new TypeError('the desktop shell sent a bad base64 chunk');
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (accumulator >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A `DOMException`-shaped abort, the only failure the port treats specially. */
export function createAbortError(): DOMException {
  const message = 'The operation was aborted.';
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error as unknown as DOMException;
}

/** A non-cancellation transport failure, shaped like the `TypeError` fetch throws. */
function transportErrorToException(error: Extract<LlmStreamEvent, { type: 'error' }>): TypeError {
  return new TypeError(`the desktop transport failed (${error.kind}): ${error.message}`);
}

/** Unique per request; the id is the key `llm_cancel` uses. */
function nextRequestId(): string {
  requestCounter += 1;
  return `st-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

let requestCounter = 0;
