/**
 * A failed import must leave the library exactly as it was.
 *
 * TWO FAILURE MODES, BOTH REQUIRED:
 *   1. the PACKAGE is bad (a payload that is valid JSON but not an entity) — the
 *      import must refuse before it opens a transaction at all;
 *   2. the WRITE fails halfway — the port's transaction rolls back, so a storage
 *      error can never leave a half-imported save behind. That case is the reason
 *      the importer does everything inside one `StorageAdapter.transaction` call
 *      instead of writing as it decides.
 *
 * `MemoryStorageAdapter.failOn` injects the second failure mid-`putMany`, which is
 * the only way to reach the interesting state: rows already written, then a throw.
 */
import { COLLECTION_NAMES, COLLECTIONS } from '@smarttavern/core';
import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes } from './canonical-json';
import { seedLibrary } from './testing/fixtures';
import { emptyLibrary, exportSession, importInto, repackage } from './testing/harness';
import type { MemoryStorageAdapter } from './testing/memory-storage';

function sizes(storage: MemoryStorageAdapter): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const name of COLLECTION_NAMES) snapshot[name] = storage.size(name);
  return snapshot;
}

function emptySizes(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const name of COLLECTION_NAMES) snapshot[name] = 0;
  return snapshot;
}

async function fixtureBytes(): Promise<Uint8Array> {
  const source = emptyLibrary();
  seedLibrary(source);
  return (await exportSession(source)).bytes;
}

describe('a failed import leaves the storage untouched', () => {
  it('refuses an unparseable payload without even opening a transaction', async () => {
    const bytes = await fixtureBytes();
    // Valid JSON, wrong entity: the package passes the container checks and fails
    // entity validation — the case `packages/packages` deliberately does not cover.
    const patched = await repackage(bytes, (files) => {
      files.set('data/worlds.json', canonicalJsonBytes({ not: 'an array' }));
    });

    const target = emptyLibrary();
    const report = await importInto(target, patched);

    expect(report.ok).toBe(false);
    expect(
      report.findings
        .filter((finding) => finding.code === 'payload-schema')
        .map((finding) => finding.path),
    ).toEqual(['data/worlds.json']);
    expect(target.transactionCount).toBe(0);
    expect(sizes(target)).toEqual(emptySizes());
  });

  it('refuses a package whose character payload is not a character', async () => {
    const bytes = await fixtureBytes();
    const patched = await repackage(bytes, (files) => {
      files.set('data/characters.json', canonicalJsonBytes([{ id: 'broken' }]));
    });

    const target = emptyLibrary();
    const report = await importInto(target, patched);

    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'payload-schema')).toBe(true);
    expect(target.transactionCount).toBe(0);
    expect(sizes(target)).toEqual(emptySizes());
  });

  it('rolls a write failure back, including the rows already written', async () => {
    const bytes = await fixtureBytes();
    const target = emptyLibrary();
    // `worlds` is written before `worldVersions`, and `putMany` writes its first row
    // before the injected failure fires — so there IS something to roll back.
    target.failOn = { collection: COLLECTIONS.worldVersions, method: 'putMany' };

    await expect(importInto(target, bytes)).rejects.toThrow(/injected putMany failure/);

    expect(target.transactionCount).toBe(1);
    expect(sizes(target)).toEqual(emptySizes());
    expect(target.peek(COLLECTIONS.worlds)).toEqual([]);
  });

  it('keeps a successful import atomic across every collection', async () => {
    const bytes = await fixtureBytes();
    const target = emptyLibrary();
    const report = await importInto(target, bytes);

    expect(report.ok).toBe(true);
    // One transaction for the whole import: "as few as the port allows".
    expect(target.transactionCount).toBe(1);
    expect(sizes(target)[COLLECTIONS.messages]).toBe(3);
    expect(sizes(target)[COLLECTIONS.worldVersions]).toBe(1);
  });
});
