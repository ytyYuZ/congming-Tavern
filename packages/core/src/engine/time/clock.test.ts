/**
 * `advance` and `setTime` (M1-T1, docs/02 §5.7 副作用链 step 1).
 *
 * THE TWO DECISIONS THIS FILE PINS DOWN
 *
 * 1. Delta 0 is legal and crosses nothing. Refusing it would break the common
 *    "advance by stepMinutes" loop on a step of 0.
 * 2. A NEGATIVE delta is a real traversal, not an error and not a no-op. The
 *    clock walks backwards and reports the segments it left, in the order it
 *    left them — see `crossings.ts`. §5.7 requires checkpoint rollback
 *    ("读档即回滚时钟") to be expressible, so this is checked from both ends: the
 *    forward step 晨→昼 and the backward step 昼→晨 are mirror images.
 *
 * Every expected minute below is hand arithmetic over `test-kit.ts`:
 * fantasy minutesPerDay = 2600, plain minutesPerDay = 720.
 */
import { describe, expect, it } from 'vitest';
import { advance, setTime } from './clock';
import { deepFreeze, fantasyCalendar, gappyCalendar, plainCalendar } from './test-kit';

const ids = (steps: readonly { id: string }[]): string[] => steps.map((step) => step.id);

describe('advance — crossing several segments in one step', () => {
  const table: readonly [delta: number, fromMinute: number, expected: string][] = [
    // inside one segment: the clock spent that minute in 晨, so 晨 is reported.
    [50, 600, 'dawn'],
    // 晨 -> 昼, staying inside the same day.
    [300, 1000, 'dawn,day'],
    // 晨 -> 昼 -> 昏 in one step.
    [900, 1000, 'dawn,day,dusk'],
    // 昼 -> 昏 -> 夜, starting mid-day.
    [1200, 1500, 'day,dusk,night'],
    // NOT the final segment only: a step over a whole fantasy day samples every
    // hour, so it reports every segment the calendar names, in order, including the
    // wrap at midnight. The endpoints are both 夜, which is why one appears at each
    // end.
    [2600, 0, 'night,dawn,day,dusk,night'],
  ];

  it.each(table)('advancing %i minutes from %i reports %s', (delta, fromMinute, expected) => {
    const step = advance({ delta, calendar: fantasyCalendar, fromMinute });
    expect(ids(step.crossedSegments).join(',')).toBe(expected);
  });

  it('reports the position and the signed delta', () => {
    expect(advance({ delta: 900, calendar: fantasyCalendar, fromMinute: 1000 })).toEqual({
      fromMinute: 1000,
      toMinute: 1900,
      delta: 900,
      crossedSegments: [
        { id: 'dawn', name: 'Dawn' },
        { id: 'day', name: 'Day' },
        { id: 'dusk', name: 'Dusk' },
      ],
    });
  });

  it('crosses a day boundary into the wrapping night window', () => {
    // minute 2599 is the last of day 0 (hour 25), 2605 is hour 0 of day 1 — which
    // 夜 (25 -> 5) still covers, having wrapped.
    const step = advance({ delta: 6, calendar: fantasyCalendar, fromMinute: 2599 });
    expect(step.toMinute).toBe(2605);
    expect(ids(step.crossedSegments)).toEqual(['night']);
    expect(step.crossedSegments[0]?.name).toBe('Night');
  });

  it('reports a segment again when the walk genuinely re-enters it', () => {
    // 夜 wraps: day 0 hour 25 -> day 1 hours 0..4 are all 夜, and day 1 hour 25 is
    // 夜 again. A whole day plus a bit enters 夜, leaves it, and enters it again.
    const step = advance({ delta: 2600 + 200, calendar: fantasyCalendar, fromMinute: 0 });
    expect(ids(step.crossedSegments)).toEqual(['night', 'dawn', 'day', 'dusk', 'night']);
  });
});

