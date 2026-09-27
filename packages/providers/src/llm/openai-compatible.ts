/**
 * OpenAI-compatible `LLMProvider` — the first real adapter behind the port
 * (M0-T6, `docs/06-开发任务拆解.md` §9.2; contract #7 of `docs/02` §6).
 *
 * WHO THIS COVERS. One adapter serves OpenAI, DeepSeek, Moonshot, Qwen
 * (DashScope), Groq, Together, OpenRouter, Ollama, LM Studio, vLLM and any
 * user-supplied base URL, because all of them speak the same
 * `POST {base}/chat/completions` streaming dialect. Vendor differences that
 * matter to a caller are expressed once, in `VENDOR_PROFILES` below.
 *
 * ZERO DEPENDENCIES, PLATFORM `fetch` ONLY. Streaming is parsed by `./sse`.
 * `fetch` is INJECTED through the options rather than reached for as a global,
 * which buys three things: a test can drive the adapter without a socket, the
 * Tauri shell can swap in a Rust-side transport when a vendor blocks browser
 * CORS (HANDOFF §9 item 9 — "do not assume the browser can always connect
 * directly"), and an embedder can add proxying or retries. The default is the
 * platform global, so the browser path needs no configuration. An injected
 * transport MUST honour `init.signal`: it is the only cancellation channel the
 * port gives us.
 *
 * THE FOUR ERROR MAPPINGS ARE EVENTS, NOT THROWS (§9.2). They need a stable
 * vocabulary, and `LLM_ERROR_CODES` is it. The machine facts — HTTP status,
 * `Retry-After`, the vendor's own `code`/`type` and the vendor's error object —
 * ride in the dedicated fields the port now has for them (`status`,
 * `retryAfterMs`, `providerCode`, `details`, ADR-019); `message` stays readable
 * but is no longer their only carrier, because a sentence can only be parsed by
 * accident. A mapped failure ENDS the iteration immediately after it, because
 * `ports/llm.ts` says an adapter "MUST still terminate with `done` or throw, so
 * a consumer never has to guess" — and that terminating event is
 * `done{finishReason:'error'}`.
 *
 * CANCELLATION ENDS THE STREAM — it never throws. The signal is checked before
 * every yield, so an abort after N events yields exactly N and stops; an
 * already-aborted signal yields nothing and sends no request. That matches
 * `core/ports/mock/mock-llm.ts`: `packages/core` is platform-free and cannot
 * see `DOMException`/`AbortError`, so an abort must not be an exception a caller
 * has to catch.
 *
 * THE KEY LIVES HERE AND NOWHERE ELSE (HANDOFF §4.1 invariant 6). It is never
 * put in a request body, a `StreamEvent`, an `id` or a `ModelInfo`. The one path
 * that could leak it is a gateway echoing our own `Authorization` header back
 * inside an error body, so every emitted message goes through `redactSecret`.
 *
 * WHAT THIS ADAPTER DELIBERATELY DOES NOT IMPLEMENT: `countTokens` (see the
 * `capabilities` field) and any retry policy (the caller owns `retryable`,
 * because only it knows the budget).
 */
import type {
  ChatMessage,
  ChatRequest,
  FinishReason,
  LLMProvider,
  ModelInfo,
  ProviderCapabilities,
  StreamEvent,
} from '@smarttavern/core';
import type { JsonValue, SamplingParams, ToolDefinition, ToolParameter } from '@smarttavern/schema';
import { parseSseStream, type SseMessage } from './sse';

/* ───────────────────────────── error vocabulary ───────────────────────────── */

/**
 * Every `error.code` this adapter can emit. Stable strings on purpose: a caller
 * (retry policy, i18n, telemetry) matches on them, so renaming one is a breaking
 * change. The first four are the mappings §9.2 mandates; the last two exist
 * because "we could not read the response at all" is not one of the four and
 * silently folding it into `network` would make a retry loop spin forever.
 */
export const LLM_ERROR_CODES = {
  /** HTTP 401/403, or a body that says the key was rejected. Not retryable. */
  auth: 'auth',
  /** HTTP 429, or a body that says we are over quota. Retryable. */
  rateLimit: 'rate_limit',
  /** fetch rejected, HTTP 5xx, or the body died mid-stream. Retryable. */
  network: 'network',
  /** `finish_reason: 'content_filter'`, or a clear moderation refusal. Not retryable. */
  contentFilter: 'content_filter',
  /** A non-auth 4xx: the request itself is wrong. Not retryable. */
  invalidRequest: 'invalid_request',
  /** A 2xx whose body is neither SSE nor a completion. Not retryable. */
  invalidResponse: 'invalid_response',
} as const;

export type LLMErrorCode = (typeof LLM_ERROR_CODES)[keyof typeof LLM_ERROR_CODES];

/** Human-readable cause per code; `message` is for people, `code` is for code. */
const CODE_LABELS: Record<LLMErrorCode, string> = {
  auth: 'the API key was rejected',
  rate_limit: 'the provider is rate limiting requests',
  network: 'the provider could not be reached, or the stream died',
  content_filter: 'the request was blocked by content moderation',
  invalid_request: 'the provider rejected the request',
  invalid_response: 'the provider returned a response we cannot read',
};

/**
 * HOW CONTENT MODERATION IS DETECTED. There is no HTTP status for it — OpenAI
 * answers 400 with `code: "content_policy_violation"`, Azure answers 400 with
 * `code: "content_filter"` and `innererror.code: "ResponsibleAIPolicyViolation"`,
 * and a gateway may answer 200 with an error object — so the only portable
 * signal is the text of the error body, which is what this list matches. It is
 * checked BEFORE the status mapping, because a moderation refusal must not be
 * mistaken for a malformed request.
 */
