/**
 * LLM port — `docs/02-技术架构.md` §6 (contract #7 in §13), transcribed faithfully.
 *
 * WHAT IS FROZEN HERE, AND WHY IT IS THE EXPENSIVE PART
 * `LLMProvider` and `StreamEvent` decide every conversational capability the app
 * has. `StreamEvent`'s six variants are copied verbatim from §6 — including
 * `error.retryable`, which §8.4 决定 3 requires and §6 does not spell out — so a
 * provider adapter (M0-T6) has exactly one event vocabulary to target and the UI
 * has exactly one to render.
 *
 * WHO OWNS WHICH TYPE
 * `Message.role` is already frozen in `@smarttavern/schema` and is the same wire
 * vocabulary a provider receives, so `ChatRole` is DERIVED from it rather than
 * re-declared (ADR-016: a second copy of a cross-module type is the drift we
 * forbid). `ChatMessage` is not `Message`: a stored message has a tree edge, a
 * timestamp and a session; a request message is only what goes on the wire.
 *
 * WHAT IS DELIBERATELY ABSENT
 * - No HTTP client, no base URL, no auth: those belong to the adapter. This file
 *   is types only, so `packages/core` keeps zero I/O (HANDOFF §4.1 invariant 1).
 * - No concrete error taxonomy. §8.4 决定 3 puts the four mappings (auth / rate
 *   limit / network / moderation) in M0-T6; all this contract needs is whether a
 *   given failure is worth retrying.
 */
import type {
  JsonValue,
  Message,
  SamplingParams,
  ToolCall,
  ToolDefinition,
} from '@smarttavern/schema';

/* ─────────────────────────────── 对话消息 ──────────────────────────────── */

/**
 * Wire-protocol role. Derived from `Message.role` on purpose: the schema is the
 * one place that decides this vocabulary (docs/02 §4.1, ADR-016).
 */
export type ChatRole = Message['role'];

/**
 * How a tool call reached us, taken straight from `Message.toolCalls[].source`
 * (OPEN: `native` | `json` | `text-protocol` | `x-<ns>`). Reusing this union is
 * what keeps §5.3's degradation ladder from growing a second vocabulary — see
 * `./tools`.
 */
export type ToolInvocationSource = ToolCall['source'];

/**
 * One message on the wire. `toolCallId` and `toolCalls` are mutually exclusive by
 * role: an assistant turn carries the calls it made, a `tool` turn carries the
 * id of the call it answers.
 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Which card spoke. Presentation only; a provider never sees this. */
  speakerId?: string;
  /** Assistant turn: the calls the model asked for. */
  toolCalls?: {
    id: string;
    name: string;
    args: unknown;
    /** Which channel produced the call (§5.3 ladder), when the runtime knows. */
    source?: ToolInvocationSource;
  }[];
  /** `role: 'tool'`: the call this message answers. */
  toolCallId?: string;
}

/* ─────────────────────────────── 请求 / 模型 ───────────────────────────── */

/**
 * Everything a provider needs for one completion. Optional fields are optional
 * because providers differ; an adapter ignores what its vendor cannot express,
 * and the capability flags below are what lets a caller know that up front.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Tool SIGNATURES only (data from `@smarttavern/schema`, §5.3). */
  tools?: ToolDefinition[];
  /**
   * When set, the model must answer with JSON matching this JSON Schema —
   * level ② of §5.3's ladder. Core does not build it: M0-T2's Zod → JSON Schema
   * pipeline does (docs/06 §8.4 决定 5).
   */
  responseSchema?: JsonValue;
  sampling?: Partial<SamplingParams>;
  /**
   * Ask the provider to report usage (only when `capabilities.reportsUsage`).
   *
   * There is deliberately no `reasoningEffort` field here as well: the budget lives
   * in `sampling` only. Two ways to say one thing means one of them silently wins,
   * and M0-T6 had to guess the precedence (ADR-020).
   */
  includeUsage?: boolean;
}

