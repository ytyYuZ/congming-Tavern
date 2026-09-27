/**
 * Budget & trimming (M1-G4; docs/02-技术架构.md §5.1: 总预算 = 模型上下文长度 −
 * 预留输出长度。按块优先级从低到高裁剪（optional → normal → high；required 永不裁剪，
 * 超限则明确报错并给出建议）).
 *
 * THE TRIM RULE, EXACTLY
 * 1. `limit = contextWindow - reservedOutput`.
 * 2. Candidates are the blocks that produced a message. History turns and the
 *    current user input are NOT candidates: they carry no priority, and shortening
 *    history is the MemoryManager's job (docs/02 §5.2 L0/L1/L2) — a composer that
 *    silently dropped old turns would hide a memory failure inside a token count.
 * 3. One block at a time, least important first, re-measuring after each drop and
 *    stopping the moment the assembly fits. Re-measuring (rather than subtracting
 *    a precomputed block cost) is what makes the loop correct for an INJECTED
 *    counter, which need not be additive; the per-message cache in `estimate.ts`
 *    is what keeps that affordable.
 * 4. `required` blocks are never dropped. If the assembly still does not fit with
 *    only required blocks and history left, `applyBudget` returns an explicit
 *    `PromptBudgetError` naming the shortfall instead of an over-budget request
 *    (a wasted round trip and a confusing vendor error).
 *
 * THE TIE-BREAK, AND WHICH END OF `order` IS "LEAST IMPORTANT"
 * Priority decides first: `optional`, then `normal`, then `high`. Inside one
 * priority class the block with the HIGHEST `order` is dropped first.
 * WHY THE HIGH END: `order` is the author's slot inside the block's own position
 * group, and the assembly emits ascending `order`. The head of a group is the
 * structural scaffolding (system instruction, world summary, card fields) while
 * the tail is where later, finer nudges accumulate — so dropping from the tail
 * costs the least structure and leaves the surviving prefix of every group
 * byte-identical to the top of the preset as the user sees it in the editor. The
 * counter-argument (recency: the last line before the user input is the most
 * influential) would drop the head instead; it is rejected because it would take
 * out the world's own system instruction before a stylistic aside.
 * Two blocks with the SAME `order` have no ranking from the preset at all, so the
 * last tie-break is declaration order in `preset.blocks` (the later declaration is
 * dropped first). That tie-break is deterministic, not meaningful, and is
 * documented as such rather than dressed up.
 *
 * `budget.share` (the schema's per-block ceiling, a fraction of `limit`) is
 * enforced as its own pass before priority trimming: a DROPPABLE block over its
 * ceiling is dropped with reason `over-share`, because "give it less" cannot mean
 * cutting prose: a truncated system instruction is a corrupted instruction. A
 * `required` block over its ceiling is kept (priority wins) and reported as a
 * warning, so the contradiction is visible instead of silently resolved.
 *
 * A block with no `budget` at all is `normal`: an unspecified block must be
 * trimmable, because the alternative (defaulting to `required`) would make every
 * forgotten field permanently undroppable.
 */
import type { PromptBlock, PromptBlockPriority } from '@smarttavern/schema';
import { createEstimator } from './estimate';
import type {
  AssembledItem,
  BlockUsage,
  BudgetOutcome,
  BudgetReport,
  DroppedBlock,
  DropReason,
  PromptBudget,
  PromptBudgetError,
} from './types';

/** Drop order between priority classes; `required` sorts last and is never dropped. */
const PRIORITY_TRIM_ORDER: Readonly<Record<PromptBlockPriority, number>> = {
  optional: 0,
  normal: 1,
  high: 2,
  required: 3,
};

/** The priority of a block that states none — see the file header. */
export const DEFAULT_BLOCK_PRIORITY: PromptBlockPriority = 'normal';

/** One block's claim on the assembly, with its cost already measured. */
interface Candidate {
  readonly index: number;
  readonly block: PromptBlock;
  readonly priority: PromptBlockPriority;
  readonly order: number;
  /** Message tokens only, request framing excluded (framing never changes). */
  readonly tokens: number;
}

/** Group the assembled items by the block that produced them. */
function groupByBlock(items: readonly AssembledItem[]): Map<number, AssembledItem[]> {
  const groups = new Map<number, AssembledItem[]>();
  for (const item of items) {
    const blockIndex = item.blockIndex;
    if (blockIndex === undefined || item.block === undefined) continue;
    const existing = groups.get(blockIndex);
    if (existing === undefined) groups.set(blockIndex, [item]);
    else existing.push(item);
  }
  return groups;
}

/**
 * Trim an assembly to fit `budget`.
 *
 * Pure and self-contained: it builds its own estimator from `budget.counter`, so
 * one call is one cache. `compose` is the safe entry point; this is the raw step
 * that also reports the failure (see `BudgetOutcome`).
 */
