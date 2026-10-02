/**
 * The M1-I2 acceptance suite (`docs/06-开发任务拆解.md` §2.6): "导入示例包即可开始一局".
 *
 * ONE TEST PER NAMED PROPERTY, so a red run names the promise that broke:
 *
 *   1. build → import        per-kind counts equal the rows the import really made
 *   2. import → export → import  is a fixed point (deep equality, then the bytes)
 *   3. EACH of the pack's two worlds declares its OWN calendar, neither of them the
 *                            built-in one, and the real `TimeEngine` maps each
 *                            world's `startMinute` with the right one
 *   4. a session started from the imported pack pins the versions THE LIBRARY HOLDS
 *                            and takes its `initialClock` from the world — for the
 *                            full setting and for the short scenario alike
 *   5. ...even when the import had to REMAP a world (an id/name conflict), which is
 *                            why the pins are looked up and not assumed
 *   6. every worldbook `timeOfDay` names one of ITS OWN world's segments, the engine
 *                            reaches it, and every segment of both worlds is used
 *   7. there is no rule-pack and no preset payload, ref or count: both halves of
 *                            §2.6 are BLOCKED (no schema, no rows), not faked
 *   8. building it twice is byte-identical (source wins; the pack is reproducible)
 *
 * WHY THE ROW LEVEL AND NOT THE UI: `apps/web` is not this task's to change, so the
 * acceptance "you can start playing after importing it" is proved where it can be
 * proved — the imported rows satisfy their schemas, a session row built from them
 * pins those rows, and its clock comes from the world. Everything here runs through
 * the REAL `importPackage` and a `StorageAdapter`; only the container is the
 * port-level double (`docs/04` §2's ZIP is `@smarttavern/packages`, which this
 * package may not import — `tools/stpack-cli/src/example.test.ts` runs the same pack
 * through the real container).
 */
import {
  COLLECTIONS,
  calendarView,
  display,
  minuteAtHourOfDay,
  resolvedSegmentsOf,
  segmentOf,
} from '@smarttavern/core';
import {
  type CharacterVersion,
  type PackageCounts,
  type Session,
  SessionSchema,
  type World,
  type WorldbookEntry,
  WorldbookEntrySchema,
  type WorldVersion,
  WorldVersionSchema,
} from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { deepEqual } from '../deep-equal';
import { emptyLibrary, importInto, memoryWriter } from '../testing/harness';
import { decodeContainer } from '../testing/memory-package';
import type { MemoryStorageAdapter } from '../testing/memory-storage';
import {
  EXAMPLE_CALENDARS,
  EXAMPLE_CHARACTER_KEYS,
  EXAMPLE_CREATED_AT,
  EXAMPLE_IDS,
  EXAMPLE_LAST_FERRY_ROSTER,
  EXAMPLE_LICENSE,
  EXAMPLE_PACK_NAME,
  EXAMPLE_PACKAGE_ID,
  EXAMPLE_START_MINUTES,
  EXAMPLE_WORLD_KEYS,
  seedExampleLibrary,
} from './content';
import { buildExampleContentPack, exportContentPack } from './content-pack';
import { exampleStartSession } from './start-session';

/** The one row a `[0]` would hide behind a type error, or a loud test failure. */
function only<T>(rows: readonly T[]): T {
  expect(rows).toHaveLength(1);
  const first = rows[0];
  if (first === undefined) throw new Error('expected exactly one row');
  return first;
}

/** Rows in a stable order, so a comparison cannot pass (or fail) on insert order. */
function byId<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** The collections the pack writes, i.e. everything its fixed point has to preserve. */
const IMPORTED_COLLECTIONS = [
  COLLECTIONS.worlds,
  COLLECTIONS.worldVersions,
  COLLECTIONS.worldbookEntries,
  COLLECTIONS.characters,
  COLLECTIONS.characterVersions,
] as const;

/** Every `contents.counts` key, so a count that is wrong in EITHER direction shows. */
const EXPECTED_COUNTS: PackageCounts = {
  worlds: 2,
  worldbooks: 8,
  characters: 4,
  promptPresets: 0,
  rulePacks: 0,
  themes: 0,
  sessions: 0,
  messages: 0,
  checkpoints: 0,
  agenda: 0,
  memories: 0,
  assets: 0,
};

