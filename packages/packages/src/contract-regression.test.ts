/**
 * The contract regression suite: `docs/04-分享格式规范.md` §12, items 1–7.
 *
 * ONE TEST PER CLAUSE, NAMED AFTER THE CLAUSE. The packaging layer already has
 * deeper tests (`pack.test.ts`, `zip/zip.test.ts`, `zip/read-rejects.test.ts`), but
 * those are organised by *mechanism*. This file is organised by *promise*: when the
 * spec's acceptance list changes, the diff should be visible here, and a red run
 * should name the clause that broke rather than a helper.
 *
 * Items 8–14 of that list are M1 work (import/export against a real library,
 * SillyTavern round-trips) and are deliberately absent.
 */
import {
  CURRENT_SCHEMA_VERSIONS,
  type JsonValue,
  MIGRATIONS,
  type MigrationStep,
  migrate,
  PACKAGE_COUNT_KEYS,
} from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes } from './canonical-json';
import { type ManifestDraft, type PayloadInput, sha256Hex } from './manifest';
import { pack } from './pack';
import { unpackPackage } from './unpack';
import { validatePackage } from './validate';
import { readZip } from './zip/read';
import { writeZip } from './zip/write';

const UTF8 = new TextEncoder();

const PACKAGE_ID = '0192f0a1-2222-7000-8000-000000000001';
const WORLD: JsonValue = { name: '银松镇', premise: '守夜人与灯塔' };

const zeroCounts = (): Record<string, number> =>
  Object.fromEntries(PACKAGE_COUNT_KEYS.map((key) => [key, 0]));

function draft(overrides: Partial<ManifestDraft> = {}): ManifestDraft {
  return {
    kind: 'world',
    id: PACKAGE_ID,
    name: '银松镇',
    createdAt: '2026-09-27T10:00:00.000Z',
    generator: { app: 'SmartTavern', version: '0.1.0', platform: 'cli' },
    license: 'CC-BY-4.0',
    counts: { ...zeroCounts(), worlds: 1 } as ManifestDraft['counts'],
    schemaVersions: { world: 1 },
    ...overrides,
  };
}

function payload(): PayloadInput[] {
  return [
    { path: 'LICENSE.txt', bytes: UTF8.encode('CC-BY-4.0') },
    { path: 'data/worlds.json', json: WORLD },
  ];
}

async function build(overrides: Partial<ManifestDraft> = {}): Promise<Uint8Array> {
  return pack({ manifest: draft(overrides), files: payload() });
}

/** Rewrite one entry, leaving the manifest untouched — how tampering looks. */
async function replaceEntry(
  archive: Uint8Array,
  path: string,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const entries = await readZip(archive);
  return writeZip(
    entries.map((entry) =>
      entry.path === path
        ? { path: entry.path, bytes, method: 'deflate' as const }
        : { path: entry.path, bytes: entry.bytes, method: 'deflate' as const },
    ),
  );
}

/** Rewrite the manifest itself, so the archive no longer matches its own claims. */
async function patchManifest(
  archive: Uint8Array,
  patch: (raw: Record<string, unknown>) => void,
): Promise<Uint8Array> {
  const entries = await readZip(archive);
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json');
  if (manifestEntry === undefined) throw new Error('fixture has no manifest');
  const raw = JSON.parse(new TextDecoder().decode(manifestEntry.bytes)) as Record<string, unknown>;
  patch(raw);
  return writeZip(
    entries.map((entry) =>
      entry.path === 'manifest.json'
        ? { path: entry.path, bytes: canonicalJsonBytes(raw), method: 'deflate' as const }
        : { path: entry.path, bytes: entry.bytes, method: 'deflate' as const },
    ),
  );
}

/* ─────────────────────────────── §12 items ──────────────────────────────── */

describe('docs/04 §12 contract regression', () => {
  it('§12-1 pack → unpack → pack is byte-identical (same implementation)', async () => {
    const archive = await build();
    const { report, files } = await unpackPackage(archive);
    expect(report.ok).toBe(true);

    const rebuilt = await pack({ manifest: draft(), files });
    expect(rebuilt).toEqual(archive);
  });

  it('§12-2 every payload SHA-256 matches entries[]', async () => {
    const archive = await build();
    const entries = await readZip(archive);
    const { manifest } = await unpackPackage(archive);
    if (manifest === undefined) throw new Error('expected a manifest');

    for (const entry of manifest.entries) {
      const actual = entries.find((candidate) => candidate.path === entry.path);
      expect(actual).toBeDefined();
      expect(await sha256Hex(actual?.bytes ?? new Uint8Array())).toBe(entry.sha256);
      expect(actual?.bytes.byteLength).toBe(entry.bytes);
    }
  });

  it('§12-3 tampering with any single byte fails validation and names the file', async () => {
    const archive = await build();
    const tampered = await replaceEntry(
      archive,
      'data/worlds.json',
      UTF8.encode('{"name":"tampered"}'),
    );

    const report = await validatePackage(tampered);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((candidate) => candidate.code === 'entry-hash');
    expect(finding?.path).toBe('data/worlds.json');
  });

  it('§12-4 an unknown manifest field still imports (forward compatibility)', async () => {
    const archive = await build();
    const patched = await patchManifest(archive, (raw) => {
      raw.aFieldFromTheFuture = { nested: [1, 2, 3] };
    });

    const report = await validatePackage(patched);
    expect(report.ok).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('§12-5 formatVersion 2 is refused with an upgrade hint', async () => {
    const archive = await build();
    const patched = await patchManifest(archive, (raw) => {
      raw.formatVersion = 2;
    });

    const report = await validatePackage(patched);
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain('format-version-unsupported');
    expect(report.findings[0]?.message).toMatch(/upgrade the application/i);
  });

  it('§12-6 an older schemaVersions value is migrated by the registered step', () => {
    // The shipping table is empty on purpose (nothing has changed since v1), so this
    // clause is proven with a step injected for the duration of the test. What M0 can
    // honestly promise is the CONTRACT: equal versions are the identity, a registered
    // chain runs in order, and a missing step refuses instead of guessing.
    expect(MIGRATIONS).toEqual([]);
    expect(migrate('world', { keep: true }, 1)).toEqual({ keep: true });

    const step: MigrationStep = {
      entity: 'world',
      from: 1,
      to: 2,
      migrate: (input) => ({ ...(input as Record<string, unknown>), upgraded: true }),
    };
    const table = MIGRATIONS as MigrationStep[];
    table.push(step);
    try {
      expect(migrate('world', { name: '银松镇' }, 1, 2)).toEqual({
        name: '银松镇',
        upgraded: true,
      });
      // One past the end of the chain: no step registered for 2 -> 3.
      expect(() => migrate('world', {}, 2, 3)).toThrow(/no migration step/);
      expect(CURRENT_SCHEMA_VERSIONS.world).toBe(1);
    } finally {
      table.splice(table.indexOf(step), 1);
    }
    expect(MIGRATIONS).toEqual([]);
  });

  it('§12-7 a malicious ZIP with `../` in a path is refused', async () => {
    // (a) we never WRITE one…
    await expect(
      pack({ manifest: draft(), files: [{ path: '../escaped.json', bytes: UTF8.encode('{}') }] }),
    ).rejects.toThrow(/invalid payload path/);

    // (b) …and a hand-built archive that contains one is refused on read.
    const hostile = await writeZip([
      { path: 'manifest.json', bytes: canonicalJsonBytes(draft()) },
      { path: '../escaped.json', bytes: UTF8.encode('{}') },
    ]);
    const report = await validatePackage(hostile);
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain('zip-rejected');
  });
});
