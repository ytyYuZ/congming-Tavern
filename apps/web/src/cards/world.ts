/**
 * The world card's payload, as the editor (M1-W1) works with it: the blank shape a new world
 * starts from, the tolerant reader of a stored DRAFT, the validation the publish gate uses,
 * and the inventory of fields the form renders.
 *
 * WHY THIS IS PURE AND SEPARATE FROM THE VIEW
 * Every transition here is `old value + change -> new value` over plain data, so it is
 * testable without a DOM and reusable by a future AI-proposal path (`docs/06` M1-W2) that
 * must not go through a form. The view decides where the controls are; this module decides
 * what a field is, what "valid" means, and what a damaged draft degrades to.
 *
 * THE CALENDAR IS DATA, AND THE ENGINE IS THE JUDGE (docs/02 §5.7, ADR-012)
 * `CalendarSchema` is the shape contract, but the acceptance for a calendar is the TimeEngine's
 * own rules, so `worldIssues` runs `calendarView()` from `@smarttavern/core` over the payload
 * and reports ITS message. A 26-hour day and a 100-minute hour are legal data and are never
 * "fixed" to 24/60; a segment whose `toHour` runs past `hoursPerDay` is not, and the fix
 * belongs to the author. Nothing here re-implements calendar arithmetic: the editor edits
 * data, and every minute -> date conversion stays in `engine/time/`.
 *
 * WHERE 自定义字段 LIVE: the payload's OWN `customFields` record (`docs/02` §4), which this form
 * renders like any other field and `cards/custom-fields.ts` owns the rules for. It is domain data,
 * so `common.ts` rule 1 — "third-party data goes in `extensions`" — does not apply to it; the
 * version envelope's `extensions` bag stays the PLUGIN channel, and this editor only carries it
 * through a draft so a plugin's data survives a user edit (`cards/draft.ts`).
 */
import { calendarView } from '@smarttavern/core';
import {
  type Calendar,
  type CalendarMonth,
  type DaySegment,
  type Faction,
  mintUuidV7,
  type Region,
  type WorldData,
  WorldDataSchema,
} from '@smarttavern/schema';
import {
  BUILTIN_CALENDAR,
  BUILTIN_DAYS_PER_MONTH,
  BUILTIN_MINUTES_PER_HOUR,
} from '../chat/builtin-content';
import {
  asBoolean,
  asList,
  asNumber,
  asString,
  asStringList,
  asStringRecord,
  type BooleanFieldSpec,
  type CardIssue,
  jsonObject,
  memberOf,
  memberValue,
  type NumberFieldSpec,
  type StringListFieldSpec,
  type TextFieldSpec,
} from './fields';

/* ─────────────────────────── the blank shapes (增) ───────────────────────── */

/** The calendar id a new world's default calendar carries. A payload-local slug. */
export const BLANK_CALENDAR_ID = 'calendar';

/**
 * A new world's calendar: a COPY of the app's built-in one.
 *
 * WHY A COPY OF THE BUILT-IN AND NOT THE BUILT-IN ITSELF: the built-in is a module constant
 * that the play screen still reads (`chat/clock.ts`), so a world editor that edited it in
 * place would rewrite the running app's clock — the same aliasing bug `copyState` in
 * `db/repository.ts` exists to prevent. And reusing its month and segment names is what keeps
 * a new world's calendar WORKING (a calendar must have at least one named month) without
 * inventing content or adding a second file of Chinese literals.
 *
 * The `id` is the only field that differs: `builtin-default` names the app's own calendar,
 * and a world's calendar is the world's.
 */
