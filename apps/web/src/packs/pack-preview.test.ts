/**
 * The preview before the write, and the refusals around it (M1-A4).
 *
 * WHY EVERY ASSERTION HERE IS AGAINST THE RAW STORES
 * "A refused import writes nothing" is the promise the screen makes, and the cheapest way to
 * believe it is to read back through the repository. That reader parses a row into a shape and
 * drops unknown fields (see `db/raw-indexeddb.test-helpers.ts`), so it could not see a
 * half-written row. `snapshotAllRows` compares what is actually in IndexedDB, as one string, so
 * "nothing changed" means nothing changed — including in the collections no test is looking at.
 *
 * WHY THE PREVIEW IS TESTED SEPARATELY FROM THE IMPORT
 * The preview runs the importer's REAL transaction and then aborts it (`packs/pack-storage.ts`).
 * If the abort were wrong — a commit that slipped through, or a rollback that swallowed a real
 * storage failure — the report would still look perfect. So this file pins the two halves that
 * the report cannot show: the library is untouched, and a genuine failure is not mistaken for a
 * successful preview.
 */
import 'fake-indexeddb/auto';
import type { StorageAdapter } from '@smarttavern/core';
import { COLLECTIONS } from '@smarttavern/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, readTable, resetDatabase } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import { listCharacters, listWorlds } from '../db/repository';
import { examplePackBytes, importPack, previewPack } from './pack-import';
import { packStorage } from './pack-storage';

let databases = 0;
let current = '';

beforeEach(() => {
  databases += 1;
  current = `apps-web-packs-preview-${databases}`;
  resetDatabase(current);
});

afterEach(async () => {
  closeDatabase();
  await deleteDatabase(current);
});

/** Bytes that are not a container at all — the wrong file, picked by a user. */
function notAPack(): Uint8Array {
  return new TextEncoder().encode('this is not a content pack');
}

describe('the preview before the write', () => {
  it('reports the import it would make and leaves the library byte-identical', async () => {
    const example = await examplePackBytes();
    const before = await snapshotAllRows(current);

    const report = await previewPack({ bytes: example.bytes, storage: packStorage() });

    // A real report, on a real transaction — not an empty one, or "nothing was written" would be
    // true for the wrong reason.
    expect(report.ok).toBe(true);
    expect(report.counts.created).toBeGreaterThan(0);
    expect(report.entities.length).toBeGreaterThan(0);

    expect(await snapshotAllRows(current)).toBe(before);
    expect(await listWorlds()).toEqual([]);
    expect(await listCharacters()).toEqual([]);
  });

  it('writes the rows once the import is confirmed, and reports what the preview showed', async () => {
    const example = await examplePackBytes();

    const preview = await previewPack({ bytes: example.bytes, storage: packStorage() });
    expect(await listWorlds()).toEqual([]);

    const result = await importPack({ bytes: example.bytes, storage: packStorage() });

    expect(result.ok).toBe(true);
    // Confirmation must not be a second, different decision: the counts the user agreed to are
    // the counts that happened.
    expect(result.counts).toEqual(preview.counts);
    expect(result.entities).toEqual(preview.entities);
    expect((await listWorlds()).length).toBeGreaterThan(0);
    expect((await listCharacters()).length).toBeGreaterThan(0);
  });

  it('turns an unreadable file into a finding instead of a throw', async () => {
    const before = await snapshotAllRows(current);

    // No rejection: a user who picks the wrong file needs a sentence, and the importer's
    // contract is a report whose findings carry `zip-corrupt`.
    const report = await previewPack({ bytes: notAPack(), storage: packStorage() });

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'zip-corrupt')).toBe(true);
    expect(report.counts).toEqual({ created: 0, reused: 0, remapped: 0, skipped: 0 });
    expect(report.entities).toEqual([]);
    expect(await snapshotAllRows(current)).toBe(before);
  });

  it('writes nothing when a corrupt package is imported rather than previewed', async () => {
    // The real adapter, not the dry run: this is the half that would actually write, so
    // "refused" has to hold here too.
    const before = await snapshotAllRows(current);

    const refused = await importPack({ bytes: notAPack(), storage: packStorage() });

    expect(refused.ok).toBe(false);
    expect(await snapshotAllRows(current)).toBe(before);
    expect(await readTable(COLLECTIONS.worlds).count()).toBe(0);
    expect(await readTable(COLLECTIONS.characters).count()).toBe(0);
  });

  it('rethrows a real storage failure rather than reporting it as a preview', async () => {
    // The abort is recognised by the state set on the statement before it throws, so a failure
    // from INSIDE the transaction — a database that cannot be written — is not swallowed and
    // shown to the user as a perfectly good import report.
    const example = await examplePackBytes();
    const broken: StorageAdapter = {
      transaction: () => Promise.reject(new Error('the disk is on fire')),
    };

    await expect(previewPack({ bytes: example.bytes, storage: broken })).rejects.toThrow(
      'the disk is on fire',
    );
  });
});
