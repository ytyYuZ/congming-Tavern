/**
 * The clock's app-side operations (M1-T2): `advanceState` and `segmentStep`.
 *
 * WHY THIS FILE HAS NO DOM AND NO DATABASE
 * Both functions are pure, and both are places where the app could accidentally re-derive
 * calendar arithmetic the engine already owns ("+1 hour is 60 minutes", "+1 day is 1440").
 * So the expectations here come from the ENGINE — `clockDisplay`, `hourOfDayAt` — rather
 * than from numbers typed into the test: a hand-computed `06:00` would keep passing if
 * `advance` and this module drifted together, which is exactly the bug the wiring is
 * supposed to make impossible. What is asserted literally is only the part a human can
 * check by reading the calendar: which segment a minute falls in.
 *
 * WHY THE MUTATION CASES COME FIRST
 * `advanceState` returns a NEW state (`engine/time/types.ts` records why: "time went back
 * but the state did not" must be inexpressible). A version that edited its argument would
 * pass every value assertion below and still corrupt the caller's checkpoint snapshot —
 * which is the aliasing bug `repository.test.ts` catches one layer down.
 *
 * WHY THE CALENDAR IS PASSED IN, AND WHY THERE IS A SECOND CALENDAR HERE (M1-T1 follow-up)
 * Every function in `chat/clock.ts` takes the session's `Calendar`, so the tests name the
 * calendar they mean instead of relying on a module-internal constant. Most cases use the
 * built-in one (`BUILTIN_CALENDAR`), because that is what a session whose world row is gone
 * resolves to and because its geometry is readable beside `builtin-content.ts`. The
 * `sessionCalendar` block then uses a 26-hour, 100-minute world with its own month names: a
 * calendar the built-in arithmetic CANNOT produce, so those assertions fail if the calendar
 * parameter is ignored and the built-in constant is read instead.
 */
import { display as clockDisplay } from '@smarttavern/core';
import type { Calendar, Session, SessionState } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CALENDAR,
  BUILTIN_HOURS_PER_DAY,
  BUILTIN_MINUTES_PER_HOUR,
} from './builtin-content';
import { advanceState, calendarOf, clockOf, segmentStep } from './clock';

/** A session state whose clock is `minute` and whose other fields are recognisable. */
function stateAt(minute: number): SessionState {
  return {
    scene: { title: 'The inn', location: 'Silverpine', time: minute },
    clock: minute,
    vars: { weather: 'snow' },
    sheets: { 'actor-a': { hp: 3 } },
    deadlines: [],
  };
}

