/**
 * Day segments: "which named stretch of the day is this minute in?".
 * docs/02 §5.2 / §5.7 `segmentOf`, `entities/world.ts` `DaySegment`.
 *
 * WHY THIS IS SEPARATE FROM `calendar.ts`. A segment is not a date and not a
 * unit conversion: it is the lookup a worldbook `timeOfDay` condition performs
 * (`conditions?: { timeOfDay?: string[] }`), so it is on the worldbook hot path
 * and must stay independent of month arithmetic. It reads its hour number from
 * `calendar.ts` and nothing else.
 *
 * THE THREE SHAPES A WINDOW MAY HAVE. `fromHour` is inclusive and `toHour` is
 * exclusive, and `fromHour` is allowed to be greater than `toHour` ("夜
 * legitimately wraps midnight"). On top of that an editor may write the wrap as
 * hours past the end of the day (22 -> 30), which is the same window. All three
 * shapes are flattened here, once, into a `SegmentHourWindow` tag, so the
 * lookup below is a two-comparison branch instead of four.
 *
 * `segments` MAY BE EMPTY AND MAY NOT COVER THE DAY. A world that does not name
 * its day-parts simply never matches `timeOfDay` (world.ts), so `segmentOf`
 * returns `undefined` for an uncovered minute rather than inventing a segment.
 */
import type { Calendar, DaySegment, EpochMinute } from '@smarttavern/schema';
import type { CalendarView } from './calendar';
import { hourOfDayAt } from './calendar';
import type { ResolvedDaySegment, SegmentHourWindow, SegmentRef } from './types';
import { TimeEngineError } from './types';

function assertHourIndex(value: number, what: string, hoursPerDay: number): void {
  if (!Number.isInteger(value) || value < 0 || value > hoursPerDay) {
    throw new TimeEngineError(`${what} must be a whole hour index in 0..${hoursPerDay}`);
  }
}

/**
 * Flatten each declared segment into absolute hour bounds plus a shape tag.
 *
 * A `fromHour > toHour` declaration is normalised to the equivalent "overnight"
 * window by adding a day to `toHour`, which is what makes 22 -> 4 and 22 -> 30
 * one case instead of two.
 */
export function resolveSegments(
  segments: readonly DaySegment[],
  hoursPerDay: number,
): readonly ResolvedDaySegment[] {
  return segments.map((segment) => {
    assertHourIndex(segment.fromHour, `segment ${segment.id} fromHour`, hoursPerDay);
    // `toHour` is allowed PAST the end of the day, because that is the second spelling of
    // a wrap this module documents (22 -> 30 on a 24-hour day is the same window as
    // 22 -> 6). Bounding it at `fromHour + hoursPerDay` admits exactly one wrap and keeps
    // the normalisation below total; bounding it at `hoursPerDay` rejected the documented
    // form before it could be normalised, which is what a 293-file green suite could not
    // see because no test wrote a wrap that way.
    const maxToHour = segment.fromHour + hoursPerDay;
    if (!Number.isInteger(segment.toHour) || segment.toHour < 0 || segment.toHour > maxToHour) {
      throw new TimeEngineError(
        `segment ${segment.id} toHour must be a whole hour index in 0..${maxToHour}` +
          ` (a wrap may be written past the end of the day, e.g. 22 -> 30 on a 24-hour day)`,
      );
    }
    const { fromHour } = segment;
    const toHour = segment.toHour < fromHour ? segment.toHour + hoursPerDay : segment.toHour;
    const hours = toHour - fromHour;
    const tag: SegmentHourWindow =
      hours >= hoursPerDay ? 'whole-day' : toHour > hoursPerDay ? 'overnight' : 'within-day';
    return { id: segment.id, name: segment.name, fromHour, toHour, hours, hoursPerDay, tag };
  });
}

/** The segments a calendar declares, resolved. The one entry point callers need. */
export function resolvedSegmentsOf(
  calendar: Calendar,
  hoursPerDay: number,
): readonly ResolvedDaySegment[] {
  return resolveSegments(calendar.segments, hoursPerDay);
}

/**
 * Does this window hold the given hour index of the day? The hour is always in
 * `[0, hoursPerDay)` because it comes from `hourOfDayAt`.
 *
 * THE OVERNIGHT CASE IS THE ONE THAT IS EASY TO GET WRONG. An overnight window
 * has been normalised so its `toHour` runs PAST `hoursPerDay` (22 -> 6 on a
 * 24-hour day becomes 22 -> 30). It holds an hour at or after `fromHour` on this
 * day, or an hour before the folded end on the next morning — where the fold is
 * `toHour - hoursPerDay`, i.e. 6. Comparing against the unsubtracted `toHour`
 * would wrongly match the entire middle of the day.
 */
export function hourWindowHolds(segment: ResolvedDaySegment, hour: number): boolean {
  if (segment.tag === 'whole-day') return true;
  if (segment.tag === 'within-day') return hour >= segment.fromHour && hour < segment.toHour;
  return hour >= segment.fromHour || hour < segment.toHour - segment.hoursPerDay;
}

/**
 * The segment that holds `minute`, or `undefined` when the calendar covers no
 * segment there. First match wins, so overlapping windows resolve predictably
 * (declaration order) instead of at the mercy of the lookup.
 */
export function segmentOf(
  view: CalendarView,
  segments: readonly ResolvedDaySegment[],
  minute: EpochMinute,
): SegmentRef | undefined {
  const hourField = 'hour' as const;
  const { [hourField]: hour } = hourOfDayAt(view, minute);
  for (const segment of segments) {
    if (hourWindowHolds(segment, hour)) return { id: segment.id, name: segment.name };
  }
  return undefined;
}

/**
 * Every segment that holds `minute`, in declaration order.
 *
 * `segmentOf` answers the worldbook condition (one id); this answers `display()`,
 * which must not silently drop a second overlapping window from the context it
 * reports. Both share `hourWindowHolds`, so they cannot disagree.
 */
export function segmentsAt(
  view: CalendarView,
  segments: readonly ResolvedDaySegment[],
  minute: EpochMinute,
): readonly SegmentRef[] {
  const hourField = 'hour' as const;
  const { [hourField]: hour } = hourOfDayAt(view, minute);
  const found: SegmentRef[] = [];
  for (const segment of segments) {
    if (hourWindowHolds(segment, hour)) found.push({ id: segment.id, name: segment.name });
  }
  return found;
}