export function blankCalendar(): Calendar {
  return {
    id: BLANK_CALENDAR_ID,
    name: BUILTIN_CALENDAR.name,
    minutesPerHour: BUILTIN_CALENDAR.minutesPerHour,
    hoursPerDay: BUILTIN_CALENDAR.hoursPerDay,
    ...(BUILTIN_CALENDAR.weekdays === undefined
      ? {}
      : { weekdays: [...BUILTIN_CALENDAR.weekdays] }),
    months: BUILTIN_CALENDAR.months.map((month) => ({ ...month })),
    ...(BUILTIN_CALENDAR.epochLabel === undefined
      ? {}
      : { epochLabel: BUILTIN_CALENDAR.epochLabel }),
    segments: BUILTIN_CALENDAR.segments.map((segment) => ({ ...segment })),
  };
}

/**
 * A new world payload: every required field present, every content field empty.
 *
 * It is SCHEMA-VALID on purpose (`cards/world.test.ts` asserts it): a world is created as
 * version 1, and a payload that could not be published would make 「新建」 a control that
 * writes nothing. Only `name` carries content, because `WorldDataSchema` gives only `name` a
 * non-empty constraint.
 */
export function blankWorldData(name: string): WorldData {
  return {
    name,
    premise: '',
    genre: [],
    era: '',
    techOrMagic: '',
    regions: [],
    factions: [],
    rulesOfNature: { powerSource: '', limits: '', taboos: '' },
    narrative: { conflict: '', tone: '', themes: [], style: '' },
    calendar: blankCalendar(),
    startMinute: 0,
    timeRhythm: {
      implicitAdvance: false,
      advanceEveryTurns: 1,
      stepMinutes: BUILTIN_MINUTES_PER_HOUR,
    },
    openingHooks: [],
    customFields: {},
  };
}

/**
 * The blank factories for the list rows (地区 / 势力 / 月份 / 时段).
 *
 * The id-carrying ones MINT their id (`docs/04` §4: an id this app mints is a UUIDv7), because
 * `IdSchema` is required on those shapes and an id derived from the row's name would change
 * under the user's typing. The completion path below uses `''` instead — a DAMAGED row has no
 * id to mint, and inventing one would be inventing content; the validation panel then reports
 * the empty id like any other schema failure.
 */
export function blankRegion(): Region {
  return { id: mintUuidV7(), name: '', description: '' };
}

export function blankFaction(): Faction {
  return { id: mintUuidV7(), name: '', description: '', goals: [] };
}

/** A month row. `days` starts at the built-in month length, which is the app's own default. */
export function blankMonth(): CalendarMonth {
  return { name: '', days: BUILTIN_DAYS_PER_MONTH };
}

/** A day segment row. `0 -> 0` is an EMPTY window the engine matches nothing in. */
export function blankSegment(): DaySegment {
  return { id: mintUuidV7(), name: '', fromHour: 0, toHour: 0 };
}

/* ───────────────────── the tolerant reader of a draft (读) ───────────────── */

function completeRegion(member: unknown): Region | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  const parentId = asString(source, 'parentId', '');
  const tags = asStringList(source, 'tags', []);
  return {
    id: asString(source, 'id', ''),
    name: asString(source, 'name', ''),
    description: asString(source, 'description', ''),
    // An absent optional member stays absent: writing `''` would turn "no parent region" into
    // a parent whose id is the empty string, which `IdSchema` refuses.
    ...(parentId === '' ? {} : { parentId }),
    ...(tags.length === 0 ? {} : { tags }),
  };
}

function completeFaction(member: unknown): Faction | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  const stance = asString(source, 'stance', '');
  return {
    id: asString(source, 'id', ''),
    name: asString(source, 'name', ''),
    description: asString(source, 'description', ''),
    ...(stance === '' ? {} : { stance }),
    goals: asStringList(source, 'goals', []),
  };
}

function completeMonth(member: unknown): CalendarMonth | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  return { name: asString(source, 'name', ''), days: asNumber(source, 'days', 0) };
}

function completeSegment(member: unknown): DaySegment | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  return {
    id: asString(source, 'id', ''),
    name: asString(source, 'name', ''),
    fromHour: asNumber(source, 'fromHour', 0),
    toHour: asNumber(source, 'toHour', 0),
  };
}