/** Two worlds + four cards + one worldbook entry per segment per world. */
const EXPECTED_CREATED = 2 + 4 + 8;

/** The built example pack imported into a fresh library, ready for a property. */
async function importedExample(): Promise<{
  readonly library: MemoryStorageAdapter;
  readonly bytes: Uint8Array;
}> {
  const pack = await buildExampleContentPack({ writer: memoryWriter() });
  const library = emptyLibrary();
  const report = await importInto(library, pack.bytes);
  expect(report.ok).toBe(true);
  return { library, bytes: pack.bytes };
}

/** One example world as the LIBRARY holds it, after the import. */
interface ImportedWorld {
  readonly head: World;
  readonly version: WorldVersion;
  readonly worldbook: WorldbookEntry[];
}

function importedWorld(library: MemoryStorageAdapter, worldId: string): ImportedWorld {
  return {
    head: only(library.peek<World>(COLLECTIONS.worlds).filter((row) => row.id === worldId)),
    version: only(
      library
        .peek<WorldVersion>(COLLECTIONS.worldVersions)
        .filter((row) => row.worldId === worldId),
    ),
    worldbook: library
      .peek<WorldbookEntry>(COLLECTIONS.worldbookEntries)
      .filter((row) => row.worldId === worldId),
  };
}

/** The `modelConfig` a session needs; the app owns this value, so the test passes one. */
const MODEL_CONFIG = {
  provider: 'mock',
  model: 'mock-1',
  params: { temperature: 0.8, topP: 0.9 },
} as const;

/**
 * The preset pin. `packages/importers` may not import `apps/web`, and the only
 * preset in M1 is that app's built-in constant
 * (`apps/web/src/chat/builtin-content.ts` `BUILTIN_PRESET_ID = 'builtin-default'`,
 * version 1); `apps/web/src/db/session.test-helpers.ts` repeats the same literal for
 * the same reason.
 */
const BUILTIN_PRESET_PIN = { id: 'builtin-default', version: 1 } as const;

const START_TIME = new Date('2026-09-27T10:00:00.000Z');

