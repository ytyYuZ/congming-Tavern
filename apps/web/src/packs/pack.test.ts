/**
 * The export → import round trip on the real library (M1-A4).
 *
 * WHY THE SOURCE LIBRARY IS THE SHIPPED EXAMPLE
 * The assertion this file exists for is "the exported bytes import back, and the per-kind
 * counts match the real rows". What the ROWS are is not this file's business — that belongs to
 * `packages/importers/src/examples/example-pack.test.ts`, which already pins the example's
 * contents. So the source library is built by importing the example, which is the one library
 * this repository can assemble in process that contains worldbook entries as well as worlds and
 * characters (`apps/web` has no worldbook editor yet), and the test then compares the library
 * to ITSELF across the round trip. Nothing here re-asserts what the example contains.
 *
 * WHY A SECOND DATABASE PER ROUND TRIP
 * Re-importing into the same library would pass even if the package carried nothing at all:
 * every row is already there, the identity policy REUSES it, and the counts would look healthy
 * for the wrong reason. The target library is therefore empty, so every line the report shows is
 * a row the package actually carried.
 */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { ImportReport } from '@smarttavern/importers';
import { buildExampleContentPack, EXAMPLE_IDS } from '@smarttavern/importers';
import { createPackageWriter } from '@smarttavern/packages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, databaseName, readTable, resetDatabase } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import { listCharacters, listWorlds, writeProviderSettings } from '../db/repository';
import { exportLibraryPack } from './pack-export';
import { examplePackBytes, importPack } from './pack-import';
import { packStorage } from './pack-storage';

/** A key that must not survive into a package. Shaped like the real thing on purpose. */
const SECRET_KEY = 'sk-packs-must-not-leak-9f3c1d';

let databases = 0;
const opened: string[] = [];

/**
 * Open a FRESH library for one case, remembering the name so teardown can delete every
 * database a test opened — the round trip deliberately opens two.
 */
function openLibrary(): string {
  databases += 1;
  const name = `apps-web-packs-${databases}`;
  opened.push(name);
  resetDatabase(name);
  return name;
}

beforeEach(() => {
  opened.length = 0;
  openLibrary();
});

afterEach(async () => {
  closeDatabase();
  for (const name of opened) await deleteDatabase(name);
});

/** The rows `exportContentPack` reads, per kind it can write. */
async function libraryCounts(): Promise<{ worlds: number; worldbook: number; characters: number }> {
  return {
    worlds: await readTable(COLLECTIONS.worlds).count(),
    worldbook: await readTable(COLLECTIONS.worldbookEntries).count(),
    characters: await readTable(COLLECTIONS.characters).count(),
  };
}

/** The library's ids, sorted, so two libraries compare as sets rather than as orders. */
async function libraryIds(): Promise<{ worlds: string[]; characters: string[] }> {
  return {
    worlds: (await listWorlds()).map((world) => world.id).sort(),
    characters: (await listCharacters()).map((character) => character.id).sort(),
  };
}

/**
 * How many report lines each of the kinds an export can carry produced.
 *
 * Spelled as three named fields rather than a `Record<string, number>`: this workspace compiles
 * with `noPropertyAccessFromIndexSignature`, so a record would force `counts.world` to be written
 * as a bracketed index access.
 */
function kindCounts(report: ImportReport): { world: number; worldbook: number; character: number } {
  const counts = { world: 0, worldbook: 0, character: 0 };
  for (const row of report.entities) {
    if (row.entity === 'world' || row.entity === 'worldbook' || row.entity === 'character') {
      counts[row.entity] += 1;
    }
  }
  return counts;
}

/** Every report line as text, sorted — two imports compared as multisets of decisions. */
function rowLines(report: ImportReport): string[] {
  return report.entities
    .map((row) => `${row.entity}:${row.action}:${row.id ?? row.originId ?? ''}`)
    .sort();
}

/** Exactly what the route asks `exportLibraryPack` for: the whole library, no picker. */
async function exportCurrentLibrary() {
  const worlds = await listWorlds();
  const characters = await listCharacters();
  return exportLibraryPack({
    storage: packStorage(),
    worldIds: worlds.map((world) => world.id),
    characterIds: characters.map((character) => character.id),
  });
}

