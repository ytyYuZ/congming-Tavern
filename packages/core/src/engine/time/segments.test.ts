/**
 * Segment boundaries: `segmentOf` and `segmentsAt` (M1-T1, docs/02 §5.2).
 *
 * WHY A BOUNDARY TABLE AND NOT A SAMPLE. `fromHour` is inclusive and `toHour` is
 * exclusive, so every window has exactly two minutes that decide whether the
 * lookup is right: the first minute it holds and the last one it holds. A table
 * of those two rows per segment catches an off-by-one that a mid-segment sample
 * never would, and the wrap-around window 夜 (25 -> 5) makes the exclusive end
 * observable after midnight.
 *
 * All expectations are hand arithmetic over `test-kit.ts`:
 * fantasy minutesPerHour = 100, hoursPerDay = 26.
 */

import type { Calendar } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { calendarView } from './calendar';
import { resolvedSegmentsOf, resolveSegments, segmentOf, segmentsAt } from './segments';
import { fantasyCalendar, gappyCalendar, plainCalendar, timelessCalendar } from './test-kit';
import { type ResolvedDaySegment, TimeEngineError } from './types';

function locate(calendar: Calendar): readonly ResolvedDaySegment[] {
  return resolvedSegmentsOf(calendar, calendarView(calendar).hoursPerDay);
}

describe('segmentOf — first and last minute of every named segment', () => {
  const view = calendarView(fantasyCalendar);
  const segments = locate(fantasyCalendar);

  const table: readonly [segment: string, firstMinute: number, lastMinute: number][] = [
    // 晨 5 -> 12: hour 5 begins at 500, hour 11 ends at 1199.
    ['dawn', 5 * 100, 12 * 100 - 1],
    // 昼 12 -> 18
    ['day', 12 * 100, 18 * 100 - 1],
    // 昏 18 -> 22
    ['dusk', 18 * 100, 22 * 100 - 1],
    // 夜 25 -> 5 wraps midnight: it opens on the last hour of the day and keeps
    // holding through hour 4 of the next one.
    ['night', 25 * 100, 5 * 100 - 1],
  ];

  it.each(table)('%s holds its first minute', (id, firstMinute) => {
    expect(segmentOf(view, segments, firstMinute)?.id).toBe(id);
  });

  it.each(table)('%s holds its last minute', (id, _firstMinute, lastMinute) => {
    expect(segmentOf(view, segments, lastMinute)?.id).toBe(id);
  });

  it.each(table)(
    '%s does not hold the minute after its last one',
    (id, _firstMinute, lastMinute) => {
      expect(segmentOf(view, segments, lastMinute + 1)?.id).not.toBe(id);
    },
  );

  it.each(table)('%s reports its name as well as its id', (id, firstMinute) => {
    const ref = segmentOf(view, segments, firstMinute);
    expect(ref?.id).toBe(id);
    expect(ref?.name).not.toBe('');
  });
});

describe('segmentOf — minutes in no segment', () => {
  const view = calendarView(gappyCalendar);
  const segments = locate(gappyCalendar);

  it('returns undefined where the calendar names nothing (hours 2..7 of 10)', () => {
    expect(segmentOf(view, segments, 4 * 60)).toBeUndefined();
    expect(segmentOf(view, segments, 6 * 60 + 59)).toBeUndefined();
  });

  it('still finds the segments on either side of the gap', () => {
    expect(segmentOf(view, segments, 2 * 60 - 1)?.id).toBe('early');
    expect(segmentOf(view, segments, 7 * 60)?.id).toBe('late');
  });

  it('returns undefined for every minute when the calendar declares no segments', () => {
    const timeless = calendarView(timelessCalendar);
    expect(segmentOf(timeless, [], 0)).toBeUndefined();
    expect(segmentOf(timeless, [], 23 * 60 + 59)).toBeUndefined();
  });

  it('does not carry a segment across a day boundary for a non-wrapping window', () => {
    const plain = calendarView(plainCalendar);
    const plainSegments = locate(plainCalendar);
    // dawn 0 -> 3 ends at minute 179; minute 180 is noon, and the next day restarts.
    expect(segmentOf(plain, plainSegments, 179)?.id).toBe('dawn');
    expect(segmentOf(plain, plainSegments, 180)?.id).toBe('noon');
    expect(segmentOf(plain, plainSegments, 720)?.id).toBe('dawn');
  });
});

describe('segmentOf — the overnight window folds its end back into the day', () => {
  const view = calendarView(fantasyCalendar);
  const segments = locate(fantasyCalendar);

  const table: readonly [hour: number, expected: string | undefined][] = [
    // 夜 is declared 25 -> 5 on a 26-hour day: it covers hour 25 and hours 0..4,
    // and nothing else. The row at hour 12 is the one an unfolded comparison fails.
    [0, 'night'],
    [4, 'night'],
    [5, 'dawn'],
    [11, 'dawn'],
    [12, 'day'],
    [17, 'day'],
    [18, 'dusk'],
    [21, 'dusk'],
    [22, undefined],
    [24, undefined],
    [25, 'night'],
  ];

  it.each(table)('hour %i belongs to %s', (hour, expected) => {
    expect(segmentOf(view, segments, hour * 100)?.id).toBe(expected);
  });
});

