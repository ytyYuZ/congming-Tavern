/**
 * `stpack import` against REAL `.stpack` bytes.
 *
 * WHY THIS FILE EXISTS AT ALL: `packages/importers` may not import
 * `@smarttavern/packages` (`biome.json`'s adapter override and
 * `tools/scripts/check-dependency-direction.mjs` allow `packages/schema` and
 * `packages/core` only), so the importer's own tests run against a port-level
 * double. A tool workspace may import everything, so THIS is where the real
 * container, the real reader/writer and the importer meet: a real ZIP written by
 * `createPackageWriter`, imported by `stpack import` into a JSON library, with the
 * report printed.
 *
 * IT ALSO PINS TWO THINGS THE UNIT TESTS CANNOT: that the importer's canonical JSON
 * agrees byte for byte with `@smarttavern/packages`'s (two implementations of one
 * frozen rule, §11 v1-r3 — a drift here would make packages non-diffable), and that
 * the §12 item 11 static scan holds for COMPRESSED bytes (a naive scan of a ZIP
 * would find nothing either way, which is why it decompresses first).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLECTIONS } from '@smarttavern/core';
import {
  exportSessionPackage,
  FIXTURE,
  canonicalJsonBytes as importerCanonicalJson,
  MemoryStorageAdapter,
  type PayloadCategory,
  seedLibrary,
} from '@smarttavern/importers';
import {
  createPackageWriter,
  canonicalJsonBytes as packagesCanonicalJson,
  unpackPackage,
} from '@smarttavern/packages';
import type { UuidV7 } from '@smarttavern/schema';
import { CheckpointSchema } from '@smarttavern/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './cli';
import { EXIT, parseSelection } from './commands';
import type { CliIo } from './format';
import type { LibraryDocument } from './library';

const FIXED_TIME = new Date('2026-09-27T10:00:00.000Z');
const PACKAGE_ID: UuidV7 = '0192f0a1-9999-7000-8000-000000000001';

const PLANTED = {
  apiKey: 'sk-live-PLANTED-KEY-0123456789',
  path: 'D:\\SmartTavern\\secret-library',
  device: 'DEVICE-PLANTED-9F3A',
} as const;

interface Capture {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-stpack-import-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A complete library, with the secrets a package must never carry, if asked. */
function seededLibrary(options: { secrets?: boolean } = {}): MemoryStorageAdapter {
  const storage = new MemoryStorageAdapter();
  seedLibrary(storage);
  if (options.secrets === true) {
    storage.seed(COLLECTIONS.settings, [
      { id: 'llm.apiKey', value: PLANTED.apiKey },
      { id: 'workspace.root', value: PLANTED.path },
      { id: 'device.id', value: PLANTED.device },
    ]);
    storage.seed(COLLECTIONS.providers, [{ id: 'p-1', kind: 'llm', apiKey: PLANTED.apiKey }]);
  }
  return storage;
}

/** A real `.stpack` session package, written by the real writer. */
async function realSessionPackage(storage: MemoryStorageAdapter): Promise<Uint8Array> {
  const result = await exportSessionPackage({
    kind: 'session',
    storage,
    writer: createPackageWriter({ now: () => FIXED_TIME, mintId: () => PACKAGE_ID }),
    id: PACKAGE_ID,
    sessionId: FIXTURE.sessionId,
    license: 'CC-BY-4.0',
  });
  return result.bytes;
}

