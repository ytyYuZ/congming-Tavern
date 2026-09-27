/**
 * Which day segments a clock step walked over (docs/02 §5.7 副作用链 step 1).
 *
 * WHY THIS IS NOT A LOOP OVER MINUTES. A step may be a year long, so the walk
 * samples the hour marks of the span rather than every minute, and collapses runs
 * of adjacent samples in the same segment (see `append`). For a 100-minute hour and
 * a 26-hour day that is one lookup per hour, which is the price of the calendar
 * being data rather than a 24/60 constant. `hourMarksBetween` is still O(span in
 * hours) because a traversal a caller can render hour by hour is worth emitting;
 * what is avoided is a minute-by-minute walk, which a three-year step would make
 * two million iterations long.
 *
 * FORWARD vs BACKWARD, THE DECISION THAT MATTERS (M1-T1).
 * `advance()` supports a negative delta, because a user may set the clock back
 * and docs/02 §5.7 requires a checkpoint rollback to be expressible. A backward
 * step is NOT a forward step with the sign flipped, and it is not "no segments
 * crossed" either: it is the same traversal read in the other direction.
 *
 * WHAT BOTH DIRECTIONS SAMPLE. Both endpoint instants, plus every hour mark
 * strictly between them — so the hour the clock starts in and the hour it comes to
 * rest in are both represented even when neither endpoint is itself a mark. The one
 * definition lives in `hourMarksBetween`; `crossedSegmentsForward` reads it
 * ascending and `crossedSegmentsBackward` reads the SAME list descending.
 *
 * ORDER IS THE ONLY DIFFERENCE, and that is deliberate: forward 55 → 65 reports
 * [晨, 昼] while the backward step 65 → 55 reports [昼, 晨]. A caller that only
 * cares about the set sorts or dedupes; a caller that renders "the clock went from
 * X to Y" gets the direction from the list itself.
 *
 * THE GUARANTEE CALLERS CAN RELY ON is therefore the mirror property, and it is
 * exact rather than approximate: for any `fromMinute` and `toMinute`,
 * `crossedSegmentsBackward(to, from)` equals `crossedSegmentsForward(from, to)`
 * reversed. Because both directions read one list, this holds for EVERY pair of
 * minutes — a step inside a segment, across a boundary, across midnight, across a
 * year — and `clock.test.ts` asserts it row by row rather than at one example.
 *
 * THE ENDPOINTS ARE NOT "START" AND "END". Because `advance` may be called with
 * either sign, an implementation that gave the two instants asymmetric treatment
 * would produce a different segment list for the same pair of minutes depending on
 * which way the clock travelled — the silent nonsense this refuses to produce. The
 * builder takes `low`/`high` and both walks apply the same rule to them.
 *
 * WHAT IS DELIBERATELY ABSENT: day and month boundaries. §5.7's step 1 says
 * "计算新时刻与跨越的时段" — the new instant and the segments. A caller that
 * needs "did we cross midnight?" has `fromMinute`/`toMinute` and the calendar,
 * and a midnight is not a segment.
 *
 * TWO DETAILS THAT LOOK LIKE OFF-BY-ONES AND ARE NOT.
 * 1. A step that stays inside 晨 reports [晨]: the clock did stand there at the
 *    sampled minutes, including both endpoints.
 * 2. Consecutive duplicates are dropped, so 晨 → 昼 → 晨 keeps both 晨 entries
 *    while two adjacent hours of the same segment are one crossing.
 */
import type { EpochMinute } from '@smarttavern/schema';
import type { CalendarView } from './calendar';
import { hourMarksBetween } from './calendar';
import { segmentOf } from './segments';
import type { ResolvedDaySegment, SegmentRef } from './types';

function append(
  found: SegmentRef[],
  view: CalendarView,
  segments: readonly ResolvedDaySegment[],
  minute: EpochMinute,
): void {
  const ref = segmentOf(view, segments, minute);
  if (ref === undefined) return;
  const lastIndex = found.length - 1;
  const last = lastIndex < 0 ? undefined : found[lastIndex];
  if (last !== undefined && last.id === ref.id) return;
  found.push(ref);
}

/**
 * The forward traversal: the sampled minutes of the span, ascending.
 *
 * A sample is either an endpoint instant or an hour mark; the definition lives in
 * `hourMarksBetween`, so this function and its backward twin cannot drift apart.
 * Consecutive samples in the same segment collapse (see `append`), which is why a
 * three-day step reports one entry per named day-part per day rather than one per
 * hour.
 */
export function crossedSegmentsForward(
  view: CalendarView,
  segments: readonly ResolvedDaySegment[],
  fromMinute: EpochMinute,
  toMinute: EpochMinute,
): readonly SegmentRef[] {
  const found: SegmentRef[] = [];
  const samples = hourMarksBetween(
    Math.min(fromMinute, toMinute),
    Math.max(fromMinute, toMinute),
    view.minutesPerHour,
  );
  for (const sample of samples) append(found, view, segments, sample);
  return found;
}

/**
 * The backward traversal: THE SAME SAMPLED MINUTES, read in reverse.
 *
 * That is the entire implementation, and it is why the mirror property holds for
 * every pair of minutes rather than only for the easy ones: both directions read
 * one list, and only the order differs. `crossedSegmentsBackward(to, from)` is
 * therefore always `crossedSegmentsForward(from, to)` reversed, which is the
 * property `clock.test.ts` asserts for every row of its boundary table.
 *
 * Getting this wrong is subtle and produces a plausible-looking answer. Walking
 * down from 65 to 59 with 60-minute hours, the samples are 65 (昼), 60 (昼) and 59
 * (晨), so the walk must report [昼, 晨]. A version that sampled only the hour marks
 * would report [昼] and silently drop the segment the clock came to rest in.
 */
export function crossedSegmentsBackward(
  view: CalendarView,
  segments: readonly ResolvedDaySegment[],
  fromMinute: EpochMinute,
  toMinute: EpochMinute,
): readonly SegmentRef[] {
  const found: SegmentRef[] = [];
  const samples = hourMarksBetween(
    Math.min(fromMinute, toMinute),
    Math.max(fromMinute, toMinute),
    view.minutesPerHour,
  );
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample === undefined) continue;
    append(found, view, segments, sample);
  }
  return found;
}

/** Dispatch on the sign of the step; both directions are real traversals. */
export function crossedSegments(
  view: CalendarView,
  segments: readonly ResolvedDaySegment[],
  fromMinute: EpochMinute,
  toMinute: EpochMinute,
): readonly SegmentRef[] {
  if (toMinute > fromMinute) {
    return crossedSegmentsForward(view, segments, fromMinute, toMinute);
  }
  if (toMinute < fromMinute) {
    return crossedSegmentsBackward(view, segments, fromMinute, toMinute);
  }
  return [];
}
