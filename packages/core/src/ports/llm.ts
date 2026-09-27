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
  /** System prompt is a message, not a field; this pins the reasoning budget. */
  reasoningEffort?: SamplingParams['reasoningEffort'];
  /** Ask the provider to report usage (only when `capabilities.tokenCounting`). */
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
  /** True when the model accepts images on the input side. */
  vision?: boolean;
}

/**
 * What a provider can do — the whole point of the port, because it lets the
 * engine degrade (§5.3) or hide UI instead of discovering a limit at runtime.
 */
export interface ProviderCapabilities {
  /** ① of the degradation ladder: native function calling. */
  tools: boolean;
  /** ② of the ladder: JSON-Schema-constrained output. */
  structuredOutput: boolean;
  vision: boolean;
  streaming: boolean;
  tokenCounting: boolean;
  /** True when the provider reports reasoning (e.g. `reasoning-delta` events). */
  reasoning?: boolean;
}

/* ──────────────────────────────── 流事件 ───────────────────────────────── */

/**
 * The six variants of §6, verbatim. Discriminated by `type`, so a consumer
 * narrows with a `switch` and the compiler proves every case is handled.
 *
 * `error` is the only variant that does not end the stream by itself: the
 * adapter decides whether to retry from `retryable` and MUST still terminate
 * with `done` or throw, so a consumer never has to guess.
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'done'; finishReason: string };

/* ─────────────────────────────── Provider ─────────────────────────────── */

/**
 * The one contract every LLM adapter implements (docs/02 §6).
 *
 * `stream` takes an `AbortSignal` because generation MUST be cancellable; an
 * implementation stops pulling from the vendor and resolves the iteration when
 * the signal aborts. `countTokens` is optional: it is absent whenever the
 * provider cannot count without generating, which is legal (the flag in
 * `capabilities` says so).
 */
export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}
