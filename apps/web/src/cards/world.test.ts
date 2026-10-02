/**
 * The world payload as the editor treats it (M1-W1).
 *
 * WHAT THIS FILE IS DEFENDING
 * 1. 「所有字段可增删改」 is checked against the CONTRACT: the form's declared paths must cover
 *    every leaf of `WorldDataSchema` (or delegate it explicitly), and the blank payload a new
 *    world starts from must be one the schema and the time engine both accept.
 * 2. 历法 is judged by the ENGINE (`calendarView`), not by a second rule invented here: a 26-hour
 *    day with a 100-minute hour and a midnight-wrapping segment are legal and stay legal, while a
 *    segment naming an hour the day does not have is refused in the engine's own words.
 * 3. `completeWorldData` is total: a damaged draft falls back field by field — `''` included,
 *    because a cleared field is an edit and not damage — and never throws.
 */
import { calendarView } from '@smarttavern/core';
import { UUID_V7_PATTERN, type WorldData, WorldDataSchema } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { appendItem, jsonObject, removeItem, toJson, withItem } from './fields';
import { leafPaths } from './schema-leaves.test-helpers';
import {
  blankCalendar,
  blankFaction,
  blankMonth,
  blankRegion,
  blankSegment,
  blankWorldData,
  completeWorldData,
  WORLD_DELEGATED_PATHS,
  WORLD_ENVELOPE_PATHS,
  WORLD_FORM_PATHS,
  worldIssues,
} from './world';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const REGION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b04';
const FACTION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b05';

/**
 * A world with EVERY member present, including the optionals.
 *
 * WHY IT IS NOT A 24/60 CALENDAR: the engine's acceptance is that its numbers are data, so the
 * fixture is a 26-hour day with a 100-minute hour and a segment that wraps past midnight. If any
 * of that were "fixed" on the way through the editor, this fixture would stop round-tripping.
 */
const fullWorld: WorldData = {
  name: '霜月群岛',
  premise: '永冬之海上的群岛，灯塔是唯一的光源。',
  genre: ['奇幻', '生存'],
  era: '第三纪 1287 年',
  techOrMagic: '潮汐魔法与风帆技术并存',
  regions: [
    {
      id: REGION_ID,
      name: '银松镇',
      description: '群岛北端的小镇，终年积雪。',
      tags: ['城镇'],
    },
    { id: 'silverpine-keep', name: '银松堡', description: '镇外的旧堡垒。', parentId: REGION_ID },
  ],
  factions: [
    {
      id: FACTION_ID,
      name: '守夜人',
      description: '轮流守灯塔的人。',
      stance: '中立',
      goals: ['点亮灯塔', '记录长夜'],
    },
  ],
  rulesOfNature: { powerSource: '潮汐', limits: '离海越远越弱', taboos: '不得呼唤深海之名' },
  narrative: {
    conflict: '长夜与灯火的拉锯',
    tone: '冷峻克制',
    themes: ['守约', '孤独'],
    style: '第二人称叙述',
  },
  calendar: {
    id: 'frost-calendar',
    name: '霜月历',
    minutesPerHour: 100,
    hoursPerDay: 26,
    weekdays: ['月曜', '火曜'],
    months: [
      { name: '霜月', days: 30 },
      { name: '雪月', days: 31 },
    ],
    epochLabel: '第三纪',
    segments: [
      { id: 'dawn', name: '晨', fromHour: 6, toHour: 12 },
      // Wraps midnight: legal, and the engine flattens it.
      { id: 'night', name: '夜', fromHour: 22, toHour: 6 },
      // The window that runs to the end of the day, written the way `world.ts` documents it.
      { id: 'long-night', name: '长夜', fromHour: 22, toHour: 26 },
    ],
  },
  startMinute: 1_000_000,
  timeRhythm: { implicitAdvance: true, advanceEveryTurns: 5, stepMinutes: 10 },
  openingHooks: ['旅店的灯灭了。'],
  customFields: { 天气: '暴雪' },
};

/* ────────────────────────── field completeness ───────────────────────────── */

