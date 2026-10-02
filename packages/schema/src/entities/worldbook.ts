/**
 * Worldbook entry — the lorebook (docs/02 §5.2 L4, §7 `worldbookEntries`,
 * docs/02 §4.1).
 *
 * WHAT TRIGGERS AN ENTRY
 * `keywords` are matched with Aho-Corasick over the recent turns, `probability`
 * gates the hit, `depth` says how deep into the history the content is injected,
 * and `conditions` adds the time dimension (`timeOfDay` / `afterMinute` /
 * `withinDays`) that ADR-012 promised. Every hit is recorded on the message so
 * the debug panel can explain why a setting appeared in the prompt (docs/01
 * F5-2, docs/02 §5.2).
 *
 * WHY THIS IS NOT A MEMORY ENTRY (ADR-015)
 * A worldbook entry is authored, deterministic and conditional; a memory entry is
 * extracted, semantic and needs confirmation. They share an editor and a storage
 * layer, never a trigger.
 *
 * OPEN vs CLOSED
 * - `position` is CLOSED and uses the PromptComposer's own slot vocabulary
 *   (`'pre_history' | 'in_history' | 'post_history'`, docs/02 §5.1). A
 *   plugin-invented slot would pass validation and then be silently dropped by
 *   the composer at assembly time, which is worse than an honest rejection.
 * - A plugin that wants new *behaviour* adds fields under `extensions`; the
 *   injection slots themselves are intrinsic to our prompt assembly.
 *
 * docs/02 §7 names the storage fields but never types `position`, so the three
 * slots above are a decision taken here (see the M0-T1 report).
 */
import { z } from 'zod';
import { EpochMinuteSchema, ExtensionsSchema, IdSchema } from '../common';

/* ──────────────────────────────── 触发条件 ───────────────────────────────── */

/**
 * Time conditions, evaluated against the current clock before injection.
 *
 * All three are optional and independent: `timeOfDay` names a calendar day
 * segment id (晨/昼/昏/夜), `afterMinute` makes an entry appear only once the
 * story has passed a point, and `withinDays` expires it again so late-game
 * content cannot leak into act one.
 */
export const WorldbookConditionsSchema = z.object({
  /** A `Calendar.segments[].id`, not a free-form label. */
  timeOfDay: z.string().min(1).optional(),
  /** Only fires at or after this epoch minute. */
  afterMinute: EpochMinuteSchema.optional(),
  /** Only fires within this many days after it first became eligible. */
  withinDays: z.number().positive().optional(),
});
export type WorldbookConditions = z.infer<typeof WorldbookConditionsSchema>;

/* ─────────────────────────────── 世界书条目 ──────────────────────────────── */

export const WorldbookEntrySchema = z.object({
  id: IdSchema,
  /** Owning world; entries are always scoped to one setting. */
  worldId: IdSchema,
  /** Trigger keys. An empty list means "never by keyword" — see `enabled`. */
  keywords: z.array(z.string()),
  /** What gets injected when it hits. */
  content: z.string(),
  /** Higher wins when the token budget forces a choice. */
  priority: z.number().int(),
  /** CLOSED injection slot from the PromptComposer (docs/02 §5.1). */
  position: z.enum(['pre_history', 'in_history', 'post_history']),
  /**
   * How DEEP into the history the content is injected, counting messages back from
   * the END of it (the same convention as `PromptBlock.depth`).
   *
   * WHY THE INJECTION MEANING AND NOT "how many recent turns are scanned for
   * `keywords`": injection is what the composer does with this number.
   * `packages/core/src/engine/prompt/compose.ts` resolves it in `insertionIndex` as
   * `historyLength - depth` — its header states the rule in as many words, "depth
   * counts messages BACK FROM THE END of the history": 0 is immediately before the
   * current user input, 1 is before the last stored turn, and a depth beyond the
   * history clamps to its beginning. Nothing there scans the conversation by this
   * number, so the keyword window is not this field.
   */
  depth: z.number().int().nonnegative(),
  /** Roll chance 0-100 (SillyTavern convention), so 100 = always inject. */
  probability: z.number().int().min(0).max(100),
  conditions: WorldbookConditionsSchema,
  /** Manual switch, independent of the trigger: off means off. */
  enabled: z.boolean(),
  /** Author's note for the editor; never injected. */
  comment: z.string().optional(),
  extensions: ExtensionsSchema.optional(),
});
export type WorldbookEntry = z.infer<typeof WorldbookEntrySchema>;
