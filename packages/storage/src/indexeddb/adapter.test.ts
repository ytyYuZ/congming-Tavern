/**
 * `createIndexedDbStorage` against the frozen `StorageAdapter` port — the
 * acceptance tests of `docs/06-开发任务拆解.md` §1's M0-T7 row: entity round-trip
 * and transaction rollback, plus the query/index/delete surface.
 *
 * WHY REAL SCHEMA ENTITIES AND NOT `{ id, name }`
 * A hand-written row type would only prove that IndexedDB stores objects. Storing
 * a `World`/`WorldVersion` built from `@smarttavern/schema` and parsing it back
 * through its Zod schema proves the storage layer speaks the frozen types — i.e.
 * that the structured clone of a real, nested entity survives `put` -> `get`
 * unchanged, which is the property every later milestone depends on.
 *
 * `fake-indexeddb/auto` polyfills `globalThis.indexedDB`; no jsdom is involved.
 */
import 'fake-indexeddb/auto';
import {
  COLLECTIONS,
  type Query,
  RANGE_BOUND_NOT_COMPARABLE_MESSAGE,
  RANGE_FIELD_REQUIRED_MESSAGE,
  StorageQueryError,
} from '@smarttavern/core';
import {
  type Character,
  CharacterSchema,
  type Id,
  mintUuidV7,
  UUID_V7_PATTERN,
  type World,
  WorldSchema,
  type WorldVersion,
  WorldVersionSchema,
} from '@smarttavern/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { createIndexedDbStorage, IndexedDbRowMissingError, IndexedDbStorageError } from './adapter';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

/** Fixture ids. The shared minter, aliased because every use here is "a fresh row id". */
const uuid = (): Id => mintUuidV7();

const NAMED_INDEX = 'messages_sessionId_parentId';
const RANGE_INDEX = 'messages_createdAt';