function completeCalendar(member: unknown, fallback: Calendar): Calendar {
  const source = jsonObject(member);
  if (source === undefined) return fallback;
  const weekdays = asStringList(source, 'weekdays', []);
  const epochLabel = asString(source, 'epochLabel', '');
  return {
    id: asString(source, 'id', ''),
    name: asString(source, 'name', ''),
    minutesPerHour: asNumber(source, 'minutesPerHour', 0),
    hoursPerDay: asNumber(source, 'hoursPerDay', 0),
    ...(weekdays.length === 0 ? {} : { weekdays }),
    months: asList(source, 'months', completeMonth, fallback.months),
    ...(epochLabel === '' ? {} : { epochLabel }),
    segments: asList(source, 'segments', completeSegment, fallback.segments),
  };
}

/**
 * Complete a stored draft payload over the version it was based on, field by field.
 *
 * THE RULE, IN ONE SENTENCE: a member with the right TYPE is taken from the draft — `''` and
 * `0` included, because clearing a field is a real edit — and anything missing or wrongly
 * typed falls back to `base`. A draft is unvalidated by construction (`cards/fields.ts`), and
 * this is the function that makes "a corrupt draft falls back rather than throws" true without
 * discarding the half-typed form the draft exists to keep (`db/repository.ts`'s
 * `completeState` is the precedent for exactly this shape of repair).
 */
export function completeWorldData(base: WorldData, raw: unknown): WorldData {
  const source = jsonObject(raw);
  if (source === undefined) return base;
  const rules = memberOf(source, 'rulesOfNature');
  const narrative = memberOf(source, 'narrative');
  const rhythm = memberOf(source, 'timeRhythm');
  return {
    name: asString(source, 'name', base.name),
    premise: asString(source, 'premise', base.premise),
    genre: asStringList(source, 'genre', base.genre),
    era: asString(source, 'era', base.era),
    techOrMagic: asString(source, 'techOrMagic', base.techOrMagic),
    regions: asList(source, 'regions', completeRegion, base.regions),
    factions: asList(source, 'factions', completeFaction, base.factions),
    rulesOfNature: {
      powerSource: asString(rules, 'powerSource', base.rulesOfNature.powerSource),
      limits: asString(rules, 'limits', base.rulesOfNature.limits),
      taboos: asString(rules, 'taboos', base.rulesOfNature.taboos),
    },
    narrative: {
      conflict: asString(narrative, 'conflict', base.narrative.conflict),
      tone: asString(narrative, 'tone', base.narrative.tone),
      themes: asStringList(narrative, 'themes', base.narrative.themes),
      style: asString(narrative, 'style', base.narrative.style),
    },
    calendar: completeCalendar(memberValue(source, 'calendar'), base.calendar),
    startMinute: asNumber(source, 'startMinute', base.startMinute),
    timeRhythm: {
      implicitAdvance: asBoolean(rhythm, 'implicitAdvance', base.timeRhythm.implicitAdvance),
      advanceEveryTurns: asNumber(rhythm, 'advanceEveryTurns', base.timeRhythm.advanceEveryTurns),
      stepMinutes: asNumber(rhythm, 'stepMinutes', base.timeRhythm.stepMinutes),
    },
    openingHooks: asStringList(source, 'openingHooks', base.openingHooks),
    customFields: asStringRecord(source, 'customFields', base.customFields),
  };
}

/* ───────────────────────────── validation (校验) ─────────────────────────── */

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Everything that stands between this payload and a published version.
 *
 * SCHEMA FIRST, ENGINE SECOND, AND NEVER BOTH FOR ONE CAUSE: the engine is consulted only
 * when the payload already satisfies `WorldDataSchema`, so a world whose calendar is missing
 * a month never produces two sentences for one mistake. The engine's own validation is what
 * accepts a 26-hour day and refuses a segment that names an hour the day does not have
 * (`engine/time/calendar.ts`'s `assertSegmentHours`) — this editor does not restate that rule, it
 * reports it.
 */
export function worldIssues(data: WorldData): readonly CardIssue[] {
  const parsed = WorldDataSchema.safeParse(data);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  }
  try {
    calendarView(data.calendar);
  } catch (cause) {
    return [{ path: 'calendar', message: messageOf(cause) }];
  }
  return [];
}

