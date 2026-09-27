/**
 * Agenda firing and repeat rollover: docs/02 §5.7 `fireDue` / `repeatHandling`,
 * 副作用链 step 2, `entities/agenda.ts`.
 *
 * THE TWO RULES THAT DECIDE CORRECTNESS HERE
 *
 * 1. `atMinute` MEANS "DUE AT, INCLUSIVE". An entry due exactly at `now` fires;
 *    an entry the clock walked past while the session was closed also fires
 *    (`atMinute <= now`), which is what makes a long advance report everything
 *    it stepped over. An entry that is `fired`, `skipped` or `rescheduled` is
 *    not a candidate, so re-running the sweep is idempotent.
 * 2. THE ROLLOVER IS STRICTLY AFTER `now`. `repeatEveryMinutes` is a period,
 *    not a wall-clock rule (agenda.ts: a 26-hour day has no wall-clock to hang a
 *    cron rule on), so the next occurrence is `atMinute + k * period` for the
 *    smallest whole `k` that lands strictly after `now`. An entry whose period
 *    would land exactly on `now` is pushed one period further rather than fired
 *    twice in the same minute. A malformed period that cannot move the entry
 *    forward is reported as `{ repeats: false }` instead of looping forever.
 *
 * NOTHING IS MUTATED. Every fired entry is a new object; every entry the sweep
 * did not touch keeps its input identity, so a caller can persist the result and
 * diff it against the input by reference. Whether `fireDue` also appends a
 * `Message` and sets `resultingMessageId` is the orchestrator's step 2 — this
 * function decides WHAT came due, not what the table says about it.
 */
import type { AgendaEntry, EpochMinute } from '@smarttavern/schema';
import type { AgendaSweep, FiredAgendaEntry, RepeatRollover } from './types';
import { TimeEngineError } from './types';

/**
 * The smallest whole `k >= 0` with `a + k * period > now`.
 *
 * WHY `+ 1` AND NOT A CEILING DIVISION. The largest `k` that is NOT strictly
 * after `now` is `floor((now - a) / period)`, so the smallest that is comes one
 * later. Ceiling-dividing instead gets `now === a` wrong: it would hand back the
 * occurrence that is firing right now, and the entry would fire twice in the same
 * minute. The `>= 0` clamp covers the one remaining case, an entry whose `atMinute`
 * is already in the future (it was rescheduled while a sweep's `now` lagged),
 * where the answer is 0 — wait for it rather than jump a period.
 *
 * `period <= 0` has no answer and is reported as `undefined` by the caller
 * rather than looping forever.
 */
function stepsStrictlyAfter(a: number, period: number, now: number): number | undefined {
  if (!Number.isFinite(period) || period <= 0) return undefined;
  const steps = Math.floor((now - a) / period) + 1;
  return Number.isFinite(steps) ? Math.max(0, steps) : undefined;
}

/**
 * When a repeating entry runs next, given that it has just been fired.
 *
 * `atMinute` rather than `now` is the anchor: a repeating entry keeps its phase.
 * Anchoring on `now` would drift the schedule by however late the sweep ran, so
 * a daily market at 08:00 would creep later every time the user advanced by
 * nine minutes.
 */
export function nextRepeat(entry: AgendaEntry, now: EpochMinute): RepeatRollover {
  const { repeatEveryMinutes } = entry;
  if (repeatEveryMinutes === undefined) return { repeats: false };
  if (!Number.isInteger(repeatEveryMinutes)) return { repeats: false };
  const k = stepsStrictlyAfter(entry.atMinute, repeatEveryMinutes, now);
  if (k === undefined) return { repeats: false };
  const nextMinute = entry.atMinute + k * repeatEveryMinutes;
  if (!Number.isSafeInteger(nextMinute)) return { repeats: false };
  return { repeats: true, nextMinute };
}

/**
 * Restate a repeating entry for its next occurrence: `pending` again, with
 * `atMinute` moved. A one-shot entry is already at rest, so it is returned
 * unchanged — `fireDue` deliberately does not apply this, because agenda.ts's
 * state machine has `fired` as a terminal state and an automatic re-arm is an
 * agenda CRUD decision (docs/06 M2-T1), not a clock decision.
 */
export function rollOverRepeat(entry: AgendaEntry, now: EpochMinute): AgendaEntry {
  const repeat = nextRepeat(entry, now);
  if (!repeat.repeats || repeat.nextMinute === undefined) return entry;
  return { ...entry, atMinute: repeat.nextMinute, status: 'pending' };
}

function fireOne(entry: AgendaEntry, now: EpochMinute): FiredAgendaEntry {
  const repeat = nextRepeat(entry, now);
  return {
    entry: { ...entry, status: 'fired' },
    repeat,
    rolledOver: repeat.repeats && repeat.nextMinute !== undefined,
  };
}

/**
 * The agenda sweep for one instant: every `pending` entry with `atMinute <= now`
 * becomes `fired`, and each one's next occurrence (if it repeats) is computed.
 *
 * `remaining` keeps the untouched entries in input order. The fired entries are
 * NOT in it: the caller writes their new status back (agenda.ts: a checkpoint's
 * `agendaStatus` records exactly this transition).
 */
export function fireDue(agenda: readonly AgendaEntry[], now: EpochMinute): AgendaSweep {
  if (!Number.isFinite(now)) throw new TimeEngineError('fireDue now must be a finite number');
  const fired: FiredAgendaEntry[] = [];
  const remaining: AgendaEntry[] = [];
  for (const entry of agenda) {
    if (entry.status === 'pending' && entry.atMinute <= now) fired.push(fireOne(entry, now));
    else remaining.push(entry);
  }
  return { now, fired, remaining };
}
