/**
 * Round-trip tests: export → import → export.
 *
 * `docs/04` §12-1 already pins byte equality for the CONTAINER (`pack` → `unpack`
 * → `pack`). What is new here is the ENTITY layer: the same content must survive a
 * trip through a database, which is a different claim — the importer decides
 * identity, rewrites references and derives head rows, and any of those could
 * quietly change what the second export writes. So both are asserted: the entity
 * set (so a failure says WHICH file changed) and then the bytes (the strongest
 * form of "nothing changed").
 *
 * The suite also covers the two import-flow branches `docs/04` §7 names but the
 * §12 clauses do not: the user's cherry-pick (step 7) and a missing dependency
 * (step 6).
 *
 * AND `state.json` (ADR-032): it is the session's LIVE state on the session row, so
 * it must survive the trip on its own terms — equal to the exported session's
 * `state`, distinct from the newest checkpoint, and written back into the session
 * row on the way in. The fixture's live clock (1140) deliberately differs from its
 * checkpoint's (1120) so a test cannot pass by reading the wrong one.
 */
import { COLLECTIONS } from '@smarttavern/core';
import type {
  CharacterVersion,
  Session,
  SessionState,
  World,
  WorldbookEntry,
  WorldVersion,
} from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { exportCharacterPackage, exportWorldPackage } from './export-package';
import { FIXTURE, seedLibrary } from './testing/fixtures';
import {
  emptyLibrary,
  exportSession,
  importInto,
  memoryWriter,
  PACKAGE_ID,
  payloadOf,
  repackage,
} from './testing/harness';
import { decodeContainer } from './testing/memory-package';
import type { MemoryStorageAdapter } from './testing/memory-storage';

/** Every payload a session package carries, in the order `docs/04` §2 lists them. */
const SESSION_PAYLOADS = [
  'data/session.json',
  'data/worlds.json',
  'data/characters.json',
  'data/messages.jsonl',
  'data/checkpoints.json',
  'data/agenda.json',
  'data/memories.json',
  'data/state.json',
  'data/promptPresets.json',
  'LICENSE.txt',
  'README.txt',
] as const;

async function firstSession(): Promise<{ source: MemoryStorageAdapter; bytes: Uint8Array }> {
  const source = emptyLibrary();
  seedLibrary(source);
  const result = await exportSession(source);
  return { source, bytes: result.bytes };
}

