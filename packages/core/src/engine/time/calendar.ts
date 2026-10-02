/**
 * Calendar arithmetic: `EpochMinute` <-> (year, month, day, hour, minute).
 * docs/02 §5.7 `display`, `entities/world.ts` `Calendar`.
 *
 * THE ONE RULE HERE: `minutesPerHour` AND `hoursPerDay` ARE DATA.
 * A fantasy world may have a 26-hour day or a 100-minute hour (world.ts says so
 * in as many words). Every division and remainder in this file divides by a
 * number read out of the calendar, never by a literal 24 or 60. If you are
 * about to write `% 1440`, write `% view.minutesPerDay` instead.
 *
 * WHY `CalendarView` EXISTS. Mapping a minute to a date needs the month lengths,
 * their prefix sums and the two derived divisors. Recomputing those on every
 * call would make `display()` O(months) per render; deriving them once, in
 * `calendarView()`, makes the mapping itself O(log months) and keeps the
 * derived numbers in one place instead of three.
 *
 * WHY NOTHING IS CLAMPED. A malformed calendar throws `TimeEngineError` instead
 * of returning a plausible-looking wrong date (world.ts: "a wrong calendar
 * prints the wrong text"). Minutes, however, are NOT rejected for being
 * negative: checkpoint rollback and `setTime` both have to be expressible, and
 * `floorDiv`/`mod` are Euclidean precisely so that minute -1 is the last minute
 * of day -1 rather than day 0 at a negative hour.
 */
import type { Calendar, CalendarMonth, DaySegment, EpochMinute } from '@smarttavern/schema';
import type { CalendarDate, HourOfDay } from './types';
import { TimeEngineError } from './types';

/** What a calendar looks like once its derived values are known. */
export interface CalendarView {
  readonly calendar: Calendar;
  readonly minutesPerHour: number;
  readonly hoursPerDay: number;
  readonly minutesPerDay: number;
  readonly minutesPerYear: number;
  readonly months: readonly CalendarMonth[];
  /** `monthStartSum[monthIndex]` is the day offset of that month's first day. */
  readonly monthStartSum: readonly number[];
  readonly daysPerYear: number;
}

/** Euclidean remainder: always in `[0, divisor)`, including for negatives. */
export function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Floor division: rounds toward minus infinity, unlike `Math.trunc`. */
export function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * A segment's `fromHour` must be a whole hour index in `[0, hoursPerDay]`, and its
 * `toHour` in `[0, fromHour + hoursPerDay]`. Note the inclusive upper bounds:
 * `toHour === hoursPerDay` is how a window that runs to the end of the day is written,
 * and a window that wraps midnight may be written EITHER short (`22 -> 4`) or long
 * (`22 -> 30` on a 24-hour day). The long form is not a typo: `types.ts` documents it
 * ("may exceed `hoursPerDay` for an overnight window"), `segments.ts`'s
 * `resolveSegments` normalises the short form INTO it, and `hourWindowHolds` folds
 * `toHour - hoursPerDay` to read it back. Bounding `toHour` at `hoursPerDay` therefore
 * rejected a spelling the rest of the engine depends on — see the note below on why
 * that mattered. `fromHour + hoursPerDay` admits exactly one wrap and nothing more.
 *
 * WHY THE CHECK IS HERE AND NOT ONLY IN `segments.ts`. `calendarView()` is the
 * one call every entry point makes, so validating here means a malformed
 * calendar fails on the way in — including for a caller that only ever wants a
 * date and would never call `resolveSegments` (`segments.ts` keeps its own,
 * more specific message for the same condition).
 *
 * WHICH IS ALSO WHY THIS FILE HELD THE BUG FOR SO LONG. Because the rule lives in two
 * places, a repair applied to only one of them is invisible to a test that calls
 * `resolveSegments` directly — and `display()`/`advance()`, the two calls every real
 * consumer makes, go through THIS one. `segments.test.ts` therefore asserts the long
 * form through `calendarView` as well as through the resolver.
 */
function assertSegmentHours(segments: readonly DaySegment[], hoursPerDay: number): void {
  for (const segment of segments) {
    if (
      !Number.isInteger(segment.fromHour) ||
      segment.fromHour < 0 ||
      segment.fromHour > hoursPerDay
    ) {
      throw new TimeEngineError(
        `segment ${segment.id} fromHour must be a whole hour index in 0..${hoursPerDay}`,
      );
    }
    const maxToHour = segment.fromHour + hoursPerDay;
    if (!Number.isInteger(segment.toHour) || segment.toHour < 0 || segment.toHour > maxToHour) {
      throw new TimeEngineError(
        `segment ${segment.id} toHour must be a whole hour index in 0..${maxToHour}` +
          ` (a wrap may be written past the end of the day, e.g. 22 -> 30 on a 24-hour day)`,
      );
    }
  }
}

/**
 * Derive the month prefix sums and the per-day / per-year arithmetic for one
 * calendar. Pure and cheap, but callers should still hold onto the result: the
 * segment crossing walk in `crossings.ts` uses `minutesPerDay` per iteration.
 */
