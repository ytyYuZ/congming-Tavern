/**
 * Countdown / duration deadlines: docs/02 §5.7 副作用链 step 3,
 * `entities/session.ts` `Deadline`.
 *
 * THE STATE MACHINE IS `active -> expired`, AND ONLY THAT.
 * `dueMinute <= now` on an `active` deadline makes it `expired`. `cleared` (the
 * user cancelled it) and `expired` (already fired) are terminal states and are
 * not resurrected by a later sweep — a checkpoint rollback is what un-expires a
 * deadline, by restoring the whole state, not a second pass of this function.
 *
 * `kind: 'countdown' | 'duration'` DOES NOT CHANGE THE CHECK. Both are a due
 * instant in epoch minutes; the kind tells the UI how the remaining span was
 * authored (a countdown to a named moment vs a duration from some start), so
 * branching on it here would be two names for one comparison.
 *
 * IMMUTABILITY: an expiring deadline is copied with the new status; every
 * deadline the sweep did not touch keeps its input object identity, so a caller
 * can persist the array and diff it by reference.
 *
 * NO I/O AND NO MESSAGE: this decides which reminders are due. Turning one into
 * a system prompt, a log entry or an agenda insert is the caller's step 3.
 */
import type { Deadline, EpochMinute } from '@smarttavern/schema';
import type { DeadlineSweep } from './types';
import { TimeEngineError } from './types';

/** True when this deadline crosses from `active` to `expired` at `now`. */
export function isDueAt(deadline: Deadline, now: EpochMinute): boolean {
  return deadline.status === 'active' && deadline.dueMinute <= now;
}

/** The new deadline array for `now`, in input order. */
export function expireDeadlines(
  deadlines: readonly Deadline[],
  now: EpochMinute,
): readonly Deadline[] {
  return deadlines.map((deadline) =>
    isDueAt(deadline, now) ? { ...deadline, status: 'expired' as const } : deadline,
  );
}

/**
 * The §5.7 step-3 check in one call: what expired, and the array to persist.
 *
 * The second value is what the caller writes into `SessionState.deadlines`; the
 * first is what it turns into reminders. Both come from one traversal, so they
 * cannot disagree about which deadline fired.
 */
export function expireDue(deadlines: readonly Deadline[], now: EpochMinute): DeadlineSweep {
  if (!Number.isFinite(now)) throw new TimeEngineError('expireDue now must be a finite number');
  const expired: Deadline[] = [];
  const next: Deadline[] = [];
  for (const deadline of deadlines) {
    if (isDueAt(deadline, now)) {
      const expiredDeadline: Deadline = { ...deadline, status: 'expired' };
      expired.push(expiredDeadline);
      next.push(expiredDeadline);
    } else {
      next.push(deadline);
    }
  }
  return { now, expired, deadlines: next };
}
