/**
 * Tool runtime port — `docs/02-技术架构.md` §5.3 (ToolRuntime) and contract #8 of
 * §13; declarations live in `@smarttavern/schema/tool.ts`.
 *
 * THE ONE RULE THAT SHAPES EVERY TYPE HERE (HANDOFF §4.1 invariant 3):
 * **the AI may REQUEST, only the local runtime WRITES.**
 *
 * A request from a model is therefore never an instruction to change state. It
 * is a value that must survive, in this order: JSON Schema validation → domain
 * validation (resource bounds, dice syntax, time-advance policy) → approval when
 * the tool says `requiresApproval` → LOCAL execution → result fed back. Every
 * step of that pipeline is a type below, because §5.3 requires every call to be
 * auditable and undoable and cannot audit a step it cannot name.
 *
 * THE DEGRADATION LADDER IS A REUSED VOCABULARY, NOT A NEW ONE
 * §5.3 degrades ① native function calling → ② structured output (JSON Schema) →
 * ③ text protocol `<tool name="...">{...}</tool>`. That is EXACTLY the channel
 * vocabulary `Message.toolCalls[].source` already owns (`native` | `json` |
 * `text-protocol`, OPEN for plugins), so `ToolChannel` is DERIVED from it
 * instead of being declared again (ADR-016; `schema/tool.ts` says the same thing
 * from the other side). When all three fail, §5.3 forbids silent failure:
 * `ToolDegradationPlan.giveUp` names the level that surfaces the error to the
 * user and offers a retry.
 *
 * WHAT IS DELIBERATELY ABSENT
 * - No catalogue of the fifteen built-in tools (§8.4 决定 4): they are M1–M3 work
 *   and are contributed as `ToolDefinition` DATA at runtime.
 * - No argument validation implementation. §8.4 决定 5 routes tool parameter
 *   validation through M0-T2's Zod → JSON Schema pipeline, so the port only says
 *   WHAT is being validated and hands back issues.
 */
import type { ToolDefinition, ToolName, ToolParameter } from '@smarttavern/schema';
import type { ToolInvocationSource } from './llm';

/* ────────────────────────────── 降级协议 ───────────────────────────────── */

/**
 * Which transport carried a tool call. Derived from
 * `Message.toolCalls[].source` so the ladder, the stored message and the UI all
 * name the same three levels (plus plugin channels).
 */
export type ToolChannel = ToolInvocationSource;

/** The three built-in levels, in ladder order (§5.3). */
export const TOOL_CHANNELS = ['native', 'json', 'text-protocol'] as const;

/**
 * Capability profile the runtime is planned against: level ① needs a model with
 * native function calling, level ② needs `structuredOutput`, level ③ needs
 * nothing but text. Superset of `ProviderCapabilities`' relevant flags on
 * purpose, so a caller can build it from a provider without a translation map.
 */
export interface ToolChannelCapabilities {
  /** Provider can emit native function calls (level ①). */
  nativeFunctionCalling: boolean;
  /** Provider accepts a JSON Schema for the response (level ②). */
  structuredOutput: boolean;
  /** Level ③ is always available: it is just text. */
  textProtocol: true;
}

/**
 * The ladder as data: which channels this turn may use, and what happens when
 * they are exhausted. `giveUp` is required — §5.3 says a total failure "不静默
 * 忽略", so there is no legal plan that ends in silence.
 */
export interface ToolDegradationPlan {
  /** Channels in the order they will be attempted. */
  readonly order: readonly ToolChannel[];
  /** The first attempt; always `order[0]` when the plan was built by the runtime. */
  readonly primary: ToolChannel;
  /** True when a lower level answered only part of the call and it must be retried. */
  readonly allowRetry: boolean;
  /** What the runtime does when every level fails: report, never swallow. */
  readonly giveUp: 'report-to-user';
}

/** The ladder's level order, ① → ③. `schema`'s plugin channels are not ranked. */
export const TOOL_CHANNEL_ORDER: readonly ToolChannel[] = TOOL_CHANNELS;