const MODERATION_PATTERNS = [
  'content_filter',
  'content filter',
  'content_policy',
  'content policy',
  'safety system',
  'moderation',
  'responsibleai',
  'responsible ai',
  'prohibited content',
  'flagged',
];

/** Fallbacks for vendors that hide an auth failure behind a generic status. */
const AUTH_PATTERNS = [
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'api key not valid',
  'missing api key',
  'no auth credentials',
  'unauthorized',
  'authentication',
];

/** Fallbacks for a 200/400 that is really a throttle. */
const RATE_LIMIT_PATTERNS = ['rate limit', 'rate_limit', 'too many requests', 'quota'];

/** The outcome of classifying a failure: the two fields the port's `error` carries. */
export interface FailureClass {
  readonly code: LLMErrorCode;
  readonly retryable: boolean;
}

const CONTENT_FILTER: FailureClass = { code: 'content_filter', retryable: false };
const AUTH: FailureClass = { code: 'auth', retryable: false };
const RATE_LIMIT: FailureClass = { code: 'rate_limit', retryable: true };
const NETWORK_FAILURE: FailureClass = { code: 'network', retryable: true };
const INVALID_REQUEST: FailureClass = { code: 'invalid_request', retryable: false };

/**
 * Pure mapping from (status, lower-cased error text) to a stable code. Exported
 * for the tests, which pin the table rather than a call path.
 */
export function classifyFailure(status: number | undefined, haystack: string): FailureClass {
  if (matchesAny(haystack, MODERATION_PATTERNS)) return CONTENT_FILTER;
  if (status === 401 || status === 403) return AUTH;
  if (status === 429) return RATE_LIMIT;
  if (status !== undefined && status >= 500) return NETWORK_FAILURE;
  if (matchesAny(haystack, AUTH_PATTERNS)) return AUTH;
  if (matchesAny(haystack, RATE_LIMIT_PATTERNS)) return RATE_LIMIT;
  if (status !== undefined && status >= 400) return INVALID_REQUEST;
  // No status (an `error` object inside the stream), or a 2xx that still carried
  // one: an upstream hiccup we cannot name. Retryable, because retrying is the
  // only move a caller has left.
  return NETWORK_FAILURE;
}

function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

/* ───────────────────────────────── options ───────────────────────────────── */

/**
 * The `fetch` shape the adapter uses. Deliberately narrower than `typeof fetch`
 * (a `string` URL, never a `Request`) so a non-platform transport — the Tauri
 * Rust side of HANDOFF §9 item 9 — is trivial to supply.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Construction options. Small and explicit; nothing else is configurable yet. */
export interface OpenAICompatibleOptions {
  /**
   * API root INCLUDING the version segment the vendor documents, e.g.
   * `https://api.openai.com/v1`, `http://localhost:11434/v1`. A bare host gets
   * `/v1` appended, because every vendor here is documented as `{host}/v1/...`
   * and a bare host would otherwise 404.
   */
  baseUrl: string;
  /**
   * The key. Kept in this object and nowhere else (HANDOFF §4.1 invariant 6).
   * An empty string means "send no `Authorization` header", which is what a
   * local Ollama or vLLM needs.
   */
  apiKey: string;
  /**
   * Default model id. `ChatRequest.model` wins when it is set (the port makes it
   * required, so it is the authoritative one); this value is the fallback and
   * the seed of the offline `listModels()` answer.
   */
  model: string;
  /** Extra/overriding headers (Azure `api-key`, OpenRouter `HTTP-Referer`, …). */
  headers?: Record<string, string>;
  /** Transport override. Defaults to the platform `fetch`. Must honour `init.signal`. */
  fetch?: FetchLike;
}

/* ───────────────────────── vendor profiles (capabilities) ─────────────────── */

/**
 * WHAT A VENDOR'S CHAT ENDPOINT DOCUMENTS, plus model ids worth offering when
 * `GET /v1/models` is unavailable.
 *
 * WHY A TABLE AND NOT A CONSTRUCTOR OPTION: `ProviderCapabilities` is a property
 * of the provider, and the port offers no per-model way to express "tools work
 * on some models of this endpoint". Guessing `true` for an unknown host would
 * make the engine take a degradation-ladder path the vendor cannot honour, so
 * the default is the vendor-agnostic minimum and only documented hosts opt in.
 *
 * NO `vision` ANYWHERE (ADR-021). `ChatMessage.content` is a plain `string`, so
 * no adapter could send an image, and a flag that can only ever be `false` tells
 * the UI a road exists that does not. Vendors that do see images (OpenAI, Qwen,
 * OpenRouter) still get no claim here: the claim comes back with multimodal
 * content, which will reference an `assetId`.
 *
 * NO PER-MODEL `capabilities`, ON PURPOSE (ADR-020). The port added
 * `ModelInfo.capabilities` so a provider that can tell "this model calls tools,
 * that one does not" apart can say so, but this adapter is a *transport*: it
 * reads the `data[]` of `GET /v1/models` and the vendor's model ids, neither of
 * which carries a capability list. Inventing per-model values here would be a
 * guess wearing a fact's clothes — the profiles below are exactly the vendor
 * level where a documented claim exists. It gets filled in when M1 adds a
 * provider (OpenRouter, Ollama) whose models endpoint really reports it.
 */
interface VendorProfile {
  /** Hostnames (exact, or a domain suffix) that identify the vendor. */
  readonly hosts: readonly string[];
  readonly capabilities: Omit<ProviderCapabilities, 'streaming'>;
  readonly models: readonly ModelInfo[];
}