describe('segmentsAt — overlapping windows are all reported', () => {
  const view = calendarView(fantasyCalendar);

  it('returns every segment holding the minute, in declaration order', () => {
    // An editor overlaid a whole-day "festival" window on the fantasy calendar.
    const festival: ResolvedDaySegment = {
      id: 'festival',
      name: 'Festival',
      fromHour: 0,
      toHour: 26,
      hours: 26,
      hoursPerDay: 26,
      tag: 'whole-day',
    };
    const segments = [...locate(fantasyCalendar), festival];
    expect(segmentsAt(view, segments, 12 * 100)).toEqual([
      { id: 'day', name: 'Day' },
      { id: 'festival', name: 'Festival' },
    ]);
  });

  it('reports an overlap between a wrapping window and a normal one', () => {
    // 夜 covers hour 0, and so does a second "small hours" window: both match.
    const smallHours: ResolvedDaySegment = {
      id: 'small-hours',
      name: 'Small hours',
      fromHour: 0,
      toHour: 3,
      hours: 3,
      hoursPerDay: 26,
      tag: 'within-day',
    };
    const segments = [...locate(fantasyCalendar), smallHours];
    expect(segmentsAt(view, segments, 0)).toEqual([
      { id: 'night', name: 'Night' },
      { id: 'small-hours', name: 'Small hours' },
    ]);
    // and it does not match where 夜 does not either.
    expect(segmentsAt(view, segments, 12 * 100)).toEqual([{ id: 'day', name: 'Day' }]);
  });

  it('is empty for an uncovered minute, matching segmentOf', () => {
    const gappyView = calendarView(gappyCalendar);
    const segments = locate(gappyCalendar);
    expect(segmentsAt(gappyView, segments, 4 * 60)).toEqual([]);
    expect(segmentOf(gappyView, segments, 4 * 60)).toBeUndefined();
  });
});

describe('segmentOf — the worldbook condition shape', () => {
  it('returns the id a timeOfDay condition compares against', () => {
    const view = calendarView(fantasyCalendar);
    const segments = locate(fantasyCalendar);
    expect(segmentOf(view, segments, 0)).toEqual({ id: 'night', name: 'Night' });
  });
});

describe('resolveSegments — one window, two spellings', () => {
  /**
   * The long form is documented in this module's header AND in `types.ts` ("may exceed
   * `hoursPerDay` for an overnight window"), and `resolveSegments` normalises the short
   * form INTO it — but the hour assertion here used to bound `toHour` at `hoursPerDay`, so
   * the documented long form was refused before it could be normalised. No test wrote it
   * that way, which is exactly why a green suite could not see it: the short spelling folds
   * before the bound is reached, so only the long one hit it.
   *
   * AND THE FIRST REPAIR WAS INCOMPLETE, which is why the case below exists: this module is
   * not the only validator. `calendar.ts`'s `assertSegmentHours` bounded `toHour` the same
   * way, and `calendarView` — what `display()` and `advance()` call — is the one every real
   * consumer goes through. Fixing one of two copies of a rule is invisible to a test that
   * calls the other, so both spellings are now asserted through BOTH layers.
   */
  it('accepts a wrapped night written short (22 -> 6) and long (22 -> 30) as one window', () => {
    const shortForm = resolveSegments([{ id: 'night', name: '夜', fromHour: 22, toHour: 6 }], 24);
    const longForm = resolveSegments([{ id: 'night', name: '夜', fromHour: 22, toHour: 30 }], 24);
    expect(longForm).toEqual(shortForm);
    expect(shortForm[0]).toMatchObject({ fromHour: 22, toHour: 30, hours: 8, tag: 'overnight' });
  });

  it('still refuses a window that would wrap more than once', () => {
    expect(() =>
      resolveSegments([{ id: 'night', name: '夜', fromHour: 22, toHour: 50 }], 24),
    ).toThrow(TimeEngineError);
  });

  it('accepts the long spelling through calendarView, the call every consumer makes', () => {
    const shortSpelled: Calendar = {
      ...fantasyCalendar,
      segments: [{ id: 'night', name: '夜', fromHour: 22, toHour: 4 }],
    };
    const longSpelled: Calendar = {
      ...fantasyCalendar,
      segments: [{ id: 'night', name: '夜', fromHour: 22, toHour: 30 }],
    };
    expect(() => calendarView(longSpelled)).not.toThrow();
    // The fantasy day is 26 hours, so 22 -> 4 wraps to 22 -> 30; both spellings must resolve
    // to one window through the entry point a real caller uses (`display`, `advance`).
    const longView = calendarView(longSpelled);
    const shortView = calendarView(shortSpelled);
    expect(resolvedSegmentsOf(longSpelled, longView.hoursPerDay)).toEqual(
      resolvedSegmentsOf(shortSpelled, shortView.hoursPerDay),
    );
    expect(resolvedSegmentsOf(longSpelled, longView.hoursPerDay)[0]).toMatchObject({
      fromHour: 22,
      toHour: 30,
      hours: 8,
      tag: 'overnight',
    });
  });
});