async function writePackage(dir: string, bytes: Uint8Array): Promise<string> {
  const file = join(dir, 'save.stpack');
  await writeFile(file, bytes);
  return file;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readLibrary(path: string): Promise<LibraryDocument> {
  return JSON.parse(await readFile(path, 'utf8')) as LibraryDocument;
}

function only<T>(rows: readonly T[]): T {
  expect(rows).toHaveLength(1);
  const first = rows[0];
  if (first === undefined) throw new Error('expected exactly one row');
  return first;
}

/* ───────────────────────────────── import ───────────────────────────────── */

describe('stpack import', () => {
  it('imports a real session package and prints the report, then reuses everything on a second run', async () => {
    const dir = await tempDir();
    const file = await writePackage(dir, await realSessionPackage(seededLibrary()));
    const library = join(dir, 'library.json');

    const first = capture();
    expect(await main(['import', file, library], first.io)).toBe(EXIT.ok);
    const firstText = first.out.join('\n');
    expect(firstText).toContain('created 12');
    expect(firstText).toContain('Silverpine');
    expect(firstText).toContain('library contents');

    const document = await readLibrary(library);
    expect((document[COLLECTIONS.worlds] ?? []).map((row) => row.id)).toEqual([FIXTURE.worldId]);
    expect(document[COLLECTIONS.messages]).toHaveLength(3);
    expect(document[COLLECTIONS.checkpoints]).toHaveLength(1);
    expect(document[COLLECTIONS.memories]).toHaveLength(2);
    expect(document[COLLECTIONS.characters]).toHaveLength(2);
    expect(document[COLLECTIONS.sessions]).toHaveLength(1);
    // `settings` is not an entity and must not appear in a library document either.
    expect(document[COLLECTIONS.settings]).toBeUndefined();

    const second = capture();
    expect(await main(['import', file, library], second.io)).toBe(EXIT.ok);
    const secondText = second.out.join('\n');
    expect(secondText).toContain('created 0');
    expect(secondText).toContain('reused 12');
    expect(await readLibrary(library)).toEqual(document);
  });

  it('gives the report to scripts with --json', async () => {
    const dir = await tempDir();
    const file = await writePackage(dir, await realSessionPackage(seededLibrary()));
    const library = join(dir, 'library.json');

    const io = capture();
    expect(await main(['import', '--json', file, library], io.io)).toBe(EXIT.ok);
    const parsed = JSON.parse(io.out.join('\n'));

    expect(parsed.ok).toBe(true);
    expect(parsed.package.kind).toBe('session');
    expect(parsed.counts).toEqual({ created: 12, reused: 0, remapped: 0, skipped: 0 });
    expect(parsed.entities).toHaveLength(12);
    expect(parsed.findings).toEqual([]);
    expect(parsed.librarySizes[COLLECTIONS.messages]).toBe(3);
  });

  it('--dry-run reports the plan and writes no library', async () => {
    const dir = await tempDir();
    const file = await writePackage(dir, await realSessionPackage(seededLibrary()));
    const library = join(dir, 'library.json');

    const io = capture();
    expect(await main(['import', '--dry-run', file, library], io.io)).toBe(EXIT.ok);

    expect(io.out.join('\n')).toContain('dry run, nothing was written');
    expect(await fileExists(library)).toBe(false);
  });

  it('--select imports only the named categories and reports the rest as skipped', async () => {
    const dir = await tempDir();
    const file = await writePackage(dir, await realSessionPackage(seededLibrary()));
    const library = join(dir, 'library.json');

    const io = capture();
    expect(await main(['import', '--select', 'worlds,session', file, library], io.io)).toBe(
      EXIT.ok,
    );
    expect(io.out.join('\n')).toContain('skipped');

    const document = await readLibrary(library);
    expect(document[COLLECTIONS.worlds]).toHaveLength(1);
    expect(document[COLLECTIONS.sessions]).toHaveLength(1);
    expect(document[COLLECTIONS.characters]).toBeUndefined();
    expect(document[COLLECTIONS.messages]).toBeUndefined();
  });

  it('refuses a file that is not a package, exits 1 and writes no library', async () => {
    const dir = await tempDir();
    const file = join(dir, 'broken.stpack');
    await writeFile(file, new TextEncoder().encode('not a zip'));
    const library = join(dir, 'library.json');

    const io = capture();
    expect(await main(['import', file, library], io.io)).toBe(EXIT.invalid);
    expect(io.out.join('\n')).toContain('REFUSED');
    expect(await fileExists(library)).toBe(false);
  });

  it('refuses a payload the entity schemas reject, and leaves no library behind', async () => {
    const dir = await tempDir();
    // A valid container whose `data/worlds.json` is JSON but not a WorldVersion[]:
    // container validation passes and ENTITY validation (the importer's job) fails.
    const written = await createPackageWriter({
      now: () => FIXED_TIME,
      mintId: () => PACKAGE_ID,
    }).write(
      [{ path: 'data/worlds.json', bytes: new TextEncoder().encode('{"not":"an array"}') }],
      { kind: 'world', id: PACKAGE_ID },
    );
    const file = await writePackage(dir, written.bytes);
    const library = join(dir, 'library.json');

    const io = capture();
    expect(await main(['import', file, library], io.io)).toBe(EXIT.invalid);
    expect(io.out.join('\n')).toContain('payload-schema');
    expect(await fileExists(library)).toBe(false);
  });

  it('exits 2 when --select names something that is not a payload category', async () => {
    const dir = await tempDir();
    const file = await writePackage(dir, await realSessionPackage(seededLibrary()));
    const io = capture();

    expect(await main(['import', '--select', 'nonsense', file, join(dir, 'l.json')], io.io)).toBe(
      EXIT.usage,
    );
    expect(io.err.join('\n')).toContain('payload categories');
  });

  it("maps an allow-list onto the importer's skip map, and rejects unknown names", () => {
    const selection = parseSelection(['worlds', 'characters']);
    const expected: Partial<Record<PayloadCategory, boolean>> = {
      worlds: true,
      worldbooks: false,
      characters: true,
      promptPresets: false,
      session: false,
      messages: false,
      checkpoints: false,
      agenda: false,
      memories: false,
      state: false,
    };
    expect(selection).toEqual(expected);
    expect(parseSelection(undefined)).toEqual({});
    expect(parseSelection(['nope'])).toBeUndefined();
  });
});

/* ───────────────────────── cross-package contracts ──────────────────────── */

describe('contracts only a tool workspace can check', () => {
  it('the importer and @smarttavern/packages produce the same canonical JSON bytes', () => {
    const fixture = {
      zebra: 1,
      alpha: { nested: ['b', 'a'], Ä: 'umlaut stays literal', deep: { y: 1, x: 2 } },
      empty: {},
      array: [{ b: 1, a: 2 }, null, true, -0.5],
      text: '银松镇 · dusk\n',
    };

    expect(Array.from(importerCanonicalJson(fixture))).toEqual(
      Array.from(packagesCanonicalJson(fixture)),
    );
  });

  it('a planted API key, path and device id never reach the REAL archive', async () => {
    const bytes = await realSessionPackage(seededLibrary({ secrets: true }));
    const unpacked = await unpackPackage(bytes);
    expect(unpacked.report.ok).toBe(true);

    const texts = unpacked.files.map((file) => new TextDecoder('utf-8').decode(file.bytes));
    const all = texts.join('\n');
    for (const secret of [PLANTED.apiKey, PLANTED.path, PLANTED.device]) {
      expect(all).not.toContain(secret);
    }
    // Sanity: the scan is looking at real, decompressed payloads.
    expect(all).toContain('Silverpine');
    expect(unpacked.manifest?.redaction).toEqual({
      apiKeys: 'excluded',
      absolutePaths: 'excluded',
    });
  });

  it('a session package round-trips through the real container and the real reporter', async () => {
    const dir = await tempDir();
    const bytes = await realSessionPackage(seededLibrary());
    const file = await writePackage(dir, bytes);
    const library = join(dir, 'library.json');

    expect(await main(['import', file, library], capture().io)).toBe(EXIT.ok);

    // The library the CLI wrote is parsed back through the FROZEN entity schema, so
    // "the CLI wrote rows" is not asserted against a hand-rolled shape: it is
    // asserted against the contract itself, and the clock the package arrived with
    // is still there.
    const document = await readLibrary(library);
    const checkpoint = CheckpointSchema.parse(only(document[COLLECTIONS.checkpoints] ?? []));
    expect(checkpoint.state.clock).toBe(1120);
    expect(checkpoint.label).toBe('Opening');
  });
});
