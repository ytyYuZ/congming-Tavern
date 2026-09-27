/**
 * World & calendar — the setting container (docs/02 §4 `WorldData`, §5.7
 * `Calendar`, §7 `worlds` / `worldVersions`).
 *
 * THREE THINGS THAT DECIDE WHETHER TIME WORKS LATER
 *
 * 1. Time is an `EpochMinute`, never a wall-clock date (ADR-012). `Calendar` is
 *    only the *display mapping* over `startMinute`: it is what
 *    `TimeEngine.display()` reads to print "第三纪 1287 年 霜月 12 日 · 黄昏". A
 *    wrong calendar prints the wrong text; it can never produce a wrong `clock`.
 * 2. `segments` are the day's named hours (晨/昼/昏/夜) and exist so worldbook
 *    entries can trigger on `timeOfDay` (docs/02 §5.2, §5.7 `segmentOf`).
 *    `fromHour`/`toHour` are bounded below by 0 only — a 26-hour day is legal, so
 *    a hard-coded ceiling of 23 here would reject a valid fantasy calendar.
 *    `toHour < fromHour` is also legal: 夜 legitimately wraps midnight.
 * 3. `WorldData` carries no `extensions` of its own. Like `CharacterData`, the
 *    payload is wrapped by a `WorldVersion` envelope, and the envelope owns the
 *    plugin channel (`versionedEntity()`). Two slots for one plugin's data could
 *    disagree, so there is exactly one.
 *
 * `Region` and `Faction` are referenced by docs/02 §4 `WorldData` but never
 * defined there; docs/02 §4.1 hands them to this file. They are frozen minimal
 * and additive: an import that carries more (maps, relations, trade routes)
 * keeps it under `extensions`, or in a plugin-defined entity.
 */
import { z } from 'zod';
import { EpochMinuteSchema, ExtensionsSchema, IdSchema, UuidV7Schema } from '../common';
import { VersionedHeadFieldsSchema, versionedEntity } from '../versioning';

/* ──────────────────── 地区与势力：§4 引用过、从未定义（§4.1） ───────────────── */

/**
 * A location node. `parentId` carries the containment tree (洲 → 国 → 城) so a
 * world needs one collection instead of one per granularity.
 *
 * `id` is an `IdSchema`, not a `UuidV7Schema`: a world written by somebody else
 * may use slugs (`silverpine-town`), and `common.ts` is explicit that validating
 * the shape of a foreign id would reject valid third-party content.
 */
export const RegionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  description: z.string(),
  /** Parent region, for nested places. Absent at the top level. */
  parentId: IdSchema.optional(),
  tags: z.array(z.string()).optional(),
  extensions: ExtensionsSchema.optional(),
});
export type Region = z.infer<typeof RegionSchema>;

/** A power bloc. `stance` is free text on purpose: the world defines its politics. */
export const FactionSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  description: z.string(),
  /** Attitude toward the player's side, as free text ("敌对" / "观望"). */
  stance: z.string().optional(),
  goals: z.array(z.string()),
  extensions: ExtensionsSchema.optional(),
});
export type Faction = z.infer<typeof FactionSchema>;

/* ─────────────────────────────── 历法（§5.7） ─────────────────────────────── */

/** One month of the world's year. `days` is what maps a day number onto a month. */
export const CalendarMonthSchema = z.object({
  name: z.string().min(1),
  days: z.number().int().positive(),
});
export type CalendarMonth = z.infer<typeof CalendarMonthSchema>;

/**
 * A named stretch of the day. `fromHour` is inclusive and `toHour` exclusive, so
 * 晨 6→12 / 昼 12→18 tile without a gap.
 */
export const DaySegmentSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  fromHour: z.number().int().min(0),
  toHour: z.number().int().min(0),
});
export type DaySegment = z.infer<typeof DaySegmentSchema>;

/**
 * The world's clock face. `minutesPerHour` and `hoursPerDay` are data, not
 * constants, because a fantasy world is allowed a 26-hour day or a 100-minute
 * hour — every minute->text conversion goes through these two numbers.
 */
export const CalendarSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  /** Usually 60. Never assumed. */
  minutesPerHour: z.number().int().positive(),
  /** Usually 24. `segments` hours are bounded by this, not by 24. */
  hoursPerDay: z.number().int().positive(),
  weekdays: z.array(z.string()).optional(),
  /**
   * At least one month: `display()` must be able to render *some* date, and a
   * year-less calendar can only ever fail at runtime. `segments` may stay empty —
   * a world that does not name its day-parts simply never matches `timeOfDay`.
   */
  months: z.array(CalendarMonthSchema).min(1),
  /** Prefix for rendered dates, e.g. "第三纪". */
  epochLabel: z.string().optional(),
  segments: z.array(DaySegmentSchema),
});
export type Calendar = z.infer<typeof CalendarSchema>;

/* ──────────────────────────────── 世界数据 ───────────────────────────────── */

/**
 * The world payload. `premise` is the one-line pitch the prompt injects, and
 * `rulesOfNature` is what keeps an AI from inventing magic the setting forbids —
 * which is why `taboos` is a required string rather than an optional note.
 */
export const WorldDataSchema = z.object({
  name: z.string().min(1).max(200),
  premise: z.string(),
  genre: z.array(z.string()),
  era: z.string(),
  techOrMagic: z.string(),
  regions: z.array(RegionSchema),
  factions: z.array(FactionSchema),
  rulesOfNature: z.object({
    powerSource: z.string(),
    limits: z.string(),
    taboos: z.string(),
  }),
  narrative: z.object({
    conflict: z.string(),
    tone: z.string(),
    themes: z.array(z.string()),
    style: z.string(),
  }),
  calendar: CalendarSchema,
  /** Where the world's own clock starts (ADR-012): the session copies this. */
  startMinute: EpochMinuteSchema,
  /**
   * How time moves without being asked (docs/02 §5.7). Implicit advance is off by
   * default by design, so `advanceEveryTurns` is required but ignored while
   * `implicitAdvance` is false; `stepMinutes` must be positive because a zero
   * step would "advance" the clock forever without moving it.
   */
  timeRhythm: z.object({
    implicitAdvance: z.boolean(),
    advanceEveryTurns: z.number().int().positive(),
    stepMinutes: z.number().int().positive(),
  }),
  openingHooks: z.array(z.string()),
  /** User-authored extra fields, same escape hatch the character card has. */
  customFields: z.record(z.string(), z.string()),
});
export type WorldData = z.infer<typeof WorldDataSchema>;

/**
 * Immutable version row (`worldVersions`, docs/02 §7):
 * envelope + `worldId` back-pointer + payload. The calendar and `timeRhythm`
 * live inside `data`, so a save that pins `{worldId, version}` reproduces the
 * exact time semantics it was played under.
 */
export const WorldVersionSchema = versionedEntity(WorldDataSchema).extend({
  worldId: UuidV7Schema,
});
export type WorldVersion = z.infer<typeof WorldVersionSchema>;

/**
 * Head row (`worlds`, docs/02 §7): what the library lists and searches without
 * loading every version payload. Shared verbatim with every other versioned
 * entity — see `VersionedHeadFieldsSchema`.
 */
export const WorldSchema = VersionedHeadFieldsSchema;
export type World = z.infer<typeof WorldSchema>;