describe('advance — month and year boundaries', () => {
  it('crosses the last day of a month into the next month', () => {
    const step = advance({ delta: 180, calendar: plainCalendar, fromMinute: 7199 });
    expect(step.toMinute).toBe(7379);
    // 7199 is the last minute of 夜 (hour 11) and 7379 is hour 2 of the next day,
    // which is 晨. The mark at 7200 is the first minute of that new day.
    expect(ids(step.crossedSegments)).toEqual(['night', 'dawn']);
  });

  it('crosses the last day of the last month into the next year', () => {
    const step = advance({ delta: 120, calendar: plainCalendar, fromMinute: 43199 });
    expect(step.toMinute).toBe(43319);
    // year 1 ends at 43199 (hour 11, 夜) and year 2 starts at 43200 (hour 0, 晨).
    expect(ids(step.crossedSegments)).toEqual(['night', 'dawn']);
  });

  it('crosses the year boundary when the walk itself crosses a segment', () => {
    // 43199 is hour 11 (夜); 43200 is the new year's first minute (hour 0, 晨) and
    // 43259 is still hour 0.
    const step = advance({ delta: 60, calendar: plainCalendar, fromMinute: 43199 });
    expect(step.toMinute).toBe(43259);
    expect(ids(step.crossedSegments)).toEqual(['night', 'dawn']);
  });

  it('crosses several days in one step, one cycle per day', () => {
    // 夜 -> 晨 at midnight is the only place two adjacent hours differ, so each
    // whole day collapses to one crossing per segment and the next day restarts
    // the cycle. Three days from day 1 hour 0 is therefore 3 cycles + the next 晨.
    const step = advance({ delta: 3 * 720, calendar: plainCalendar, fromMinute: 720 });
    expect(step.toMinute).toBe(4 * 720);
    expect(ids(step.crossedSegments)).toEqual([
      'dawn',
      'noon',
      'dusk',
      'night',
      'dawn',
      'noon',
      'dusk',
      'night',
      'dawn',
      'noon',
      'dusk',
      'night',
      'dawn',
    ]);
  });
});

describe('advance — zero and negative deltas', () => {
  it('does nothing at delta 0, and crosses nothing', () => {
    expect(advance({ delta: 0, calendar: fantasyCalendar, fromMinute: 1234 })).toEqual({
      fromMinute: 1234,
      toMinute: 1234,
      delta: 0,
      crossedSegments: [],
    });
  });

  it('walks backwards and reports the segments in the order the clock left them', () => {
    // The samples are both endpoints and every hour mark strictly between, read
    // descending: 2000 (hour 20, 昼), then the marks 1980..960 — which is where 昏,
    // 夜 and 晨 come from — and finally the destination 900 (晨 again).
    const step = advance({ delta: -1100, calendar: fantasyCalendar, fromMinute: 2000 });
    expect(step.toMinute).toBe(900);
    expect(ids(step.crossedSegments)).toEqual(['dusk', 'day', 'dawn']);
  });

  it('is the mirror image of the forward step that undoes it', () => {
    const forward = advance({ delta: 1100, calendar: fantasyCalendar, fromMinute: 900 });
    const backward = advance({ delta: -1100, calendar: fantasyCalendar, fromMinute: 2000 });
    expect(backward.toMinute).toBe(forward.fromMinute);
    // 900 -> 2000 samples 900 (晨), the marks 1000..1900, and 2000 (昼).
    expect(ids(forward.crossedSegments)).toEqual(['dawn', 'day', 'dusk']);

    const reversed = [...forward.crossedSegments].reverse().map((segment) => segment.id);
    expect(ids(backward.crossedSegments)).toEqual(reversed);
  });

  it('crosses a day boundary backwards', () => {
    // 2600 is day 1 hour 0 and 2590 is day 0 hour 25 — both are 夜 (25 -> 5) — but
    // the step is a whole day long, so it samples every hour in between as well.
    const step = advance({ delta: -2590, calendar: fantasyCalendar, fromMinute: 2600 });
    expect(step.toMinute).toBe(10);
    expect(ids(step.crossedSegments)).toEqual(['night', 'dusk', 'day', 'dawn', 'night']);
  });

  it('walks backwards over a month boundary', () => {
    // plain: 7200 is Beta 1 00:00 (hour 0, 晨) and 7100 is hour 9 (夜) of the
    // previous day. The only sample in between is the mark 7140, so the walk is 晨
    // then 夜 across the month boundary.
    const step = advance({ delta: -100, calendar: plainCalendar, fromMinute: 7200 });
    expect(step.toMinute).toBe(7100);
    expect(ids(step.crossedSegments)).toEqual(['dawn', 'night']);
  });

  it('produces a negative minute, which the calendar still maps', () => {
    const step = advance({ delta: -5, calendar: fantasyCalendar, fromMinute: 3 });
    expect(step.toMinute).toBe(-2);
    expect(ids(step.crossedSegments)).toEqual(['night']);
  });

  it('reports nothing but the position when the step stays inside one segment', () => {
    const step = advance({ delta: -1, calendar: gappyCalendar, fromMinute: 100 });
    expect(step.crossedSegments).toEqual([{ id: 'early', name: 'Early' }]);
  });
});

/**
 * Steps that land exactly on a segment boundary.
 *
 * THE SAMPLING RULE THESE ROWS PIN. A step samples the hour marks of its span
 * plus its destination instant, so a step whose start minute is not itself an
 * hour mark still samples the hour it starts in (through that hour's mark) — but
 * a step that STARTS on a mark and stops inside 昼 does not sample the hour it
 * left. The mirror property holds for every row here because both directions read
 * the same sample list; only the direction of the reported list differs.
 */