/* ─────────────────────── the form's field inventory (改) ─────────────────── */

/** 基本: the one-line pitch, the era and the tech/magic level. */
export const WORLD_TEXT_FIELDS: readonly TextFieldSpec<WorldData>[] = [
  { key: 'name', label: 'world.nameLabel' },
  { key: 'premise', label: 'world.premiseLabel', multiline: true },
  { key: 'era', label: 'world.eraLabel' },
  { key: 'techOrMagic', label: 'world.techOrMagicLabel', multiline: true },
];

export const WORLD_GENRE_FIELD: StringListFieldSpec<WorldData> = {
  key: 'genre',
  label: 'world.genreLabel',
};

/** 地区: one row per place. */
export const REGION_FIELDS: readonly TextFieldSpec<Region>[] = [
  { key: 'id', label: 'world.regionIdLabel' },
  { key: 'name', label: 'world.regionNameLabel' },
  { key: 'description', label: 'world.regionDescriptionLabel', multiline: true },
  { key: 'parentId', label: 'world.regionParentLabel' },
];

export const REGION_TAGS_FIELD: StringListFieldSpec<Region> = {
  key: 'tags',
  label: 'world.regionTagsLabel',
};

/** 势力: one row per power bloc. */
export const FACTION_FIELDS: readonly TextFieldSpec<Faction>[] = [
  { key: 'id', label: 'world.factionIdLabel' },
  { key: 'name', label: 'world.factionNameLabel' },
  { key: 'description', label: 'world.factionDescriptionLabel', multiline: true },
  { key: 'stance', label: 'world.factionStanceLabel' },
];

export const FACTION_GOALS_FIELD: StringListFieldSpec<Faction> = {
  key: 'goals',
  label: 'world.factionGoalsLabel',
};

/** 规则: what the setting's powers may and may not do. */
export const RULES_FIELDS: readonly TextFieldSpec<WorldData['rulesOfNature']>[] = [
  { key: 'powerSource', label: 'world.powerSourceLabel' },
  { key: 'limits', label: 'world.limitsLabel', multiline: true },
  { key: 'taboos', label: 'world.taboosLabel', multiline: true },
];

/** 叙事: the conflict, its tone and the telling's style (the themes are a list). */
export const NARRATIVE_TEXT_FIELDS: readonly TextFieldSpec<WorldData['narrative']>[] = [
  { key: 'conflict', label: 'world.conflictLabel', multiline: true },
  { key: 'tone', label: 'world.toneLabel' },
  { key: 'style', label: 'world.styleLabel', multiline: true },
];

export const NARRATIVE_THEMES_FIELD: StringListFieldSpec<WorldData['narrative']> = {
  key: 'themes',
  label: 'world.themesLabel',
};

/** 历法: the world's clock face. Every number here is data the time engine divides by. */
export const CALENDAR_TEXT_FIELDS: readonly TextFieldSpec<Calendar>[] = [
  { key: 'id', label: 'world.calendarIdLabel' },
  { key: 'name', label: 'world.calendarNameLabel' },
  { key: 'epochLabel', label: 'world.epochLabelLabel' },
];

export const CALENDAR_NUMBER_FIELDS: readonly NumberFieldSpec<Calendar>[] = [
  { key: 'minutesPerHour', label: 'world.minutesPerHourLabel', integer: true, min: 1 },
  { key: 'hoursPerDay', label: 'world.hoursPerDayLabel', integer: true, min: 1 },
];