const VENDOR_PROFILES: readonly VendorProfile[] = [
  {
    hosts: ['api.openai.com'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      // Chat Completions does not stream reasoning CONTENT (only the Responses
      // API exposes a summary), so claiming otherwise would light up a UI panel
      // that never receives an event.
      reasoning: false,
    },
    models: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }],
  },
  {
    hosts: ['api.deepseek.com'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      // `deepseek-reasoner` streams `delta.reasoning_content`.
      reasoning: true,
    },
    models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  },
  {
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      reasoning: false,
    },
    models: [{ id: 'moonshot-v1-8k' }, { id: 'moonshot-v1-32k' }],
  },
  {
    hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      reasoning: true,
    },
    models: [{ id: 'qwen-plus' }, { id: 'qwen-max' }],
  },
  {
    hosts: ['api.groq.com'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      reasoning: false,
    },
    models: [{ id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }],
  },
  {
    hosts: ['api.together.xyz', 'api.together.ai'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      reasoning: false,
    },
    models: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }],
  },
  {
    hosts: ['openrouter.ai'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      // OpenRouter normalises vendor reasoning onto `reasoning`/`reasoning_content`.
      reasoning: true,
    },
    models: [{ id: 'openai/gpt-4o-mini' }, { id: 'anthropic/claude-3.5-sonnet' }],
  },
  {
    // Ollama, LM Studio, vLLM and anything else served from this machine.
    // `[::1]` is written the way `URL.hostname` reports an IPv6 literal.
    hosts: ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'host.docker.internal'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      reasoning: false,
    },
    models: [{ id: 'llama3.2' }, { id: 'qwen2.5' }, { id: 'local-model' }],
  },
];

/** The vendor-agnostic minimum: everything off except what the wire guarantees. */
const MINIMAL_CAPABILITIES: Omit<ProviderCapabilities, 'streaming'> = {
  tools: false,
  structuredOutput: false,
  reportsUsage: false,
  reasoning: false,
};

/* ──────────────────────────────── provider ───────────────────────────────── */

/** One `tool_calls[]` entry, accumulated across the fragments a stream delivers. */
interface ToolCallBuffer {
  id: string;
  name: string;
  /** Argument JSON, concatenated fragment by fragment. */
  args: string;
}

/** Everything one stream has to remember between chunks. */
interface StreamState {
  finishReason: string | undefined;
  /** `[DONE]` was seen: the provider finished on purpose. */
  sawDone: boolean;
  /** Stop reading: `[DONE]` arrived, or a terminal error did. */
  terminated: boolean;
  /** A terminal `error` event was already emitted; only `done` is left. */
  failed: boolean;
  contentFiltered: boolean;
  toolCalls: Map<number, ToolCallBuffer>;
  toolCallsFlushed: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  /**
   * `reportsUsage` SAYS ONE THING: this endpoint reports `usage` when asked.
   *
   * ADR-020 split the old `tokenCounting` flag because it meant two different
   * things — "reports usage when asked" and "counts offline" — and a caller that
   * read it the second way crashed on `countTokens!`. This adapter implements
   * `countTokens` NOT AT ALL: an OpenAI-compatible endpoint has no offline
   * tokenizer, and a char/4 guess returned from a method called `countTokens` is
   * a wrong number wearing a right one's clothes. That is also why
   * `countsTokensOffline` is deliberately absent rather than set to `false`:
   * absent is what the port documents for "this method does not exist".
   */
  readonly capabilities: ProviderCapabilities;

  /** API root with no trailing slash, e.g. `https://api.openai.com/v1`. */
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly profile: VendorProfile | undefined;

  constructor(options: OpenAICompatibleOptions) {
    this.endpoint = normalizeEndpoint(options.baseUrl);
    this.apiKey = options.apiKey;
    this.defaultModel = options.model;
    this.extraHeaders = { ...options.headers };
    // An arrow, never a bare reference: `window.fetch` called unbound throws
    // "Illegal invocation" in a browser.
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.profile = findProfile(this.endpoint);
    this.id = `openai-compatible:${hostOf(this.endpoint)}`;
    this.capabilities = {
      // Every endpoint this adapter targets streams; a non-streaming one is a
      // different adapter, not a flag.
      streaming: true,
      ...(this.profile?.capabilities ?? MINIMAL_CAPABILITIES),
    };
  }

