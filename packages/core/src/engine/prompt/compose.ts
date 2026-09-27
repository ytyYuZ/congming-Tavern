/**
 * `compose` — the prompt composer's assembly step (M1-G4; docs/02-技术架构.md §5.1
 * 装配顺序, ADR-029 for the block shape, docs/06 §2.1 for the acceptance).
 *
 * THE ORDER THIS PRODUCES, and how it relates to §5.1's twelve-step list:
 *
 *     pre_history blocks            (ascending `order`)
 *       -> conversation history     (oldest first, already flattened)
 *       -> in_history blocks        (at their `depth`, `order` inside a depth)
 *       -> post_history blocks      (ascending `order`)
 *       -> the current user input   (always last)
 *
 * §5.1's list is a list of content KINDS (system instruction, world summary, the
 * hard time injection, worldbook hits, card fields, player card, memory, rolling
 * summary, recent turns, the turn plan, tool definitions and results, the user
 * input). The preset is what turns those kinds into blocks, and a block says
 * where it belongs with `position` + `order` + `depth` — which is the whole point
 * of ADR-029. The one thing §5.1's prose does not name explicitly is a slot
 * between the history and the user input; that is what `post_history` is, and it
 * is where §5.1's "本轮发言计划" and "工具定义与结果" land. Tool SIGNATURES are
 * deliberately not serialised into a message: §5.3 keeps them on
 * `ChatRequest.tools`, so they are echoed on the result instead.
 *
 * ORDERING RULES
 * - Blocks at the same `position` are sorted by ascending `order`, then by their
 *   position in `preset.blocks` (so a preset with duplicate orders still has one
 *   deterministic answer).
 * - `depth` counts messages BACK FROM THE END of the history: depth 0 is
 *   immediately before the current user input, depth 1 is before the last stored
 *   turn, and a depth beyond the history clamps to its beginning. Depths are
 *   resolved against the ORIGINAL history, so two blocks at different depths
 *   never displace each other.
 *
 * WHAT IS SKIPPED, AND WHY THAT IS NOT THE SAME AS "EMITTED EMPTY"
 * - `enabled: false` blocks are skipped, exactly as the schema says: a disabled
 *   block is kept in the preset so turning it back on loses nothing, not so that
 *   it can occupy a message slot.
 * - An enabled block whose content expands to the empty string contributes no
 *   message either. It says nothing, and a provider charges framing tokens per
 *   message, so an empty turn is pure cost. This applies to the user input too.
 * - History is NEVER macro-expanded: it is text the model has already seen, and
 *   re-expanding it would rewrite a past turn (and could fire a second `setvar`).
 *
 * CONDITIONS (docs/02 §5.1 `conditions`). `minTurns`, `keywords` and `timeOfDay`
 * are ANDed; a block with no conditions is always included; an EMPTY condition
 * list states nothing (the same as omitting the field).
 * WHEN AN INPUT IS MISSING FROM THE CONTEXT, THE CONDITION IS UNMET — not met:
 *   - `timeOfDay` with no active segment ids (no `clock`, no `segmentIds`) and
 *   - `keywords` can never be missing, because the conversation text is always
 *     available (history + input); an empty conversation simply matches nothing.
 * Guessing "met" would inject world content the world did not ask for, which is
 * the expensive direction: it spends tokens and can contradict the scene. `minTurns`
 * has no missing case at all, because `turnNumber` is required in the context —
 * that is exactly why it is required.
 * Keyword matching is case-insensitive (`toLowerCase`, locale-independent) so a
 * user writing `dragon` still triggers on `Dragon`; segment ids are matched
 * EXACTLY, because they are ids from the world's calendar and not prose.
 *
 * PURITY. No I/O, no `Date`, no RNG (docs/02 §5.1's `{{roll}}`/`{{random}}`/
 * `{{pick}}` need the M3-R1 dice engine and are left unresolved — see
 * `macros.ts`). The context is read, never written.
 */
import type {
  Id,
  PromptBlock,
  PromptBlockConditions,
  PromptBlockPosition,
  PromptPreset,
} from '@smarttavern/schema';
import { applyBudget } from './budget';
import type { VariableChange } from './macros';
import { expandMacros } from './macros';
import type { AssembledItem, ComposeResult, PromptBudget, PromptContext } from './types';

/**
 * Where each position sits in the assembly. A table, and the only place this
 * order is written down, so §5.1's sequence cannot drift between the sort and
 * the emit loops below.
 */
const POSITION_ORDER: Readonly<Record<PromptBlockPosition, number>> = {
  pre_history: 0,
  in_history: 1,
  post_history: 2,
};

/* ─────────────────────────────── conditions ───────────────────────────────── */

/**
 * Per-call memo for the two derived inputs a condition needs. It is created
 * inside `compose` and never stored at module scope: a module-level cache would
 * leak one caller's conversation into the next call's answer, which is the one
 * way a "pure" function can still be wrong.
 */
interface ConditionMemo {
  conversation?: string;
  segmentIds?: ReadonlySet<Id>;
}

/** History plus the new input, lower-cased once, for keyword matching. */
function conversationOf(context: PromptContext, memo: ConditionMemo): string {
  if (memo.conversation === undefined) {
    const turns = context.history.map((turn) => turn.content);
    memo.conversation = [...turns, context.input.content].join('\n').toLowerCase();
  }
  return memo.conversation;
}