export const CALENDAR_WEEKDAYS_FIELD: StringListFieldSpec<Calendar> = {
  key: 'weekdays',
  label: 'world.weekdaysLabel',
};

export const MONTH_TEXT_FIELDS: readonly TextFieldSpec<CalendarMonth>[] = [
  { key: 'name', label: 'world.monthNameLabel' },
];

export const MONTH_NUMBER_FIELDS: readonly NumberFieldSpec<CalendarMonth>[] = [
  { key: 'days', label: 'world.monthDaysLabel', integer: true, min: 1 },
];

export const SEGMENT_TEXT_FIELDS: readonly TextFieldSpec<DaySegment>[] = [
  { key: 'id', label: 'world.segmentIdLabel' },
  { key: 'name', label: 'world.segmentNameLabel' },
];

export const SEGMENT_NUMBER_FIELDS: readonly NumberFieldSpec<DaySegment>[] = [
  { key: 'fromHour', label: 'world.segmentFromLabel', integer: true, min: 0 },
  { key: 'toHour', label: 'world.segmentToLabel', integer: true, min: 0 },
];

/** 时间节奏: where the clock starts, and how it moves without being asked. */
export const START_MINUTE_FIELD: NumberFieldSpec<WorldData> = {
  key: 'startMinute',
  label: 'world.startMinuteLabel',
  integer: true,
};

export const RHYTHM_NUMBER_FIELDS: readonly NumberFieldSpec<WorldData['timeRhythm']>[] = [
  { key: 'advanceEveryTurns', label: 'world.advanceEveryTurnsLabel', integer: true, min: 1 },
  { key: 'stepMinutes', label: 'world.stepMinutesLabel', integer: true, min: 1 },
];

export const RHYTHM_BOOLEAN_FIELDS: readonly BooleanFieldSpec<WorldData['timeRhythm']>[] = [
  { key: 'implicitAdvance', label: 'world.implicitAdvanceLabel' },
];

export const WORLD_OPENING_HOOKS_FIELD: StringListFieldSpec<WorldData> = {
  key: 'openingHooks',
  label: 'world.openingHooksLabel',
};

/**
 * Every payload path this form RENDERS, including the composite groups.
 *
 * WHY A DECLARED LIST AT ALL: 「字段完整」 is an acceptance criterion, and the only way to check
 * it is to compare what the editor claims to cover against the schema itself. `cards/world.test.ts`
 * walks `WorldDataSchema` and fails when a field is in neither this list nor the delegated one,
 * so a schema addition cannot silently leave the editor incomplete.
 */
export const WORLD_FORM_PATHS: readonly string[] = [
  'name',
  'premise',
  'genre',
  'era',
  'techOrMagic',
  'regions',
  'factions',
  'rulesOfNature.powerSource',
  'rulesOfNature.limits',
  'rulesOfNature.taboos',
  'narrative.conflict',
  'narrative.tone',
  'narrative.themes',
  'narrative.style',
  'calendar.id',
  'calendar.name',
  'calendar.minutesPerHour',
  'calendar.hoursPerDay',
  'calendar.weekdays',
  'calendar.epochLabel',
  'calendar.months',
  'calendar.segments',
  'startMinute',
  'timeRhythm.implicitAdvance',
  'timeRhythm.advanceEveryTurns',
  'timeRhythm.stepMinutes',
  'openingHooks',
  'customFields',
];

/**
 * Payload fields the editor does NOT render — and for a world that set is EMPTY.
 *
 * The list exists rather than being left out so the completeness check has one place to look, and
 * so "nothing is delegated" is a checked statement rather than an omission: every member of
 * `WorldData` has exactly one control, `customFields` included. Those are the payload's OWN record
 * (`cards/custom-fields.ts`) — the plugin bag on the version envelope is a different owner's data,
 * which this editor only carries through a draft.
 */
export const WORLD_DELEGATED_PATHS: readonly string[] = [];
