/**
 * The import/export contract regression suite: `docs/04-分享格式规范.md` §12,
 * items 8–12.
 *
 * ONE TEST PER CLAUSE, NAMED AFTER THE CLAUSE — the same convention
 * `packages/packages/src/contract-regression.test.ts` uses for items 1–7, so a red
 * run names the promise that broke instead of a helper. Items 13 (`chat.jsonl`
 * round-trip, M1-I1) and 14 (JSON Schema) are deliberately absent.
 *
 * EVERYTHING HERE RUNS THROUGH THE PORTS: the storage is an in-memory
 * `StorageAdapter`, the container is this package's `PackageWriter`/`PackageReader`
 * double (the real ZIP is wired up in `tools/stpack-cli/src/import.test.ts`, which
 * is allowed to import `@smarttavern/packages`; this package is not).
 */
import { COLLECTIONS, type RowBase } from '@smarttavern/core';
import type {
  AgendaEntry,
  CharacterVersion,
  Checkpoint,
  MemoryEntry,
  Message,
  PromptPreset,
  Session,
  UuidV7,
  World,
  WorldVersion,
} from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { EXPORTABLE_COLLECTIONS, exportCharacterPackage } from './export-package';
import { IMPORT_EXTENSION_KEYS } from './identity';
import { FIXTURE, seedLibrary } from './testing/fixtures';
import {
  containerText,
  emptyLibrary,
  exportSession,
  importInto,
  memoryWriter,
  PACKAGE_ID,
  sequenceMinter,
} from './testing/harness';
import type { MemoryStorageAdapter } from './testing/memory-storage';

/** The collections a session import writes — the size snapshot uses them all. */
const TRACKED = [
  COLLECTIONS.worlds,
  COLLECTIONS.worldVersions,
  COLLECTIONS.worldbookEntries,
  COLLECTIONS.characters,
  COLLECTIONS.characterVersions,
  COLLECTIONS.promptPresets,
  COLLECTIONS.sessions,
  COLLECTIONS.messages,
  COLLECTIONS.checkpoints,
  COLLECTIONS.agenda,
  COLLECTIONS.memories,
  COLLECTIONS.settings,
] as const;

function sizes(storage: MemoryStorageAdapter): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const name of TRACKED) snapshot[name] = storage.size(name);
  return snapshot;
}

/** The one row a `[0]` would hide behind a type error, or a loud test failure. */
function only<T>(rows: readonly T[]): T {
  expect(rows).toHaveLength(1);
  const first = rows[0];
  if (first === undefined) throw new Error('expected exactly one row');
  return first;
}

/** A planted secret, an absolute path and a device id, for item 11. */
const PLANTED = {
  apiKey: 'sk-live-PLANTED-KEY-0123456789',
  providerKey: 'sk-live-PROVIDER-KEY-9876543210',
  path: 'D:\\SmartTavern\\secret-library',
  device: 'DEVICE-PLANTED-9F3A',
} as const;