/** One payload as a comparable value: JSONL becomes an array of lines, text stays text. */
function payloadValue(bytes: Uint8Array, path: string): unknown {
  const raw = decodeContainer(bytes).get(path);
  if (raw === undefined) throw new Error(`the package has no ${path}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (path.endsWith('.txt')) return text;
  if (path.endsWith('.jsonl')) {
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }
  return JSON.parse(text);
}

describe('export → import → export', () => {
  it('a session package produces the same entity set and the same bytes after a round trip', async () => {
    const { bytes } = await firstSession();

    const target = emptyLibrary();
    const report = await importInto(target, bytes);
    expect(report.ok).toBe(true);

    const again = await exportSession(target);

    // Entity first: a mismatch names the file that changed.
    for (const path of SESSION_PAYLOADS) {
      expect({ path, value: payloadValue(again.bytes, path) }).toEqual({
        path,
        value: payloadValue(bytes, path),
      });
    }
    // Then the whole archive: nothing else (manifest identity, ordering, JSON form)
    // drifted either.
    expect(again.bytes).toEqual(bytes);
  });

  it('a world package round-trips its version and its worldbook entries', async () => {
    const source = emptyLibrary();
    seedLibrary(source);
    const exported = await exportWorldPackage({
      kind: 'world',
      storage: source,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      worldId: FIXTURE.worldId,
    });

    const target = emptyLibrary();
    const report = await importInto(target, exported.bytes);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ created: 2, reused: 0, remapped: 0, skipped: 0 });
    expect(
      target
        .peek<WorldVersion>(COLLECTIONS.worldVersions)
        .map((row) => `${row.worldId}@${row.version}`),
    ).toEqual([`${FIXTURE.worldId}@1`]);
    expect(target.peek<World>(COLLECTIONS.worlds).map((row) => row.headVersion)).toEqual([1]);
    expect(target.peek<WorldbookEntry>(COLLECTIONS.worldbookEntries).map((row) => row.id)).toEqual([
      FIXTURE.worldbookId,
    ]);

    const reExported = await exportWorldPackage({
      kind: 'world',
      storage: target,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      worldId: FIXTURE.worldId,
    });
    expect(reExported.bytes).toEqual(exported.bytes);
  });

  it('a character package round-trips the card', async () => {
    const source = emptyLibrary();
    seedLibrary(source);
    const exported = await exportCharacterPackage({
      kind: 'character',
      storage: source,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      characterId: FIXTURE.playerId,
    });

    const target = emptyLibrary();
    const report = await importInto(target, exported.bytes);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ created: 1, reused: 0, remapped: 0, skipped: 0 });
    expect(
      target.peek<CharacterVersion>(COLLECTIONS.characterVersions).map((row) => row.data.name),
    ).toEqual(['Alice']);

    const reExported = await exportCharacterPackage({
      kind: 'character',
      storage: target,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      characterId: FIXTURE.playerId,
    });
    expect(reExported.bytes).toEqual(exported.bytes);
  });

  it('a cherry-pick imports the chosen categories and reports the skipped ones (docs/04 §7 step 7)', async () => {
    const { bytes } = await firstSession();
    const target = emptyLibrary();

    const report = await importInto(target, bytes, { select: { characters: false } });

    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ created: 10, reused: 0, remapped: 0, skipped: 2 });
    expect(
      report.entities
        .filter((entity) => entity.action === 'skipped')
        .map((entity) => `${entity.entity}:${entity.name}:${entity.reason}`),
    ).toEqual(['character:Alice:not-selected', 'character:Bram:not-selected']);
    expect(target.peek<CharacterVersion>(COLLECTIONS.characterVersions)).toEqual([]);
    // The session still references the characters it was built with, and a skipped
    // entity is not silently "resolved": the report names EVERY site that noticed,
    // from the session's refs down to the message speakers and the checkpoint cast.
    expect(
      report.findings
        .filter((finding) => finding.code === 'import-reference-unresolved')
        .map((finding) => finding.where),
    ).toEqual([
      'message m-2.speakerId',
      'message m-3.speakerId',
      'checkpoint cp-1.castState',
      'agenda agenda-1.actors',
      'memory memory-2.targetId',
      'session.refs.playerCharacter',
      'session.refs.cast',
    ]);
  });

  it('a required dependency that is not here refuses the import and writes nothing (docs/04 §7 step 6)', async () => {
    // A perfectly valid world package that additionally REQUIRES a rule pack this
    // library does not have: §7 step 6 says stop and say what is missing.
    const source = emptyLibrary();
    seedLibrary(source);
    const exported = await exportWorldPackage({
      kind: 'world',
      storage: source,
      writer: memoryWriter(),
      id: PACKAGE_ID,
      worldId: FIXTURE.worldId,
    });
    const files = decodeContainer(exported.bytes);
    files.delete('manifest.json');
    const { bytes } = await memoryWriter().write(
      [...files].map(([path, content]) => ({ path, bytes: content })),
      {
        kind: 'world',
        id: PACKAGE_ID,
        refs: [{ kind: 'rulepack', id: 'dnd5e-srd', version: 1, requirement: 'required' }],
      },
    );

    const target = emptyLibrary();
    const report = await importInto(target, bytes);

    expect(report.ok).toBe(false);
    expect(
      report.findings.map((finding) => `${finding.severity}:${finding.code}:${finding.where}`),
    ).toContain('error:import-missing-dependency:refs[rulepack:dnd5e-srd]');
    expect(target.peek<WorldVersion>(COLLECTIONS.worldVersions)).toEqual([]);
    expect(report.counts).toEqual({ created: 0, reused: 0, remapped: 0, skipped: 0 });
  });

  it('state.json is the session’s LIVE state, and an import writes it back into the session row', async () => {
    // ADR-032: the live state is `Session.state` on the session row — "now" — and a
    // checkpoint is a snapshot in its own collection — "then". The fixture proves the
    // two are NOT the same value (live 1140 vs checkpoint 1120), so a test that
    // accepted either one would be caught here.
    const source = emptyLibrary();
    seedLibrary(source);
    const row = source.peek<Session>(COLLECTIONS.sessions)[0];
    if (row === undefined) throw new Error('the fixture library has no session');
    // Move the live clock PAST the last save point, which is the whole point of
    // storing it separately: time between two manual saves has nowhere else to live.
    const liveState: SessionState = {
      ...row.state,
      scene: { title: 'The cliff path', location: 'Silverpine', time: 9999 },
      clock: 9999,
      vars: { mood: 'wary' },
    };
    source.seed(COLLECTIONS.sessions, [{ ...row, state: liveState }]);

    const { bytes } = await exportSession(source);

    // (1) `state.json` IS the exported session's live state, value for value.
    expect(payloadOf(bytes, 'data/state.json')).toEqual(liveState);
    // ...while the checkpoint still carries its own snapshot, untouched.
    const checkpoints = payloadOf(bytes, 'data/checkpoints.json') as { state: SessionState }[];
    expect(checkpoints[0]?.state.clock).toBe(1120);

    // (2) An import puts it back on the session row, through the real import path.
    const target = emptyLibrary();
    const report = await importInto(target, bytes);

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(target.peek<Session>(COLLECTIONS.sessions)[0]?.state.clock).toBe(9999);
    expect(target.peek<Session>(COLLECTIONS.sessions)[0]?.state.vars).toEqual({ mood: 'wary' });
  });

  it('a state.json with no session to carry it is reported (ADR-032)', async () => {
    // The state now lives ON the session row, so a package whose session was
    // cherry-picked away has nowhere to put it. That is worth a warning rather than a
    // silent drop — the import still succeeds, it just cannot store the clock.
    const { bytes } = await firstSession();
    const patched = await repackage(bytes, (files) => {
      files.delete('data/session.json');
    });

    const target = emptyLibrary();
    const report = await importInto(target, patched);

    expect(report.ok).toBe(true);
    // The state is the finding under test; the message/agenda references to the
    // session that is no longer in the package are reported too (and that is correct
    // — they now dangle), so this asserts the code is present rather than alone.
    expect(report.findings.map((finding) => finding.code)).toContain(
      'import-state-without-session',
    );
    expect(target.peek<Session>(COLLECTIONS.sessions)).toEqual([]);
  });

  it('an unreadable container is refused as a finding, not as a crash', async () => {
    const target = emptyLibrary();
    const report = await importInto(target, new TextEncoder().encode('not a package'));

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('zip-corrupt');
    expect(target.transactionCount).toBe(0);
  });

  it('imports into a library that already holds the same world and cast without duplicating them', async () => {
    // The library has the catalog but no playthrough yet: the catalog is reused and
    // only the save itself is created.
    const { bytes } = await firstSession();
    const target = emptyLibrary();
    seedLibrary(target, { includeSession: false });

    const report = await importInto(target, bytes);

    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ created: 8, reused: 4, remapped: 0, skipped: 0 });
    expect(
      report.entities
        .filter((entity) => entity.action === 'created')
        .map((entity) => entity.entity),
    ).toEqual([
      'session',
      'message',
      'message',
      'message',
      'agenda',
      'checkpoint',
      'memory',
      'memory',
    ]);
    expect(
      report.entities.filter((entity) => entity.action === 'reused').map((entity) => entity.entity),
    ).toEqual(['world', 'character', 'character', 'promptPreset']);
    expect(target.peek<Session>(COLLECTIONS.sessions)).toHaveLength(1);
  });
});