describe('export → import round trip', () => {
  it('imports the exported bytes back with the same rows, kind by kind', async () => {
    const example = await examplePackBytes();
    const source = await importPack({ bytes: example.bytes, storage: packStorage() });
    expect(source.ok).toBe(true);

    const before = await libraryCounts();
    const sourceIds = await libraryIds();
    expect(before.worlds).toBeGreaterThan(0);
    expect(before.characters).toBeGreaterThan(0);

    const pack = await exportCurrentLibrary();
    expect(pack.bytes.length).toBeGreaterThan(0);
    expect(pack.fileName.endsWith('.stpack')).toBe(true);

    // The target library is empty, so nothing can be REUSED and every count is a carried row.
    openLibrary();

    const target = await importPack({ bytes: pack.bytes, storage: packStorage() });
    expect(target.ok).toBe(true);

    // The rows themselves, per kind the exporter writes.
    expect(await libraryCounts()).toEqual(before);
    expect(await libraryIds()).toEqual(sourceIds);

    // ...and the report describes those rows rather than summarising them: one line per row,
    // every one a CREATION, and each kind's line count is the collection's row count.
    expect(target.counts.created).toBe(target.entities.length);
    expect(target.counts.reused).toBe(0);
    expect(target.counts.remapped).toBe(0);
    expect(target.counts.skipped).toBe(0);
    expect(kindCounts(target).world).toBe(before.worlds);
    expect(kindCounts(target).worldbook).toBe(before.worldbook);
    expect(kindCounts(target).character).toBe(before.characters);
  });

  it('writes the same rows whether the example is built in process or built again', async () => {
    // The button's path — the one `/packs` calls.
    const button = await examplePackBytes();
    const buttonReport = await importPack({ bytes: button.bytes, storage: packStorage() });
    expect(buttonReport.ok).toBe(true);

    const buttonIds = await libraryIds();
    // The example's OWN ids arrived. That is what 「用示例开局」 resolves a session draft
    // against, and it is the property the CLI's output shares.
    expect(buttonIds.worlds).toContain(EXAMPLE_IDS.worlds.longdayHarbour.id);
    expect(buttonIds.characters).toContain(EXAMPLE_IDS.characters.shenYan.id);

    openLibrary();

    // The bytes a FILE would carry: the very entry point `tools/stpack-cli` calls, so the
    // example the app builds in process and the one a `.stpack` on disk holds cannot drift.
    const built = await buildExampleContentPack({ writer: createPackageWriter() });
    const builtReport = await importPack({ bytes: built.bytes, storage: packStorage() });
    expect(builtReport.ok).toBe(true);

    expect(rowLines(builtReport)).toEqual(rowLines(buttonReport));
    expect(await libraryIds()).toEqual(buttonIds);
  });

  it('puts no provider secret in the bytes it exports', async () => {
    const example = await examplePackBytes();
    await importPack({ bytes: example.bytes, storage: packStorage() });
    await writeProviderSettings({
      baseUrl: 'https://gateway.test/v1',
      model: 'leak-check',
      secret: { kind: 'plaintext', apiKey: SECRET_KEY },
    });

    // Presence first. A scan for an absent string proves nothing, so the key is shown to be in
    // the database the exporter reads before the package is asked whether it carried it — the
    // same order `db/provider-list.test.ts` uses for its own byte scan.
    expect(await snapshotAllRows(databaseName())).toContain(SECRET_KEY);

    const pack = await exportCurrentLibrary();

    // (1) Byte level, the shape `packages/importers/src/export-secrets.test.ts` uses.
    const text = new TextDecoder('utf-8').decode(pack.bytes);
    expect(text).not.toContain(SECRET_KEY);

    // (2) Structural level: the manifest makes the claim, and the payload is the library's own
    // files with nothing from `settings`/`providers` — the collections `EXPORTABLE_COLLECTIONS`
    // deliberately leaves out (ADR-034). This is the half the byte scan cannot make.
    expect(pack.manifest.redaction).toEqual({ apiKeys: 'excluded', absolutePaths: 'excluded' });
    const paths = pack.manifest.entries.map((entry) => entry.path);
    expect(paths).toContain('data/worlds.json');
    expect(paths).not.toContain('data/settings.json');
    expect(paths).not.toContain('data/providers.json');
  });
});