export function applyBudget(items: readonly AssembledItem[], budget: PromptBudget): BudgetOutcome {
  const estimator = createEstimator(budget.counter);
  const limit = budget.contextWindow - budget.reservedOutput;
  const measure = (list: readonly AssembledItem[]): number =>
    estimator.messages(list.map((item) => item.message));

  const groups = groupByBlock(items);
  const candidates: Candidate[] = [];
  for (const [index, groupItems] of groups) {
    const first = groupItems[0];
    if (first === undefined || first.block === undefined) continue;
    const block = first.block;
    candidates.push({
      index,
      block,
      priority: block.budget?.priority ?? DEFAULT_BLOCK_PRIORITY,
      order: block.order,
      tokens: groupItems.reduce((sum, item) => sum + estimator.message(item.message), 0),
    });
  }

  const trimOrder = [...candidates].sort(
    (left, right) =>
      PRIORITY_TRIM_ORDER[left.priority] - PRIORITY_TRIM_ORDER[right.priority] ||
      right.order - left.order ||
      right.index - left.index,
  );

  const warnings: string[] = [];
  const dropped: DroppedBlock[] = [];
  const droppedIndexes = new Set<number>();
  let kept: readonly AssembledItem[] = [...items];
  let used = measure(kept);

  const drop = (candidate: Candidate, reason: DropReason): void => {
    const before = used;
    kept = kept.filter((item) => item.blockIndex !== candidate.index);
    used = measure(kept);
    droppedIndexes.add(candidate.index);
    dropped.push({
      id: candidate.block.id,
      name: candidate.block.name,
      priority: candidate.priority,
      order: candidate.order,
      tokens: before - used,
      reason,
    });
  };

  // Pass 1: the schema's per-block ceiling (`budget.share`) — see the header.
  if (limit > 0) {
    for (const candidate of trimOrder) {
      const share = candidate.block.budget?.share;
      if (share === undefined) continue;
      const ceiling = Math.floor(share * limit);
      if (candidate.tokens <= ceiling) continue;
      if (candidate.priority === 'required') {
        warnings.push(
          `required block "${candidate.block.name}" needs ${candidate.tokens} tokens but its ` +
            `share ceiling is ${ceiling} (share ${share} of limit ${limit}); kept because ` +
            'required blocks are never trimmed',
        );
        continue;
      }
      drop(candidate, 'over-share');
    }
  }

  // Pass 2: low-to-high priority, one block at a time, stopping as soon as it fits.
  for (const candidate of trimOrder) {
    if (used <= limit) break;
    if (candidate.priority === 'required' || droppedIndexes.has(candidate.index)) continue;
    drop(candidate, 'over-budget');
  }

  const blocks: BlockUsage[] = candidates.map((candidate) => ({
    id: candidate.block.id,
    name: candidate.block.name,
    position: candidate.block.position,
    order: candidate.order,
    priority: candidate.priority,
    tokens: candidate.tokens,
    kept: !droppedIndexes.has(candidate.index),
  }));

  const report: BudgetReport = {
    contextWindow: budget.contextWindow,
    reservedOutput: budget.reservedOutput,
    limit,
    used,
    freed: dropped.reduce((sum, entry) => sum + entry.tokens, 0),
    measuredBy: estimator.source,
  };

  const error = used > limit ? budgetError(used, limit, budget) : undefined;
  return {
    kept,
    dropped,
    blocks,
    warnings,
    report,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * The §5.1 "明确报错并给出建议": what is over, by how much, and what can be done.
 *
 * `undroppableTokens` is `used`, because pass 2 has already dropped every
 * trimmable block by the time this is built — the number is therefore "history
 * plus required blocks", which is exactly what a suggestion has to act on.
 */
function budgetError(used: number, limit: number, budget: PromptBudget): PromptBudgetError {
  const shortfall = used - limit;
  const emptyBudget = limit <= 0;
  return {
    code: emptyBudget ? 'empty-budget' : 'budget-exceeded',
    message: emptyBudget
      ? `The budget is ${limit} tokens: contextWindow ${budget.contextWindow} minus ` +
        `reservedOutput ${budget.reservedOutput} leaves no room for a prompt (short by ${shortfall}).`
      : `The prompt still needs ${used} tokens after dropping every trimmable block, but the ` +
        `budget is ${limit} (short by ${shortfall}).`,
    shortfall,
    undroppableTokens: used,
    limit,
    suggestion: emptyBudget
      ? `reservedOutput (${budget.reservedOutput}) must be smaller than contextWindow ` +
        `(${budget.contextWindow}); lower the reserve or raise the window.`
      : `Raise contextWindow, lower reservedOutput, or shorten the conversation history by ` +
        `${shortfall} tokens.`,
  };
}