  /**
   * `GET {base}/models`. A failure is NOT an error: a hand-typed model name is
   * the normal case (§9.2), so this falls back to the configured model plus the
   * vendor's well-known ids instead of throwing.
   *
   * The optional `signal` goes straight into the transport (ADR-020): a gateway
   * that accepts the connection and then never answers must not hang the model
   * picker. An abort takes the same road as every other failure — the offline
   * candidate list — because this method's contract is "never throws", and the
   * caller that aborted already knows it gave up. A transport that ignores
   * `signal` can still hang; that is the documented contract of `FetchLike`.
   */
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/models`, {
        method: 'GET',
        headers: this.requestHeaders('application/json'),
        signal,
      });
      if (signal?.aborted === true) return this.fallbackModels();
      if (!response.ok) return this.fallbackModels();

      const parsed: unknown = await response.json();
      const record = asRecord(parsed);
      const entries = Array.isArray(parsed) ? parsed : record && field(record, 'data');
      if (!Array.isArray(entries)) return this.fallbackModels();

      const models: ModelInfo[] = [];
      for (const entry of entries) {
        const item = asRecord(entry);
        if (item === undefined) continue;
        const id = asString(field(item, 'id')) ?? asString(field(item, 'name'));
        if (id === undefined) continue;
        // Vendors that publish a window use different names for it; the ones we
        // know are mapped, everything else is left absent rather than guessed.
        const contextWindow =
          asNumber(field(item, 'context_length')) ??
          asNumber(field(item, 'context_window')) ??
          asNumber(field(item, 'max_model_len'));
        models.push(contextWindow === undefined ? { id } : { id, contextWindow });
      }
      return models.length > 0 ? models : this.fallbackModels();
    } catch {
      // Unreachable gateway, bad TLS, a body that is not JSON: all the same here.
      return this.fallbackModels();
    }
  }

  /**
   * Stream one completion. Never throws for a provider-side failure: every
   * failure becomes an `error` event followed by `done`, and an abort simply
   * ends the iteration.
   */
  async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (signal.aborted) return;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: this.requestHeaders('text/event-stream'),
        body: JSON.stringify(this.chatBody(req)),
        signal,
      });
    } catch (cause) {
      // An abort makes the fetch reject too; that is cancellation, not a failure.
      if (signal.aborted) return;
      yield this.errorEvent(
        'network',
        `${this.id} could not be reached: ${describeCause(cause)}`,
        true,
      );
      yield doneEvent('error');
      return;
    }

    if (!response.ok) {
      const body = await readBodyText(response);
      if (signal.aborted) return;
      yield this.failureEvent(response.status, response.headers, body);
      yield doneEvent('error');
      return;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      yield* this.streamEvents(this.readTextChunks(response), signal, response.headers);
      return;
    }

    const body = await readBodyText(response);
    if (signal.aborted) return;
    const head = body.replace(/^\uFEFF/, '').trimStart();
    if (head.startsWith('data:')) {
      // A gateway that lost the SSE content type. The body is already buffered,
      // so parse it through the same path instead of rejecting a readable stream.
      yield* this.streamEvents(once(head), signal, response.headers);
      return;
    }
    for (const event of this.bodyEvents(response.status, response.headers, body)) {
      if (signal.aborted) return;
      yield event;
    }
  }

  /* ──────────────────────────── the SSE path ───────────────────────────── */

  /** Decode a response body into text chunks, releasing the reader on the way out. */
  private async *readTextChunks(response: Response): AsyncGenerator<string> {
    const body = response.body;
    if (body === null) throw new TypeError('the response carries no body');
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        yield decoder.decode(chunk.value, { stream: true });
      }
      // Flush a multi-byte character that was split across the last two chunks.
      const tail = decoder.decode();
      if (tail !== '') yield tail;
    } finally {
      // Frees the socket when the consumer stopped early (abort or `[DONE]`).
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * Translate a stream of SSE messages into the port's event vocabulary.
   *
   * `headers` belongs to the 200 the stream arrived on. An in-stream `error`
   * object has no status of its own, but a gateway that throttles *inside* a
   * 200 still sends `Retry-After` there, so the headers are carried in rather
   * than dropped — an error event with no `retryAfterMs` because the throttle
   * was polite enough not to use HTTP 429 would be a fact lost for nothing.
   */
  private async *streamEvents(
    chunks: AsyncIterable<string>,
    signal: AbortSignal,
    headers: Headers,
  ): AsyncGenerator<StreamEvent> {
    const state = createStreamState();
    try {
      for await (const message of parseSseStream(chunks)) {
        if (signal.aborted) return;
        for (const event of this.eventsForMessage(message, state, 200, headers)) {
          if (signal.aborted) return;
          yield event;
        }
        if (state.terminated) break;
      }
    } catch (cause) {
      // The body died, or a chunk failed to decode. If we aborted, that IS the
      // cause and the caller asked for it.
      if (signal.aborted) return;
      yield this.errorEvent(
        'network',
        `the response stream ended unexpectedly: ${describeCause(cause)}`,
        true,
      );
      yield doneEvent('error');
      return;
    }

    if (signal.aborted) return;
    if (state.failed) {
      // The terminal error was already emitted; the contract only requires the
      // iteration to end predictably.
      yield doneEvent('error');
      return;
    }
    if (!state.sawDone && state.finishReason === undefined) {
      // Neither `[DONE]` nor a finish reason: the connection was cut and
      // whatever was delivered is partial. Retryable, per §9.2's network bucket.
      yield this.errorEvent(
        'network',
        'the provider closed the stream before reporting a finish reason',
        true,
      );
      yield doneEvent('error');
      return;
    }
    for (const event of flushToolCalls(state)) {
      if (signal.aborted) return;
      yield event;
    }
    if (signal.aborted) return;
    yield doneEvent(state.finishReason ?? 'stop');
  }

  /**
   * One SSE message in, zero or more `StreamEvent`s out.
   *
   * `[DONE]` is checked before the JSON parse because it is not JSON. A payload
   * that is neither is SKIPPED rather than surfaced: a truncated final chunk is
   * caught further up by the "no finish reason, no `[DONE]`" rule, which reports
   * it as the network failure it is, while a stray keep-alive chunk must not
   * kill an otherwise healthy stream.
   */
  private eventsForMessage(
    message: SseMessage,
    state: StreamState,
    status: number,
    headers: Headers,
  ): StreamEvent[] {
    const events: StreamEvent[] = [];
    const data = message.data.trim();
    if (data === '[DONE]') {
      state.sawDone = true;
      state.terminated = true;
      return events;
    }

    const payload = asRecord(safeJsonParse(data));
    if (payload === undefined) return events;

    // Some gateways report a failure as an ordinary chunk with a 200 status.
    // The status is passed through as the 200 it really was: "the HTTP request
    // succeeded, the vendor's answer was an error object" is itself a fact a
    // caller acting on `status` needs to see (ADR-019). `Retry-After` from this
    // response is picked up the same way it would be on a 429.
    if (field(payload, 'error') !== undefined) {
      events.push(this.failureEvent(status, headers, data));
      state.failed = true;
      state.terminated = true;
      return events;
    }

    const rawChoices = field(payload, 'choices');
    const choices = Array.isArray(rawChoices) ? rawChoices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      if (choice === undefined) continue;
      const delta = asRecord(field(choice, 'delta'));
      if (delta !== undefined) {
        // `reasoning_content` is DeepSeek's spelling; `reasoning` is what
        // OpenRouter normalises to. Both mean the same event on this port.
        const reasoning = firstString(delta, ['reasoning_content', 'reasoning']);
        if (reasoning !== undefined) events.push({ type: 'reasoning-delta', text: reasoning });
        const content = asString(field(delta, 'content'));
        if (content !== undefined) events.push({ type: 'text-delta', text: content });
        const calls = field(delta, 'tool_calls');
        if (Array.isArray(calls)) {
          for (const rawCall of calls) accumulateToolCall(state, rawCall);
        }
      }
      const finishReason = asString(field(choice, 'finish_reason'));
      if (finishReason !== undefined) {
        // First non-null wins: the port has one `done`, and `n > 1` is not
        // something a caller of this port can ask for.
        state.finishReason ??= finishReason;
        // The model just declared it is done asking, so every accumulated call
        // is complete and can be handed over here rather than at EOF.
        events.push(...flushToolCalls(state));
        if (finishReason === 'content_filter' && !state.contentFiltered) {
          state.contentFiltered = true;
          events.push(this.errorEvent('content_filter', CODE_LABELS.content_filter, false));
        }
      }
    }

    const usage = usageEvent(asRecord(field(payload, 'usage')));
    if (usage !== undefined) events.push(usage);
    return events;
  }

  /* ─────────────────────── the non-SSE (JSON) path ─────────────────────── */

  /**
   * A 2xx body that is not SSE. Two real shapes reach here: an error object
   * (`{"error":{…}}`, which many gateways return with a 200) and a whole
   * completion from a proxy that ignored `stream: true`. Neither may be passed
   * through as text — the first must be classified, the second must still become
   * the events a consumer expects.
   */
  private bodyEvents(status: number, headers: Headers, body: string): StreamEvent[] {
    const record = asRecord(safeJsonParse(body));
    if (record === undefined) {
      return [
        this.errorEvent(
          'invalid_response',
          `HTTP ${status}: the provider returned a body that is neither SSE nor JSON`,
          false,
        ),
        doneEvent('error'),
      ];
    }
    if (field(record, 'error') !== undefined) {
      return [this.failureEvent(status, headers, body), doneEvent('error')];
    }
    const choices = field(record, 'choices');
    if (!Array.isArray(choices)) {
      return [
        this.errorEvent(
          'invalid_response',
          `HTTP ${status}: the provider returned JSON without a choices array`,
          false,
        ),
        doneEvent('error'),
      ];
    }

    const events: StreamEvent[] = [];
    const first = asRecord(choices[0]);
    const message = first === undefined ? undefined : asRecord(field(first, 'message'));
    if (message !== undefined) {
      const reasoning = firstString(message, ['reasoning_content', 'reasoning']);
      if (reasoning !== undefined) events.push({ type: 'reasoning-delta', text: reasoning });
      const content = asString(field(message, 'content'));
      if (content !== undefined) events.push({ type: 'text-delta', text: content });
      const calls = field(message, 'tool_calls');
      if (Array.isArray(calls)) events.push(...completeToolCalls(calls));
    }
    const usage = usageEvent(asRecord(field(record, 'usage')));
    if (usage !== undefined) events.push(usage);

    const finishReason =
      (first === undefined ? undefined : asString(field(first, 'finish_reason'))) ?? 'stop';
    if (finishReason === 'content_filter') {
      events.push(this.errorEvent('content_filter', CODE_LABELS.content_filter, false));
    }
    events.push(doneEvent(finishReason));
    return events;
  }

  /* ─────────────────────────────── failures ────────────────────────────── */

  /**
   * Classify a failure that carried a body — a non-2xx response, or an `error`
   * object inside a 200 — and render it as a terminal `error` event. `status`
   * is the status of the response it arrived on, whatever that was; only the
   * transport-failure path has no status at all and does not come through here.
   *
   * `body` is what the vendor sent, verbatim. It reaches the event as
   * `details` — after redaction and compaction — because that is where the real
   * cause usually lives ("model `x` does not exist" is not derivable from a
   * status alone). The human sentence keeps the readable part of it.
   */
  private failureEvent(
    status: number | undefined,
    headers: Headers | undefined,
    body: string,
  ): StreamEvent {
    const parsed = asRecord(safeJsonParse(body));
    const providerError = parsed === undefined ? undefined : asRecord(field(parsed, 'error'));
    const detail = providerError === undefined ? undefined : errorDetail(providerError);
    const haystack = `${detail ?? ''} ${truncate(body, 512)}`.toLowerCase();
    const { code, retryable } = classifyFailure(status, haystack);

    let message = `${status === undefined ? '' : `HTTP ${status}: `}${CODE_LABELS[code]}`;
    if (detail !== undefined) message += ` (${detail})`;
    // The machine fact is `retryAfterMs`; the sentence is for people reading a
    // log, and the port's docstring says a human string must never be the only
    // carrier of it (ADR-019).
    const retryAfter = code === 'rate_limit' ? retryAfterMs(headers) : undefined;
    if (retryAfter !== undefined) message += `; retry-after ${formatMs(retryAfter)}`;

    return this.errorEvent(code, message, retryable, {
      status,
      headers,
      body,
      providerError,
    });
  }

  /**
   * The single place an `error` event is built, so redaction cannot be skipped.
   *
   * `facts` are the raw ingredients of the machine-readable part; this method is
   * what turns them into `status` / `retryAfterMs` / `providerCode` / `details`.
   * Keeping the redaction of `message` AND `details` here is deliberate: there
   * is one exit, so there is no path that forgets it (HANDOFF §4.1 invariant 6).
   */
  private errorEvent(
    code: LLMErrorCode,
    message: string,
    retryable: boolean,
    facts?: ErrorFacts,
  ): StreamEvent {
    const providerCode = facts === undefined ? undefined : providerCodeOf(facts.providerError);
    const details = facts === undefined ? undefined : providerDetails(facts);
    // `Retry-After` is meaningful wherever a response existed, including the 200
    // that carried an error object — vendored gateways do send it there.
    const retryAfter = facts?.headers === undefined ? undefined : retryAfterMs(facts.headers);
    // `providerCode` is a VENDOR string and therefore untrusted input: a gateway
    // that puts the offending `Authorization` header in its `code` field would
    // otherwise leak through the field that exists to be trustworthy. It is
    // redacted like everything else, and dropped when it is too long to be a
    // code at all (a payload wearing a code's name).
    const safeCode =
      providerCode === undefined ? undefined : redactSecret(providerCode, this.apiKey);
    return {
      type: 'error',
      code,
      message: redactSecret(message, this.apiKey),
      retryable,
      ...(facts?.status === undefined ? {} : { status: facts.status }),
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      ...(safeCode === undefined || safeCode.length > 100 ? {} : { providerCode: safeCode }),
      ...(details === undefined ? {} : { details: redactValue(details, this.apiKey) }),
    };
  }

  /* ────────────────────────────── the wire ─────────────────────────────── */

  private requestHeaders(accept: string): Record<string, string> {
    return {
      accept,
      'content-type': 'application/json',
      ...(this.apiKey === '' ? {} : { authorization: `Bearer ${this.apiKey}` }),
      // Caller headers win: Azure wants `api-key`, OpenRouter likes `HTTP-Referer`.
      ...this.extraHeaders,
    };
  }

  private chatBody(req: ChatRequest): Record<string, unknown> {
    // `reasoningEffort` is read from `sampling` ONLY (ADR-020): the port used to
    // carry it in two places with no stated precedence, so one of them silently
    // won. There is exactly one spelling now.
    const reasoningEffort = req.sampling?.reasoningEffort;
    return {
      model: req.model === '' ? this.defaultModel : req.model,
      messages: toWireMessages(req.messages),
      stream: true,
      ...samplingBody(req.sampling),
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      ...(req.tools === undefined || req.tools.length === 0
        ? {}
        : { tools: req.tools.map(toWireTool) }),
      ...(req.responseSchema === undefined
        ? {}
        : { response_format: jsonSchemaFormat(req.responseSchema) }),
      // `includeUsage` is the caller's decision and the port documents it as
      // "only when capabilities.reportsUsage"; we forward it verbatim.
      ...(req.includeUsage === true ? { stream_options: { include_usage: true } } : {}),
    };
  }

  private fallbackModels(): ModelInfo[] {
    const candidates = [{ id: this.defaultModel }, ...(this.profile?.models ?? [])];
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.id === '' || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      models.push(candidate);
    }
    return models;
  }
}

/* ─────────────────────────── wire-format helpers ─────────────────────────── */

/** One request message, exactly the fields OpenAI accepts. */
function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    // `speakerId` is presentation-only and never goes on the wire — the port
    // says so explicitly, and it is also the reason this mapping exists at all.
    const toolCalls = message.toolCalls;
    return {
      role: message.role,
      content: message.content,
      ...(message.role === 'assistant' && toolCalls !== undefined
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: stringifyArgs(call.args) },
            })),
          }
        : {}),
      ...(message.role === 'tool' ? { tool_call_id: message.toolCallId ?? '' } : {}),
    };
  });
}

/**
 * `SamplingParams` -> the OpenAI knobs. `topK` and `repetitionPenalty` are
 * deliberately DROPPED: the wire format has no field for either, and inventing
 * one would break the vendors that reject unknown keys (docs/02 §6: "an adapter
 * ignores what its vendor cannot express").
 */
function samplingBody(sampling: Partial<SamplingParams> | undefined): Record<string, unknown> {
  if (sampling === undefined) return {};
  return {
    ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
    ...(sampling.topP === undefined ? {} : { top_p: sampling.topP }),
    ...(sampling.maxTokens === undefined ? {} : { max_tokens: sampling.maxTokens }),
    ...(sampling.presencePenalty === undefined
      ? {}
      : { presence_penalty: sampling.presencePenalty }),
    ...(sampling.frequencyPenalty === undefined
      ? {}
      : { frequency_penalty: sampling.frequencyPenalty }),
    ...(sampling.stop === undefined ? {} : { stop: [...sampling.stop] }),
    ...(sampling.seed === undefined ? {} : { seed: sampling.seed }),
  };
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      // `summary` is the one-line form shown to the model; `description` is the
      // long form for people, so the model gets the short one when both exist.
      description: tool.description ?? tool.summary,
      parameters: toolParameters(tool.parameters),
    },
  };
}

/** `ToolParameter[]` -> the flat JSON Schema object OpenAI wants. */
function toolParameters(parameters: readonly ToolParameter[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    properties[parameter.name] = {
      type: parameter.type,
      description: parameter.description,
      ...(parameter.values === undefined ? {} : { enum: parameter.values }),
      ...(parameter.default === undefined ? {} : { default: parameter.default }),
    };
    if (parameter.required) required.push(parameter.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * `json_schema` response format. `strict` is left OFF on purpose: turning it on
 * makes OpenAI reject any caller schema that does not also set
 * `additionalProperties: false` and mark every property required, which would
 * turn a legitimate schema into a 400 from inside the adapter.
 */
function jsonSchemaFormat(schema: JsonValue): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: { name: 'smarttavern_response', schema },
  };
}

function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}) ?? '{}';
  } catch {
    // A cyclic or otherwise unserialisable value must not kill the request.
    return '{}';
  }
}

/* ─────────────────────────── stream bookkeeping ──────────────────────────── */

function createStreamState(): StreamState {
  return {
    finishReason: undefined,
    sawDone: false,
    terminated: false,
    failed: false,
    contentFiltered: false,
    toolCalls: new Map(),
    toolCallsFlushed: false,
  };
}

/**
 * `tool_calls` arrive as fragments: the id and name usually come once, while
 * `function.arguments` is a JSON string split at arbitrary byte offsets. They
 * are therefore accumulated by `index` and emitted ONCE, when the stream ends —
 * emitting per fragment would hand the runtime half a JSON document.
 */
function accumulateToolCall(state: StreamState, raw: unknown): void {
  const call = asRecord(raw);
  if (call === undefined) return;
  const index = asNumber(field(call, 'index')) ?? state.toolCalls.size;
  const buffer = state.toolCalls.get(index) ?? { id: '', name: '', args: '' };
  const id = asString(field(call, 'id'));
  if (id !== undefined) buffer.id = id;
  const fn = asRecord(field(call, 'function'));
  if (fn !== undefined) {
    const name = asString(field(fn, 'name'));
    if (name !== undefined) buffer.name = name;
    const args = asString(field(fn, 'arguments'));
    if (args !== undefined) buffer.args += args;
  }
  state.toolCalls.set(index, buffer);
}

function flushToolCalls(state: StreamState): StreamEvent[] {
  if (state.toolCallsFlushed) return [];
  state.toolCallsFlushed = true;
  const events: StreamEvent[] = [];
  const entries = [...state.toolCalls.entries()].sort((left, right) => left[0] - right[0]);
  for (const [index, buffer] of entries) {
    // A fragment stream that never carried a name is not a call we can run.
    if (buffer.name === '') continue;
    events.push({
      type: 'tool-call',
      // The port requires an id; a vendor that omitted one still gets a stable,
      // unique-enough value rather than an empty string the runtime cannot echo.
      id: buffer.id === '' ? `${buffer.name}-${index}` : buffer.id,
      name: buffer.name,
      args: parseToolArgs(buffer.args),
    });
  }
  return events;
}

/** Tool calls from a non-streamed body: complete already, so no accumulation. */
function completeToolCalls(calls: readonly unknown[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  calls.forEach((raw, index) => {
    const call = asRecord(raw);
    const fn = call === undefined ? undefined : asRecord(field(call, 'function'));
    const name = fn === undefined ? undefined : asString(field(fn, 'name'));
    if (call === undefined || fn === undefined || name === undefined) return;
    const args = asString(field(fn, 'arguments'));
    events.push({
      type: 'tool-call',
      id: asString(field(call, 'id')) ?? `${name}-${index}`,
      name,
      args: parseToolArgs(args ?? ''),
    });
  });
  return events;
}

/**
 * Argument decoding. The runtime validates every call before it runs anything
 * (`docs/02` §5.3), so malformed JSON is handed over as the raw string it was —
 * losing it to an empty object would hide the model's mistake instead of
 * reporting it.
 */
function parseToolArgs(args: string): unknown {
  if (args.trim() === '') return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function usageEvent(usage: Record<string, unknown> | undefined): StreamEvent | undefined {
  if (usage === undefined) return undefined;
  const input = asNumber(field(usage, 'prompt_tokens')) ?? asNumber(field(usage, 'input_tokens'));
  const output =
    asNumber(field(usage, 'completion_tokens')) ?? asNumber(field(usage, 'output_tokens'));
  if (input === undefined && output === undefined) return undefined;
  return { type: 'usage', input: input ?? 0, output: output ?? 0 };
}

/**
 * A vendor `finish_reason` -> the port's `FinishReason` (ADR-019).
 *
 * The five modelled values pass through unchanged. Anything else — `max_tokens`
 * from a gateway that never read the OpenAI docs, `eos`, `stop_sequence` — is
 * reported as `x-<reason>`: the union is open at the end exactly so a vendor
 * reason we do not model survives as data instead of being flattened into
 * `stop`, which would tell the runtime the model finished its thought when it
 * did not.
 */
function doneEvent(finishReason: string): StreamEvent {
  return { type: 'done', finishReason: toFinishReason(finishReason) };
}

function toFinishReason(finishReason: string): FinishReason {
  switch (finishReason) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return finishReason;
    // `error` is the adapter's own convention ("this stream ended on a failure
    // already delivered as an `error` event"), never a vendor's word — but a
    // vendor that literally says `error` means the same thing.
    case 'error':
      return 'error';
    default:
      return `x-${finishReason}`;
  }
}

/* ────────────────────────────── error parsing ────────────────────────────── */

/**
 * The raw ingredients of an `error` event's machine-readable half.
 *
 * They are carried as data, not pre-rendered, so `errorEvent` is the single
 * place that decides what an `error` looks like — and therefore the single place
 * redaction has to be correct. `ErrorFacts` never leaves the adapter.
 */
interface ErrorFacts {
  readonly status?: number | undefined;
  readonly headers?: Headers | undefined;
  /** The vendor's response body, verbatim. */
  readonly body: string;
  /** `body` parsed to its `error` member, when both exist. */
  readonly providerError?: Record<string, unknown> | undefined;
}

/**
 * The vendor's own error identifier: `code` first (OpenAI, Moonshot, most
 * gateways), then `type` (Anthropic-flavoured bodies). An adapter-local
 * `error.code` stays ours — this field is *their* word, which is the point of
 * having both: a caller can match on our stable vocabulary and still log the
 * vendor's.
 */
function providerCodeOf(providerError: Record<string, unknown> | undefined): string | undefined {
  if (providerError === undefined) return undefined;
  return firstString(providerError, ['code', 'type']);
}

/**
 * What goes in `details`: the vendor's error value, never the whole envelope.
 *
 * For a JSON body that is the `error` member itself — the object the vendor
 * wrote, `message`/`code`/`type`/`param`/`innererror` and all, since dropping
 * fields we do not recognise is how a "why did this 400?" investigation ends in
 * guesswork. `code`/`type` also appear in `providerCode`; the duplication is
 * intentional, because one is a flat field to branch on and the other is the
 * evidence, and a caller may reasonably keep only one of them.
 *
 * For a body that is not JSON (a proxy's HTML login page, a plain-text 503) the
 * raw text is used instead of nothing: a machine fact we cannot parse is still a
 * fact. Both forms are redacted and compacted before leaving.
 */
function providerDetails(facts: ErrorFacts): JsonValue | undefined {
  const value: unknown =
    facts.providerError ?? (facts.body === '' ? undefined : truncate(facts.body, 512));
  return value === undefined ? undefined : compactJson(value);
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are handled. */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw) * 1000));
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * `Retry-After` for the human sentence. The machine fact is the raw
 * `retryAfterMs`; this is a rendering of it, and it rounds rather than
 * truncates so a header of `0.4` does not read as "0s".
 */
function formatMs(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${Math.round(milliseconds / 1000)}s`;
}