describe('M1-I2 example content pack', () => {
  it('build → import: the manifest counts equal the rows the import created, and every row satisfies its schema', async () => {
    const pack = await buildExampleContentPack({ writer: memoryWriter() });
    expect(pack.kind).toBe('bundle');
    expect(pack.warnings).toEqual([]);
    expect(pack.manifest.contents.counts).toEqual(EXPECTED_COUNTS);

    const library = emptyLibrary();
    const report = await importInto(library, pack.bytes);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({
      created: EXPECTED_CREATED,
      reused: 0,
      remapped: 0,
      skipped: 0,
    });
    // Two worlds, four cards and eight worldbook entries — every entity named.
    expect(
      report.entities.map((entity) => `${entity.entity}:${entity.name ?? '-'}`).sort(),
    ).toEqual(
      [
        'character:沈砚',
        'character:陶三娘',
        'character:阿梧',
        'character:渡伯',
        'world:长日港',
        'world:末班渡',
        ...Array.from({ length: 8 }, () => 'worldbook:-'),
      ].sort(),
    );

    // The counts promise the same numbers the library actually holds.
    expect(library.size(COLLECTIONS.worlds)).toBe(EXPECTED_COUNTS.worlds);
    expect(library.size(COLLECTIONS.worldVersions)).toBe(EXPECTED_COUNTS.worlds);
    expect(library.size(COLLECTIONS.worldbookEntries)).toBe(EXPECTED_COUNTS.worldbooks);
    expect(library.size(COLLECTIONS.characters)).toBe(EXPECTED_COUNTS.characters);
    expect(library.size(COLLECTIONS.characterVersions)).toBe(EXPECTED_COUNTS.characters);

    // Parse-then-compare: a row that fails its schema throws here, and a field the
    // schema would STRIP makes the comparison fail instead of passing quietly.
    expect(WorldVersionSchema.array().parse(library.peek(COLLECTIONS.worldVersions))).toEqual(
      library.peek(COLLECTIONS.worldVersions),
    );
    expect(WorldbookEntrySchema.array().parse(library.peek(COLLECTIONS.worldbookEntries))).toEqual(
      library.peek(COLLECTIONS.worldbookEntries),
    );
    expect(
      library.peek<WorldVersion>(COLLECTIONS.worldVersions).map((row) => row.data.name),
    ).toEqual(['长日港', '末班渡']);
    expect(
      library.peek<WorldbookEntry>(COLLECTIONS.worldbookEntries).map((entry) => entry.keywords[0]),
    ).toEqual(['潮起', '长昼', '潮落', '静夜', '候船', '灯下', '雾', '将晓']);
  });

  it('import → export → import is a fixed point: the rows deep-equal, and so do the bytes', async () => {
    const first = await buildExampleContentPack({ writer: memoryWriter() });
    const afterFirstImport = emptyLibrary();
    expect((await importInto(afterFirstImport, first.bytes)).ok).toBe(true);

    // The second build reads the rows the IMPORT wrote — derived heads included — and
    // is given the same identity and the same manifest prose, so the pack is its own
    // fixed point rather than a second artifact that merely looks similar.
    const again = await exportContentPack({
      storage: afterFirstImport,
      writer: memoryWriter(),
      worldIds: EXAMPLE_WORLD_KEYS.map((key) => EXAMPLE_IDS.worlds[key].id),
      characterIds: EXAMPLE_CHARACTER_KEYS.map((key) => EXAMPLE_IDS.characters[key].id),
      name: EXAMPLE_PACK_NAME,
      id: EXAMPLE_PACKAGE_ID,
      createdAt: EXAMPLE_CREATED_AT,
      license: EXAMPLE_LICENSE,
      tags: [...(first.manifest.tags ?? [])],
      ...(first.manifest.description === undefined
        ? {}
        : { description: first.manifest.description }),
    });

    const afterSecondImport = emptyLibrary();
    const report = await importInto(afterSecondImport, again.bytes);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({
      created: EXPECTED_CREATED,
      reused: 0,
      remapped: 0,
      skipped: 0,
    });

    for (const collection of IMPORTED_COLLECTIONS) {
      expect(
        deepEqual(
          byId(afterFirstImport.peek(collection)),
          byId(afterSecondImport.peek(collection)),
        ),
        `${collection} differs after import → export → import`,
      ).toBe(true);
    }

    // The strongest form of "nothing drifted": the same container bytes, which is the
    // form `round-trip.test.ts` uses for the session and world exporters.
    expect(again.bytes).toEqual(first.bytes);
  });

  it('gives each world its own calendar, neither of them the built-in one, and the engine maps each start minute with the right one', async () => {
    const { library } = await importedExample();
    const longday = importedWorld(library, EXAMPLE_IDS.worlds.longdayHarbour.id);
    const ferry = importedWorld(library, EXAMPLE_IDS.worlds.lastFerry.id);

    // What each world DECLARES (the source constants)...
    expect(EXAMPLE_CALENDARS.longdayHarbour).toMatchObject({
      minutesPerHour: 100,
      hoursPerDay: 26,
    });
    expect(EXAMPLE_CALENDARS.lastFerry).toMatchObject({ minutesPerHour: 45, hoursPerDay: 20 });

    // ...and what the real engine derives from the IMPORTED rows.
    const longdayView = calendarView(longday.version.data.calendar);
    expect({
      minutesPerHour: longdayView.minutesPerHour,
      hoursPerDay: longdayView.hoursPerDay,
      minutesPerDay: longdayView.minutesPerDay,
      daysPerYear: longdayView.daysPerYear,
    }).toEqual({ minutesPerHour: 100, hoursPerDay: 26, minutesPerDay: 2600, daysPerYear: 185 });

    const ferryView = calendarView(ferry.version.data.calendar);
    expect({
      minutesPerHour: ferryView.minutesPerHour,
      hoursPerDay: ferryView.hoursPerDay,
      minutesPerDay: ferryView.minutesPerDay,
      daysPerYear: ferryView.daysPerYear,
    }).toEqual({ minutesPerHour: 45, hoursPerDay: 20, minutesPerDay: 900, daysPerYear: 45 });

    // The app's built-in calendar is 60 x 24 = 1440 minutes a day
    // (`apps/web/src/chat/builtin-content.ts`). Reading it here cannot go unnoticed:
    // the day is nearly twice as long in one world and nearly a third in the other.
    for (const world of [longday, ferry]) {
      const view = calendarView(world.version.data.calendar);
      expect(view.minutesPerDay).not.toBe(60 * 24);
      expect(view.hoursPerDay).not.toBe(24);
    }
    // ...and the two worlds are not each other's calendar either: reading the WRONG
    // ONE of the two would still print a date this world never had.
    expect(longdayView.minutesPerDay).not.toBe(ferryView.minutesPerDay);

    const partsOf = (world: ImportedWorld): Record<string, unknown> => {
      const parts = display(world.version.data.calendar, world.version.data.startMinute);
      return {
        minute: parts.minute,
        year: parts.year,
        monthName: parts.monthName,
        day: parts.day,
        hour: parts.hour,
        minuteOfHour: parts.minuteOfHour,
        minutesPerHour: parts.minutesPerHour,
        hoursPerDay: parts.hoursPerDay,
        segments: parts.segments.map((segment) => segment.id),
      };
    };

    // 长日港 opens inside 静夜, the segment that wraps past the end of its 26-hour day.
    expect(partsOf(longday)).toEqual({
      minute: EXAMPLE_START_MINUTES.longdayHarbour,
      year: 1,
      monthName: '潮月',
      day: 3,
      hour: 22,
      minuteOfHour: 40,
      minutesPerHour: 100,
      hoursPerDay: 26,
      segments: ['still-night'],
    });
    // 末班渡 opens inside 雾起, a third of the way into its 45-minute hour.
    expect(partsOf(ferry)).toEqual({
      minute: EXAMPLE_START_MINUTES.lastFerry,
      year: 1,
      monthName: '候潮月',
      day: 2,
      hour: 11,
      minuteOfHour: 30,
      minutesPerHour: 45,
      hoursPerDay: 20,
      segments: ['fog'],
    });
  });

  it('a session started from the imported pack pins the imported versions and takes its clock from the world', async () => {
    const { library } = await importedExample();
    const start = await exampleStartSession(library, {
      modelConfig: MODEL_CONFIG,
      promptPreset: BUILTIN_PRESET_PIN,
      id: 'session-example',
      now: () => START_TIME,
    });
    const { session } = start;

    // The pins name the rows that landed in the library...
    expect(session.refs.world).toEqual({
      id: EXAMPLE_IDS.worlds.longdayHarbour.id,
      version: 1,
    });
    expect(session.refs.playerCharacter).toEqual({
      id: EXAMPLE_IDS.characters.shenYan.id,
      version: 1,
    });
    expect(session.refs.cast).toEqual([{ id: EXAMPLE_IDS.characters.taoSanniang.id, version: 1 }]);
    expect(session.refs.promptPreset).toEqual(BUILTIN_PRESET_PIN);
    expect(session.refs.modelConfig).toEqual(MODEL_CONFIG);
    // ...and `rulePack` stays ABSENT rather than naming a pack that does not exist
    // (M1-S1's decision; the rule-pack half is blocked — see the last-but-one test).
    expect(session.refs.rulePack).toBeUndefined();

    // The clock is the world's own `startMinute` (ADR-012), copied into the session
    // and into its live state at the same moment.
    expect(session.initialClock).toBe(start.worldVersion.data.startMinute);
    expect(session.initialClock).toBe(EXAMPLE_START_MINUTES.longdayHarbour);
    expect(session.state.clock).toBe(session.initialClock);
    expect(session.state.scene.time).toBe(session.initialClock);
    expect(session.title).toBe('长日港');
    expect(session.headMessageId).toBeNull();
    expect(session.schedulerMode).toBe('rules');
    expect(session.createdAt).toBe(START_TIME.getTime());

    // A pin that resolves to a row is what "the data path works" means: the three
    // pinned versions are the rows in this library, at the pinned version numbers.
    expect(
      only(
        library
          .peek<WorldVersion>(COLLECTIONS.worldVersions)
          .filter(
            (row) =>
              row.worldId === session.refs.world.id && row.version === session.refs.world.version,
          ),
      ),
    ).toEqual(start.worldVersion);
    // Every pinned card resolves to a version row of a card the pack actually carries.
    const packCardIds = EXAMPLE_CHARACTER_KEYS.map((key) => EXAMPLE_IDS.characters[key].id);
    expect(start.castVersions.map((row) => row.characterId)).toEqual(
      session.refs.cast.map((pin) => pin.id),
    );
    for (const pin of [session.refs.playerCharacter, ...session.refs.cast]) {
      const pinned = only(
        library
          .peek<CharacterVersion>(COLLECTIONS.characterVersions)
          .filter((row) => row.characterId === pin.id && row.version === pin.version),
      );
      expect(packCardIds).toContain(pinned.characterId);
    }

    // And the row can be stored and read back: `SessionSchema` already validated it,
    // so re-parsing is the round trip a database write would perform.
    library.seed(COLLECTIONS.sessions, [session]);
    const stored = only(library.peek<Session>(COLLECTIONS.sessions));
    expect(SessionSchema.parse(stored)).toEqual(session);
    expect(stored.initialClock).toBe(EXAMPLE_START_MINUTES.longdayHarbour);
  });

  it('the short scenario starts from ITS OWN world and clock, so one pack serves both kinds of session', async () => {
    const { library } = await importedExample();
    const start = await exampleStartSession(library, {
      modelConfig: MODEL_CONFIG,
      promptPreset: BUILTIN_PRESET_PIN,
      roster: EXAMPLE_LAST_FERRY_ROSTER,
      now: () => START_TIME,
    });

    expect(start.session.refs.world).toEqual({ id: EXAMPLE_IDS.worlds.lastFerry.id, version: 1 });
    expect(start.session.refs.playerCharacter).toEqual({
      id: EXAMPLE_IDS.characters.awu.id,
      version: 1,
    });
    expect(start.session.refs.cast).toEqual([{ id: EXAMPLE_IDS.characters.duBo.id, version: 1 }]);
    expect(start.session.title).toBe('末班渡');
    // The clock comes from the SHORT SCENARIO's calendar, not from the other world's:
    // 1425 minutes in a 900-minute day is hour 11 of 20, minute 30 of 45.
    expect(start.session.initialClock).toBe(EXAMPLE_START_MINUTES.lastFerry);
    expect(start.worldVersion.data.calendar.hoursPerDay).toBe(20);
    expect(start.session.state.clock).toBe(EXAMPLE_START_MINUTES.lastFerry);
  });

  it('pins the version that actually landed in the library when the import had to remap a world', async () => {
    const pack = await buildExampleContentPack({ writer: memoryWriter() });
    const library = emptyLibrary();
    // A local world that already carries the pack's id and a DIFFERENT premise: the
    // conflict `docs/04` §7 resolves by minting a new id for what arrives.
    await seedExampleLibrary(library);
    const localVersion = only(
      library
        .peek<WorldVersion>(COLLECTIONS.worldVersions)
        .filter((row) => row.worldId === EXAMPLE_IDS.worlds.longdayHarbour.id),
    );
    const localWorld = {
      ...localVersion,
      data: { ...localVersion.data, premise: '本地改过的前提。' },
    };
    library.seed(COLLECTIONS.worldVersions, [localWorld]);

    const report = await importInto(library, pack.bytes);
    expect(report.ok).toBe(true);
    // The scenario, in one line: the second world and all four cards are identical and
    // get REUSED, while 长日港 and its four worldbook entries (whose `worldId` follows
    // the remap) arrive under fresh ids.
    expect(report.counts).toEqual({ created: 0, reused: 9, remapped: 5, skipped: 0 });
    const worldDecision = report.entities.find(
      (entity) =>
        entity.entity === 'world' && entity.packageId === EXAMPLE_IDS.worlds.longdayHarbour.id,
    );
    expect(worldDecision?.action).toBe('remapped');
    const importedWorldId = worldDecision?.id;
    expect(importedWorldId).toBeDefined();
    expect(importedWorldId).not.toBe(EXAMPLE_IDS.worlds.longdayHarbour.id);

    const start = await exampleStartSession(library, {
      modelConfig: MODEL_CONFIG,
      promptPreset: BUILTIN_PRESET_PIN,
      now: () => START_TIME,
    });

    // The session pins what the IMPORT put in the library — not the id the pack
    // carried, and not the world the user already had under that id.
    expect(start.session.refs.world.id).toBe(importedWorldId);
    expect(start.worldVersion.worldId).toBe(importedWorldId);
    expect(start.worldVersion.data.premise).toContain('一天有二十六个小时');
    // The user's own row is untouched, premise and all (docs/04 §7: never overwrite).
    expect(
      only(
        library
          .peek<WorldVersion>(COLLECTIONS.worldVersions)
          .filter((row) => row.worldId === EXAMPLE_IDS.worlds.longdayHarbour.id),
      ).data.premise,
    ).toBe('本地改过的前提。');
    // The cards were identical, so they were REUSED under their own ids — which is why
    // the player pin still names the pack's card.
    expect(start.session.refs.playerCharacter).toEqual({
      id: EXAMPLE_IDS.characters.shenYan.id,
      version: 1,
    });

    // A session started in the OTHER world is unaffected by that conflict.
    const ferry = await exampleStartSession(library, {
      modelConfig: MODEL_CONFIG,
      promptPreset: BUILTIN_PRESET_PIN,
      roster: EXAMPLE_LAST_FERRY_ROSTER,
      now: () => START_TIME,
    });
    expect(ferry.session.refs.world).toEqual({ id: EXAMPLE_IDS.worlds.lastFerry.id, version: 1 });
  });

  it('every worldbook timeOfDay names a segment of ITS OWN world, the engine reaches it, and every segment is spoken for', async () => {
    const { library } = await importedExample();

    for (const key of EXAMPLE_WORLD_KEYS) {
      const world = importedWorld(library, EXAMPLE_IDS.worlds[key].id);
      const calendar = world.version.data.calendar;
      const view = calendarView(calendar);
      const segments = resolvedSegmentsOf(calendar, view.hoursPerDay);
      const declared = new Set(calendar.segments.map((segment) => segment.id));
      const used = new Set<string>();

      // One entry per segment, so the two sets below have to match exactly.
      expect(world.worldbook).toHaveLength(4);
      for (const entry of world.worldbook) {
        const named = entry.conditions.timeOfDay;
        expect(named, `${entry.id} carries no timeOfDay condition`).toBeDefined();
        if (named === undefined) continue;
        // (a) the id is one THIS calendar declares — a typo dies here, and a segment id
        // borrowed from the other world dies here too, which is the second-world case...
        expect(declared.has(named), `${entry.id} names unknown segment ${named}`).toBe(true);
        used.add(named);
        // ...and (b) `segmentOf`, the lookup a worldbook condition actually performs,
        // reaches it from the segment's own first hour. 长日港's 静夜 is the wrapping
        // window, so this also exercises the overnight branch of that lookup.
        const segment = calendar.segments.find((candidate) => candidate.id === named);
        expect(segment).toBeDefined();
        if (segment === undefined) continue;
        const minute = minuteAtHourOfDay(view, 0, segment.fromHour);
        expect(segmentOf(view, segments, minute)?.id).toBe(named);
      }

      // Every segment an editor can click is a segment the example proves is reachable.
      expect([...used].sort(), `${key} leaves a segment unused`).toEqual([...declared].sort());
    }
  });

  it('carries no rule-pack and no preset payload, ref or count: both halves of §2.6 are blocked, not faked', async () => {
    const pack = await buildExampleContentPack({ writer: memoryWriter() });
    const paths = pack.manifest.entries.map((entry) => entry.path);

    // §2.6's row asks for a rule pack and two presets. Neither can exist yet, and the
    // honest answer is a zero plus an explanation, not a fabricated row.
    expect(pack.manifest.contents.counts.rulePacks).toBe(0);
    expect(pack.manifest.contents.counts.promptPresets).toBe(0);
    expect(paths).not.toContain('data/rulepacks.json');
    expect(paths).not.toContain('data/promptPresets.json');
    expect(pack.manifest.schemaVersions.rulepack).toBeUndefined();
    expect(pack.manifest.schemaVersions.promptPreset).toBeUndefined();
    expect((pack.manifest.refs ?? []).some((ref) => ref.kind === 'rulepack')).toBe(false);
    expect((pack.manifest.refs ?? []).some((ref) => ref.kind === 'prompt-preset')).toBe(false);

    // The pack declares what it embeds (docs/04 §4) and nothing else: two worlds and
    // four cards, all `embedded`, none `required`.
    expect(pack.manifest.refs?.map((ref) => `${ref.kind}:${ref.requirement}`)).toEqual([
      'character:embedded',
      'character:embedded',
      'character:embedded',
      'character:embedded',
      'world:embedded',
      'world:embedded',
    ]);

    // And the artifact says so itself, so a person reading the pack learns why rather
    // than wondering whether something was dropped.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      decodeContainer(pack.bytes).get('README.txt'),
    );
    expect(text).toContain('data/rulepacks.json');
    expect(text).toContain('data/promptPresets.json');
    expect(text).toContain('rulePacks count of 0');
    expect(text).toContain('promptPresets is 0');
    // ...and the README describes BOTH worlds with THEIR OWN numbers, which is what a
    // reader needs to tell the full setting and the short scenario apart.
    expect(text).toContain('worlds: 2');
    expect(text).toContain('长日港 — 26 hours per day, 100 minutes per hour');
    expect(text).toContain('末班渡 — 20 hours per day, 45 minutes per hour');
    expect(text).toContain('still-night');
    expect(text).toContain('firstlight');

    // The import report agrees: nothing was skipped, because nothing rule-pack- or
    // preset-shaped was ever in the package.
    const library = emptyLibrary();
    const report = await importInto(library, pack.bytes);
    expect(report.counts.skipped).toBe(0);
    expect(library.peek(COLLECTIONS.rulePacks)).toEqual([]);
    expect(library.peek(COLLECTIONS.promptPresets)).toEqual([]);
  });

  it('builds the same bytes twice, so the shipped pack is reproducible from source', async () => {
    const first = await buildExampleContentPack({ writer: memoryWriter() });
    const second = await buildExampleContentPack({ writer: memoryWriter() });
    expect(second.bytes).toEqual(first.bytes);

    // A writer with a different clock must not change the example: its identity is
    // the fixed pair in the source, which is what "the same on every start" means.
    const later = await buildExampleContentPack({
      writer: memoryWriter(new Date('2030-01-01T00:00:00.000Z')),
    });
    expect(later.bytes).toEqual(first.bytes);
    expect(later.manifest.createdAt).toBe(EXAMPLE_CREATED_AT);

    // A caller that really wants a fresh artifact can still ask for one.
    const fresh = await buildExampleContentPack({
      writer: memoryWriter(),
      id: '0192f0a1-5000-7000-8000-000000000099',
    });
    expect(fresh.manifest.id).not.toBe(first.manifest.id);
    expect(fresh.manifest.contents).toEqual(first.manifest.contents);
  });

  it('refuses to start a session from a library that does not have the pack, and names what is missing', async () => {
    const library = emptyLibrary();
    const start = exampleStartSession(library, {
      modelConfig: MODEL_CONFIG,
      promptPreset: BUILTIN_PRESET_PIN,
    });
    await expect(start).rejects.toThrow(/example content pack is not in this library/);
    await expect(start).rejects.toThrow(new RegExp(EXAMPLE_IDS.worlds.longdayHarbour.id));
    // The refusal names every piece, not only the first one it looked for.
    await expect(start).rejects.toThrow(new RegExp(EXAMPLE_IDS.characters.taoSanniang.id));
    // ...and it is a question, not a crash: nothing was written.
    expect(library.peek(COLLECTIONS.sessions)).toEqual([]);

    // The short scenario's roster reports the same way when ITS world is absent.
    await expect(
      exampleStartSession(library, {
        modelConfig: MODEL_CONFIG,
        promptPreset: BUILTIN_PRESET_PIN,
        roster: EXAMPLE_LAST_FERRY_ROSTER,
      }),
    ).rejects.toThrow(new RegExp(EXAMPLE_IDS.worlds.lastFerry.id));
  });

  it('writes the head rows the format does not carry, so the library lists both worlds and all four cards', async () => {
    const { library } = await importedExample();

    expect(
      library.peek<World>(COLLECTIONS.worlds).map((head) => `${head.name}@${head.headVersion}`),
    ).toEqual(['长日港@1', '末班渡@1']);
    expect(library.peek<World>(COLLECTIONS.worlds).map((head) => head.tags)).toEqual([
      ['奇幻', '潮汐', '港口'],
      ['短剧本', '一夜', '渡口'],
    ]);
    expect(
      library.peek<CharacterVersion>(COLLECTIONS.characterVersions).map((row) => row.data.name),
    ).toEqual(['沈砚', '陶三娘', '阿梧', '渡伯']);
    // Every card's head row points at the version that was just imported.
    for (const head of library.peek<World>(COLLECTIONS.worlds)) {
      expect(
        library
          .peek<WorldVersion>(COLLECTIONS.worldVersions)
          .some((row) => row.worldId === head.id && row.version === head.headVersion),
      ).toBe(true);
    }
  });
});