/**
 * Position of `channel` on the ladder, or `-1` for a plugin channel that is not
 * part of it. Used to pick the highest-precision channel two parties share.
 */
export function toolChannelRank(channel: ToolChannel): number {
  return TOOL_CHANNEL_ORDER.indexOf(channel);
}

/**
 * True when the channel is one of the three built-in levels. A plugin channel
 * (`x-<ns>.…`) is a legal `source` but is not part of §5.3's ladder.
 */
export function isBuiltInToolChannel(channel: ToolChannel): boolean {
  return toolChannelRank(channel) >= 0;
}

/**
 * Pick the ladder from what a provider can actually do. Returns `undefined` when
 * even the text protocol is unavailable — which can only happen to a plugin
 * channel and is therefore worth surfacing rather than faking.
 */
export function planToolChannels(
  capabilities: ToolChannelCapabilities,
): ToolDegradationPlan | undefined {
  const order: ToolChannel[] = [];
  if (capabilities.nativeFunctionCalling) order.push('native');
  if (capabilities.structuredOutput) order.push('json');
  order.push('text-protocol');
  const primary = order[0];
  if (primary === undefined) return undefined;
  return { order, primary, allowRetry: true, giveUp: 'report-to-user' };
}

/* ─────────────────────────────── 工具调用 ──────────────────────────────── */

/**
 * A tool call as the runtime receives it: what the model asked for, over which
 * channel, on which turn. `args` is `unknown` because the arguments are validated
 * against the tool's own parameter list, not against a type core could know.
 */
export interface ToolCallRequest {
  /** Call id, echoed back on the `tool` message that carries the result. */
  id: string;
  name: ToolName;
  args: unknown;
  /** Which level of the ladder produced it. */
  source: ToolChannel;
  sessionId?: string;
  /** The assistant message the call came from, for the audit trail. */
  messageId?: string;
  /** World clock at request time, so the audit shows *when* it happened. */
  atMinute?: number;
}

/* ──────────────────────────────── 校验 ────────────────────────────────── */

/** One JSON Schema violation, located by parameter name. */
export interface ToolParameterIssue {
  /** Parameter that failed; absent when the whole argument object is wrong. */
  parameter?: string;
  /** Machine-readable reason, e.g. `missing` | `type` | `range` | `enum`. */
  code: string;
  detail: string;
}

/**
 * Outcome of the validate-before-execute steps. `requires-approval` is NOT an
 * error: it is the normal state of a mutating tool awaiting the user, and it is
 * the only place where the "AI may request" boundary becomes visible to the UI.
 */
export type ToolValidationStatus = 'valid' | 'requires-approval' | 'invalid' | 'unknown-tool';

/**
 * Validation result. `manualApproval` is a recorded fact, not a flag the caller
 * may ignore: when it is true, `execute` is legal only with
 * `approvedBy: 'user'`.
 */
export interface ToolValidation {
  status: ToolValidationStatus;
  /** The declaration the runtime resolved, when it found one. */
  tool?: ToolDefinition;
  /** Missing/wrong arguments (§5.3 step 1). */
  issues: ToolParameterIssue[];
  /** Domain-rule violation (resource bounds, dice syntax, time policy, §5.3 step 2). */
  domainError?: string;
  /** True when only the user may proceed. */
  manualApproval: boolean;
  /** True when the tool changes state and therefore goes through the write path. */
  mutatesState: boolean;
  /** Human sentence the UI can show without knowing anything about the tool. */
  detail: string;
}

/* ──────────────────────────────── 执行 ────────────────────────────────── */

/**
 * Terminal outcome of one call, named as §5.3 names it. `ok` mirrors the three
 * states the audit trail must distinguish (it reuses
 * `Message.toolCalls[].status`'s vocabulary at the meaning level, not the type
 * level):
 * - `ok: true`         — executed locally; `value` is fed back to the model;
 * - `rejected`         — a local decision (validation or the user) refused it;
 * - `error`            — execution was attempted and failed; `retryable` says
 *                        whether the model may ask again.
 */
