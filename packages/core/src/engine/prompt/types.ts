/**
 * The prompt composer's public shapes (M1-G4; docs/02-技术架构.md §5.1).
 *
 * WHY THERE IS NO BLOCK TYPE IN THIS FILE. ADR-029 already froze the block shape
 * in `@smarttavern/schema` (`PromptBlockSchema`), and the composer CONSUMES it:
 * `PromptBlock`, `PromptBlockPriority` and `PromptBlockPosition` are imported
 * from the schema everywhere below. A second, composer-local block interface
 * would be the drift ADR-016 forbids — the moment the schema gained a field, one
 * of the two would stop matching the preset a user saved.
 *
 * WHAT IS HERE INSTEAD is everything the schema does not own: the caller's
 * context, the budget, and the report of what assembly and trimming did.
 */
import type {
  Id,
  PromptBlock,
  PromptBlockPosition,
  PromptBlockPriority,
  ToolDefinition,
} from '@smarttavern/schema';
import type { ChatMessage } from '../../ports/llm';
import type { MeasureSource, TokenCounter } from './estimate';
import type { MacroContext, VariableChange } from './macros';

/* ──────────────────────────────── context ─────────────────────────────────── */

/**
 * Everything assembly and the macros need from the caller.
 *
 * The macro half of this `extends MacroContext` deliberately, so a context can
 * be handed to `expandMacros` unchanged: one bag, one place a name comes from.
 *
 * `history` is ALREADY FLATTENED, oldest first. The caller walks the message tree
 * (`Message.parentId`, docs/02 §7) — the composer is handed a list, because the
 * tree is a storage concern and a branch choice has already been made by the time
 * someone asks for a prompt (`Session.headMessageId`). Handing over
 * `ChatMessage` and not `Message` keeps the wire types in one place: a stored
 * message carries `sessionId`, `kind`, `meta` and a timestamp, none of which any
 * provider can be sent.
 *
 * HISTORY IS NOT MACRO-EXPANDED. It is text the model has already seen; running
 * today's macros over yesterday's turn would rewrite a past message, and a
 * `setvar` inside it would fire a second time.
 */
export interface PromptContext extends MacroContext {
  /** Conversation so far, oldest first, current user input EXCLUDED. */
  readonly history: readonly ChatMessage[];
  /** This turn's new user input, appended last (macros are expanded in it). */
  readonly input: ChatMessage;
  /**
   * Tool signatures, carried through to the result and NOT serialised into
   * messages: §5.3 keeps them on `ChatRequest.tools`, where a provider with
   * native function calling reads them. See `ComposeSuccess.tools`.
   */
  readonly tools?: readonly ToolDefinition[];
  /**
   * Day-segment ids active right now, for `conditions.timeOfDay`. Usually just
   * the ids off `clock.segments`; a caller whose worldbook conditions come from
   * somewhere else (a scheduled scene) can state them directly.
   */
  readonly segmentIds?: readonly Id[];
}

/* ──────────────────────────────── budget ──────────────────────────────────── */

/**
 * The token budget for one assembly (docs/02 §5.1: 总预算 = 模型上下文长度 −
 * 预留输出长度).
 *
 * `reservedOutput` is required rather than defaulted: the reserve is what stops a
 * long prompt from leaving the model no room to answer, and a default of 0 would
 * silently be the wrong number for every caller that forgot it. `ModelInfo`
 * carries both numbers (`contextWindow`, `maxOutputTokens`).
 */
export interface PromptBudget {
  /** The model's context window, in tokens. */
  readonly contextWindow: number;
  /** Output tokens held back for the answer. */
  readonly reservedOutput: number;
  /** Injected measurement; the built-in conservative approximation when absent. */
  readonly counter?: TokenCounter;
}

/* ─────────────────────────────── assembly ─────────────────────────────────── */

/**
 * One message plus where it came from. Trimming needs the provenance: a message
 * produced by a block disappears with that block, while a history turn or the
 * user input has no priority and is never a trim candidate (shortening history is
 * the MemoryManager's job — docs/02 §5.2 L0/L1/L2 — not the composer's).
 */
export interface AssembledItem {
  readonly message: ChatMessage;
  /** The block that produced this message; absent for history and the input. */
  readonly block?: PromptBlock;
  /** Position of that block inside `preset.blocks`, for the last tie-break. */
  readonly blockIndex?: number;
}

/* ───────────────────────────────── trim ───────────────────────────────────── */

/** Why a block was dropped from the assembly. */
export type DropReason =
  /** The assembly was over budget and this block's priority gave way first. */
  | 'over-budget'
  /** The block exceeded its own `budget.share` ceiling — see `applyBudget`. */
  | 'over-share';

/** One block that did not make it into the assembly, and what that saved. */
export interface DroppedBlock {
  readonly id: Id;
  readonly name: string;
  /** The priority that decided it was droppable (never `required`). */
  readonly priority: PromptBlockPriority;
  readonly order: number;
  /** Tokens this block's messages contributed, i.e. what dropping it freed. */
  readonly tokens: number;
  readonly reason: DropReason;
}