describe('advance — steps that land exactly on a segment boundary', () => {
  // 晨 is [0, 60) and 昼 is [60, 120) in this calendar, so minute 59 is the last
  // minute of 晨 and minute 60 the first of 昼. This is the case where "which
  // minutes does a step sample?" decides the answer, and it is where the two
  // directions must be exact mirror images.
  const boundary = {
    ...plainCalendar,
    hoursPerDay: 2,
    months: [{ name: 'Only', days: 10 }],
    segments: [
      { id: 'dawn', name: 'Dawn', fromHour: 0, toHour: 1 },
      { id: 'day', name: 'Day', fromHour: 1, toHour: 2 },
    ],
  };

  const table: readonly [delta: number, fromMinute: number, expected: string][] = [
    // Across the boundary. The samples are BOTH endpoints (59 is 晨, 60 is 昼) and
    // the marks strictly between (none), so both segments are reported.
    [1, 59, 'dawn,day'],
    // The reverse step samples the same two minutes and reports them the other way
    // round — the mirror property, on the row where it does real work.
    [-1, 60, 'day,dawn'],
    // Starting and ending on the boundary's far side: 60 and 65 are both 昼.
    [5, 60, 'day'],
    // Down one minute from 65: samples 65 and 64, both 昼.
    [-1, 65, 'day'],
    // Six minutes down from 65: samples 65 (昼), the mark 60 (昼) and 59 (晨).
    [-6, 65, 'day,dawn'],
    // An unmarked start minute is sampled directly rather than through its hour:
    // 55 is 晨, the mark 60 and the destination 65 are 昼.
    [10, 55, 'dawn,day'],
    // A whole two-hour day forward, minute 0 of day 0 to minute 0 of day 1: the
    // samples are 0 (晨), the mark 60 (昼) and 120, which is 晨 again — the
    // calendar has only two hours, so there is no 夜 in this one.
    [120, 0, 'dawn,day,dawn'],
  ];

  it.each(table)('advancing %i minutes from %i reports %s', (delta, fromMinute, expected) => {
    const step = advance({ delta, calendar: boundary, fromMinute });
    expect(ids(step.crossedSegments).join(',')).toBe(expected);
  });

  it('is an exact mirror image for every row of the table', () => {
    // Both directions read ONE sample list, so the backward list is always the
    // forward list reversed — at a boundary, inside a segment, and for an
    // unmarked start minute alike.
    for (const [delta, fromMinute] of table) {
      const span = Math.abs(delta);
      const toMinute = fromMinute + span;
      const forward = advance({ delta: span, calendar: boundary, fromMinute });
      const backward = advance({ delta: -span, calendar: boundary, fromMinute: toMinute });
      expect({ delta, fromMinute, ids: ids(backward.crossedSegments) }).toEqual({
        delta,
        fromMinute,
        ids: [...ids(forward.crossedSegments)].reverse(),
      });
    }
  });

  it('samples an unmarked start minute directly, not through its hour', () => {
    // A whole hour down from 119. The samples are the endpoints 119 (昼) and 59
    // (晨) plus the marks strictly between, which is none — so 晨 is reported even
    // though the walk never lands on its opening minute.
    expect(
      ids(advance({ delta: -60, calendar: boundary, fromMinute: 119 }).crossedSegments),
    ).toEqual(['day', 'dawn']);
  });

  it('crosses nothing for a zero-length step, even on a boundary', () => {
    expect(advance({ delta: 0, calendar: boundary, fromMinute: 60 }).crossedSegments).toEqual([]);
  });
});

describe('advance — pure and validating', () => {
  it('does not mutate the calendar it is given', () => {
    const frozen = deepFreeze(structuredClone(fantasyCalendar));
    expect(() => advance({ delta: 5000, calendar: frozen, fromMinute: 0 })).not.toThrow();
    expect(frozen.segments).toHaveLength(4);
  });

  it('rejects a fractional delta instead of pretending minutes are continuous', () => {
    expect(() => advance({ delta: 1.5, calendar: fantasyCalendar, fromMinute: 0 })).toThrow(
      /whole number/,
    );
  });

  it('rejects a non-finite delta', () => {
    expect(() => advance({ delta: Number.NaN, calendar: fantasyCalendar, fromMinute: 0 })).toThrow(
      /whole number/,
    );
  });

  it('rejects a non-finite starting minute', () => {
    expect(() => advance({ delta: 1, calendar: fantasyCalendar, fromMinute: Number.NaN })).toThrow(
      /finite/,
    );
  });
});

describe('setTime', () => {
  it('returns a new clock state and accepts any whole minute, including backwards', () => {
    expect(setTime(0)).toEqual({ clock: 0 });
    expect(setTime(-720)).toEqual({ clock: -720 });
  });

  it('does not share state between two results', () => {
    const first = setTime(10);
    const second = setTime(20);
    expect(first).not.toBe(second);
    expect(first.clock).toBe(10);
  });

  it('rejects a fractional minute', () => {
    expect(() => setTime(0.5)).toThrow(/whole number/);
  });
});
