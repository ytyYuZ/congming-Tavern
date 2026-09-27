/**
 * Turn plan — who speaks this round, decided LOCALLY (docs/02 §4.1, §5.6,
 * §7 `turnPlans`; ADR-011).
 *
 * THIS IS A LOCAL PRODUCT, NOT A MODEL OUTPUT
 * The scoring and the ordering are computed by `TurnScheduler` in core from each
 * card's `VoiceProfile` plus the hard constraints (lines per round, cooldown).
 * The AI may only ever *propose* an order, and a proposal is stored as a plan
 * whose `mode` is `'ai'` and whose `score`/`reasons` still come from the local
 * engine — so "why did this character speak" is always answerable and the same
 * inputs always produce the same plan (ADR-011, docs/01 可解释).
 *
 * `excluded` is not a debugging leftover: it is what lets the UI explain the
 * silence ("莉安 本轮冷却") instead of leaving the user wondering whether the
 * scheduler is broken.
 *
 * `reasons` on an entry is the human-readable trace of the score; both are
 * required, because a plan without them cannot be shown to the user.
 *
 * OPEN vs CLOSED: `mode` is CLOSED and is the *same schema* as
 * `Session.schedulerMode` from `./session` (imported, not redeclared) — a plan
 * can therefore never claim a mode the session could not have been started in.
 */
import { z } from 'zod';
import { ExtensionsSchema, IdSchema, TimestampSchema } from '../common';
import { SchedulerModeSchema } from './session';

/* ─────────────────────────────── 计划条目 ────────────────────────────────── */

/**
 * One character's slot in the round. `score` is the local scheduler's number and
 * is kept even when the user overrides the order, so the override can be
 * explained ("AI 排在第三，用户提到第二"). The entry carries no `extensions`:
 * plugin data belongs on the plan row, where it has one owner.
 */
export const TurnPlanEntrySchema = z.object({
  characterId: IdSchema,
  /** Position within the round; ascending, and every value is distinct. */
  order: z.number().int().nonnegative(),
  /**
   * Lines this character may produce. The ceiling comes from the card's
   * `VoiceProfile.maxLinesPerRound` (enforced by the scheduler, 1-5), so it is
   * deliberately not re-bounded here — one source of truth for that hard limit.
   */
  linesBudget: z.number().int().min(1),
  score: z.number(),
  /** Why it scored that way. Shown in the debug panel. */
  reasons: z.array(z.string()),
});
export type TurnPlanEntry = z.infer<typeof TurnPlanEntrySchema>;

/** Someone the scheduler deliberately left out, and the reason to show the user. */
export const TurnPlanExclusionSchema = z.object({
  characterId: IdSchema,
  reason: z.string().min(1),
});
export type TurnPlanExclusion = z.infer<typeof TurnPlanExclusionSchema>;

/* ──────────────────────────────── 发言计划 ───────────────────────────────── */

export const TurnPlanSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** Round counter of the session, starting at 0. */
  round: z.number().int().nonnegative(),
  /** CLOSED, shared with `Session.schedulerMode`. */
  mode: SchedulerModeSchema,
  entries: z.array(TurnPlanEntrySchema),
  excluded: z.array(TurnPlanExclusionSchema),
  /** True when the user reordered or replaced the local plan by hand. */
  overriddenByUser: z.boolean(),
  createdAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type TurnPlan = z.infer<typeof TurnPlanSchema>;