function world(overrides: Partial<World> = {}): World {
  const at = Date.now();
  return WorldSchema.parse({
    id: uuid(),
    name: 'Eldoria',
    headVersion: 1,
    tags: ['fantasy', 'high-magic'],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

/** A version row carrying the deep, nested payload a real world save has. */
function worldVersion(worldId: Id, version = 1): WorldVersion {
  const at = Date.now();
  return WorldVersionSchema.parse({
    id: uuid(),
    worldId,
    version,
    createdAt: at,
    updatedAt: at,
    data: {
      name: 'Eldoria',
      premise: 'A drowned empire rebuilds itself on the backs of tide-priests.',
      genre: ['fantasy'],
      era: 'Age of Tides',
      techOrMagic: 'Tide-magic',
      regions: [
        {
          id: 'silverpine',
          name: 'Silverpine',
          description: 'A drowned forest.',
          tags: ['region'],
        },
      ],
      factions: [
        {
          id: 'tide-priests',
          name: 'Tide Priests',
          description: 'Keepers of the flood calendar.',
          stance: '观望',
          goals: ['appease the tide'],
        },
      ],
      rulesOfNature: {
        powerSource: 'The moon-pulled sea',
        limits: 'No fire magic below the waterline.',
        taboos: 'Never speak a name while the tide turns.',
      },
      narrative: {
        conflict: 'The empire drowns faster than it can rebuild.',
        tone: 'melancholic',
        themes: ['memory', 'sacrifice'],
        style: 'lyrical',
      },
      calendar: {
        id: 'tide-calendar',
        name: 'Tide Reckoning',
        minutesPerHour: 60,
        hoursPerDay: 24,
        weekdays: ['Waveday', 'Saltday'],
        months: [{ name: 'Frostmoon', days: 30 }],
        epochLabel: '第三纪',
        segments: [
          { id: 'dawn', name: '晨', fromHour: 6, toHour: 12 },
          { id: 'night', name: '夜', fromHour: 22, toHour: 6 },
        ],
      },
      startMinute: 0,
      timeRhythm: { implicitAdvance: false, advanceEveryTurns: 4, stepMinutes: 15 },
      openingHooks: ['A bell rings under the water.'],
      customFields: { currency: 'cowrie' },
    },
  });
}

interface MessageRow {
  id: string;
  sessionId: string;
  parentId: string | null;
  createdAt: number;
  content?: string;
}

interface SessionRow {
  id: string;
  title: string;
  createdAt: number;
}

/**
 * §7's two non-entity tables, as this package stores them. §7 spells them
 * `settings (key, value)` and `migrations (version, appliedAt)`; ADR-022 keeps the
 * port's ONE addressing rule by putting the config key and the version in `id`,
 * and these two row types are what that decision looks like at a call site.
 */
interface SettingsRow {
  id: string;
  value: unknown;
  updatedAt: number;
}

interface MigrationsRow {
  id: string;
  appliedAt: number;
}

describe('createIndexedDbStorage', () => {
  let dbName: string;

  beforeEach(() => {
    dbName = `smarttavern-test-${uuid()}`;
  });

  /* ───────────────────────────── round-trip ──────────────────────────────── */

  it('mints fixture ids that satisfy the frozen UUIDv7 shape', () => {
    const first = uuid();
    expect(first).toMatch(UUID_V7_PATTERN);
    expect(uuid()).not.toBe(first);
  });

  it('round-trips a World head row through put/get exactly equal', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const row = world();

    const first = await storage.transaction(async (tx) => {
      await tx.collection<World>(COLLECTIONS.worlds).put(row);
      return tx.collection<World>(COLLECTIONS.worlds).get(row.id);
    });

    expect(first).toEqual(row);
    expect(WorldSchema.parse(first)).toEqual(row);

    // …and it really went to the database, not to a cache: a fresh adapter on the
    // same name reads the same row back.
    const reopened = createIndexedDbStorage({ name: dbName });
    const again = await reopened.transaction((tx) =>
      tx.collection<World>(COLLECTIONS.worlds).get(row.id),
    );
    expect(again).toEqual(row);
  });

  it('round-trips a nested WorldVersion payload without flattening it', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const head = world();
    const version = worldVersion(head.id);

    const [storedHead, storedVersion] = await storage.transaction(async (tx) => {
      await tx.collection<World>(COLLECTIONS.worlds).put(head);
      await tx.collection<WorldVersion>(COLLECTIONS.worldVersions).put(version);
      return [
        await tx.collection<World>(COLLECTIONS.worlds).get(head.id),
        await tx.collection<WorldVersion>(COLLECTIONS.worldVersions).get(version.id),
      ] as const;
    });

    expect(storedHead).toEqual(head);
    expect(storedVersion).toEqual(version);
    expect(WorldVersionSchema.parse(storedVersion)).toEqual(version);
    // The nested calendar and its wrapping 夜 segment survive structured clone.
    expect(storedVersion?.data.calendar.segments).toEqual(version.data.calendar.segments);
  });

  it('round-trips a Character head row, proving the port speaks schema entities', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const at = Date.now();
    const character = CharacterSchema.parse({
      id: uuid(),
      name: 'Mira Vane',
      headVersion: 2,
      tags: ['npc'],
      createdAt: at,
      updatedAt: at,
    });

    const stored = await storage.transaction(async (tx) => {
      await tx.collection<Character>(COLLECTIONS.characters).put(character);
      return tx.collection<Character>(COLLECTIONS.characters).get(character.id);
    });

    expect(CharacterSchema.parse(stored)).toEqual(character);
  });

  it('refuses a row without an id instead of minting one silently', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await expect(
      storage.transaction((tx) =>
        tx.collection<World>(COLLECTIONS.worlds).put({ name: 'No id' } as unknown as World),
      ),
    ).rejects.toBeInstanceOf(IndexedDbStorageError);
  });

  /* ──────────────────────── ADR-022: one addressing rule ─────────────────── */

  it('keys a `settings` row by `id`, holding the config key there (ADR-022)', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    // §7 writes `settings (key, value)`. ADR-022 rejected a per-collection
    // primary key for the port, so the config key IS the row id.
    const row: SettingsRow = { id: 'ui.theme', value: { mode: 'dark' }, updatedAt: 1 };

    const stored = await storage.transaction(async (tx) => {
      const settings = tx.collection<SettingsRow>(COLLECTIONS.settings);
      await settings.put(row);
      return { byKey: await settings.get('ui.theme'), all: await settings.list() };
    });

    expect(stored.byKey).toEqual(row);
    expect(stored.all).toEqual([row]);
    expect(
      await storage.transaction((tx) => tx.collection<SettingsRow>(COLLECTIONS.settings).count()),
    ).toBe(1);
  });

  it('keys a `migrations` row by `id`, holding the version there (ADR-022)', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    // §7 writes `migrations (version, appliedAt)`, and the adapter's docstring says
    // `id` holds the version. `Id` is a string (`packages/schema` common.ts), so a
    // numeric version is stored in its string form — v3 as `'3'`.
    const row: MigrationsRow = { id: '3', appliedAt: 1_700_000_000_000 };

    const stored = await storage.transaction(async (tx) => {
      const migrations = tx.collection<MigrationsRow>(COLLECTIONS.migrations);
      await migrations.put(row);
      return { byVersion: await migrations.get('3'), all: await migrations.list() };
    });

    expect(stored.byVersion).toEqual(row);
    expect(stored.all).toEqual([row]);
  });

  /* ────────────────────────────── rollback ───────────────────────────────── */

  it('ROLLS BACK creates across two collections when the transaction throws', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const row = world();

    await expect(
      storage.transaction(async (tx) => {
        await tx.collection<World>(COLLECTIONS.worlds).put(row);
        await tx
          .collection<MessageRow>(COLLECTIONS.messages)
          .put({ id: 'm1', sessionId: 's1', parentId: null, createdAt: 1 });
        throw new Error('domain rule violated mid-transaction');
      }),
    ).rejects.toThrow('domain rule violated mid-transaction');

    const [worlds, messages] = await storage.transaction(async (tx) => [
      await tx.collection<World>(COLLECTIONS.worlds).count(),
      await tx.collection<MessageRow>(COLLECTIONS.messages).count(),
    ]);
    expect(worlds).toBe(0);
    expect(messages).toBe(0);
  });

  it('ROLLS BACK an update and a create when the transaction throws', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const kept = world({ name: 'Eldoria' });
    await storage.transaction(async (tx) => {
      await tx.collection<World>(COLLECTIONS.worlds).put(kept);
      await tx
        .collection<MessageRow>(COLLECTIONS.messages)
        .put({ id: 'm0', sessionId: 's1', parentId: null, createdAt: 0 });
    });

    await expect(
      storage.transaction(async (tx) => {
        await tx.collection<World>(COLLECTIONS.worlds).update(kept.id, { name: 'RENAMED' });
        await tx
          .collection<MessageRow>(COLLECTIONS.messages)
          .put({ id: 'm1', sessionId: 's1', parentId: null, createdAt: 1 });
        await tx.collection<MessageRow>(COLLECTIONS.messages).remove('m0');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    const [worlds, messages] = await storage.transaction(async (tx) => [
      await tx.collection<World>(COLLECTIONS.worlds).list(),
      await tx.collection<MessageRow>(COLLECTIONS.messages).list(),
    ]);
    // The update, the insert AND the delete are all gone.
    expect(worlds).toEqual([kept]);
    expect(messages.map((row) => row.id)).toEqual(['m0']);
  });

  it('keeps committed transactions committed even when a later one fails', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const first = world();
    const second = world();
    await storage.transaction((tx) => tx.collection<World>(COLLECTIONS.worlds).put(first));
    await storage.transaction((tx) => tx.collection<World>(COLLECTIONS.worlds).put(second));

    // A throwing transaction outside the earlier ones must not undo them, and
    // must not leave a partial write of its own behind.
    const third = world();
    await expect(
      storage.transaction(async (tx) => {
        await tx.collection<World>(COLLECTIONS.worlds).put(third);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const ids = await storage.transaction(async (tx) =>
      (await tx.collection<World>(COLLECTIONS.worlds).list()).map((row) => row.id),
    );
    expect(ids).toEqual([first.id, second.id]);
  });

  /* ─────────────────────── queries, indexes, deletes ─────────────────────── */

  it('answers equality, range, order, paging and count like the port says', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await storage.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      for (let n = 1; n <= 5; n += 1) {
        await messages.put({
          id: `m${n}`,
          sessionId: n <= 3 ? 's1' : 's2',
          parentId: null,
          createdAt: n,
        });
      }
    });

    await storage.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);

      expect(
        (await messages.list({ where: { sessionId: 's1' } }, NAMED_INDEX)).map((row) => row.id),
      ).toEqual(['m1', 'm2', 'm3']);
      expect(await messages.count({ where: { sessionId: 's2' } })).toBe(2);

      const ranged = await messages.list(
        { where: { sessionId: 's1' }, field: 'createdAt', from: 2, to: 4 },
        RANGE_INDEX,
      );
      expect(ranged.map((row) => row.id)).toEqual(['m2', 'm3']);

      // `order` composes with `limit`: newest first, then the page window.
      expect((await messages.list({ order: 'desc', limit: 2 })).map((row) => row.id)).toEqual([
        'm5',
        'm4',
      ]);
      expect((await messages.list({ offset: 1, limit: 2 })).map((row) => row.id)).toEqual([
        'm2',
        'm3',
      ]);
      expect(await messages.count()).toBe(5);
    });
  });

  it('uses a compound index for a full tuple and still filters the residue', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await storage.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      await messages.putMany([
        { id: 'm1', sessionId: 's1', parentId: 'p1', createdAt: 1 },
        { id: 'm2', sessionId: 's1', parentId: 'p2', createdAt: 2 },
        { id: 'm3', sessionId: 's2', parentId: 'p1', createdAt: 3 },
      ]);
    });

    const rows = await storage.transaction(async (tx) =>
      tx
        .collection<MessageRow>(COLLECTIONS.messages)
        .list({ where: { sessionId: 's1', parentId: 'p1' } }, NAMED_INDEX),
    );
    expect(rows.map((row) => row.id)).toEqual(['m1']);
  });

  it('scans structurally when the index cannot answer the selector', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await storage.transaction(async (tx) => {
      await tx.collection<MessageRow>(COLLECTIONS.messages).putMany([
        { id: 'm1', sessionId: 's1', parentId: null, createdAt: 1, content: 'hi' },
        { id: 'm2', sessionId: 's2', parentId: null, createdAt: 2, content: 'hi' },
      ]);
    });

    // `content` has no §7 index, so this is an honest full scan.
    const rows = await storage.transaction(async (tx) =>
      tx.collection<MessageRow>(COLLECTIONS.messages).list({ where: { content: 'hi' } }),
    );
    expect(rows.map((row) => row.id).sort()).toEqual(['m1', 'm2']);
  });

  it('refuses a range bound that cannot be compared, instead of matching every row (ADR-024)', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await storage.transaction((tx) =>
      tx.collection<SessionRow>(COLLECTIONS.sessions).putMany([
        { id: 's1', title: 'one', createdAt: 10 },
        { id: 's2', title: 'two', createdAt: 20 },
      ]),
    );

    await storage.transaction(async (tx) => {
      const sessions = tx.collection<SessionRow>(COLLECTIONS.sessions);
      // `compare` answers 0 ("equal") for anything that is not a number or a string,
      // so before this refusal a `Date` bound MATCHED EVERY ROW: the query answered
      // the whole table instead of complaining. Same silent wrong answer ADR-023
      // outlawed, one field over — and this is why the type is `number | string`
      // now, with a runtime refusal behind it for casts and plain JS callers.
      // @ts-expect-error a Date is not a comparable bound (ADR-024)
      const dateBound: Query<SessionRow> = { field: 'createdAt', from: new Date(0) };
      await expect(sessions.list(dateBound)).rejects.toBeInstanceOf(StorageQueryError);
      await expect(sessions.list(dateBound)).rejects.toThrow(RANGE_BOUND_NOT_COMPARABLE_MESSAGE);
      // `count` shares the select path, so it refuses too.
      // @ts-expect-error a Date is not a comparable bound (ADR-024)
      const dateCeiling: Query<SessionRow> = { field: 'createdAt', to: new Date() };
      await expect(sessions.count(dateCeiling)).rejects.toBeInstanceOf(StorageQueryError);

      // Scalars keep working, unchanged.
      expect(
        (await sessions.list({ field: 'createdAt', from: 1, to: 15 })).map((row) => row.id),
      ).toEqual(['s1']);
    });
  });

  it('refuses a range query that does not name its `field` instead of guessing (ADR-023)', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await storage.transaction((tx) =>
      tx.collection<SessionRow>(COLLECTIONS.sessions).putMany([
        { id: 's1', title: 'one', createdAt: 10 },
        { id: 's2', title: 'two', createdAt: 20 },
      ]),
    );

    await storage.transaction(async (tx) => {
      const sessions = tx.collection<SessionRow>(COLLECTIONS.sessions);
      // `field` is optional in the port, and the adapter used to mirror the mock's
      // fallback — the first `where` key, else `id`. For this query that meant
      // range-scanning `createdAt`, which is exactly 10, so `from: 1, to: 5`
      // answered an EMPTY ARRAY for something that looks reasonable. A wrong answer
      // pinned by a test becomes a compatibility promise, so ADR-023 turns the
      // fallback into a refusal, with the mock's exact message so the two cannot
      // drift.
      const ambiguous = sessions.list({ where: { createdAt: 10 }, from: 1, to: 5 });
      await expect(ambiguous).rejects.toBeInstanceOf(StorageQueryError);
      await expect(ambiguous).rejects.toThrow(RANGE_FIELD_REQUIRED_MESSAGE);
      // `count` shares the same select path, so it must refuse too.
      await expect(sessions.count({ from: 1, to: 5 })).rejects.toBeInstanceOf(StorageQueryError);

      // Naming the field is all it takes, and the bound is then really applied:
      // `createdAt` is 10 for `s1` and 20 for `s2`.
      expect(
        (await sessions.list({ field: 'createdAt', from: 1, to: 20 })).map((row) => row.id),
      ).toEqual(['s1', 's2']);
      expect(
        (await sessions.list({ field: 'createdAt', from: 1, to: 15 })).map((row) => row.id),
      ).toEqual(['s1']);
    });
  });

  it('throws on an index name the collection does not declare', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await expect(
      storage.transaction((tx) =>
        tx.collection<MessageRow>(COLLECTIONS.messages).list(undefined, 'messages_nope'),
      ),
    ).rejects.toBeInstanceOf(IndexedDbStorageError);
  });

  it('refuses to update a row that does not exist', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    await expect(
      storage.transaction((tx) =>
        tx.collection<World>(COLLECTIONS.worlds).update('nope', { name: 'x' }),
      ),
    ).rejects.toBeInstanceOf(IndexedDbRowMissingError);
  });

  it('updates a row in place and returns the stored shape', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const row = world({ name: 'Eldoria' });
    await storage.transaction((tx) => tx.collection<World>(COLLECTIONS.worlds).put(row));

    const updated = await storage.transaction((tx) =>
      tx.collection<World>(COLLECTIONS.worlds).update(row.id, { name: 'Karsis' }),
    );
    expect(updated.name).toBe('Karsis');
    expect(updated.tags).toEqual(row.tags);
  });

  it('keeps remove idempotent, as a rollback path needs', async () => {
    const storage = createIndexedDbStorage({ name: dbName });
    const row = world();
    await storage.transaction(async (tx) => {
      const worlds = tx.collection<World>(COLLECTIONS.worlds);
      await worlds.put(row);
      await worlds.remove(row.id);
      await worlds.remove(row.id);
      expect(await worlds.count()).toBe(0);
    });
  });
});
