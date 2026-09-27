/**
 * `docs/04` §12 item 11, the mechanism behind the static scan: the export path
 * cannot reach a secret.
 *
 * The clause test in `contract-regression.test.ts` scans the produced bytes for a
 * planted key, an absolute path and a device id. That is a necessary check but a
 * weak one — a future field could copy a secret into a payload and the scan would
 * only catch the secrets a test happened to plant. This suite asserts the
 * STRUCTURAL half: the exporter opens a fixed list of entity collections, so
 * `settings` and `providers` — where `docs/02` §7 keeps API keys — are never even
 * opened. An exporter cannot leak what it never reads.
 *
 * The storage double records every collection a code path touches, which is what
 * makes that provable rather than asserted in a comment.
 */
import { COLLECTIONS } from '@smarttavern/core';
import { describe, expect, it } from 'vitest';
import {
  EXPORTABLE_COLLECTIONS,
  exportCharacterPackage,
  exportSessionPackage,
  exportWorldPackage,
} from './export-package';
import { FIXTURE, seedLibrary } from './testing/fixtures';
import { emptyLibrary, memoryWriter, PACKAGE_ID } from './testing/harness';
import type { MemoryStorageAdapter } from './testing/memory-storage';

const NOT_ENTITIES = [COLLECTIONS.settings, COLLECTIONS.providers, COLLECTIONS.jobs];

/** A library whose settings and providers hold things a package must never carry. */
function libraryWithSecrets(): MemoryStorageAdapter {
  const storage = emptyLibrary();
  seedLibrary(storage);
  storage.seed(COLLECTIONS.settings, [
    { id: 'llm.apiKey', value: 'sk-live-SECRET' },
    { id: 'device.id', value: 'DEVICE-SECRET' },
  ]);
  storage.seed(COLLECTIONS.providers, [{ id: 'p-1', kind: 'llm', apiKey: 'sk-live-PROVIDER' }]);
  storage.touched.length = 0;
  return storage;
}

describe('the export path cannot reach a secret (item 11, HANDOFF §4.1 invariant 6)', () => {
  it('opens only exportable collections when exporting a world', async () => {
    const storage = libraryWithSecrets();
    await exportWorldPackage({
      kind: 'world',
      storage,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      worldId: FIXTURE.worldId,
    });

    expect(storage.touched).toEqual([
      COLLECTIONS.worlds,
      COLLECTIONS.worldVersions,
      COLLECTIONS.worldbookEntries,
    ]);
    for (const name of storage.touched) expect(EXPORTABLE_COLLECTIONS).toContain(name);
  });

  it('opens only exportable collections when exporting a character', async () => {
    const storage = libraryWithSecrets();
    await exportCharacterPackage({
      kind: 'character',
      storage,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      characterId: FIXTURE.playerId,
    });

    expect(storage.touched).toEqual([COLLECTIONS.characters, COLLECTIONS.characterVersions]);
  });

  it('opens only exportable collections when exporting a session', async () => {
    const storage = libraryWithSecrets();
    await exportSessionPackage({
      kind: 'session',
      storage,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      sessionId: FIXTURE.sessionId,
    });

    for (const name of NOT_ENTITIES) expect(storage.touched).not.toContain(name);
    for (const name of storage.touched) expect(EXPORTABLE_COLLECTIONS).toContain(name);
    // The save genuinely needs these, so the assertion above is not vacuous.
    for (const name of [
      COLLECTIONS.sessions,
      COLLECTIONS.messages,
      COLLECTIONS.checkpoints,
      COLLECTIONS.agenda,
      COLLECTIONS.memories,
    ]) {
      expect(storage.touched).toContain(name);
    }
  });

  it('a settings row shaped like an entity is still not exported', async () => {
    const storage = libraryWithSecrets();
    // A settings row can hold anything (`{key, value}`); make it look exactly like
    // the world payload and mark it, so a careless "copy every collection that has
    // a worlds-like row" shortcut would be caught here.
    storage.seed(COLLECTIONS.settings, [
      { id: 'worlds', value: [{ worldId: 'MARKER-SETTINGS-WORLD', version: 1 }] },
    ]);

    const result = await exportSessionPackage({
      kind: 'session',
      storage,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      sessionId: FIXTURE.sessionId,
    });

    const text = new TextDecoder('utf-8').decode(result.bytes);
    expect(text).not.toContain('MARKER-SETTINGS-WORLD');
  });
});
