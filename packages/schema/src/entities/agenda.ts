/**
 * Agenda — the schedule of things that will happen (docs/02 §4 `AgendaEntry`,
 * §5.7 `fireDue` / `repeatHandling`, §7 `agenda`).
 *
 * An entry is a promise the time engine keeps: when `advance()` crosses
 * `atMinute`, the entry fires and `resultingMessageId` records what it produced,
 * so the story stays traceable back to the scheduler.
 *
 * TIME IS THE SORT KEY, NOT A DATE. `atMinute` is an `EpochMinute` (ADR-012), and
 * `repeatEveryMinutes` is a delta rather than a cron rule — a fantasy calendar
 * with a 26-hour day has no wall-clock to hang a cron rule on.
 *
 * OPEN vs CLOSED
 * - `source` is OPEN (`openEnum`): who *put* the entry there is a provenance
 *   question, and a plugin or an importer may legitimately have done it
 *   (`x-mythos.rumor-table`).
 * - `status` is CLOSED: it is the state machine the local time engine drives
 *   (`pending -> fired | skipped | rescheduled`), and `Checkpoint.agendaStatus`
 *   reuses this exact schema so a save can never disagree with the entry.
 *
 * `sessionId` IS ON THE ROW (docs/02 §4 vs §7, resolved at M0-T1):
 * §7 declares the `agenda` collection indexed by `(sessionId, atMinute, status)`
 * while §4's draft interface omitted the field. The index key is authoritative —
 * without it the storage layer would have to carry a parallel session key beside
 * every row — so the field was added here and §4 was corrected to match.
 * `Message`, `Checkpoint` and `TurnPlan` already carry it; agenda was the outlier.
 */
import { z } from 'zod';
import { EpochMinuteSchema, ExtensionsSchema, IdSchema, openEnum } from '../common';

/* ─────────────────────────────── 状态与来源 ──────────────────────────────── */

/** CLOSED: the agenda state machine driven by `TimeEngine.fireDue()`. */
export const AgendaStatusSchema = z.enum(['pending', 'fired', 'skipped', 'rescheduled']);
export type AgendaStatus = z.infer<typeof AgendaStatusSchema>;

/** OPEN: provenance, so a plugin or importer can contribute entries. */
export const AgendaSourceSchema = openEnum(['user', 'ai', 'rulepack'] as const);
export type AgendaSource = z.infer<typeof AgendaSourceSchema>;

/* ──────────────────────────────── 日程条目 ───────────────────────────────── */

export const AgendaEntrySchema = z.object({
  id: IdSchema,
  /** Owning session — the first component of §7's `(sessionId, atMinute, status)` index. */
  sessionId: IdSchema,
  title: z.string().min(1).max(200),
  description: z.string(),
  /** When it becomes due, in epoch minutes. */
  atMinute: EpochMinuteSchema,
  /** Repeat period; absent means one-shot. `fireDue()` shifts the next run by it. */
  repeatEveryMinutes: z.number().int().positive().optional(),
  /** Who is involved. Ids, not names, so a card can be renamed. */
  actors: z.array(IdSchema),
  /** Secret entries fire without being shown to the player in the agenda list. */
  secret: z.boolean(),
  status: AgendaStatusSchema,
  source: AgendaSourceSchema,
  /** Set once it fired, so the note in the log can be traced back. */
  resultingMessageId: IdSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});
export type AgendaEntry = z.infer<typeof AgendaEntrySchema>;