/** The day segments active right now: stated ids plus whatever the clock says. */
function segmentsOf(context: PromptContext, memo: ConditionMemo): ReadonlySet<Id> {
  if (memo.segmentIds === undefined) {
    const ids = new Set<Id>(context.segmentIds ?? []);
    for (const segment of context.clock?.segments ?? []) ids.add(segment.id);
    memo.segmentIds = ids;
  }
  return memo.segmentIds;
}

/**
 * Does this block apply? See the file header for the missing-input rule.
 *
 * Keywords are searched in the conversation and NOT in the other blocks: a block
 * that mentions a keyword must not be able to trigger itself.
 */
function conditionsMet(
  conditions: PromptBlockConditions | undefined,
  context: PromptContext,
  memo: ConditionMemo,
): boolean {
  if (conditions === undefined) return true;

  const minTurns = conditions.minTurns;
  if (minTurns !== undefined && context.turnNumber < minTurns) return false;

  const timeOfDay = conditions.timeOfDay;
  if (timeOfDay !== undefined && timeOfDay.length > 0) {
    const active = segmentsOf(context, memo);
    if (active.size === 0) return false;
    if (!timeOfDay.some((segmentId) => active.has(segmentId))) return false;
  }

  const keywords = conditions.keywords;
  if (keywords !== undefined && keywords.length > 0) {
    const conversation = conversationOf(context, memo);
    const hit = keywords.some(
      (keyword) => keyword.length > 0 && conversation.includes(keyword.toLowerCase()),
    );
    if (!hit) return false;
  }

  return true;
}

/* ──────────────────────────────── assembly ────────────────────────────────── */

/** One selected block with the index it occupies in `preset.blocks`. */
interface SelectedBlock {
  readonly block: PromptBlock;
  readonly index: number;
}

/**
 * Where an `in_history` block goes: its index in the ORIGINAL history array.
 * See the header for the depth convention; `depth` is clamped because a foreign
 * or hand-edited preset can carry a number the schema's `nonnegative` does not
 * forbid from being larger than the conversation.
 */
function insertionIndex(depth: number | undefined, historyLength: number): number {
  const fromEnd = Math.max(depth ?? 0, 0);
  return Math.min(Math.max(historyLength - fromEnd, 0), historyLength);
}

/**
 * Build the prompt for one turn.
 *
 * Returns a discriminated result: `ok: true` carries the `messages` to send,
 * `ok: false` carries the explicit §5.1 error (naming the shortfall) and NO
 * `messages` field, so an over-budget assembly cannot be forwarded by accident.
 */
export function compose(
  preset: PromptPreset,
  context: PromptContext,
  budget: PromptBudget,
): ComposeResult {
  const unresolved = new Set<string>();
  const changes: VariableChange[] = [];
  const memo: ConditionMemo = {};

  const selected: SelectedBlock[] = preset.blocks
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.enabled && conditionsMet(entry.block.conditions, context, memo))
    .sort(
      (left, right) =>
        POSITION_ORDER[left.block.position] - POSITION_ORDER[right.block.position] ||
        left.block.order - right.block.order ||
        left.index - right.index,
    );

  const items: AssembledItem[] = [];
  const emitBlock = (entry: SelectedBlock): void => {
    const expansion = expandMacros(entry.block.content, context);
    for (const token of expansion.unresolved) unresolved.add(token);
    changes.push(...expansion.changes);
    if (expansion.text.length === 0) return;
    items.push({
      message: { role: entry.block.role, content: expansion.text },
      block: entry.block,
      blockIndex: entry.index,
    });
  };

  for (const entry of selected) {
    if (entry.block.position === 'pre_history') emitBlock(entry);
  }

  const buckets = new Map<number, SelectedBlock[]>();
  for (const entry of selected) {
    if (entry.block.position !== 'in_history') continue;
    const at = insertionIndex(entry.block.depth, context.history.length);
    const bucket = buckets.get(at);
    if (bucket === undefined) buckets.set(at, [entry]);
    else bucket.push(entry);
  }
  for (let index = 0; index <= context.history.length; index += 1) {
    const bucket = buckets.get(index);
    if (bucket !== undefined) for (const entry of bucket) emitBlock(entry);
    const turn = context.history[index];
    if (turn !== undefined) items.push({ message: turn });
  }

  for (const entry of selected) {
    if (entry.block.position === 'post_history') emitBlock(entry);
  }

  const input = expandMacros(context.input.content, context);
  for (const token of input.unresolved) unresolved.add(token);
  changes.push(...input.changes);
  if (input.text.length > 0) {
    items.push({ message: { ...context.input, content: input.text } });
  }

  const outcome = applyBudget(items, budget);
  const base = {
    dropped: outcome.dropped,
    blocks: outcome.blocks,
    unresolvedMacros: [...unresolved],
    variableChanges: changes,
    budget: outcome.report,
    warnings: outcome.warnings,
    ...(context.tools === undefined ? {} : { tools: context.tools }),
  };

  if (outcome.error !== undefined) {
    return {
      ok: false,
      ...base,
      error: outcome.error,
      overBudget: outcome.kept.map((item) => item.message),
    };
  }
  return { ok: true, ...base, messages: outcome.kept.map((item) => item.message) };
}