/**
 * HANDOFF §4.1 invariant 6, last line of defence: a gateway that echoes the
 * `Authorization` header back inside an error body must not turn our own error
 * report into the leak. `split`/`join` rather than a regex, because a key may
 * contain regex metacharacters.
 *
 * `redactValue` is the same guarantee for the structured `details` field, which
 * is the new place a vendor echo could reach: redacting only the sentence would
 * leave the leak one field over.
 */
function redactSecret(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('***');
}

function redactValue(value: unknown, secret: string): JsonValue {
  if (typeof value === 'string') {
    // `truncate` after redaction: `***` is shorter than a real key, so a
    // redacted string can never be pushed over the limit by the substitution.
    return truncate(redactSecret(value, secret), JSON_STRING_LIMIT);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, JSON_ARRAY_LIMIT).map((item) => redactValue(item, secret));
  }
  return redactRecord(value, secret);
}

function redactRecord(value: unknown, secret: string): Record<string, JsonValue> {
  const record = asRecord(value);
  const result: Record<string, JsonValue> = {};
  if (record === undefined) return result;
  for (const key of Object.keys(record).slice(0, JSON_KEY_LIMIT)) {
    result[redactSecret(key, secret)] = redactValue(field(record, key), secret);
  }
  return result;
}

/**
 * Shrink a vendor payload to something a `StreamEvent` can honestly carry: an
 * error event travels into the UI and the session log, and a gateway that
 * answers with a megabyte of HTML must not put a megabyte in both.
 *
 * It is deliberately a *truncation* and not a projection to known keys — see
 * `providerDetails` — and it is lossy only past limits no real error body
 * reaches.
 */