describe('docs/04 §12 contract regression (import/export)', () => {
  it('§12-8 a session package restores world, characters, messages, clock, checkpoints and memories into an empty library', async () => {
    const source = emptyLibrary();
    seedLibrary(source);
    const { bytes, manifest } = await exportSession(source);
    expect(manifest.kind).toBe('session');

    const target = emptyLibrary();
    const report = await importInto(target, bytes);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ created: 12, reused: 0, remapped: 0, skipped: 0 });

    // The world: one version row plus the head the format does not carry.
    expect(
      target
        .peek<WorldVersion>(COLLECTIONS.worldVersions)
        .map((row) => `${row.worldId}@${row.version}:${row.data.name}`),
    ).toEqual([`${FIXTURE.worldId}@1:Silverpine`]);
    expect(
      target
        .peek<World>(COLLECTIONS.worlds)
        .map((row) => `${row.id}@${row.headVersion}:${row.name}`),
    ).toEqual([`${FIXTURE.worldId}@1:Silverpine`]);

    // The characters: both cards, player and cast.
    expect(
      target
        .peek<CharacterVersion>(COLLECTIONS.characterVersions)
        .map((row) => `${row.characterId}@${row.version}:${row.data.name}`),
    ).toEqual([`${FIXTURE.playerId}@1:Alice`, `${FIXTURE.npcId}@1:Bram`]);

    // The message tree, still a tree.
    expect(
      target
        .peek<Message>(COLLECTIONS.messages)
        .map((row) => `${row.id}<-${row.parentId ?? 'root'}:${row.speakerId ?? '-'}`),
    ).toEqual(['m-1<-root:-', `m-2<-m-1:${FIXTURE.playerId}`, `m-3<-m-2:${FIXTURE.npcId}`]);

    // The clock, twice over: the SESSION row carries the live state (ADR-032 — the
    // "now"), and the checkpoint carries its own full snapshot (docs/04 §6 — the
    // "then"). They are separate facts and an import must restore both.
    const session = only(target.peek<Session>(COLLECTIONS.sessions));
    expect(`${session.initialClock}:${session.state.clock}:${session.state.scene.time}`).toBe(
      '1000:1140:1140',
    );
    expect(session.state.vars).toEqual({ wind: 'strong' });
    const checkpoint = only(target.peek<Checkpoint>(COLLECTIONS.checkpoints));
    expect(`${checkpoint.id}:${checkpoint.state.clock}:${checkpoint.state.scene.time}`).toBe(
      'cp-1:1120:1120',
    );
    expect(checkpoint.state.vars).toEqual({ wind: 'strong' });
    expect(checkpoint.state.deadlines.map((deadline) => deadline.label)).toEqual(['Dawn']);

    // Memories and the agenda come along; the preset is embedded (§4). Memories
    // arrive in story order — `(atMinute, id)` — which is why the character
    // memory (1010) precedes the session one (1120).
    expect(
      target.peek<MemoryEntry>(COLLECTIONS.memories).map((row) => `${row.scope}:${row.targetId}`),
    ).toEqual([`character:${FIXTURE.playerId}`, `session:${FIXTURE.sessionId}`]);
    expect(target.peek<AgendaEntry>(COLLECTIONS.agenda).map((row) => row.title)).toEqual([
      'The lamp gutters',
    ]);
    expect(target.peek<PromptPreset>(COLLECTIONS.promptPresets).map((row) => row.name)).toEqual([
      'Default preset',
    ]);

    // And what a session package does NOT carry is not invented: worldbook entries
    // belong to the world package, not the save.
    expect(target.peek<RowBase>(COLLECTIONS.worldbookEntries)).toEqual([]);
  });

  it('§12-9 importing the same package twice adds nothing the second time', async () => {
    const source = emptyLibrary();
    seedLibrary(source);
    const { bytes } = await exportSession(source);

    const target = emptyLibrary();
    const first = await importInto(target, bytes);
    expect(first.counts).toEqual({ created: 12, reused: 0, remapped: 0, skipped: 0 });
    const afterFirst = sizes(target);

    const second = await importInto(target, bytes);

    expect(second.ok).toBe(true);
    expect(second.counts).toEqual({ created: 0, reused: 12, remapped: 0, skipped: 0 });
    expect(second.entities.map((entity) => entity.action)).toEqual([
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
      'reused',
    ]);
    expect(second.entities.map((entity) => entity.reason)).toEqual([
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
      'identical-content',
    ]);
    expect(sizes(target)).toEqual(afterFirst);
  });

  it('§12-10 a character with the same name but different content gets a new id, records originId, and leaves the original alone', async () => {
    const local = emptyLibrary();
    seedLibrary(local);
    const original = only(
      local
        .peek<CharacterVersion>(COLLECTIONS.characterVersions)
        .filter((row) => row.characterId === FIXTURE.playerId),
    );

    // The package's Alice is a DIFFERENT card with the same name and another id.
    const remotePlayer = '0192f0a1-5555-7000-8000-000000000001' as UuidV7;
    const remote = emptyLibrary();
    seedLibrary(remote, {
      playerId: remotePlayer,
      playerName: 'Alice',
      playerDescription: 'The lighthouse keeper.',
    });
    const { bytes } = await exportCharacterPackage({
      kind: 'character',
      storage: remote,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      characterId: remotePlayer,
    });

    const newId = '0192f0a1-9999-7000-8000-000000000100' as UuidV7;
    const report = await importInto(local, bytes, { mintId: sequenceMinter(100) });

    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ created: 0, reused: 0, remapped: 1, skipped: 0 });
    expect(report.entities[0]).toEqual({
      entity: 'character',
      collection: COLLECTIONS.characters,
      action: 'remapped',
      packageId: remotePlayer,
      id: newId,
      originId: remotePlayer,
      version: 1,
      name: 'Alice',
      reason: 'same-name-different-content',
    });

    const rows = local.peek<CharacterVersion>(COLLECTIONS.characterVersions);
    expect(rows).toHaveLength(3);
    const imported = only(rows.filter((row) => row.characterId === newId));
    expect(`${imported.data.name}:${imported.data.description}`).toBe(
      'Alice:The lighthouse keeper.',
    );
    expect(imported.extensions?.[IMPORT_EXTENSION_KEYS.originId]).toBe(remotePlayer);
    expect(imported.extensions?.[IMPORT_EXTENSION_KEYS.importedFrom]).toBe(PACKAGE_ID);

    // The original is byte-for-byte what it was: nothing was overwritten.
    expect(
      only(
        local
          .peek<CharacterVersion>(COLLECTIONS.characterVersions)
          .filter((row) => row.characterId === FIXTURE.playerId),
      ),
    ).toEqual(original);

    // ...and importing the same package AGAIN reuses the row it created, instead
    // of minting one more duplicate per attempt (that is what originId is for).
    const again = await importInto(local, bytes, { mintId: sequenceMinter(200) });
    expect(again.counts).toEqual({ created: 0, reused: 1, remapped: 0, skipped: 0 });
    expect(again.entities[0]?.reason).toBe('from-earlier-import');
    expect(local.peek<CharacterVersion>(COLLECTIONS.characterVersions)).toHaveLength(3);
  });

  it('§12-11 no API key, absolute path or device id reaches the package (static scan + unit test)', async () => {
    const source = emptyLibrary();
    seedLibrary(source);
    // The collections that hold secrets are NOT entities (docs/02 §7 `settings`),
    // which is why they must not be exportable at all (HANDOFF §4.1 invariant 6).
    source.seed(COLLECTIONS.settings, [
      { id: 'llm.apiKey', value: PLANTED.apiKey },
      { id: 'workspace.root', value: PLANTED.path },
      { id: 'device.id', value: PLANTED.device },
    ]);
    source.seed(COLLECTIONS.providers, [{ id: 'p-1', kind: 'llm', apiKey: PLANTED.providerKey }]);
    source.touched.length = 0;

    const { bytes, manifest } = await exportSession(source);
    const text = containerText(bytes);

    expect(text).toContain('Silverpine'); // the scan really is looking at payloads
    for (const secret of [PLANTED.apiKey, PLANTED.providerKey, PLANTED.path, PLANTED.device]) {
      expect(text).not.toContain(secret);
    }
    expect(manifest.redaction).toEqual({ apiKeys: 'excluded', absolutePaths: 'excluded' });

    // The stronger statement: the export path never even OPENED the collections
    // that hold them, so no future field can smuggle one out.
    expect(source.touched).not.toContain(COLLECTIONS.settings);
    expect(source.touched).not.toContain(COLLECTIONS.providers);
    for (const name of source.touched) expect(EXPORTABLE_COLLECTIONS).toContain(name);

    // Structural half of the same clause: no entry path is absolute.
    for (const entry of manifest.entries) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path).not.toContain(':');
    }
  });

  it('§12-12 an embedded version that conflicts with a local same-name version is remapped and every reference follows', async () => {
    const source = emptyLibrary();
    seedLibrary(source);
    const { bytes } = await exportSession(source);

    // The local library already holds the same world and the same Alice, EDITED:
    // different content under the same ids and names — the conflict item 12 names.
    const local = emptyLibrary();
    seedLibrary(local, {
      worldVersion: 2,
      worldPremise: 'An edited premise.',
      playerDescription: 'An edited description.',
      includeSession: false,
    });
    const worldsBefore = local.peek<WorldVersion>(COLLECTIONS.worldVersions);
    const charactersBefore = local.peek<CharacterVersion>(COLLECTIONS.characterVersions);

    const newWorld = '0192f0a1-9999-7000-8000-000000000100' as UuidV7;
    const newPlayer = '0192f0a1-9999-7000-8000-000000000102' as UuidV7;
    const report = await importInto(local, bytes, { mintId: sequenceMinter(100) });

    expect(report.ok).toBe(true);
    expect(
      report.entities
        .filter((entity) => entity.action === 'remapped')
        .map((entity) => `${entity.entity}:${entity.packageId}->${entity.id}:${entity.reason}`),
    ).toEqual([
      `world:${FIXTURE.worldId}->${newWorld}:id-collision-content-differs`,
      `character:${FIXTURE.playerId}->${newPlayer}:id-collision-content-differs`,
    ]);

    // The session's own refs follow the remap...
    const session = only(local.peek<Session>(COLLECTIONS.sessions));
    expect(session.refs.world).toEqual({ id: newWorld, version: 1 });
    expect(session.refs.playerCharacter).toEqual({ id: newPlayer, version: 1 });
    expect(session.refs.cast).toEqual([{ id: FIXTURE.npcId, version: 1 }]);

    // ...and so does every message that named a remapped speaker (item 12's
    // "消息引用一致"), including the narration that belongs to the reused NPC.
    expect(
      local
        .peek<Message>(COLLECTIONS.messages)
        .map((row) => `${row.id}<-${row.parentId ?? 'root'}:${row.speakerId ?? '-'}`),
    ).toEqual(['m-1<-root:-', `m-2<-m-1:${newPlayer}`, `m-3<-m-2:${FIXTURE.npcId}`]);

    // The rest of the save is remapped consistently with the same table.
    const checkpoint = only(local.peek<Checkpoint>(COLLECTIONS.checkpoints));
    expect(Object.keys(checkpoint.castState)).toEqual([newPlayer]);
    expect(checkpoint.state.clock).toBe(1120);
    expect(only(local.peek<AgendaEntry>(COLLECTIONS.agenda)).actors).toEqual([newPlayer]);
    expect(
      only(local.peek<MemoryEntry>(COLLECTIONS.memories).filter((row) => row.scope === 'character'))
        .targetId,
    ).toBe(newPlayer);

    // The local versions the import conflicted with are untouched.
    expect(
      local
        .peek<WorldVersion>(COLLECTIONS.worldVersions)
        .filter((row) => row.worldId === FIXTURE.worldId),
    ).toEqual(worldsBefore.filter((row) => row.worldId === FIXTURE.worldId));
    expect(
      local
        .peek<CharacterVersion>(COLLECTIONS.characterVersions)
        .filter((row) => row.characterId === FIXTURE.playerId),
    ).toEqual(charactersBefore.filter((row) => row.characterId === FIXTURE.playerId));
  });
});