export function calendarView(calendar: Calendar): CalendarView {
  const { minutesPerHour, hoursPerDay, months } = calendar;

  // These three are already guaranteed by CalendarSchema; the checks are here
  // because a view may be built from data that arrived as `unknown` (an imported
  // package, a plugin bag) and an integer division by 0 or by 1.5 must not
  // silently succeed.
  if (!isPositiveInt(minutesPerHour)) {
    throw new TimeEngineError(`calendar.minutesPerHour must be a positive integer`);
  }
  if (!isPositiveInt(hoursPerDay)) {
    throw new TimeEngineError(`calendar.hoursPerDay must be a positive integer`);
  }
  if (months.length === 0) throw new TimeEngineError('calendar.months must not be empty');
  assertSegmentHours(calendar.segments, hoursPerDay);

  const monthStartSum: number[] = [];
  let daysPerYear = 0;
  for (let index = 0; index < months.length; index += 1) {
    const month = months[index];
    // `noUncheckedIndexedAccess` makes this genuinely optional; the length check
    // above is what makes it unreachable in practice.
    if (month === undefined) throw new TimeEngineError('calendar.months has a hole');
    if (!isPositiveInt(month.days)) {
      throw new TimeEngineError(`calendar month ${index} must have a positive whole day count`);
    }
    monthStartSum.push(daysPerYear);
    daysPerYear += month.days;
    if (!Number.isSafeInteger(daysPerYear)) {
      throw new TimeEngineError('calendar year is too long to map with exact integers');
    }
  }

  const minutesPerDay = minutesPerHour * hoursPerDay;
  const minutesPerYear = minutesPerDay * daysPerYear;
  if (!Number.isSafeInteger(minutesPerYear)) {
    throw new TimeEngineError('calendar year is too long to map with exact integers');
  }

  return {
    calendar,
    minutesPerHour,
    hoursPerDay,
    minutesPerDay,
    minutesPerYear,
    months,
    monthStartSum,
    daysPerYear,
  };
}

function assertFiniteInteger(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new TimeEngineError(`${what} must be a finite number`);
}

/** Which day the minute falls on. Negative for negative minutes; that is fine. */
export function dayIndexAt(view: CalendarView, minute: EpochMinute): number {
  assertFiniteInteger(minute, 'minute');
  return floorDiv(minute, view.minutesPerDay);
}

/** The minute inside its day. Always in `[0, minutesPerDay)`. */
export function minuteOfDayAt(view: CalendarView, minute: EpochMinute): number {
  return mod(minute, view.minutesPerDay);
}

/** The calendar hour index and the minute inside that hour. */
export function hourOfDayAt(view: CalendarView, minute: EpochMinute): HourOfDay {
  const minuteOfDay = minuteOfDayAt(view, minute);
  return {
    hour: floorDiv(minuteOfDay, view.minutesPerHour),
    minute: mod(minuteOfDay, view.minutesPerHour),
  };
}

/** The minute at which the given calendar day starts. */
export function minuteAtDayStart(view: CalendarView, dayIndex: number): EpochMinute {
  return dayIndex * view.minutesPerDay;
}

/**
 * The minute at whose start the given hour index of the given day begins.
 *
 * `hourIndex` may be `>= hoursPerDay`: overnight windows (world.ts: "`toHour <
 * fromHour` is also legal: 夜 legitimately wraps midnight") are expressed as
 * hours past the end of the day, so the hour index is allowed to run over and
 * the extra days are added back here.
 */
export function minuteAtHourOfDay(
  view: CalendarView,
  dayIndex: number,
  hourIndex: number,
): EpochMinute {
  const daysOver = floorDiv(hourIndex, view.hoursPerDay);
  const hourInDay = mod(hourIndex, view.hoursPerDay);
  return (dayIndex + daysOver) * view.minutesPerDay + hourInDay * view.minutesPerHour;
}

/**
 * The start of the first hour boundary at or before `minute`.
 *
 * The backward traversal in `crossings.ts` needs the hour boundary it is
 * standing on *included*, while the forward one needs the next boundary
 * *excluded* — the two differ by exactly this flooring, so both are computed
 * here rather than open-coded at the two call sites.
 */
export function hourAtOrBefore(view: CalendarView, minute: EpochMinute): EpochMinute {
  const { hour } = hourOfDayAt(view, minute);
  return minuteAtHourOfDay(view, dayIndexAt(view, minute), hour);
}

/** The start of the next hour boundary strictly after `minute`. */
export function nextHourBoundary(view: CalendarView, minute: EpochMinute): EpochMinute {
  return hourAtOrBefore(view, minute) + view.minutesPerHour;
}

