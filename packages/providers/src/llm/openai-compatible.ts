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
 * vocabulary, and the port only exposes `{ code, message, retryable }`, so the
 * vocabulary is `LLM_ERROR_CODES`. Two facts the port cannot carry — the HTTP
 * status and `Retry-After` — are folded into `message`; a machine-readable
 * channel for them would need a contract change, and inventing an extra field
 * on `StreamEvent` here would fork the port. A mapped failure ENDS the
 * iteration immediately after it, because `ports/llm.ts` says an adapter "MUST
 * still terminate with `done` or throw, so a consumer never has to guess".
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
 * `capabilities` field — the port's flag means two different things) and any
 * retry policy (the caller owns `retryable`, because only it knows the budget).
 */
import type {
  ChatMessage,
  ChatRequest,
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
 * What a vendor's chat endpoint documents, plus model ids worth offering when
 * `GET /v1/models` is unavailable.
 *
 * WHY A TABLE AND NOT A CONSTRUCTOR OPTION: `ProviderCapabilities` is a property
 * of the provider, and the port offers no per-model way to express "tools work
 * on some models of this endpoint". Guessing `true` for an unknown host would
 * make the engine take a degradation-ladder path the vendor cannot honour, so
 * the default is the vendor-agnostic minimum and only documented hosts opt in.
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
      vision: true,
      tokenCounting: true,
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
      vision: false,
      tokenCounting: true,
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
      vision: true,
      tokenCounting: true,
      reasoning: false,
    },
    models: [{ id: 'moonshot-v1-8k' }, { id: 'moonshot-v1-32k' }],
  },
  {
    hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: true,
      tokenCounting: true,
      reasoning: true,
    },
    models: [{ id: 'qwen-plus' }, { id: 'qwen-max' }],
  },
  {
    hosts: ['api.groq.com'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: false,
      tokenCounting: true,
      reasoning: false,
    },
    models: [{ id: 'llama-3.3-70b-versatile' }, { id: 'llama-3.1-8b-instant' }],
  },
  {
    hosts: ['api.together.xyz', 'api.together.ai'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: true,
      tokenCounting: true,
      reasoning: false,
    },
    models: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }],
  },
  {
    hosts: ['openrouter.ai'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: true,
      tokenCounting: true,
      // OpenRouter normalises vendor reasoning onto `reasoning`/`reasoning_content`.
      reasoning: true,
    },
    models: [{ id: 'openai/gpt-4o-mini' }, { id: 'anthropic/claude-3.5-sonnet' }],
  },
  {
    // Ollama, LM Studio, vLLM and anything else served from this machine. They
    // are OpenAI-compatible for tools and JSON schema, but whether a given local
    // model can see an image depends on the weights, so `vision` stays off.
    // `[::1]` is written the way `URL.hostname` reports an IPv6 literal.
    hosts: ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'host.docker.internal'],
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: false,
      tokenCounting: true,
      reasoning: false,
    },
    models: [{ id: 'llama3.2' }, { id: 'qwen2.5' }, { id: 'local-model' }],
  },
];

/** The vendor-agnostic minimum: everything off except what the wire guarantees. */
const MINIMAL_CAPABILITIES: Omit<ProviderCapabilities, 'streaming'> = {
  tools: false,
  structuredOutput: false,
  vision: false,
  tokenCounting: false,
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
   * `tokenCounting` IS READ AS "THIS ENDPOINT REPORTS `usage` WHEN ASKED".
   *
   * The port uses the flag twice and the two readings disagree. `ChatRequest`
   * documents `includeUsage` as legal "only when capabilities.tokenCounting",
   * while `LLMProvider.countTokens` is documented as absent whenever the provider
   * cannot count, "which is legal (the flag in capabilities says so)". An
   * OpenAI-compatible endpoint has no offline tokenizer, so this adapter cannot
   * implement `countTokens` without either a dependency or a local estimate — and
   * a char/4 guess returned from a method called `countTokens` is a wrong number
   * wearing a right one's clothes. The flag therefore follows the reading that
   * keeps a real capability alive (the `usage` event, which §9.2 requires), and
   * `countTokens` stays absent. A caller must not treat the flag as proof that
   * the method exists.
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
   * vendor's well-known ids instead of throwing. Note that the port gives this
   * method no `AbortSignal`, so a hanging gateway can only be bounded by the
   * injected transport.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/models`, {
        method: 'GET',
        headers: this.requestHeaders('application/json'),
      });
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
      yield* this.streamEvents(this.readTextChunks(response), signal);
      return;
    }

    const body = await readBodyText(response);
    if (signal.aborted) return;
    const head = body.replace(/^\uFEFF/, '').trimStart();
    if (head.startsWith('data:')) {
      // A gateway that lost the SSE content type. The body is already buffered,
      // so parse it through the same path instead of rejecting a readable stream.
      yield* this.streamEvents(once(head), signal);
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

  /** Translate a stream of SSE messages into the port's event vocabulary. */
  private async *streamEvents(
    chunks: AsyncIterable<string>,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const state = createStreamState();
    try {
      for await (const message of parseSseStream(chunks)) {
        if (signal.aborted) return;
        for (const event of this.eventsForMessage(message, state)) {
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
  private eventsForMessage(message: SseMessage, state: StreamState): StreamEvent[] {
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
    if (field(payload, 'error') !== undefined) {
      events.push(this.failureEvent(undefined, undefined, data));
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
   * Classify an HTTP failure (or an in-stream `error` object, where `status` is
   * undefined) and render it as a terminal `error` event.
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
    // `Retry-After` has no field on `StreamEvent`, so it is surfaced where a
    // human (and a log) will see it: the message.
    const retryAfter = code === 'rate_limit' ? retryAfterSeconds(headers) : undefined;
    if (retryAfter !== undefined) message += `; retry-after ${retryAfter}s`;

    return this.errorEvent(code, message, retryable);
  }

  /** The single place an `error` event is built, so redaction cannot be skipped. */
  private errorEvent(code: LLMErrorCode, message: string, retryable: boolean): StreamEvent {
    return { type: 'error', code, message: redactSecret(message, this.apiKey), retryable };
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
    const reasoningEffort = req.reasoningEffort ?? req.sampling?.reasoningEffort;
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
      // "only when capabilities.tokenCounting"; we forward it verbatim.
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

function doneEvent(finishReason: string): StreamEvent {
  return { type: 'done', finishReason };
}

/* ────────────────────────────── error parsing ────────────────────────────── */

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

/** `Retry-After` is either delta-seconds or an HTTP date; both are handled. */
function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.round(Number(raw)));
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * HANDOFF §4.1 invariant 6, last line of defence: a gateway that echoes the
 * `Authorization` header back inside an error body must not turn our own error
 * report into the leak. `split`/`join` rather than a regex, because a key may
 * contain regex metacharacters.
 */
function redactSecret(text: string, secret: string): string {
  if (secret === '') return text;
  return text.split(secret).join('***');
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