/**
 * Per-block token usage for the debug panel (docs/06 §2.5 M1-T3 asks for "时间块
 * 与 token 占用"). This is the usage view — every block that was considered;
 * `DroppedBlock` is the trim journal of the authoritative outcome. Both are
 * reported on purpose: the panel wants to show a dropped block's cost beside the
 * blocks that survived.
 */
export interface BlockUsage {
  readonly id: Id;
  readonly name: string;
  readonly position: PromptBlockPosition;
  readonly order: number;
  readonly priority: PromptBlockPriority;
  /** Message tokens this block contributed, request framing excluded. */
  readonly tokens: number;
  /** False when trimming removed it. */
  readonly kept: boolean;
}

/** The numbers behind a decision, so a caller can display or assert them. */
export interface BudgetReport {
  readonly contextWindow: number;
  readonly reservedOutput: number;
  /** `contextWindow - reservedOutput`; the number trimming works against. */
  readonly limit: number;
  /** Tokens of the returned assembly. */
  readonly used: number;
  /** Tokens freed by dropping blocks (the sum of `DroppedBlock.tokens`). */
  readonly freed: number;
  readonly measuredBy: MeasureSource;
}

/**
 * The explicit failure §5.1 asks for instead of an over-budget request.
 *
 * `shortfall` is the point of the object: a caller that just logs `message` still
 * learns how far over it is, and `suggestion` names the levers that exist (a
 * bigger window, a smaller reserve, a shorter history) rather than a generic
 * "prompt too long".
 */
export interface PromptBudgetError {
  /**
   * `budget-exceeded`: trimmable blocks are gone and it still does not fit.
   * `empty-budget`: `reservedOutput` leaves no room at all — a configuration
   * mistake, and worth telling apart from an over-long prompt.
   */
  readonly code: 'budget-exceeded' | 'empty-budget';
  readonly message: string;
  /** Tokens over the limit. Always positive. */
  readonly shortfall: number;
  /** Tokens that trimming could not remove (history + `required` blocks). */
  readonly undroppableTokens: number;
  /** `contextWindow - reservedOutput`. */
  readonly limit: number;
  readonly suggestion: string;
}

/**
 * What one pass of `applyBudget` produced.
 *
 * It carries BOTH the surviving assembly and the error: it is the raw step, and a
 * debug panel legitimately wants to render an over-budget prompt to explain what
 * happened. `compose` is the safe entry point — it turns an error into a
 * `ComposeFailure`, which has no `messages` field, so the over-budget assembly
 * cannot be sent by forgetting one `if`.
 */
export interface BudgetOutcome {
  readonly kept: readonly AssembledItem[];
  readonly dropped: readonly DroppedBlock[];
  readonly blocks: readonly BlockUsage[];
  readonly warnings: readonly string[];
  readonly report: BudgetReport;
  readonly error?: PromptBudgetError;
}

/* ──────────────────────────────── result ──────────────────────────────────── */

/** What both result branches report, in the shape §2.1 M1-G4 asks for. */
interface ComposeBase {
  readonly dropped: readonly DroppedBlock[];
  readonly blocks: readonly BlockUsage[];
  /** Distinct unresolved macro tokens, deduplicated in first-appearance order. */
  readonly unresolvedMacros: readonly string[];
  /** Every `setvar` the composer performed; M1-S6 persists them. */
  readonly variableChanges: readonly VariableChange[];
  readonly budget: BudgetReport;
  /** Non-fatal findings (e.g. a `required` block over its `share` ceiling). */
  readonly warnings: readonly string[];
  /**
   * The tool signatures that were passed in, echoed so one call builds one
   * request: §5.1 lists 工具定义 among the things that reach the model, but
   * §5.3 puts them on `ChatRequest.tools` rather than in a chat message, so they
   * are carried through instead of being rendered into text. Absent when the
   * caller passed none.
   */
  readonly tools?: readonly ToolDefinition[];
}

/** Success: `messages` is ready for `ChatRequest.messages`. */
export interface ComposeSuccess extends ComposeBase {
  readonly ok: true;
  readonly messages: readonly ChatMessage[];
}

/**
 * Failure: the assembly needs more tokens than the budget has, even with every
 * trimmable block gone.
 *
 * `overBudget` is the assembly that did NOT fit, and it is NAMED DIFFERENTLY from
 * `messages` on purpose: the two branches must not be interchangeable, so a
 * caller cannot forward an over-budget prompt by dropping one `if`. It exists for
 * the debug panel (M2-P1), which has to show the user why the prompt did not fit.
 */
export interface ComposeFailure extends ComposeBase {
  readonly ok: false;
  readonly error: PromptBudgetError;
  readonly overBudget: readonly ChatMessage[];
}

export type ComposeResult = ComposeSuccess | ComposeFailure;