/**
 * The sampled minutes of a clock step, in ascending order — the ONE definition
 * `crossings.ts` reads forwards for a positive delta and backwards for a negative
 * one.
 *
 * THE RULE, stated exactly: a step touches BOTH of its endpoint instants and every
 * hour mark strictly between them. So the samples are `low`, then each multiple of
 * `minutesPerHour` in `(low, high)`, then `high`. `high` is always last so the
 * hour containing the destination is represented even when that hour opened before
 * the destination and even when the destination is one minute into a new segment.
 *
 * WHY BOTH ENDPOINTS. `advance` may be called with either sign, and the two
 * instants are symmetric — neither is privileged. Sampling both, plus the marks in
 * between, is what makes the backward traversal's list exactly the forward one
 * reversed, which is the mirror property `crossings.ts` promises and
 * `clock.test.ts` asserts row by row.
 *
 * `Math.ceil` for the first interior mark (not `floorDiv`) is deliberate: an
 * unmarked `low` such as 55 must not round down to the 0 mark, because 0 is
 * outside the span and the clock never stood there.
 *
 * The list is O(span in hours), which is the honest cost of a traversal a caller
 * can render hour by hour. A single day of a 26-hour calendar is at most 28 entries.
 */
export function hourMarksBetween(
  low: EpochMinute,
  high: EpochMinute,
  minutesPerHour: number,
): readonly EpochMinute[] {
  const samples: EpochMinute[] = [low];
  for (
    let mark = Math.ceil((low + 1) / minutesPerHour) * minutesPerHour;
    mark < high;
    mark += minutesPerHour
  ) {
    samples.push(mark);
  }
  if (high !== low) samples.push(high);
  return samples;
}

function resolveDate(view: CalendarView, minute: EpochMinute): CalendarDate | undefined {
  const dayInYear = mod(dayIndexAt(view, minute), view.daysPerYear);
  for (let index = 0; index < view.months.length; index += 1) {
    const sum = view.monthStartSum[index];
    const month = view.months[index];
    // Both are present by construction; the guard is here because
    // `noUncheckedIndexedAccess` is on and because a hole must not print a date.
    if (sum === undefined || month === undefined) continue;
    if (dayInYear < sum + month.days) {
      return { monthIndex: index, month, day: dayInYear - sum + 1 };
    }
  }
  return undefined;
}

/** `EpochMinute` -> (year, month, 1-based day). Year 1 holds day 0, like the label. */
export function toCalendarDate(view: CalendarView, minute: EpochMinute): CalendarDate {
  const date = resolveDate(view, minute);
  if (date === undefined) throw new TimeEngineError('calendar months do not cover the year');
  return date;
}

/** `EpochMinute` -> 1-based year. */
export function yearAt(view: CalendarView, minute: EpochMinute): number {
  return floorDiv(dayIndexAt(view, minute), view.daysPerYear) + 1;
}

/** `EpochMinute` -> 1-based day inside its year. */
export function dayOfYearAt(view: CalendarView, minute: EpochMinute): number {
  return mod(dayIndexAt(view, minute), view.daysPerYear) + 1;
}

/**
 * `Calendar.weekdays` is a display label list, not an arithmetic fact, so if it
 * does not divide the year evenly the day-of-week mapping is not well defined at
 * all. Returning nothing is the honest answer there — a wrong weekday would be
 * invented content.
 */
export function weekdayAt(view: CalendarView, minute: EpochMinute): string | undefined {
  const weekdays = view.calendar.weekdays;
  if (weekdays === undefined || weekdays.length === 0) return undefined;
  if (view.daysPerYear % weekdays.length !== 0) return undefined;
  return weekdays[mod(dayIndexAt(view, minute), weekdays.length)];
}

/**
 * (year, monthIndex, day, hour, minute) -> `EpochMinute`, the inverse of
 * `toCalendarDate` + `hourOfDayAt`. Provided so an editor can place an entry at
 * "霜月 12 日 黄昏" without a second division-by-the-calendar implementation
 * existing anywhere.
 */
export function toEpochMinute(
  view: CalendarView,
  at: {
    year: number;
    monthIndex: number;
    day: number;
    hour?: number;
    minute?: number;
  },
): EpochMinute {
  const { year, monthIndex, day, hour = 0, minute = 0 } = at;
  for (const part of [year, monthIndex, day, hour, minute]) {
    if (!Number.isInteger(part)) throw new TimeEngineError('calendar coordinates must be integers');
  }
  if (year < 1) throw new TimeEngineError('year is 1-based and must be >= 1');
  const month = view.months[monthIndex];
  if (month === undefined) {
    throw new TimeEngineError(`month index ${monthIndex} is outside calendar.months`);
  }
  if (day < 1 || day > month.days) {
    throw new TimeEngineError(`day ${day} is outside month ${monthIndex} (1..${month.days})`);
  }
  if (hour < 0 || hour >= view.hoursPerDay) {
    throw new TimeEngineError(`hour ${hour} is outside 0..${view.hoursPerDay - 1}`);
  }
  if (minute < 0 || minute >= view.minutesPerHour) {
    throw new TimeEngineError(`minute ${minute} is outside 0..${view.minutesPerHour - 1}`);
  }
  const dayIndex = (year - 1) * view.daysPerYear + (view.monthStartSum[monthIndex] ?? 0) + day - 1;
  return dayIndex * view.minutesPerDay + hour * view.minutesPerHour + minute;
}