function compactJson(value: unknown, depth = 0): JsonValue {
  if (typeof value === 'string') return truncate(value, JSON_STRING_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (depth >= JSON_DEPTH_LIMIT) return null;
    return value.slice(0, JSON_ARRAY_LIMIT).map((item) => compactJson(item, depth + 1));
  }
  if (depth >= JSON_DEPTH_LIMIT) return null;
  const record = asRecord(value);
  if (record === undefined) return String(value);
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).slice(0, JSON_KEY_LIMIT)) {
    result[key] = compactJson(field(record, key), depth + 1);
  }
  return result;
}

/** Longest string `details` keeps; longer vendor text is cut with an ellipsis. */
const JSON_STRING_LIMIT = 512;
/** Nesting levels `details` keeps before a branch becomes `null`. */
const JSON_DEPTH_LIMIT = 4;
/** Entries per array `details` keeps. */
const JSON_ARRAY_LIMIT = 20;
/** Keys per object `details` keeps. */
const JSON_KEY_LIMIT = 40;

/**
 * Pull the human-readable part out of `{"error":{…}}`. Vendors disagree on
 * which field carries it (`message`, `code`, `type`), so all three are joined;
 * the caller only ever shows or classifies the result.
 */
function errorDetail(providerError: Record<string, unknown>): string | undefined {
  const parts = [
    asString(field(providerError, 'message')),
    asString(field(providerError, 'code')),
    asString(field(providerError, 'type')),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : truncate(parts.join(' / '), 300);
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message;
  return String(cause);
}

/* ──────────────────────────── small value helpers ────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Read one field of a parsed JSON object.
 *
 * WHY A HELPER AND NOT `record['key']`: this workspace compiles with
 * `noPropertyAccessFromIndexSignature`, so `record.key` is a type error, while
 * Biome flags the literal bracket form as `useLiteralKeys`. A parameterised key
 * is the one spelling both accept — and it keeps the style of the rest of this
 * file, where every value off the wire goes through a guard.
 */
function field(source: Record<string, unknown>, key: string): unknown {
  return source[key];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(field(record, key));
    if (value !== undefined) return value;
  }
  return undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/** Read a body we are about to discard; a failure here is already the error. */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** A one-element async source, for a body that arrived whole. */
async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

/* ───────────────────────────── URL normalisation ─────────────────────────── */

/**
 * `https://api.openai.com` -> `https://api.openai.com/v1`, but
 * `https://gw.example.com/openai/v1` is left exactly as given: the version
 * segment is the caller's to choose, and guessing one for a path we do not
 * recognise would break every gateway whose layout is not the vendor's.
 */
function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const url = tryUrl(trimmed);
  if (url !== undefined && (url.pathname === '' || url.pathname === '/')) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

/** `id` uses the host WITH its port, so two local runtimes never collide. */
function hostOf(endpoint: string): string {
  const url = tryUrl(endpoint);
  if (url !== undefined) return url.host;
  const withoutScheme = endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return withoutScheme.split('/')[0] ?? endpoint;
}

function findProfile(endpoint: string): VendorProfile | undefined {
  const url = tryUrl(endpoint);
  const hostname = url === undefined ? hostOf(endpoint) : url.hostname;
  return VENDOR_PROFILES.find((profile) =>
    profile.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)),
  );
}

function tryUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