describe('the form inventory', () => {
  it('covers every leaf of WorldDataSchema, or delegates it on purpose', () => {
    const declared = new Set([
      ...WORLD_FORM_PATHS,
      ...WORLD_DELEGATED_PATHS,
      ...WORLD_ENVELOPE_PATHS,
    ]);
    const missing = leafPaths(WorldDataSchema).filter((path) => !declared.has(path));
    expect(missing).toEqual([]);
  });

  it('names nothing the payload does not have (a typo is not a rendered field)', () => {
    const leaves = new Set(leafPaths(WorldDataSchema));
    const unknown = [...WORLD_FORM_PATHS, ...WORLD_DELEGATED_PATHS].filter(
      (path) => !leaves.has(path),
    );
    expect(unknown).toEqual([]);
  });

  it('delegates exactly one payload field, and says which', () => {
    // The payload's own `customFields` record: superseded for new data by the envelope's
    // `extensions`, and preserved by hydration rather than edited.
    expect(WORLD_DELEGATED_PATHS).toEqual(['customFields']);
    expect(WORLD_ENVELOPE_PATHS).toEqual(['extensions']);
  });
});

/* ─────────────────────────── the blank payload ───────────────────────────── */

describe('blankWorldData', () => {
  it('starts a new world from a payload the schema and the engine both accept', () => {
    const data = blankWorldData('新世界');
    expect(WorldDataSchema.safeParse(data).success).toBe(true);
    expect(() => calendarView(data.calendar)).not.toThrow();
    expect(worldIssues(data)).toEqual([]);
  });

  it('hands out its own copy of the built-in calendar, never the module constant', () => {
    // `chat/builtin-content.ts` is still what the play screen's clock reads, so an editor that
    // edited it in place would rewrite the running app's own time mapping.
    const copy = blankCalendar();
    copy.months.length = 0;
    copy.segments.push({ id: 'probe', name: 'probe', fromHour: 0, toHour: 1 });
    expect(copy.months).toEqual([]);
    expect(blankCalendar().months.length).toBeGreaterThan(0);
    expect(blankCalendar().segments.some((segment) => segment.id === 'probe')).toBe(false);
    expect(() => calendarView(blankCalendar())).not.toThrow();
  });

  it('mints a v7 id for every row that needs one', () => {
    for (const row of [blankRegion(), blankFaction(), blankSegment()]) {
      expect(UUID_V7_PATTERN.test(row.id), row.id).toBe(true);
    }
    expect(blankMonth()).toEqual({ name: '', days: expect.any(Number) });
  });
});

/* ───────────────────────── 增 / 删 / 改 over lists ───────────────────────── */

describe('the list controls, at the payload level', () => {
  it('appends, edits and removes a region without touching the original payload', () => {
    const base = blankWorldData('w');
    const region = blankRegion();
    const added = { ...base, regions: appendItem(base.regions, region) };
    expect(added.regions).toHaveLength(1);

    const renamed = {
      ...added,
      regions: withItem(added.regions, 0, { ...region, name: '银松镇' }),
    };
    expect(renamed.regions[0]?.name).toBe('银松镇');

    const emptied = { ...renamed, regions: removeItem(renamed.regions, 0) };
    expect(emptied.regions).toEqual([]);
    // ADR-010 applied to the form itself: the value a row already holds never moves.
    expect(base.regions).toEqual([]);
  });

  it('keeps the calendar valid while a new month and segment are being filled in', () => {
    const base = blankWorldData('w');
    const calendar = {
      ...base.calendar,
      // The transitions return `readonly` arrays (they never hand back the input), so a caller that
      // wants a mutable payload copies once — which is also what the editor's `onChange` does.
      months: [...appendItem(base.calendar.months, blankMonth())],
      segments: [...appendItem(base.calendar.segments, blankSegment())],
    };
    // A blank row is a ROW WITHOUT A NAME, which the schema refuses — and that is the state a
    // user is in for one keystroke, so it must be reportable rather than silently accepted.
    expect(WorldDataSchema.safeParse({ ...base, calendar }).success).toBe(false);

    const month = blankMonth();
    const segment = blankSegment();
    const named = {
      ...calendar,
      months: [
        ...withItem(calendar.months, calendar.months.length - 1, { ...month, name: '霜月' }),
      ],
      segments: [
        ...withItem(calendar.segments, calendar.segments.length - 1, {
          ...segment,
          name: '长夜',
          toHour: 6,
        }),
      ],
    };
    expect(WorldDataSchema.safeParse({ ...base, calendar: named }).success).toBe(true);
    expect(worldIssues({ ...base, calendar: named })).toEqual([]);
  });
});