/** A model a provider can serve. `listModels()` is the only discovery path. */
export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Cheap routing hint, e.g. 'chat' | 'reasoning' | 'embedding'. Free string. */
  kind?: string;
  /**
   * Per-model overrides for `ProviderCapabilities`, merged over the provider's own
   * answer (a key present here wins). Capabilities are really a property of the
   * MODEL — one OpenRouter or Ollama endpoint serves tool-calling and non-tool
   * models side by side — so a provider that can tell them apart says so here
   * (ADR-020). A provider that cannot simply omits it.
   */
  capabilities?: Partial<ProviderCapabilities>;
}

/**
 * What a provider can do — the whole point of the port, because it lets the
 * engine degrade (§5.3) or hide UI instead of discovering a limit at runtime.
 *
 * There is no `vision` flag (ADR-021). `ChatMessage.content` is a plain `string`,
 * so no adapter could ever send an image, and a flag that can only ever be `false`
 * is worse than no flag: it tells the UI a road exists that does not. It comes back
 * with multimodal content, which will reference an `assetId` rather than inline
 * base64 (assets already live in the `AssetStore`, ADR-004).
 */
export interface ProviderCapabilities {
  /** ① of the degradation ladder: native function calling. */
  tools: boolean;
  /** ② of the ladder: JSON-Schema-constrained output. */
  structuredOutput: boolean;
  streaming: boolean;
  /**
   * True when the provider can REPORT token usage for a completion
   * (`ChatRequest.includeUsage` → the `usage` event). Says nothing about counting
   * offline — see `countsTokensOffline`. ADR-020 split the old single
   * `tokenCounting` flag because it meant both, and a caller that read it the other
   * way crashed on `countTokens!`.
   */
  reportsUsage: boolean;
  /**
   * True when `LLMProvider.countTokens` exists AND answers without generating.
   * Optional because most adapters honestly cannot: a char/4 guess returned from a
   * method named `countTokens` is a wrong number wearing a right name.
   */
  countsTokensOffline?: boolean;
  /** True when the provider reports reasoning (e.g. `reasoning-delta` events). */
  reasoning?: boolean;
}

/* ──────────────────────────────── 流事件 ───────────────────────────────── */

/**
 * Why a stream ended. Open at the end for vendor-specific reasons, matching the
 * `x-` convention the rest of the schema uses for extensible enums (ADR-019).
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | `x-${string}`;

/**
 * The six variants of §6, verbatim. Discriminated by `type`, so a consumer
 * narrows with a `switch` and the compiler proves every case is handled.
 *
 * `error` is the only variant that does not end the stream by itself: the adapter
 * decides whether to retry from `retryable` and MUST still terminate with `done` or
 * throw, so a consumer never has to guess. When it reports instead of throwing, the
 * terminating event is `done` with `finishReason: 'error'` — that is the published
 * convention (ADR-019): `'error'` means "this stream ended on a failure that was
 * already delivered as an event", and a consumer that only watches `done` still
 * learns that something went wrong.
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'usage'; input: number; output: number }
  | {
      type: 'error';
      /** Stable code from the adapter's own vocabulary (retry policy, i18n). */
      code: string;
      /** The sentence a human reads. Never the only carrier of a machine fact. */
      message: string;
      retryable: boolean;
      /** HTTP status, when the failure came from a response. */
      status?: number;
      /** Parsed `Retry-After` — both the delta-seconds and the HTTP-date form. */
      retryAfterMs?: number;
      /** The vendor's own error code, when it has one. */
      providerCode?: string;
      /** The vendor's error value, already stripped of credentials. */
      details?: JsonValue;
    }
  | { type: 'done'; finishReason: FinishReason };

/* ─────────────────────────────── Provider ─────────────────────────────── */

/**
 * The one contract every LLM adapter implements (docs/02 §6).
 *
 * `stream` takes an `AbortSignal` because generation MUST be cancellable; an
 * implementation stops pulling from the vendor and resolves the iteration when
 * the signal aborts. `listModels` takes an optional one for the same reason: a
 * gateway that stops answering must not hang the model picker (ADR-020).
 *
 * `countTokens` is optional: it is absent whenever the provider cannot count
 * without generating, which is legal — `capabilities.countsTokensOffline` is what
 * says so.
 */
export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}
