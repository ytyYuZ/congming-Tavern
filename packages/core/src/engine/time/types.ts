/**
 * Public value shapes of the time engine (docs/02 §5.7, M1-T1).
 *
 * WHY THIS FILE EXISTS. Every operation in `engine/time` is a pure function that
 * returns a NEW value rather than mutating a `SessionState` (docs/02 §5.7: a
 * checkpoint carries the whole clock, so "time went back but the state did not"
 * must be inexpressible). These interfaces are those return values.
 *
 * TWO RULES THIS FILE ENCODES
 *
 * 1. NOTHING HERE IS USER-FACING PROSE. `display()` deliberately returns the
 *    structured parts of a date instead of the doc's finished sentence
 *    "第三纪 1287 年 霜月 12 日 · 黄昏" — see `clock.ts`. Month and segment NAMES
 *    are part of the world's own calendar data, which is content; the joining
 *    sentence and its punctuation belong to `packages/i18n` and the caller.
 * 2. TIME IS AN `EpochMinute`. No field below is a wall-clock `Date` (ADR-012).
 */
import type { AgendaEntry, CalendarMonth, Deadline, EpochMinute, Id } from '@smarttavern/schema';

/**
 * Where a day's clock face stands: which hour index, and which minute inside it.
 *
 * `minute` is NOT a wall-clock minute and is bounded by |minute| <
 * `Calendar.minutesPerHour`, which is 60 only by convention. A world with a
 * 100-minute hour is legal (entities/world.ts), so every value here comes from
 * the calendar's data and never from a hard-coded 24 or 60.
 */
export interface HourOfDay {
  /** Hour index inside the day: 0 .. hoursPerDay - 1. */
  readonly hour: number;
  /** Minute inside that hour: 0 .. minutesPerHour - 1. */
  readonly minute: number;
}

/** A month and a 1-based day inside it, as resolved from an `EpochMinute`. */
export interface CalendarDate {
  readonly monthIndex: number;
  readonly month: CalendarMonth;
  readonly day: number;
}

/** How a `DaySegment`'s hour window reads once it has been resolved. */
export type SegmentHourWindow = 'whole-day' | 'within-day' | 'overnight';

/**
 * A day segment, resolved to absolute hour indexes and tagged with its shape.
 *
 * `tag` is precomputed so no consumer has to branch on `fromHour`/`toHour` twice:
 * an editor may legitimately write 夜 as 22 -> 30 (overnight, wrapping past
 * `hoursPerDay`), as 0 -> 26 (whole-day) or as 22 -> 26 (within-day).
 *
 * `hoursPerDay` is carried because the overnight test needs to fold `toHour`
 * back into `[0, hoursPerDay)` — the number cannot be recovered from the window
 * alone (22 -> 30 on a 26-hour day and on a 24-hour day are the same numbers but
 * different windows), and guessing 24 is exactly the constant this engine bans.
 */
export interface ResolvedDaySegment {
  readonly id: Id;
  readonly name: string;
  readonly fromHour: number;
  /** Exclusive, may exceed `hoursPerDay` for an overnight window. */
  readonly toHour: number;
  /** `hoursPerDay` for a whole-day window, otherwise `toHour - fromHour`. */
  readonly hours: number;
  readonly hoursPerDay: number;
  readonly tag: SegmentHourWindow;
}

/** The identity of one named stretch of the day. */
export interface SegmentRef {
  readonly id: Id;
  readonly name: string;
}

/* ───────────────────────────── advance / setTime ─────────────────────────── */

/**
 * One traversal of the clock, as reported by `advance()`.
 *
 * `crossedSegments` is the §5.7 副作用链 step-1 output: EVERY day segment that
 * held at least one of the minutes walked over, in walk order — not just the
 * segment the clock landed in, and not deduplicated when a segment is entered
 * more than once (e.g. 晨 → 昼 → 晨). Day boundaries are deliberately absent:
 * the traversal describes the minutes, not the days.
 */
