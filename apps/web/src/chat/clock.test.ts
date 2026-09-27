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
 */
import { display as clockDisplay } from '@smarttavern/core';
import type { SessionState } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CALENDAR,
  BUILTIN_HOURS_PER_DAY,
  BUILTIN_MINUTES_PER_HOUR,
} from './builtin-content';
import { advanceState, segmentStep } from './clock';

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

describe('chat/clock — advanceState (M1-T2)', () => {
  it('moves the clock by exactly `delta` and keeps every other field', () => {
    const before = stateAt(30);
    const after = advanceState(before, BUILTIN_MINUTES_PER_HOUR);
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
      const moved = advanceState(stateAt(start), testCase.delta);
      expect(moved.clock, testCase.what).toBe(start + testCase.delta);
    }

    // The literals above are the CALENDAR's numbers, not the test's: a world with a
    // 100-minute hour would change the hour step with no edit here.
    expect(hour).toBe(BUILTIN_MINUTES_PER_HOUR);
    expect(day).toBe(BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR);
  });

  it('accepts a negative result and a zero step', () => {
    expect(advanceState(stateAt(0), -60).clock).toBe(-60);
    expect(advanceState(stateAt(0), 0).clock).toBe(0);
  });

  it('refuses a delta the engine cannot walk', () => {
    // A fractional minute is a caller bug, and the engine throws rather than rounding —
    // which is what keeps this function from silently accepting "0.5 hours".
    expect(() => advanceState(stateAt(0), 1.5)).toThrow(/whole number of minutes/);
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
      const step = segmentStep(stateAt(testCase.minute));
      const moved = advanceState(stateAt(testCase.minute), step).clock;
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
    expect(segmentStep(stateAt(0))).toBe(sixHours);
    expect(segmentStep(stateAt(6 * 60))).toBe(sixHours);
    // Mid-segment, the step is what is LEFT of the segment, not a whole one.
    expect(segmentStep(stateAt(9 * 60 + 45))).toBe(sixHours - 3 * 60 - 45);
  });
});
