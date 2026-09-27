/**
 * Table-driven proof that `EpochMinute` -> parts is correct (M1-T1's acceptance
 * criterion: "历法映射正确（含跨月、跨年）；有表驱动测试").
 *
 * HOW TO READ A ROW. Each row is `[minute, expected fields]` and every expected
 * value was computed by hand from the calendar in `test-kit.ts`: the minute is
 * divided by `minutesPerHour * hoursPerDay` for the day index, the day index is
 * walked over the month lengths for the year and month, and the remainder is
 * split by `minutesPerHour`. No row's expectation is produced by the function
 * under test.
 *
 * The tables are grouped by the property they demonstrate (ordinary day, month
 * roll, year roll, non-24/60 units, extra-length month, minute 0, far future) so
 * a reviewer can check one group at a time.
 */

import type { Calendar } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { calendarView, toEpochMinute } from './calendar';
import { display, renderParts } from './clock';
import {
  fantasyCalendar,
  gappyCalendar,
  leapishCalendar,
  plainCalendar,
  timelessCalendar,
} from './test-kit';
import type { ClockDisplay } from './types';

/** The subset of `ClockDisplay` a date row asserts; the rest is checked elsewhere. */
type DateRow = [
  minute: number,
  expected: Pick<
    ClockDisplay,
    'year' | 'monthIndex' | 'monthName' | 'day' | 'dayOfYear' | 'hour' | 'minuteOfHour'
  >,
];