/** A session whose state is `stateAt(minute)` and whose pins name a world that need not exist. */
function sessionAt(minute: number): Session {
  return {
    id: 'session-1',
    title: 'A test session',
    refs: {
      world: { id: 'test-world', version: 1 },
      playerCharacter: { id: 'test-player', version: 1 },
      cast: [],
      promptPreset: { id: 'builtin-default', version: 1 },
      modelConfig: { provider: 'test', model: 'test', params: { temperature: 1, topP: 1 } },
    },
    initialClock: 0,
    state: stateAt(minute),
    schedulerMode: 'user',
    headMessageId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('chat/clock — advanceState (M1-T2)', () => {
  it('moves the clock by exactly `delta` and keeps every other field', () => {
    const before = stateAt(30);
    const after = advanceState(BUILTIN_CALENDAR, before, BUILTIN_MINUTES_PER_HOUR);
    expect(after.clock).toBe(90);
    expect(after).not.toBe(before);
    expect(before.clock).toBe(30);
    // The rest of the state is carried, not rebuilt: the rollback story depends on the
    // vars and the scene being the same values they were.
    expect(after.vars).toEqual({ weather: 'snow' });
    expect(after.scene).toEqual({ title: 'The inn', location: 'Silverpine', time: 30 });
    expect(after.sheets).toEqual({ 'actor-a': { hp: 3 } });
  });

  /*
   * THE THREE BUTTONS, as a table. `delta` is what the play screen passes, and the
   * expectation is written as "minutes past the same starting minute" — which is checked
   * against the engine's own `toMinute` in the assertion beside it, so a change to
   * `advance` cannot make this table silently wrong.
   */
  it('moves by the day arithmetic the CALENDAR declares, not by literals', () => {
    const start = 1_000;
    const hour = BUILTIN_MINUTES_PER_HOUR;
    const day = BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR;
    const cases: readonly { readonly what: string; readonly delta: number }[] = [
      { what: '+1 小时', delta: hour },
      { what: '+1 天', delta: day },
      { what: 'custom +90', delta: 90 },
      // A step back is a request, not an error: `setTime`/rollback both need the
      // direction, and `advance` defines what "crossed" means going backwards.
      { what: 'custom -30', delta: -30 },
    ];

    for (const testCase of cases) {
      const moved = advanceState(BUILTIN_CALENDAR, stateAt(start), testCase.delta);
      expect(moved.clock, testCase.what).toBe(start + testCase.delta);
    }

    // The literals above are the CALENDAR's numbers, not the test's: a world with a
    // 100-minute hour would change the hour step with no edit here.
    expect(hour).toBe(BUILTIN_MINUTES_PER_HOUR);
    expect(day).toBe(BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR);
  });

  it('accepts a negative result and a zero step', () => {
    expect(advanceState(BUILTIN_CALENDAR, stateAt(0), -60).clock).toBe(-60);
    expect(advanceState(BUILTIN_CALENDAR, stateAt(0), 0).clock).toBe(0);
  });

  it('refuses a delta the engine cannot walk', () => {
    // A fractional minute is a caller bug, and the engine throws rather than rounding —
    // which is what keeps this function from silently accepting "0.5 hours".
    expect(() => advanceState(BUILTIN_CALENDAR, stateAt(0), 1.5)).toThrow(
      /whole number of minutes/,
    );
  });
});

describe('chat/clock — segmentStep (M1-T2)', () => {
  /**
   * The built-in calendar's four segments tile the day with no gap (06:00 / 12:00 /
   * 18:00 / 00:00), so the expectation is written as the SEGMENT the clock lands in —
   * a fact a reader can check against `builtin-content.ts` — rather than as "360".
   */
  /**
   * The engine's own display, under a local name: the bare `display` identifier would
   * collide with the DOM's global accessor in a jsdom test environment, which is the
   * reason `chat/clock.ts` imports it under a local name too (the import at the top of
   * this file does the same).
   */
  function segmentNameAt(minute: number): string | undefined {
    return clockDisplay(BUILTIN_CALENDAR, minute).segments[0]?.name;
  }

  it('moves to the START of the next segment for every hour of the day', () => {
    const cases: readonly { readonly minute: number; readonly landsIn: string }[] = [
      { minute: 0, landsIn: '昼' },
      { minute: 5 * 60 + 30, landsIn: '昼' },
      { minute: 6 * 60, landsIn: '昏' },
      { minute: 11 * 60 + 59, landsIn: '昏' },
      { minute: 12 * 60, landsIn: '夜' },
      { minute: 17 * 60 + 5, landsIn: '夜' },
      { minute: 18 * 60, landsIn: '晨' },
      { minute: 23 * 60 + 30, landsIn: '晨' },
    ];

    for (const testCase of cases) {
      const step = segmentStep(BUILTIN_CALENDAR, stateAt(testCase.minute));
      const moved = advanceState(BUILTIN_CALENDAR, stateAt(testCase.minute), step).clock;
      expect(segmentNameAt(moved), `${testCase.minute} -> ${moved}`).toBe(testCase.landsIn);
      // A step is always forward and never past the end of the day, so a segment step can
      // never silently skip a whole day's worth of boundaries.
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR);
      // And it lands ON a boundary: the minutes are zero past the hour start.
      expect(moved % BUILTIN_MINUTES_PER_HOUR).toBe(0);
    }
  });

  it('is the same number the engine would walk, for the built-in six-hour windows', () => {
    // The built-in calendar is uniform, so the step from the start of a segment is one
    // segment wide — the one place the test may state a number, because it is the
    // calendar's own geometry rather than arithmetic this module re-derived.
    const sixHours = 6 * BUILTIN_MINUTES_PER_HOUR;
    expect(segmentStep(BUILTIN_CALENDAR, stateAt(0))).toBe(sixHours);
    expect(segmentStep(BUILTIN_CALENDAR, stateAt(6 * 60))).toBe(sixHours);
    // Mid-segment, the step is what is LEFT of the segment, not a whole one.
    expect(segmentStep(BUILTIN_CALENDAR, stateAt(9 * 60 + 45))).toBe(sixHours - 3 * 60 - 45);
  });
});

/* ───────────── M1-T1 follow-up: the SESSION's calendar, not the built-in ───────────── */

/**
 * The world this block plays in: two 20-day months, a 26-hour day, a 100-minute hour and two
 * 13-hour watches. `CalendarSchema` allows both numbers and `cards/world.ts` says so in as
 * many words, which is why nothing here is "fixed" to 24/60. Every value is deliberately one
 * the built-in calendar CANNOT produce, so an assertion below fails if `chat/clock.ts` reads
 * the built-in face instead of the calendar it was handed.
 */
const TWO_MOON: Calendar = {
  id: 'two-moon',
  name: 'Two-moon reckoning',
  minutesPerHour: 100,
  hoursPerDay: 26,
  months: [
    { name: 'Frostmoon', days: 20 },
    { name: 'Embermoon', days: 20 },
  ],
  epochLabel: 'Third Age',
  segments: [
    { id: 'first-watch', name: 'First Watch', fromHour: 0, toHour: 13 },
    { id: 'second-watch', name: 'Second Watch', fromHour: 13, toHour: 26 },
  ],
};

/** A calendar that names no day parts: `segmentStep` has no boundary to aim at there. */
const SEGMENTLESS: Calendar = { ...TWO_MOON, id: 'segmentless', segments: [] };

/**
 * A pinned version row, as far as `calendarOf` is concerned. Only `data.calendar` is read, so
 * the fixture states its subject without building a whole version envelope — a real
 * `WorldVersion` satisfies the same shape.
 */
const TWO_MOON_VERSION = { data: { calendar: TWO_MOON } };

describe('chat/clock — the pinned world calendar (M1-T1 follow-up)', () => {
  it("reads the clock in the PINNED world's units, not the built-in ones", () => {
    const calendar = calendarOf(TWO_MOON_VERSION);
    // Hour 5, minute 42 of the two-moon day. The very same epoch minute is hour 9, minute 2 in
    // the built-in face (542 = 9 x 60 + 2), so a reading cannot be right by accident.
    const minute = 5 * 100 + 42;
    const reading = clockOf(calendar, sessionAt(minute));

    expect(reading.hour).toBe(5);
    expect(reading.minuteOfHour).toBe(42);
    expect(reading.minutesPerHour).toBe(100);
    expect(reading.hoursPerDay).toBe(26);
    expect(reading.epochLabel).toBe('Third Age');
    expect(reading.year).toBe(1);
    expect(reading.monthName).toBe('Frostmoon');
    expect(reading.day).toBe(1);
    expect(reading.segments.map((segment) => segment.name)).toEqual(['First Watch']);

    // The built-in face for the SAME epoch minute is a different clock — the wrong-calendar bug
    // this parameter exists to make impossible.
    const builtin = clockOf(BUILTIN_CALENDAR, sessionAt(minute));
    expect(builtin.hour).not.toBe(reading.hour);
    expect(builtin.minutesPerHour).toBe(BUILTIN_MINUTES_PER_HOUR);

    // A later minute shows the second month and the second watch, so the whole face is the
    // pinned world's — not just the hour arithmetic.
    const later = clockOf(calendar, sessionAt(20 * 26 * 100 + 14 * 100));
    expect(later.monthName).toBe('Embermoon');
    expect(later.day).toBe(1);
    expect(later.hour).toBe(14);
    expect(later.segments.map((segment) => segment.name)).toEqual(['Second Watch']);
  });

  it("walks the day in the pinned calendar's units (advanceState, segmentStep)", () => {
    const calendar = calendarOf(TWO_MOON_VERSION);

    // "+1 hour" is 100 minutes here and 60 in the built-in face: the two numbers differ, so
    // this is exactly the assertion the built-in read would have failed.
    expect(advanceState(calendar, stateAt(0), calendar.minutesPerHour).clock).toBe(100);
    expect(advanceState(BUILTIN_CALENDAR, stateAt(0), BUILTIN_MINUTES_PER_HOUR).clock).toBe(60);
    // "+1 day" is 26 x 100, not 24 x 60.
    expect(
      advanceState(calendar, stateAt(0), calendar.hoursPerDay * calendar.minutesPerHour).clock,
    ).toBe(2600);

    // The segment step lands ON the watch boundary at hour 13, measured in 100-minute hours.
    expect(segmentStep(calendar, stateAt(0))).toBe(13 * calendar.minutesPerHour);
    expect(segmentStep(calendar, stateAt(13 * 100))).toBe(13 * calendar.minutesPerHour);
    // Mid-hour, the step backs out the minutes already past the hour — in this unit, so the
    // built-in 60 would answer a different number.
    expect(segmentStep(calendar, stateAt(5 * 100 + 42))).toBe(8 * 100 - 42);
    expect(segmentStep(calendar, stateAt(5 * 100 + 42))).not.toBe(
      segmentStep(BUILTIN_CALENDAR, stateAt(5 * 100 + 42)),
    );

    // A calendar with no day parts has no boundary to aim at, so the step is one of ITS hours.
    expect(segmentStep(SEGMENTLESS, stateAt(0))).toBe(100);
    expect(segmentStep(SEGMENTLESS, stateAt(0))).not.toBe(BUILTIN_MINUTES_PER_HOUR);
  });

  it('falls back to the built-in calendar when there is no version row to read', () => {
    // The readable case first: the pinned calendar is the one that comes back, by identity.
    expect(calendarOf(TWO_MOON_VERSION)).toBe(TWO_MOON);
    // `undefined` is what `state/chat-store.ts` hands over when the pin resolves to nothing: a
    // deleted world, a version nobody published, or a row that fails to parse.
    expect(calendarOf(undefined)).toBe(BUILTIN_CALENDAR);
    // The fallback is a usable calendar, not a sentinel: the clock still reads in its units.
    const reading = clockOf(calendarOf(undefined), sessionAt(0));
    expect(reading.minutesPerHour).toBe(BUILTIN_MINUTES_PER_HOUR);
    expect(reading.hoursPerDay).toBe(BUILTIN_HOURS_PER_DAY);
  });
});
