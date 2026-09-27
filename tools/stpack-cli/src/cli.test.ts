/**
 * Tests for the `stpack` CLI (`docs/06-开发任务拆解.md` §8.3).
 *
 * `main()` takes argv and an injectable `CliIo` and returns an exit code instead
 * of calling `process.exit`, so every subcommand is testable in-process — which
 * is the whole reason the wrapper in `../bin/stpack.mjs` exists.
 *
 * These tests are the CLI's acceptance: three working subcommands, a content list
 * from `inspect`, and exit codes stable enough for CI to assert on.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pack } from '@smarttavern/packages';
import { type JsonValue, PACKAGE_COUNT_KEYS } from '@smarttavern/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from './cli';
import { EXIT } from './commands';
import type { CliIo } from './format';

const UTF8 = new TextEncoder();

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
  const dir = await mkdtemp(join(process.cwd(), '.tmp-stpack-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const WORLD: JsonValue = { name: '银松镇', premise: '守夜人与灯塔' };

function counts(): Record<string, number> {
  return { ...Object.fromEntries(PACKAGE_COUNT_KEYS.map((key) => [key, 0])), worlds: 1 };
}

/** A real, valid package written to disk. */
async function fixture(dir: string, name = 'world.stpack'): Promise<string> {
  const archive = await pack({
    manifest: {
      kind: 'world',
      id: '0192f0a1-2222-7000-8000-000000000001',
      name: '银松镇',
      createdAt: '2026-09-27T10:00:00.000Z',
      generator: { app: 'SmartTavern', version: '0.1.0', platform: 'cli' },
      license: 'CC-BY-4.0',
      counts: counts() as never,
      schemaVersions: { world: 1 },
      description: '一个单场景世界。',
      tags: ['奇幻'],
    },
    files: [
      { path: 'LICENSE.txt', bytes: UTF8.encode('CC-BY-4.0') },
      { path: 'data/worlds.json', json: WORLD },
    ],
  });
  const file = join(dir, name);
  await writeFile(file, archive);
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

/* ──────────────────────────────── validate ──────────────────────────────── */

describe('stpack validate', () => {
  it('accepts a good package and exits 0', async () => {
    const file = await fixture(await tempDir());
    const io = capture();
    expect(await main(['validate', file], io.io)).toBe(EXIT.ok);
    expect(io.out.join('\n')).toContain('OK');
  });

  it('emits machine-readable output with --json', async () => {
    const file = await fixture(await tempDir());
    const io = capture();
    expect(await main(['validate', '--json', file], io.io)).toBe(EXIT.ok);
    const parsed = JSON.parse(io.out.join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.manifest.name).toBe('银松镇');
    expect(parsed.findings).toEqual([]);
  });

  it('rejects a file that is not a package at all, and names the reason', async () => {
    const dir = await tempDir();
    const file = join(dir, 'broken.stpack');
    await writeFile(file, UTF8.encode('not a zip'));
    const io = capture();
    expect(await main(['validate', file], io.io)).toBe(EXIT.invalid);
    expect(io.out.join('\n')).toContain('zip-rejected');
  });

  it('exits 3 when the file cannot be read', async () => {
    const io = capture();
    expect(await main(['validate', join(await tempDir(), 'missing.stpack')], io.io)).toBe(EXIT.io);
    expect(io.err.join('\n')).toContain('cannot read');
  });
});

/* ──────────────────────────────── inspect ───────────────────────────────── */

describe('stpack inspect', () => {
  it('prints the manifest summary and the content list', async () => {
    const file = await fixture(await tempDir());
    const io = capture();
    expect(await main(['inspect', file], io.io)).toBe(EXIT.ok);

    const text = io.out.join('\n');
    expect(text).toContain('银松镇');
    expect(text).toContain('contents:');
    expect(text).toContain('worlds');
    expect(text).toContain('entries (2):');
    expect(text).toContain('data/worlds.json');
    expect(text).toContain('LICENSE.txt');
  });

  it('gives the full manifest as JSON for scripts', async () => {
    const file = await fixture(await tempDir());
    const io = capture();
    expect(await main(['inspect', '--json', file], io.io)).toBe(EXIT.ok);
    const parsed = JSON.parse(io.out.join('\n'));
    expect(parsed.summary.kind).toBe('world');
    expect(parsed.manifest.entries).toHaveLength(2);
    expect(parsed.manifest.contents.counts.worlds).toBe(1);
  });
});

/* ───────────────────────────────── unpack ───────────────────────────────── */

describe('stpack unpack', () => {
  it('writes the manifest first and every payload file', async () => {
    const file = await fixture(await tempDir());
    const target = join(await tempDir(), 'out');
    const io = capture();

    expect(await main(['unpack', file, target], io.io)).toBe(EXIT.ok);
    expect(await fileExists(join(target, 'manifest.json'))).toBe(true);
    expect(await fileExists(join(target, 'LICENSE.txt'))).toBe(true);
    expect(await fileExists(join(target, 'data', 'worlds.json'))).toBe(true);

    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('smarttavern.package');
    const world = JSON.parse(await readFile(join(target, 'data', 'worlds.json'), 'utf8'));
    expect(world).toEqual(WORLD);
  });

  it('refuses to overwrite existing files unless --force', async () => {
    const file = await fixture(await tempDir());
    const target = join(await tempDir(), 'out');

    expect(await main(['unpack', file, target], capture().io)).toBe(EXIT.ok);

    const second = capture();
    expect(await main(['unpack', file, target], second.io)).toBe(EXIT.io);
    expect(second.err.join('\n')).toContain('already exists');

    const forced = capture();
    expect(await main(['unpack', '--force', file, target], forced.io)).toBe(EXIT.ok);
  });

  it('writes nothing when the package is invalid', async () => {
    const dir = await tempDir();
    const file = join(dir, 'broken.stpack');
    await writeFile(file, UTF8.encode('not a zip'));
    const target = join(dir, 'out');
    const io = capture();

    expect(await main(['unpack', file, target], io.io)).toBe(EXIT.invalid);
    expect(await fileExists(target)).toBe(false);
    expect(io.err.join('\n')).toContain('refused');
  });
});

/* ───────────────────────────────── usage ────────────────────────────────── */

describe('stpack usage', () => {
  it('prints help and exits 0 for --help', async () => {
    const io = capture();
    expect(await main(['--help'], io.io)).toBe(EXIT.ok);
    expect(io.out.join('\n')).toContain('stpack validate');
  });

  it('tolerates the literal `--` that pnpm and npm insert when forwarding args', async () => {
    // `pnpm stpack -- --help` arrives as ['--', '--help']. Without dropping the
    // separator, parseArgs reads the flag as a positional and `--help` — the
    // documented way to ask for help — would be unreachable.
    const io = capture();
    expect(await main(['--', '--help'], io.io)).toBe(EXIT.ok);
    expect(io.out.join('\n')).toContain('stpack validate');
  });

  it('exits 2 for an unknown command, a missing file and an unknown flag', async () => {
    for (const argv of [['frobnicate'], ['validate'], ['--nope', 'validate', 'x']]) {
      const io = capture();
      expect(`${argv.join(' ')}:${await main(argv, io.io)}`).toBe(
        `${argv.join(' ')}:${EXIT.usage}`,
      );
      expect(io.err.join('\n')).toContain('stpack');
    }
  });
});

/* ─────────────────────────── output hygiene ─────────────────────────────── */

describe('output hygiene', () => {
  it('never emits an ANSI escape or a carriage return, so no host can flicker', async () => {
    // Project requirement (docs/06 §0.3): output is APPEND-ONLY. A spinner or an
    // in-place progress line (`\r`, `ESC[2K`) makes the embedding terminal — and
    // the WebView that hosts the app — repaint continuously. Asserting on the
    // bytes is the only way that rule survives a later "nice progress bar".
    const file = await fixture(await tempDir());
    const target = join(await tempDir(), 'out');
    const io = capture();

    await main(['--help'], io.io);
    await main(['validate', file], io.io);
    await main(['inspect', '--json', file], io.io);
    await main(['unpack', file, target], io.io);
    await main(['nonsense'], io.io);

    const all = [...io.out, ...io.err];
    expect(all.length).toBeGreaterThan(0);

    // `includes` rather than a regex literal: biome rightly rejects control
    // characters inside a pattern, and listing the offenders is more useful than
    // a bare boolean when this ever fails.
    const offenders = all.filter((line) => line.includes('\u001B') || line.includes('\r'));
    expect(offenders).toEqual([]);
  });
});