describe('display — plain calendar (12-hour days, 60-minute hours, 10/20/30-day months)', () => {
  const table: readonly DateRow[] = [
    // minute 0 — the epoch itself.
    [
      0,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Alpha',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // last minute of the first day: 720 minutes per day, so hour 11, minute 59.
    [
      719,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Alpha',
        day: 1,
        dayOfYear: 1,
        hour: 11,
        minuteOfHour: 59,
      },
    ],
    // the first minute of the second day.
    [
      720,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Alpha',
        day: 2,
        dayOfYear: 2,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // last minute of the last day of month 1 (Alpha has 10 days) -> next day rolls into Beta.
    [
      7199,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Alpha',
        day: 10,
        dayOfYear: 10,
        hour: 11,
        minuteOfHour: 59,
      },
    ],
    [
      7200,
      {
        year: 1,
        monthIndex: 1,
        monthName: 'Beta',
        day: 1,
        dayOfYear: 11,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // last minute of the last day of month 2 -> next day rolls into Gamma.
    [
      21599,
      {
        year: 1,
        monthIndex: 1,
        monthName: 'Beta',
        day: 20,
        dayOfYear: 30,
        hour: 11,
        minuteOfHour: 59,
      },
    ],
    [
      21600,
      {
        year: 1,
        monthIndex: 2,
        monthName: 'Gamma',
        day: 1,
        dayOfYear: 31,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // last minute of the LAST month -> next day rolls into the next YEAR.
    [
      43199,
      {
        year: 1,
        monthIndex: 2,
        monthName: 'Gamma',
        day: 30,
        dayOfYear: 60,
        hour: 11,
        minuteOfHour: 59,
      },
    ],
    [
      43200,
      {
        year: 2,
        monthIndex: 0,
        monthName: 'Alpha',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // a third year in, on a mid-month day: 2 years + 25 days + 5 hours + 7 minutes.
    [
      2 * 43200 + 25 * 720 + 5 * 60 + 7,
      {
        year: 3,
        monthIndex: 1,
        monthName: 'Beta',
        day: 16,
        dayOfYear: 26,
        hour: 5,
        minuteOfHour: 7,
      },
    ],
  ];

  it.each(table)('minute %i maps to the expected date', (minute, expected) => {
    expect(display(plainCalendar, minute)).toMatchObject(expected);
  });

  it('reports the raw units so a caller never has to re-read the calendar', () => {
    expect(display(plainCalendar, 0)).toMatchObject({
      minute: 0,
      epochLabel: 'Era',
      minutesPerHour: 60,
      hoursPerDay: 12,
    });
  });
});

describe('display — fantasy calendar (26-hour days, 100-minute hours)', () => {
  const table: readonly DateRow[] = [
    // minutesPerDay = 2600: day 0 is Frost 1.
    [
      0,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Frost',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // 10900 = 4 * 2600 + 500 -> day index 4, hour 5, minute 0.
    [
      10900,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Frost',
        day: 5,
        dayOfYear: 5,
        hour: 5,
        minuteOfHour: 0,
      },
    ],
    // 2599 is the last minute of the day: hour 25 of 26, minute 99 of 100.
    [
      2599,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Frost',
        day: 1,
        dayOfYear: 1,
        hour: 25,
        minuteOfHour: 99,
      },
    ],
    // 2600 opens the second day. A 24/60 or 24-hour assumption lands elsewhere entirely.
    [
      2600,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Frost',
        day: 2,
        dayOfYear: 2,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // Frost has 30 days: day index 29 is its last, day index 30 opens Ember, the 28-day month.
    [
      29 * 2600,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Frost',
        day: 30,
        dayOfYear: 30,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    [
      30 * 2600,
      {
        year: 1,
        monthIndex: 1,
        monthName: 'Ember',
        day: 1,
        dayOfYear: 31,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // day index 57 is the last of Ember (30 + 27), day 58 opens Mist.
    [
      57 * 2600,
      {
        year: 1,
        monthIndex: 1,
        monthName: 'Ember',
        day: 28,
        dayOfYear: 58,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    [
      58 * 2600,
      {
        year: 1,
        monthIndex: 2,
        monthName: 'Mist',
        day: 1,
        dayOfYear: 59,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // Days per year = 390, so day index 389 is the last day and 390 opens year 2.
    [
      389 * 2600,
      {
        year: 1,
        monthIndex: 6,
        monthName: 'Long',
        day: 150,
        dayOfYear: 390,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    [
      390 * 2600,
      {
        year: 2,
        monthIndex: 0,
        monthName: 'Frost',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // Minute -1 is the last minute of the year BEFORE year 1 — year 1 is not the
    // beginning of the axis, only of the first labelled year (worlds count years
    // from the epoch, and a checkpoint may roll back past it).
    [
      -1,
      {
        year: 0,
        monthIndex: 6,
        monthName: 'Long',
        day: 150,
        dayOfYear: 390,
        hour: 25,
        minuteOfHour: 99,
      },
    ],
    // Year 0 is its own full year of 390 days; its last day starts at -2600.
    [
      -2600,
      {
        year: 0,
        monthIndex: 6,
        monthName: 'Long',
        day: 150,
        dayOfYear: 390,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    [
      -1014000,
      {
        year: 0,
        monthIndex: 0,
        monthName: 'Frost',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    [
      -1014001,
      {
        year: -1,
        monthIndex: 6,
        monthName: 'Long',
        day: 150,
        dayOfYear: 390,
        hour: 25,
        minuteOfHour: 99,
      },
    ],
  ];

  it.each(table)('minute %i maps to the expected date', (minute, expected) => {
    expect(display(fantasyCalendar, minute)).toMatchObject(expected);
  });

  it('maps a minute far in the future without losing precision', () => {
    // 10 years, to the minute: 10 * 1014000.
    expect(display(fantasyCalendar, 10 * 1014000)).toMatchObject({
      year: 11,
      monthIndex: 0,
      monthName: 'Frost',
      day: 1,
      dayOfYear: 1,
      hour: 0,
      minuteOfHour: 0,
    });
    // One minute before that is the last minute of year 10.
    expect(display(fantasyCalendar, 10 * 1014000 - 1)).toMatchObject({
      year: 10,
      monthIndex: 6,
      monthName: 'Long',
      day: 150,
      dayOfYear: 390,
      hour: 25,
      minuteOfHour: 99,
    });
  });
});

describe('display — the extra-length last month (45-minute hours, 10-hour days)', () => {
  const table: readonly DateRow[] = [
    // minutesPerDay = 450, daysPerYear = 200, minutesPerYear = 90000.
    [
      0,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Short',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // last minute of day 24 -> day 25 opens the 75-day Middle month.
    [
      24 * 450 + 449,
      {
        year: 1,
        monthIndex: 0,
        monthName: 'Short',
        day: 25,
        dayOfYear: 25,
        hour: 9,
        minuteOfHour: 44,
      },
    ],
    [
      25 * 450,
      {
        year: 1,
        monthIndex: 1,
        monthName: 'Middle',
        day: 1,
        dayOfYear: 26,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // day 99 is the last of Middle (25 + 74); day 100 opens the 100-day LongExtra.
    [
      99 * 450,
      {
        year: 1,
        monthIndex: 1,
        monthName: 'Middle',
        day: 75,
        dayOfYear: 100,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    [
      100 * 450,
      {
        year: 1,
        monthIndex: 2,
        monthName: 'LongExtra',
        day: 1,
        dayOfYear: 101,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
    // the extra-length month runs to day 199, and the year rolls at 200.
    [
      199 * 450 + 449,
      {
        year: 1,
        monthIndex: 2,
        monthName: 'LongExtra',
        day: 100,
        dayOfYear: 200,
        hour: 9,
        minuteOfHour: 44,
      },
    ],
    [
      200 * 450,
      {
        year: 2,
        monthIndex: 0,
        monthName: 'Short',
        day: 1,
        dayOfYear: 1,
        hour: 0,
        minuteOfHour: 0,
      },
    ],
  ];

  it.each(table)('minute %i maps to the expected date', (minute, expected) => {
    expect(display(leapishCalendar, minute)).toMatchObject(expected);
  });
});

describe('display — segments, labels and weekdays are data-driven', () => {
  it('reports every segment holding the minute, in declaration order', () => {
    // hour 5 opens 晨 [5, 12), and 夜 is declared 25 -> 5: its wrapped end is
    // exclusive, so hour 5 belongs to 晨 alone.
    expect(display(fantasyCalendar, 5 * 100).segments).toEqual([{ id: 'dawn', name: 'Dawn' }]);
    // hour 4 of the NEXT day is the last hour 夜 covers after wrapping.
    expect(display(fantasyCalendar, 4 * 100).segments).toEqual([{ id: 'night', name: 'Night' }]);
    // hour 12 is inside 昼 [12, 18) and NOWHERE near 夜's wrapped hours. This is the
    // row that catches an overnight window compared against an unfolded `toHour`,
    // which would wrongly match the middle of the day.
    expect(display(fantasyCalendar, 12 * 100).segments).toEqual([{ id: 'day', name: 'Day' }]);
    // hour 25 opens 夜, and hour 25 is not inside 晨 [5, 12).
    expect(display(fantasyCalendar, 25 * 100).segments).toEqual([{ id: 'night', name: 'Night' }]);
  });

  it('reports no segment for a minute the calendar does not cover', () => {
    // gappyCalendar names hours 0..2 and 7..10; hour 4 belongs to nobody.
    expect(display(gappyCalendar, 4 * 60).segments).toEqual([]);
  });

  it('reports no segment at all when the calendar declares none', () => {
    expect(display(timelessCalendar, 12 * 60).segments).toEqual([]);
    expect(display(timelessCalendar, 12 * 60).monthName).toBe('Only');
  });

  it('omits epochLabel and weekday rather than inventing them', () => {
    const parts = display(timelessCalendar, 0);
    expect(parts.epochLabel).toBeUndefined();
    expect(parts.weekday).toBeUndefined();
  });

  it('maps a weekday only when the weekday list divides the year', () => {
    // fantasy: daysPerYear 390 / 5 weekdays = 78 whole weeks, so day 1 is 'One'.
    expect(display(fantasyCalendar, 0).weekday).toBe('One');
    expect(display(fantasyCalendar, 2600).weekday).toBe('Two');
    expect(display(fantasyCalendar, 390 * 2600).weekday).toBe('One');
    // gappy: 12 days per year over 4 weekday names happens to divide, so it maps.
    expect(display(gappyCalendar, 0).weekday).toBe('A');
    // fantasy with a 7-name list would not divide; built here so the branch is real.
    const sevenDay = { ...fantasyCalendar, weekdays: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
    expect(display(sevenDay, 0).weekday).toBeUndefined();
  });
});

describe('renderParts — a plain data join with no prose of its own', () => {
  it('joins the parts with the separator it is given', () => {
    expect(renderParts(display(plainCalendar, 0), ' | ')).toBe('Era | 1 | Alpha | 1 | 00:00');
  });

  it('pads hours and minutes to two digits for hour and minute widths above 9', () => {
    // fantasy minute 10900 -> hour 5, minute 0.
    expect(renderParts(display(fantasyCalendar, 10900), ' ')).toBe('Third Age 1 Frost 5 05:00');
  });

  it('renders without a label when the calendar has none', () => {
    expect(renderParts(display(timelessCalendar, 12 * 60 + 30), '-')).toBe('1-Only-1-12:30');
  });

  it('contains no segment prose: the caller appends the day-part itself', () => {
    expect(renderParts(display(fantasyCalendar, 5 * 100), ' ')).not.toContain('Dawn');
  });
});

describe('toEpochMinute — the inverse of display', () => {
  const table: readonly [calendar: Calendar, minute: number][] = [
    [plainCalendar, 0],
    [plainCalendar, 7199],
    [plainCalendar, 43200],
    [plainCalendar, 2 * 43200 + 25 * 720 + 5 * 60 + 7],
    [fantasyCalendar, 0],
    [fantasyCalendar, 10900],
    [fantasyCalendar, 389 * 2600 + 2599],
    [fantasyCalendar, 10 * 1014000],
    [leapishCalendar, 199 * 450 + 449],
    [leapishCalendar, 200 * 450],
    [gappyCalendar, 7 * 600 + 3 * 60 + 11],
  ];

  it.each(table)('round-trips minute %2$i through its own parts', (calendar, minute) => {
    const parts = display(calendar, minute);
    expect(
      toEpochMinute(calendarView(calendar), {
        year: parts.year,
        monthIndex: parts.monthIndex,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minuteOfHour,
      }),
    ).toBe(minute);
  });

  it('rejects coordinates outside the calendar instead of wrapping them', () => {
    const view = calendarView(fantasyCalendar);
    expect(() => toEpochMinute(view, { year: 0, monthIndex: 0, day: 1 })).toThrow(/1-based/);
    expect(() => toEpochMinute(view, { year: 1, monthIndex: 7, day: 1 })).toThrow(/outside/);
    expect(() => toEpochMinute(view, { year: 1, monthIndex: 0, day: 31 })).toThrow(/outside/);
    expect(() => toEpochMinute(view, { year: 1, monthIndex: 0, day: 1, hour: 26 })).toThrow(
      /outside/,
    );
    expect(() => toEpochMinute(view, { year: 1, monthIndex: 0, day: 1, minute: 100 })).toThrow(
      /outside/,
    );
  });
});

describe('calendarView — malformed calendars fail loudly', () => {
  it('refuses a zero or fractional hour', () => {
    expect(() => calendarView({ ...plainCalendar, minutesPerHour: 0 })).toThrow(/positive integer/);
    expect(() => calendarView({ ...plainCalendar, hoursPerDay: 2.5 })).toThrow(/positive integer/);
  });

  it('refuses a calendar with no months', () => {
    expect(() => calendarView({ ...plainCalendar, months: [] })).toThrow(/must not be empty/);
  });

  it('refuses a month with a zero or fractional day count', () => {
    expect(() => calendarView({ ...plainCalendar, months: [{ name: 'Bad', days: 0 }] })).toThrow(
      /positive whole day count/,
    );
    expect(() => calendarView({ ...plainCalendar, months: [{ name: 'Bad', days: 1.5 }] })).toThrow(
      /positive whole day count/,
    );
  });

  it('derives the divisors from the data rather than assuming 24 and 60', () => {
    expect(calendarView(fantasyCalendar)).toMatchObject({
      minutesPerDay: 2600,
      minutesPerYear: 1014000,
      daysPerYear: 390,
    });
    expect(calendarView(plainCalendar)).toMatchObject({
      minutesPerDay: 720,
      minutesPerYear: 43200,
      daysPerYear: 60,
    });
  });

  it('refuses a segment hour outside the day instead of clamping it', () => {
    // `calendarView` is the one call every entry point makes, so the check is
    // here: a typo fails on the way in even for a caller that only wants a date
    // and would never resolve segments.
    expect(() =>
      calendarView({
        ...plainCalendar,
        segments: [{ id: 'bad', name: 'Bad', fromHour: 0, toHour: 13 }],
      }),
    ).toThrow(/whole hour index/);
    expect(() =>
      calendarView({
        ...plainCalendar,
        segments: [{ id: 'bad', name: 'Bad', fromHour: -1, toHour: 2 }],
      }),
    ).toThrow(/whole hour index/);
  });

  it('accepts toHour === hoursPerDay, which is how a to-end-of-day window is written', () => {
    expect(() =>
      calendarView({
        ...plainCalendar,
        segments: [{ id: 'all-day', name: 'All day', fromHour: 0, toHour: 12 }],
      }),
    ).not.toThrow();
  });
});
