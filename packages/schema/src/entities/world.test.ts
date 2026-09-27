/**
 * Tests for the world & calendar contract (docs/02 §4, §4.1, §5.7).
 *
 * The cases that matter are the ones ADR-012 depends on:
 * 1. a calendar is *data* — non-24-hour days and midnight-wrapping segments must
 *    parse, because the time engine derives every date from it;
 * 2. `WorldData` itself has no `extensions`; the plugin channel belongs to the
 *    `WorldVersion` / `World` envelope, and these tests pin that down so the
 *    character-card trap (a payload that silently swallows `extensions`) cannot
 *    be repeated here;
 * 3. unknown fields are stripped, never rejected (HANDOFF §4.1 invariant 5).
 */
import { describe, expect, it } from 'vitest';
import { UUID_V7_PATTERN } from '../common';
import { WorldDataSchema, WorldSchema, WorldVersionSchema } from './world';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const WORLD_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b01';
const VERSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b02';
const LINEAGE_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b03';
const REGION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b04';
const FACTION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b05';
const NOW = 1_790_000_000_000;

/** Every optional field is present, so a stripped field is detectable. */
const fullWorld = {
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
    minutesPerHour: 60,
    hoursPerDay: 24,
    weekdays: ['月曜', '火曜'],
    months: [
      { name: '霜月', days: 30 },
      { name: '雪月', days: 31 },
    ],
    epochLabel: '第三纪',
    segments: [
      { id: 'dawn', name: '晨', fromHour: 6, toHour: 12 },
      { id: 'day', name: '昼', fromHour: 12, toHour: 18 },
      // Wraps midnight: legal, and the time engine has to cope with it.
      { id: 'night', name: '夜', fromHour: 22, toHour: 6 },
    ],
  },
  startMinute: 1_000_000,
  timeRhythm: { implicitAdvance: true, advanceEveryTurns: 5, stepMinutes: 10 },
  openingHooks: ['旅店的灯灭了。'],
  customFields: { 天气: '暴雪' },
};

const worldVersion = {
  id: VERSION_ID,
  worldId: WORLD_ID,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  data: fullWorld,
};

const worldHead = {
  id: WORLD_ID,
  name: '霜月群岛',
  headVersion: 1,
  tags: ['奇幻'],
  createdAt: NOW,
  updatedAt: NOW,
};

/* ──────────────────────────────── helpers ────────────────────────────────── */

type Parseable = { safeParse: (value: unknown) => { success: boolean } };

/** Required-field driver: deleting any listed field must make the parse fail. */
function expectRequired(schema: Parseable, fixture: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const broken: Record<string, unknown> = { ...fixture };
    delete broken[field];
    expect(`${field}:${schema.safeParse(broken).success}`).toBe(`${field}:false`);
  }
}

