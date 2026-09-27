/**
 * Shared fixtures for the time-engine tests (M1-T1).
 *
 * WHY A KIT AND NOT A COPY PER FILE. The acceptance criterion is a literal,
 * hand-checkable table per module, and the tables only agree if they are built
 * from ONE set of calendars. Duplicating the fantasy calendar into five files
 * would let a typo in one copy "pass" while the others pass for a different
 * reason — and a calendar is exactly the kind of data where a wrong day count
 * still produces a plausible-looking date.
 *
 * NOT A `.test.ts` FILE ON PURPOSE: it holds no suite, and a kit with a suite
 * would be collected as an empty project file (`passWithNoTests: false` in
 * vitest.config.mjs makes an empty project a failure, not a pass).
 *
 * Every calendar here is a plain parsed-`Calendar` object literal, not a Zod
 * parse, because the tests are about arithmetic over the data; the schema's own
 * tests cover whether the data can be written down at all.
 */
import type { AgendaEntry, Calendar, Deadline, EpochMinute } from '@smarttavern/schema';

/**
 * The plain case, and the one the arithmetic is easiest to check by hand:
 * 60-minute hours, a 12-hour day (so a "day" is short and a table row stays
 * readable), 3 months of 10/20/30 days, one segment per quarter day.
 *
 * minutesPerDay = 720, daysPerYear = 60, minutesPerYear = 43200.
 */
export const plainCalendar: Calendar = {
  id: 'cal-plain',
  name: 'Plain',
  minutesPerHour: 60,
  hoursPerDay: 12,
  months: [
    { name: 'Alpha', days: 10 },
    { name: 'Beta', days: 20 },
    { name: 'Gamma', days: 30 },
  ],
  epochLabel: 'Era',
  segments: [
    { id: 'dawn', name: 'Dawn', fromHour: 0, toHour: 3 },
    { id: 'noon', name: 'Noon', fromHour: 3, toHour: 6 },
    { id: 'dusk', name: 'Dusk', fromHour: 6, toHour: 9 },
    { id: 'night', name: 'Night', fromHour: 9, toHour: 12 },
  ],
};

/**
 * The fantasy case that makes requirement 1 checkable: 100 minutes in an hour,
 * 26 hours in a day, 7 months of 30/28/44/40/45/53/150 days, weekday names, and
 * a 夜 that wraps midnight (25 -> 5).
 *
 * minutesPerDay = 2600, daysPerYear = 390, minutesPerYear = 1014000.
 */
export const fantasyCalendar: Calendar = {
  id: 'cal-fantasy',
  name: 'Fantasy',
  minutesPerHour: 100,
  hoursPerDay: 26,
  months: [
    { name: 'Frost', days: 30 },
    { name: 'Ember', days: 28 },
    { name: 'Mist', days: 44 },
    { name: 'Bloom', days: 40 },
    { name: 'Sun', days: 45 },
    { name: 'Moon', days: 53 },
    { name: 'Long', days: 150 },
  ],
  epochLabel: 'Third Age',
  weekdays: ['One', 'Two', 'Three', 'Four', 'Five'],
  segments: [
    { id: 'dawn', name: 'Dawn', fromHour: 5, toHour: 12 },
    { id: 'day', name: 'Day', fromHour: 12, toHour: 18 },
    { id: 'dusk', name: 'Dusk', fromHour: 18, toHour: 22 },
    { id: 'night', name: 'Night', fromHour: 25, toHour: 5 },
  ],
};

/**
 * A calendar whose segments do NOT tile the day: hours 0..4 are named by nobody,
 * and the weekdays list (4) does not divide the year (12), so no weekday is
 * well defined. Both facts are legal data and both must be visible in the output.
 *
 * minutesPerDay = 600, daysPerYear = 12, minutesPerYear = 7200.
 */
export const gappyCalendar: Calendar = {
  id: 'cal-gappy',
  name: 'Gappy',
  minutesPerHour: 60,
  hoursPerDay: 10,
  months: [
    { name: 'Solo', days: 5 },
    { name: 'Duo', days: 7 },
  ],
  segments: [
    { id: 'early', name: 'Early', fromHour: 0, toHour: 2 },
    { id: 'late', name: 'Late', fromHour: 7, toHour: 10 },
  ],
  weekdays: ['A', 'B', 'C', 'D'],
};

/** A calendar with no named day-parts at all — `segments` is allowed to be empty. */
export const timelessCalendar: Calendar = {
  id: 'cal-timeless',
  name: 'Timeless',
  minutesPerHour: 60,
  hoursPerDay: 24,
  months: [{ name: 'Only', days: 365 }],
  segments: [],
};

/**
 * The "leap-ish extra-length month" case, in miniature: 45 minutes in an hour,
 * 10 hours in a day, and a last month that is nearly three times as long as the
 * first two. Year 1 has 200 days, so day 200 is the last day of the year.
 *
 * minutesPerDay = 450, daysPerYear = 200, minutesPerYear = 90000.
 */
export const leapishCalendar: Calendar = {
  id: 'cal-leapish',
  name: 'Leapish',
  minutesPerHour: 45,
  hoursPerDay: 10,
  months: [
    { name: 'Short', days: 25 },
    { name: 'Middle', days: 75 },
    { name: 'LongExtra', days: 100 },
  ],
  segments: [
    { id: 'first', name: 'First', fromHour: 0, toHour: 5 },
    { id: 'second', name: 'Second', fromHour: 5, toHour: 10 },
  ],
};

/** An agenda entry with every field the engine reads, so a row is self-contained. */
export function agendaEntry(overrides: Partial<AgendaEntry> & { id: string }): AgendaEntry {
  return {
    sessionId: 'session-1',
    title: `entry ${overrides.id}`,
    description: '',
    atMinute: 0,
    actors: [],
    secret: false,
    status: 'pending',
    source: 'user',
    ...overrides,
  };
}

/** A deadline, same idea. */
export function deadline(overrides: Partial<Deadline> & { id: string }): Deadline {
  return {
    label: `deadline ${overrides.id}`,
    dueMinute: 0,
    kind: 'countdown',
    status: 'active',
    ...overrides,
  };
}

/**
 * Freeze an object graph so a mutation shows up as a thrown `TypeError` instead
 * of a silently changed table row. Used to prove the engine does not mutate its
 * inputs.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const childField = key as keyof T;
      deepFreeze(value[childField]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A minute for a table row, named so the row reads as arithmetic. */
export function m(value: number): EpochMinute {
  return value;
}
