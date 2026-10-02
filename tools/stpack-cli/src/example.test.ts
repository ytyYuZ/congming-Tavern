/**
 * `stpack example` and the M1-I2 acceptance, over REAL `.stpack` bytes.
 *
 * WHY THIS FILE EXISTS AT ALL: `packages/importers` may not import
 * `@smarttavern/packages` (`biome.json`'s adapter override and
 * `tools/scripts/check-dependency-direction.mjs` allow `packages/schema` and
 * `packages/core` only), so that package's own suite builds the example pack with a
 * port-level container double. A tool workspace may import everything, so THIS is
 * where the example pack meets the real ZIP writer, the real reader, the real
 * validator and the CLI that writes and imports it:
 *
 *   stpack example out.stpack      → the real archive, reproducible byte for byte
 *   stpack validate / inspect      → the real validator reads it
 *   stpack import out.stpack lib   → the real importer writes the rows
 *   exampleStartSession(lib, …)    → a session pinned to those rows, in EITHER world
 *
 * That is the whole of "导入示例包即可开始一局" minus the UI, and it is the strongest
 * form this repository can check without `apps/web` (`docs/06` §2.6).
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { COLLECTIONS } from '@smarttavern/core';
import {
  EXAMPLE_IDS,
  EXAMPLE_LAST_FERRY_ROSTER,
  EXAMPLE_START_MINUTES,
  exampleStartSession,
  type ImportReport,
} from '@smarttavern/importers';
import { unpackPackage } from '@smarttavern/packages';
import { type PackageCounts, WorldVersionSchema } from '@smarttavern/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './cli';
import { EXIT } from './commands';
import type { CliIo } from './format';
import { JsonLibraryStorage, type LibraryDocument } from './library';

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
  const dir = await mkdtemp(join(process.cwd(), '.tmp-stpack-example-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

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

/** The `modelConfig` and preset pin the app owns; the CLI test passes them in. */
const MODEL_CONFIG = {
  provider: 'mock',
  model: 'mock-1',
  params: { temperature: 0.8, topP: 0.9 },
} as const;
const PRESET_PIN = { id: 'builtin-default', version: 1 } as const;
const NOW = (): Date => new Date('2026-09-27T10:00:00.000Z');

