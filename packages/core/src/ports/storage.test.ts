/**
 * The storage port's two frozen tables (`docs/02` §7, `docs/06` §8.4 决定 1).
 *
 * These assertions are the transcription check: if §7 grows a collection or an
 * index, this test fails until the constant table is updated — which is the only
 * reason to centralise the names in the first place.
 */
import { describe, expect, it } from 'vitest';
import { COLLECTION_NAMES, COLLECTIONS, type CollectionName, INDEXES } from './storage';

describe('COLLECTIONS (docs/02 §7)', () => {
  it('lists the project tables of §7 verbatim and in table order', () => {
    expect(COLLECTION_NAMES).toEqual([
      'worlds',
      'worldVersions',
      'characters',
      'characterVersions',
      'worldbooks',
      'worldbookEntries',
      'promptPresets',
      'rulePacks',
      'sessions',
      'messages',
      'checkpoints',
      'agenda',
      'turnPlans',
      'memories',
      'assets',
      'jobs',
      'providers',
      'settings',
      'migrations',
    ]);
  });

  it('has no `personas` collection (ADR-010 removed it in v0.2)', () => {
    expect(COLLECTION_NAMES).not.toContain('personas');
    expect(Object.keys(COLLECTIONS)).not.toContain('personas');
  });

  it('maps every key to its own name, so a rename cannot half-apply', () => {
    for (const [key, value] of Object.entries(COLLECTIONS)) {
      expect(value).toBe(key);
    }
  });
});

describe('INDEXES (docs/02 §7 索引 column)', () => {
  it('transcribes the compound and multi-valued indexes', () => {
    expect(INDEXES[COLLECTIONS.worldVersions]).toEqual([
      { name: 'worldVersions_worldId_version', fields: ['worldId', 'version'], unique: true },
    ]);
    expect(INDEXES[COLLECTIONS.messages]).toEqual([
      { name: 'messages_sessionId_parentId', fields: ['sessionId', 'parentId'], unique: false },
      { name: 'messages_createdAt', fields: ['createdAt'], unique: false },
    ]);
    expect(INDEXES[COLLECTIONS.agenda]).toEqual([
      {
        name: 'agenda_sessionId_atMinute_status',
        fields: ['sessionId', 'atMinute', 'status'],
        unique: false,
      },
    ]);
    expect(INDEXES[COLLECTIONS.memories]).toEqual([
      { name: 'memories_scope_targetId', fields: ['scope', 'targetId'], unique: false },
      { name: 'memories_atMinute', fields: ['atMinute'], unique: false },
    ]);
    expect(INDEXES[COLLECTIONS.worldbookEntries]).toEqual([
      { name: 'worldbookEntries_worldId', fields: ['worldId'], unique: false },
      { name: 'worldbookEntries_keywords', fields: ['keywords'], unique: false, multiValued: true },
    ]);
  });

  it('keeps `assets.hash` as the only unique index and `jobs.status` as listed', () => {
    const unique = COLLECTION_NAMES.flatMap((name) =>
      INDEXES[name]
        .filter((index) => index.unique)
        .map((index) => `${name}.${index.fields.join()}`),
    );
    expect(unique).toEqual([
      'worldVersions.worldId,version',
      'characterVersions.characterId,version',
      'assets.hash',
    ]);
    expect(INDEXES[COLLECTIONS.jobs]).toEqual([
      { name: 'jobs_status', fields: ['status'], unique: false },
    ]);
  });

  it('answers for every collection name, including the index-less ones', () => {
    for (const name of COLLECTION_NAMES) {
      expect(Array.isArray(INDEXES[name])).toBe(true);
    }
    // §7 writes `—` for `settings`; an empty list is how "no index" is stated.
    expect(INDEXES[COLLECTIONS.settings]).toEqual([]);
  });

  it('types INDEXES as a total record, so a lookup needs no undefined check', () => {
    const name: CollectionName = COLLECTIONS.turnPlans;
    expect(INDEXES[name][0]?.fields).toEqual(['sessionId', 'round']);
  });
});