export type ToolCallResult =
  | { ok: true; value: unknown; detail: string }
  | { ok: false; reason: 'rejected'; detail: string; issues: ToolParameterIssue[] }
  | { ok: false; reason: 'error'; detail: string; retryable: boolean };

/**
 * A registered tool's local behaviour. The runtime stores signatures; the
 * handler is what actually WRITES, and it only ever runs inside `execute` — which
 * is the mechanical form of "the AI may request, only the local runtime writes".
 */
export type ToolHandler = (args: unknown, call: ToolCallRequest) => unknown | Promise<unknown>;

/** Who authorised a mutating call. Recorded, because §5.3 requires an audit trail. */
export type ToolApprovalSource = 'policy' | 'user';

/**
 * What `execute` is given. `approvedBy` is required whenever the resolved tool
 * has `requiresApproval` (or `mutatesState`): a caller cannot execute a mutating
 * tool by simply not mentioning approval.
 */
export interface ToolExecutionRequest {
  call: ToolCallRequest;
  validation: ToolValidation;
  approvedBy?: ToolApprovalSource;
}

/** One audit row: §5.3's "所有调用写入消息元数据，可审计可撤销". */
export interface ToolAuditRecord {
  callId: string;
  name: ToolName;
  source: ToolChannel;
  /** The args as validated (defaults applied), not the raw request. */
  args: unknown;
  validationStatus: ToolValidationStatus;
  ok: boolean;
  detail: string;
  /** Set when approval was required and granted. */
  approvedBy?: ToolApprovalSource;
  atMinute?: number;
  timestamp: number;
}

/* ─────────────────────────────── ToolRuntime ──────────────────────────── */

/** Declaration lookup, used by `prepare` and by the prompt composer (§5.1). */
export interface ToolCatalog {
  list(): readonly ToolDefinition[];
  get(name: ToolName): ToolDefinition | undefined;
}

/**
 * §5.3's execution model as a contract. The names are the pipeline's steps on
 * purpose — a reader can point at each method and find the sentence in §5.3 that
 * requires it:
 *
 *   `validate` → JSON Schema check (issues) + domain check (domainError)
 *                + approval requirement
 *   `execute`  → LOCAL execution only, and only for a validated call
 *   `record`   → "结果回灌、写入消息元数据"; the returned record is append-only
 *
 * Implementations live in `packages/rules` / the app (M1–M3). This package only
 * freezes the shape, which is why nothing here imports an engine.
 */
export interface ToolRuntime extends ToolCatalog {
  /**
   * Register a tool signature, plus the LOCAL function that may write for it.
   * The handler is optional so a tool can be declared before its implementation
   * exists (the UI prompt builder only needs the signature), but a mutating tool
   * without one cannot execute and says so.
   */
  register(tool: ToolDefinition, handler?: ToolHandler): void;
  unregister(name: ToolName): boolean;

  /** The ladder this runtime will offer the next model turn. */
  planChannels(capabilities: ToolChannelCapabilities): ToolDegradationPlan | undefined;

  /** Steps 1 and 2 of §5.3. Never executes, never writes. */
  validate(call: ToolCallRequest): Promise<ToolValidation>;

  /**
   * Step 4: local execution. MUST reject a validation that is not
   * `valid`/`requires-approval`, and MUST reject a mutating call without
   * `approvedBy`.
   */
  execute(request: ToolExecutionRequest): Promise<ToolCallResult>;

  /** Append-only audit, newest last. */
  audit(): readonly ToolAuditRecord[];
}

/* ────────────────────────────── 参数辅助 ──────────────────────────────── */

/** Required parameters of a tool, in declaration order (prompt-building helper). */
export function requiredParameters(tool: ToolDefinition): ToolParameter[] {
  return tool.parameters.filter((parameter) => parameter.required);
}

/** True when a call must pass through the approval step before it may execute. */
export function needsApproval(tool: ToolDefinition): boolean {
  return tool.requiresApproval || tool.mutatesState;
}