describe('stpack example', () => {
  it('writes the built-in example pack, which the real validator accepts and the real importer turns into playable rows', async () => {
    const dir = await tempDir();
    const file = join(dir, 'example.stpack');
    const library = join(dir, 'library.json');

    const built = capture();
    expect(await main(['example', file], built.io)).toBe(EXIT.ok);
    expect(built.out.join('\n')).toContain('长日港 · 末班渡 · 示例内容包');
    expect(built.out.join('\n')).toContain('worldbooks');

    // (1) The REAL validator accepts the archive, and `inspect` reports the bundle.
    expect(await main(['validate', file], capture().io)).toBe(EXIT.ok);
    const inspected = capture();
    expect(await main(['inspect', '--json', file], inspected.io)).toBe(EXIT.ok);
    const manifest = JSON.parse(inspected.out.join('\n')).manifest as {
      kind: string;
      contents: { counts: PackageCounts };
      refs: readonly { kind: string; requirement: string }[];
    };
    expect(manifest.kind).toBe('bundle');
    expect(manifest.contents.counts).toMatchObject({ worlds: 2, worldbooks: 8, characters: 4 });
    // The two halves §2.6 asks for that cannot exist yet are ZERO here, not faked.
    expect(manifest.contents.counts.rulePacks).toBe(0);
    expect(manifest.contents.counts.promptPresets).toBe(0);
    expect(manifest.refs.every((ref) => ref.requirement === 'embedded')).toBe(true);

    // The payloads really are readable content in a REAL (compressed) container.
    const unpacked = await unpackPackage(new Uint8Array(await readFile(file)));
    expect(unpacked.report.ok).toBe(true);
    const worlds = unpacked.files.find((entry) => entry.path === 'data/worlds.json');
    expect(worlds).toBeDefined();
    if (worlds === undefined) throw new Error('the archive carries no data/worlds.json');
    const versionRows = WorldVersionSchema.array().parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(worlds.bytes)),
    );
    expect(versionRows.map((row) => row.data.name)).toEqual(['长日港', '末班渡']);
    expect(versionRows.map((row) => row.data.calendar.hoursPerDay)).toEqual([26, 20]);
    expect(versionRows.map((row) => row.data.calendar.minutesPerHour)).toEqual([100, 45]);

    // (2) The CLI imports it into a JSON library, and every row validates.
    const imported = capture();
    expect(await main(['import', file, library], imported.io)).toBe(EXIT.ok);
    expect(imported.out.join('\n')).toContain('created 14');
    expect(imported.out.join('\n')).toContain('reused 0');

    const document = await readLibrary(library);
    expect(document[COLLECTIONS.worlds]?.map((row) => row.id)).toEqual([
      EXAMPLE_IDS.worlds.longdayHarbour.id,
      EXAMPLE_IDS.worlds.lastFerry.id,
    ]);
    expect(document[COLLECTIONS.worldbookEntries]).toHaveLength(8);
    expect(document[COLLECTIONS.characterVersions]).toHaveLength(4);
    // `settings` is not an entity and must not appear in a library document either.
    expect(document[COLLECTIONS.settings]).toBeUndefined();

    // (3) A session can be created from what the CLI wrote: the same storage adapter
    // the CLI used, the same rows, and each world's own clock — for the full setting
    // AND for the short scenario, which is the point of shipping both.
    const storage = JsonLibraryStorage.fromDocument(document);
    const longday = await exampleStartSession(storage, {
      modelConfig: MODEL_CONFIG,
      promptPreset: PRESET_PIN,
      now: NOW,
    });
    expect(longday.session.refs.world).toEqual({
      id: EXAMPLE_IDS.worlds.longdayHarbour.id,
      version: 1,
    });
    expect(longday.session.refs.playerCharacter).toEqual({
      id: EXAMPLE_IDS.characters.shenYan.id,
      version: 1,
    });
    expect(longday.session.refs.cast).toEqual([
      { id: EXAMPLE_IDS.characters.taoSanniang.id, version: 1 },
    ]);
    expect(longday.session.refs.rulePack).toBeUndefined();
    expect(longday.session.initialClock).toBe(EXAMPLE_START_MINUTES.longdayHarbour);
    expect(longday.session.state.clock).toBe(EXAMPLE_START_MINUTES.longdayHarbour);

    const ferry = await exampleStartSession(storage, {
      modelConfig: MODEL_CONFIG,
      promptPreset: PRESET_PIN,
      roster: EXAMPLE_LAST_FERRY_ROSTER,
      now: NOW,
    });
    expect(ferry.session.refs.world).toEqual({ id: EXAMPLE_IDS.worlds.lastFerry.id, version: 1 });
    expect(ferry.session.refs.playerCharacter).toEqual({
      id: EXAMPLE_IDS.characters.awu.id,
      version: 1,
    });
    expect(ferry.session.refs.cast).toEqual([{ id: EXAMPLE_IDS.characters.duBo.id, version: 1 }]);
    expect(ferry.session.initialClock).toBe(EXAMPLE_START_MINUTES.lastFerry);
    expect(ferry.worldVersion.data.name).toBe('末班渡');
  });

  it('reproduces the same bytes on every run, which is why the repository commits source and not a binary', async () => {
    const dir = await tempDir();
    const first = join(dir, 'first.stpack');
    const second = join(dir, 'second.stpack');

    expect(await main(['example', first], capture().io)).toBe(EXIT.ok);
    expect(await main(['example', second], capture().io)).toBe(EXIT.ok);

    expect(new Uint8Array(await readFile(second))).toEqual(new Uint8Array(await readFile(first)));
  });

  it('refuses to overwrite an existing file unless --force, and exits 3', async () => {
    const dir = await tempDir();
    const file = join(dir, 'example.stpack');
    expect(await main(['example', file], capture().io)).toBe(EXIT.ok);

    const refused = capture();
    expect(await main(['example', file], refused.io)).toBe(EXIT.io);
    expect(refused.err.join('\n')).toContain('already exists');

    expect(await main(['example', '--force', file], capture().io)).toBe(EXIT.ok);
  });

  it('exits 2 without a target file', async () => {
    const io = capture();
    expect(await main(['example'], io.io)).toBe(EXIT.usage);
    expect(io.err.join('\n')).toContain('example needs a <file>');
  });

  it('reports the same report shape an import script already parses', async () => {
    const dir = await tempDir();
    const file = join(dir, 'example.stpack');
    const library = join(dir, 'library.json');
    expect(await main(['example', '--json', file], capture().io)).toBe(EXIT.ok);

    const io = capture();
    expect(await main(['import', '--json', file, library], io.io)).toBe(EXIT.ok);
    const report = JSON.parse(io.out.join('\n')) as ImportReport;

    expect(report.ok).toBe(true);
    expect(report.package?.kind).toBe('bundle');
    expect(report.counts).toEqual({ created: 14, reused: 0, remapped: 0, skipped: 0 });
    expect(report.findings).toEqual([]);
    expect(await fileExists(library)).toBe(true);
  });
});