/* ────────────────────────────── validation ───────────────────────────────── */

describe('worldIssues', () => {
  it('accepts a 26-hour day, a 100-minute hour and a midnight-wrapping segment', () => {
    expect(worldIssues(fullWorld)).toEqual([]);
  });

  it('refuses a segment naming an hour the day does not have, in the engine’s words', () => {
    const calendar = {
      ...fullWorld.calendar,
      segments: [
        ...fullWorld.calendar.segments,
        { id: 'late', name: 'late', fromHour: 0, toHour: 27 },
      ],
    };
    const issues = worldIssues({ ...fullWorld, calendar });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('calendar');
    // The engine's own sentence, kept verbatim: the rule is 0..hoursPerDay, not 0..23.
    expect(issues[0]?.message).toContain('toHour');
    expect(issues[0]?.message).toContain('26');
  });

  it('reports the schema problem instead of asking the engine about an invalid payload', () => {
    const issues = worldIssues({ ...fullWorld, calendar: { ...fullWorld.calendar, months: [] } });
    expect(issues.map((issue) => issue.path)).toEqual(['calendar.months']);
  });

  it('reports an empty name, which only the schema refuses', () => {
    expect(worldIssues({ ...fullWorld, name: '' }).map((issue) => issue.path)).toEqual(['name']);
  });

  it('accepts a calendar the engine accepts, built from blanks rather than from the fixture', () => {
    const base = blankWorldData('w');
    const calendar = {
      ...base.calendar,
      minutesPerHour: 100,
      hoursPerDay: 26,
      segments: [
        { id: 'day', name: '昼', fromHour: 6, toHour: 12 },
        { id: 'night', name: '夜', fromHour: 22, toHour: 6 },
      ],
    };
    expect(worldIssues({ ...base, calendar })).toEqual([]);
    expect(() => calendarView(calendar)).not.toThrow();
  });
});

/* ─────────────────────── the tolerant draft reader ───────────────────────── */

describe('completeWorldData', () => {
  it('is total over a payload that survived the JSON round trip', () => {
    // This is what a draft row holds: the payload put through `JSON.stringify` / `parse` by
    // `toJson`. If hydration lost, renamed or coerced one member, this comparison would fail.
    const stored = toJson(fullWorld);
    expect(completeWorldData(blankWorldData('base'), stored)).toEqual(fullWorld);
  });

  it('falls back to the base when the stored payload is not an object at all', () => {
    const base = blankWorldData('base');
    expect(completeWorldData(base, undefined)).toBe(base);
    expect(completeWorldData(base, 'nonsense')).toBe(base);
    expect(completeWorldData(base, [1, 2])).toBe(base);
    expect(completeWorldData(base, null)).toBe(base);
  });

  it('takes a cleared field as an edit and falls back only for the wrong type', () => {
    const base: WorldData = {
      ...blankWorldData('base'),
      premise: 'published premise',
      startMinute: 90,
    };
    const completed = completeWorldData(base, {
      premise: '',
      startMinute: 'soon',
      genre: [1, 'kept'],
      regions: 'not a list',
      narrative: { tone: 5 },
      rulesOfNature: 'not an object',
    });
    expect(completed.premise).toBe('');
    expect(completed.startMinute).toBe(base.startMinute);
    expect(completed.genre).toEqual(['kept']);
    expect(completed.regions).toEqual(base.regions);
    expect(completed.narrative.tone).toBe(base.narrative.tone);
    expect(completed.narrative.conflict).toBe(base.narrative.conflict);
    expect(completed.rulesOfNature).toEqual(base.rulesOfNature);
  });

  it('completes each element of a list and drops what is not an object', () => {
    const base = blankWorldData('base');
    const storedCalendar = jsonObject(toJson(base.calendar)) ?? {};
    const completed = completeWorldData(base, {
      regions: [{ name: '银松镇' }, 'junk', { id: 7, name: '', description: 'kept' }],
      calendar: { ...storedCalendar, months: [{ name: '霜月' }, { name: 5, days: 'x' }] },
    });
    expect(completed.regions).toEqual([
      { id: '', name: '银松镇', description: '' },
      { id: '', name: '', description: 'kept' },
    ]);
    expect(completed.calendar.months).toEqual([
      { name: '霜月', days: 0 },
      { name: '', days: 0 },
    ]);
  });
});
