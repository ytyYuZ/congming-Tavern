/**
 * Clock operations: `advance`, `setTime`, `display` (docs/02 §5.7, M1-T1).
 *
 * ───────────────────────── WHY `display` HAS NO SENTENCE ─────────────────────
 * docs/02 §5.7 sketches `display(minute)` as the finished string
 * `"第三纪 1287 年 霜月 12 日 · 黄昏"`. THIS ENGINE DELIBERATELY DOES NOT DO THAT,
 * and this paragraph exists so nobody "restores" the sketch.
 *
 * M1-G1 moved every piece of user-facing prose into the `packages/i18n`
 * catalogs, and `biome.json` now forbids `packages/core` from importing
 * `@smarttavern/i18n` at all. A date sentence is locale-dependent in ways the
 * calendar data cannot express: word order, the separators, the counters, and
 * even whether the era label leads or trails. If the engine emitted it, the
 * engine would own a locale — and the same engine serves a JSON export, a log
 * file and a test snapshot, none of which want the UI's punctuation.
 *
 * So `display()` returns `ClockDisplay`: year, month name, day, hour, minute and
 * the active segment ids and names, all as data. The month and segment names are
 * the world's own calendar content (the same reason a character's name is not in
 * a catalog), which is why they stay here. `renderParts()` is the optional
 * plain-data join for callers with no i18n layer — it prefixes nothing with a
 * Chinese word and adds no punctuation beyond the separator it is given.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `advance` IS PURE AND DOES NOT TOUCH AGENDA OR DEADLINES. §5.7's 副作用链 lists
 * seven steps; this module owns steps 1, 5 and 7's input, and steps 2 and 3 are
 * `fireDue()` / `expireDue()` in this same directory, called by the orchestrator
 * so that "compute the new clock" and "decide what the new clock triggered" can
 * be tested and retried separately. Steps 6 (write an autosave) and 4/7 (re-evaluate
 * worldbook conditions, inject the time block into the next prompt) are I/O and
 * prompt assembly: core does no I/O (HANDOFF §4.1 invariant 1), so they stay
 * outside this engine by construction.
 */
import type { Calendar, EpochMinute } from '@smarttavern/schema';
import {
  calendarView,
  dayOfYearAt,
  hourOfDayAt,
  toCalendarDate,
  weekdayAt,
  yearAt,
} from './calendar';
import { crossedSegments } from './crossings';
import { resolvedSegmentsOf, segmentsAt } from './segments';
import type { ClockDisplay, ClockState, TimeStep } from './types';
import { TimeEngineError } from './types';

/**
 * Move the clock by `delta` minutes.
 *
 * THREE THINGS THIS DOCUMENTS RATHER THAN DISCOVERS LATER
 *
 * 1. `delta === 0` is legal and moves nothing: the result is `fromMinute` with an
 *    empty `crossedSegments`. Refusing it would make a loop that advances by
 *    `stepMinutes` fail on a step of 0, and the caller has no better answer.
 *    A fractional or non-finite delta is a caller bug and throws.
 * 2. A NEGATIVE delta is supported, deliberately. A user may set the clock back
 *    and a checkpoint rollback has to be expressible (docs/02 §5.7: "读档即回滚
 *    时钟"). `crossings.ts` defines what "crossed" means in that direction.
 * 3. A negative RESULT is legal. `EpochMinuteSchema` is any integer, and a world
 *    whose `startMinute` is 0 can legitimately be rolled before its epoch; the
 *    calendar maps negative minutes to the last days of year 0 by Euclidean
 *    division rather than throwing.
 */
export function advance(step: {
  readonly delta: number;
  readonly calendar: Calendar;
  readonly fromMinute: EpochMinute;
}): TimeStep {
  const { delta, calendar, fromMinute } = step;
  if (!Number.isInteger(delta)) {
    throw new TimeEngineError('advance delta must be a whole number of minutes');
  }
  if (!Number.isFinite(fromMinute)) {
    throw new TimeEngineError('advance fromMinute must be a finite number');
  }
  const view = calendarView(calendar);
  const toMinute = fromMinute + delta;
  const segments = resolvedSegmentsOf(calendar, view.hoursPerDay);
  return {
    fromMinute,
    toMinute,
    delta,
    crossedSegments: crossedSegments(view, segments, fromMinute, toMinute),
  };
}

/**
 * Set the clock outright (docs/02 §5.7: "仅用户可操作，需确认"). The confirmation
 * is a UI concern and is not modelled here; what this function guarantees is
 * that it returns a NEW `ClockState` and moves no input.
 */
export function setTime(minute: EpochMinute): ClockState {
  if (!Number.isInteger(minute)) {
    throw new TimeEngineError('setTime minute must be a whole number of minutes');
  }
  return { clock: minute };
}

/**
 * Map `minute` onto the calendar as structured parts.
 *
 * `segments` is a list because a calendar may declare overlapping windows; a
 * worldbook `timeOfDay` condition should use `segmentOf()`, which returns the
 * first match only.
 */
export function display(calendar: Calendar, minute: EpochMinute): ClockDisplay {
  const view = calendarView(calendar);
  const date = toCalendarDate(view, minute);
  const { hour, minute: minuteOfHour } = hourOfDayAt(view, minute);
  const segments = segmentsAt(view, resolvedSegmentsOf(calendar, view.hoursPerDay), minute);
  const epochLabel = view.calendar.epochLabel;
  const weekday = weekdayAt(view, minute);
  return {
    minute,
    ...(epochLabel === undefined ? {} : { epochLabel }),
    year: yearAt(view, minute),
    monthIndex: date.monthIndex,
    monthName: date.month.name,
    day: date.day,
    dayOfYear: dayOfYearAt(view, minute),
    ...(weekday === undefined ? {} : { weekday }),
    hour,
    minuteOfHour,
    minutesPerHour: view.minutesPerHour,
    hoursPerDay: view.hoursPerDay,
    segments,
  };
}

/** Two digits, so a 100-minute hour and a 60-minute hour both render evenly. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * Join `ClockDisplay` into one string, as plain data with no prose of its own.
 *
 * This is the convenience form for a caller with no i18n layer (a log line, a
 * test snapshot, a CLI). It emits `"<epochLabel> <year> <monthName> <day>T<hh:mm>"`
 * with `labelSeparator` between the parts and nothing else: `display().segments`
 * is where the caller reads the day-part name it wants to append, in the locale
 * it wants.
 */
export function renderParts(parts: ClockDisplay, separator = ' '): string {
  const fields: readonly (string | undefined)[] = [
    parts.epochLabel,
    String(parts.year),
    parts.monthName,
    String(parts.day),
    `${pad2(parts.hour)}:${pad2(parts.minuteOfHour)}`,
  ];
  return fields.filter((field): field is string => field !== undefined).join(separator);
}