export interface TimeStep {
  readonly fromMinute: EpochMinute;
  readonly toMinute: EpochMinute;
  /** `toMinute - fromMinute`; negative when the clock was set back. */
  readonly delta: number;
  /** The segments that held the walked minutes, in walk order. */
  readonly crossedSegments: readonly SegmentRef[];
}

/**
 * The authority a caller writes back into `SessionState.clock` (docs/02 §5.7
 * step 5). It is the clock and nothing else: persisting it is the storage
 * layer's job, and this engine does no I/O (HANDOFF §4.1 invariant 1).
 */
export interface ClockState {
  readonly clock: EpochMinute;
}

/* ──────────────────────────────── display ───────────────────────────────── */

/**
 * `display()`'s result: the date, broken into parts, plus the segment(s) that
 * are active at that minute.
 *
 * Everything optional is genuinely optional: `epochLabel` and `weekdays` are
 * optional in `Calendar`, and a calendar may declare no `segments` at all, in
 * which case a worldbook `timeOfDay` condition can never match.
 *
 * `segments` is a list because the data permits overlapping windows; `segmentOf`
 * still returns exactly one (the first match) for the worldbook condition path.
 */
export interface ClockDisplay {
  /** The minute this was derived from, so a caller never has to carry it twice. */
  readonly minute: EpochMinute;
  readonly epochLabel?: string;
  /** 1-based on purpose: "year 0" reads as an epoch, not as a first year. */
  readonly year: number;
  readonly monthIndex: number;
  readonly monthName: string;
  readonly day: number;
  /** 1-based day inside the year, for "day 200 of 365" style summaries. */
  readonly dayOfYear: number;
  readonly weekday?: string;
  /** The calendar number, 0 .. hoursPerDay - 1. */
  readonly hour: number;
  /** The minute inside the hour, 0 .. minutesPerHour - 1. */
  readonly minuteOfHour: number;
  readonly minutesPerHour: number;
  readonly hoursPerDay: number;
  readonly segments: readonly SegmentRef[];
}

/* ──────────────────────────────── agenda ────────────────────────────────── */

/**
 * The next occurrence of a repeating entry, or the explicit statement that
 * there is none (a one-shot entry, or a repeat period that would not move the
 * clock forward — see `nextRepeat` in `scheduler.ts`).
 */
export interface RepeatRollover {
  readonly repeats: boolean;
  readonly nextMinute?: EpochMinute;
}

/**
 * What `fireDue()` did to one entry. `entry` is always a NEW object; none of the
 * returned values alias an input element.
 */
export interface FiredAgendaEntry {
  readonly entry: AgendaEntry;
  readonly repeat: RepeatRollover;
  /** True when the fired entry was pushed beyond `now` for its next run. */
  readonly rolledOver: boolean;
}

/** The result of one agenda sweep at `now`. */
export interface AgendaSweep {
  readonly now: EpochMinute;
  /** Entries that came due, in input order. */
  readonly fired: readonly FiredAgendaEntry[];
  /** Entries the sweep did not touch, with their original object identity. */
  readonly remaining: readonly AgendaEntry[];
}

/* ─────────────────────────────── deadlines ──────────────────────────────── */

/**
 * The result of the §5.7 step-3 countdown check. `expired` is what the caller
 * turns into reminders; `deadlines` is the new array to persist, in which the
 * untouched deadlines keep their original object identity.
 */
export interface DeadlineSweep {
  readonly now: EpochMinute;
  readonly expired: readonly Deadline[];
  readonly deadlines: readonly Deadline[];
}

/**
 * Thrown when a calendar cannot be mapped at all. This is an error and not a
 * fallback on purpose: an unreadable calendar must fail loudly rather than
 * print a plausible wrong date, which is exactly what `entities/world.ts`
 * warns about.
 */
export class TimeEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeEngineError';
  }
}