/** A schema with no `extensions` of its own still strips the key silently. */
function expectExtensionFree(schema: Parseable, fixture: Record<string, unknown>) {
  const parsed = schema.safeParse({ ...fixture, extensions: { 'x-mythos.sanity': 9 } });
  expect(parsed.success).toBe(true);
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('world data', () => {
  it('parses a fully populated world', () => {
    expect(WorldDataSchema.safeParse(fullWorld).success).toBe(true);
  });

  it('parses a minimal world (every top-level field is required, but may be empty)', () => {
    const minimal = {
      name: '空白世界',
      premise: '',
      genre: [],
      era: '',
      techOrMagic: '',
      regions: [],
      factions: [],
      rulesOfNature: { powerSource: '', limits: '', taboos: '' },
      narrative: { conflict: '', tone: '', themes: [], style: '' },
      calendar: {
        id: 'stub',
        name: '默认历',
        minutesPerHour: 60,
        hoursPerDay: 24,
        months: [{ name: '元月', days: 1 }],
        segments: [],
      },
      startMinute: 0,
      timeRhythm: { implicitAdvance: false, advanceEveryTurns: 1, stepMinutes: 1 },
      openingHooks: [],
      customFields: {},
    };
    expect(WorldDataSchema.safeParse(minimal).success).toBe(true);
    // Only `name` has a content constraint on top of being required.
    expect(WorldDataSchema.safeParse({ ...minimal, name: '' }).success).toBe(false);
  });

  it('rejects a world missing any required top-level field', () => {
    expectRequired(WorldDataSchema, fullWorld, [
      'name',
      'premise',
      'genre',
      'era',
      'techOrMagic',
      'regions',
      'factions',
      'rulesOfNature',
      'narrative',
      'calendar',
      'startMinute',
      'timeRhythm',
      'openingHooks',
      'customFields',
    ]);
  });

  it('rejects a world whose nested required field is missing', () => {
    const cases: [string, unknown][] = [
      [
        'rulesOfNature.taboos',
        { ...fullWorld, rulesOfNature: { powerSource: '潮汐', limits: '弱' } },
      ],
      ['narrative.themes', { ...fullWorld, narrative: { conflict: 'a', tone: 'b', style: 'c' } }],
      ['calendar.name', { ...fullWorld, calendar: { ...fullWorld.calendar, name: undefined } }],
      [
        'calendar.months[].days',
        {
          ...fullWorld,
          calendar: { ...fullWorld.calendar, months: [{ name: '霜月' }] },
        },
      ],
      ['timeRhythm.stepMinutes', { ...fullWorld, timeRhythm: { implicitAdvance: false } }],
      ['regions[].id', { ...fullWorld, regions: [{ name: '无名', description: 'x' }] }],
      ['factions[].goals', { ...fullWorld, factions: [{ id: 'f', name: '派', description: 'x' }] }],
    ];
    for (const [label, broken] of cases) {
      expect(`${label}:${WorldDataSchema.safeParse(broken).success}`).toBe(`${label}:false`);
    }
  });

  it('rejects out-of-range calendar values instead of clamping them', () => {
    const calendar = (patch: Record<string, unknown>) => ({
      ...fullWorld,
      calendar: { ...fullWorld.calendar, ...patch },
    });
    expect(WorldDataSchema.safeParse(calendar({ minutesPerHour: 0 })).success).toBe(false);
    expect(WorldDataSchema.safeParse(calendar({ hoursPerDay: -24 })).success).toBe(false);
    expect(WorldDataSchema.safeParse(calendar({ months: [] })).success).toBe(false);
    expect(
      WorldDataSchema.safeParse(calendar({ months: [{ name: '霜月', days: 0 }] })).success,
    ).toBe(false);
    // Segments are data, so an unmodelled day is valid and a wrapped one is too.
    expect(WorldDataSchema.safeParse(calendar({ segments: [] })).success).toBe(true);
    // An epoch minute is any integer: 0 and negatives are a valid epoch.
    expect(WorldDataSchema.safeParse({ ...fullWorld, startMinute: 0 }).success).toBe(true);
    expect(WorldDataSchema.safeParse({ ...fullWorld, startMinute: -1440 }).success).toBe(true);
    expect(WorldDataSchema.safeParse({ ...fullWorld, startMinute: 1.5 }).success).toBe(false);
  });

  it('rejects a zero-length time step, which would advance by nothing forever', () => {
    const rhythm = (patch: Record<string, unknown>) => ({
      ...fullWorld,
      timeRhythm: { ...fullWorld.timeRhythm, ...patch },
    });
    expect(WorldDataSchema.safeParse(rhythm({ stepMinutes: 0 })).success).toBe(false);
    expect(WorldDataSchema.safeParse(rhythm({ advanceEveryTurns: 0 })).success).toBe(false);
    expect(WorldDataSchema.safeParse(rhythm({ implicitAdvance: 'yes' })).success).toBe(false);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    const parsed = WorldDataSchema.parse({ ...fullWorld, someFutureField: 1 });
    expect(parsed).not.toHaveProperty('someFutureField');
    expect(parsed.name).toBe(fullWorld.name);
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(WorldDataSchema.parse(fullWorld));
    const twice = JSON.stringify(WorldDataSchema.parse(JSON.parse(once)));
    expect(twice).toBe(once);
  });

  it('has no plugin channel of its own, because the envelope owns it', () => {
    expect(Object.keys(WorldDataSchema.shape)).not.toContain('extensions');
    expectExtensionFree(WorldDataSchema, fullWorld);
  });
});

describe('world version envelope', () => {
  it('parses a first version and requires the worldId back-pointer', () => {
    expect(WorldVersionSchema.safeParse(worldVersion).success).toBe(true);
    expectRequired(WorldVersionSchema, worldVersion, [
      'id',
      'worldId',
      'version',
      'createdAt',
      'updatedAt',
      'data',
    ]);
  });

  it('anchors the world id and the version id to UUIDv7', () => {
    for (const id of [WORLD_ID, VERSION_ID, LINEAGE_ID, REGION_ID, FACTION_ID]) {
      expect(`${id}:${UUID_V7_PATTERN.test(id)}`).toBe(`${id}:true`);
    }
    // version nibble 4 — a UUIDv4 would lose time ordering.
    const v4 = '0192f0a1-7c3d-4a4e-9b21-5c8f0d3a1b01';
    expect(WorldVersionSchema.safeParse({ ...worldVersion, worldId: v4 }).success).toBe(false);
    expect(WorldVersionSchema.safeParse({ ...worldVersion, version: 0 }).success).toBe(false);
  });

  it('records lineage for an iteration and round-trips it', () => {
    const second = {
      ...worldVersion,
      id: '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b06',
      version: 2,
      lineage: { parentId: VERSION_ID, parentVersion: 1, reason: '补一页日历', at: NOW + 1000 },
    };
    const parsed = WorldVersionSchema.parse(second);
    expect(parsed.lineage?.parentVersion).toBe(1);
    expect(JSON.stringify(WorldVersionSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
  });

  it('strips unknown fields on the envelope too', () => {
    const parsed = WorldVersionSchema.parse({ ...worldVersion, someFutureField: 1 });
    expect(parsed).not.toHaveProperty('someFutureField');
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...worldVersion, extensions: { 'x-mythos.clock': { drift: -3 } } };
    const parsed = WorldVersionSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.clock': { drift: -3 } });
    expect(JSON.stringify(WorldVersionSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(
      WorldVersionSchema.safeParse({ ...worldVersion, extensions: { drift: -3 } }).success,
    ).toBe(false);
  });
});

describe('world head row', () => {
  it('reuses the shared head-row contract and keeps plugin data on it', () => {
    const withExtension = { ...worldHead, extensions: { 'x-mythos.mood': 'grim' } };
    const parsed = WorldSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.mood': 'grim' });
    expectRequired(WorldSchema, worldHead, [
      'id',
      'name',
      'headVersion',
      'tags',
      'createdAt',
      'updatedAt',
    ]);
    expect(WorldSchema.safeParse({ ...worldHead, headVersion: 0 }).success).toBe(false);
    expect(WorldSchema.safeParse({ ...worldHead, id: 'frost-realms' }).success).toBe(false);
    expect(WorldSchema.safeParse({ ...worldHead, extensions: { mood: 'grim' } }).success).toBe(
      false,
    );
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    const once = JSON.stringify(WorldSchema.parse({ ...worldHead, someFutureField: 1 }));
    expect(JSON.parse(once)).not.toHaveProperty('someFutureField');
    expect(JSON.stringify(WorldSchema.parse(JSON.parse(once)))).toBe(once);
  });
});
