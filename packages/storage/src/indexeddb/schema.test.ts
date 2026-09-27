/**
 * The Dexie schema is DERIVED from the port constants, not re-declared — the
 * requirement `docs/06-开发任务拆解.md` §9.3 states as "集合名与索引逐字取自
 * `core/ports/storage.ts` 的 `COLLECTIONS` / `INDEXES`，不再手写第二份".
 *
 * So these tests come in two halves:
 * 1. the pure translation `INDEXES` -> Dexie schema strings, which is where a
 *    missing `&` or a mistranslated compound index would show up;
 * 2. the schema Dexie actually built on a real (fake) IndexedDB connection,
 *    which is the only way to prove `unique: true` became a UNIQUE index rather
 *    than an intention.
 */
import 'fake-indexeddb/auto';
import { COLLECTION_NAMES, COLLECTIONS, type CollectionIndex, INDEXES } from '@smarttavern/core';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  indexedDbSchema,
  indexSpec,
  PRIMARY_KEY,
  tableSchema,
} from './schema';

const dbs: Dexie[] = [];

function uniqueName(): string {
  return `smarttavern-schema-test-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

/** Open a real connection so Dexie builds (and reports) the actual schema. */
async function open(name: string): Promise<Dexie> {
  const db = new Dexie(name);
  db.version(DATABASE_VERSION).stores(indexedDbSchema());
  dbs.push(db);
  await db.open();
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.delete();
  }
});

describe('indexSpec — CollectionIndex -> Dexie schema mini-language', () => {
  it('prefixes a unique single-field index with `&`', () => {
    const index: CollectionIndex = { name: 'assets_hash', fields: ['hash'], unique: true };
    expect(indexSpec(index)).toBe('&hash');
  });

  it('prefixes a multi-valued index with `*`', () => {
    const index: CollectionIndex = {
      name: 'worldbookEntries_keywords',
      fields: ['keywords'],
      unique: false,
      multiValued: true,
    };
    expect(indexSpec(index)).toBe('*keywords');
  });

  it('brackets a compound index with `+` in the declared field order', () => {
    const index: CollectionIndex = {
      name: 'agenda_sessionId_atMinute_status',
      fields: ['sessionId', 'atMinute', 'status'],
      unique: false,
    };
    expect(indexSpec(index)).toBe('[sessionId+atMinute+status]');
  });

  it('combines `&` with a compound key path for a unique tuple', () => {
    const index: CollectionIndex = {
      name: 'worldVersions_worldId_version',
      fields: ['worldId', 'version'],
      unique: true,
    };
    expect(indexSpec(index)).toBe('&[worldId+version]');
  });
});

describe('tableSchema — one string per collection, built from INDEXES', () => {
  it('starts with the primary key and then mirrors INDEXES exactly', () => {
    for (const name of COLLECTION_NAMES) {
      const expected = [PRIMARY_KEY, ...INDEXES[name].map(indexSpec)];
      expect(tableSchema(name)).toBe(expected.join(','));
    }
  });

  it('keeps the index-less collections to a primary key only', () => {
    // §7 writes `—` for `settings`; `migrations` is index-free in the port too.
    expect(tableSchema(COLLECTIONS.settings)).toBe('id');
    expect(tableSchema(COLLECTIONS.migrations)).toBe('id');
  });

  it('carries every index of the busiest collections', () => {
    expect(tableSchema(COLLECTIONS.messages)).toBe('id,[sessionId+parentId],createdAt');
    expect(tableSchema(COLLECTIONS.worldbookEntries)).toBe('id,worldId,*keywords');
    expect(tableSchema(COLLECTIONS.assets)).toBe('id,&hash');
  });

  it('covers every collection in the exported schema map', () => {
    const schema = indexedDbSchema();
    expect(Object.keys(schema).sort()).toEqual([...COLLECTION_NAMES].sort());
    expect(Object.keys(schema)).toHaveLength(COLLECTION_NAMES.length);
  });
});

describe('the schema Dexie actually builds', () => {
  let name: string;

  beforeEach(() => {
    name = uniqueName();
  });

  it('creates one table per COLLECTIONS entry', async () => {
    const db = await open(name);
    expect(db.tables.map((table) => table.name).sort()).toEqual([...COLLECTION_NAMES].sort());
  });

  it('declares `id` as the primary key of every table, non-auto-incrementing', async () => {
    const db = await open(name);
    for (const table of db.tables) {
      expect(table.schema.primKey.keyPath).toBe(PRIMARY_KEY);
      expect(table.schema.primKey.auto).toBe(false);
    }
  });

  it('really creates the unique constraints of INDEXES', async () => {
    const db = await open(name);
    const declaredUnique = COLLECTION_NAMES.flatMap((collection) =>
      INDEXES[collection]
        .filter((index) => index.unique)
        .map((index) => `${collection}:${index.fields.join('+')}`),
    );

    const builtUnique = db.tables.flatMap((table) =>
      table.schema.indexes
        .filter((index) => index.unique === true)
        .map((index) =>
          Array.isArray(index.keyPath)
            ? `${table.name}:${index.keyPath.join('+')}`
            : `${table.name}:${String(index.keyPath)}`,
        ),
    );

    expect(builtUnique.sort()).toEqual(declaredUnique.sort());
    // The three unique indexes of §7, named explicitly so a silent drop is loud.
    expect(declaredUnique.sort()).toEqual([
      'assets:hash',
      'characterVersions:characterId+version',
      'worldVersions:worldId+version',
    ]);
  });

  it('really creates the multi-entry index for worldbook keywords', async () => {
    const db = await open(name);
    const keywords = db
      .table(COLLECTIONS.worldbookEntries)
      .schema.indexes.find((index) => index.keyPath === 'keywords');
    expect(keywords?.multi).toBe(true);
    expect(keywords?.unique).not.toBe(true);
  });

  it('really creates compound indexes as compound, in field order', async () => {
    const db = await open(name);
    for (const collection of COLLECTION_NAMES) {
      const table = db.table(collection);
      for (const index of INDEXES[collection]) {
        if (index.fields.length < 2) continue;
        const built = table.schema.indexes.find(
          (candidate) =>
            Array.isArray(candidate.keyPath) &&
            candidate.keyPath.join('+') === index.fields.join('+'),
        );
        expect(built, `${collection}.${index.name} must exist`).toBeDefined();
        expect(built?.compound).toBe(true);
      }
    }
  });

  it('declares exactly one index per INDEXES entry and nothing else', async () => {
    const db = await open(name);
    for (const collection of COLLECTION_NAMES) {
      expect(db.table(collection).schema.indexes).toHaveLength(INDEXES[collection].length);
    }
  });

  it('rejects a second row under a unique index', async () => {
    const db = await open(name);
    const assets = db.table(COLLECTIONS.assets);
    await assets.put({ id: 'a1', hash: 'sha256:aaa', kind: 'image', refCount: 1 });

    // Same hash, different primary key: the unique index must stop it.
    await expect(
      assets.put({ id: 'a2', hash: 'sha256:aaa', kind: 'image', refCount: 1 }),
    ).rejects.toThrow();
    // A different hash is fine.
    await assets.put({ id: 'a2', hash: 'sha256:bbb', kind: 'image', refCount: 1 });
    expect(await assets.count()).toBe(2);
  });

  it('accepts a version only once per (worldId, version)', async () => {
    const db = await open(name);
    const versions = db.table(COLLECTIONS.worldVersions);
    await versions.put({ id: 'v1', worldId: 'w1', version: 1 });
    await expect(versions.put({ id: 'v2', worldId: 'w1', version: 1 })).rejects.toThrow();
    await versions.put({ id: 'v2', worldId: 'w1', version: 2 });
    expect(await versions.count()).toBe(2);
  });

  it('indexes a multi-entry field under each of its values', async () => {
    const db = await open(name);
    const entries = db.table(COLLECTIONS.worldbookEntries);
    await entries.bulkPut([
      { id: 'e1', worldId: 'w1', keywords: ['moon', 'tide'], content: 'a' },
      { id: 'e2', worldId: 'w1', keywords: ['sun'], content: 'b' },
    ]);

    const hits = await entries.where('keywords').equals('moon').toArray();
    expect(hits.map((row) => row.id)).toEqual(['e1']);
    expect(await entries.where('keywords').equals('tide').count()).toBe(1);
    expect(await entries.where('keywords').equals('absent').count()).toBe(0);
  });
});

describe('DATABASE_NAME / DATABASE_VERSION', () => {
  it('ships a single named database at v1 (`docs/06` §9.3: 先落一个 v1 schema)', () => {
    expect(DATABASE_NAME).toBe('smarttavern');
    expect(DATABASE_VERSION).toBe(1);
  });
});
