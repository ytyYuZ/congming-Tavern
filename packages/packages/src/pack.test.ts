/**
 * Package-level acceptance for M0-T3.
 *
 * These are the behaviours `docs/06-开发任务拆解.md` M0-T3 is accepted on, plus
 * the first five items of `docs/04` §12:
 *   1. pack → unpack → pack is byte-identical;
 *   2. every entry's sha256 matches the bytes actually inside the archive;
 *   3. tampering with one byte makes validation fail and NAME the file;
 *   4. an unknown manifest field still imports (forward compatibility);
 *   5. `formatVersion: 2` is refused with an upgrade hint;
 *   7. a `../` path is refused.
 *
 * The container's own rejection rules (encryption, symlinks, zip bombs, …) are
 * covered next to the reader by the ZIP test suite; these tests are about the
 * package layer that sits on top.
 */

import { type JsonValue, PACKAGE_COUNT_KEYS } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes } from './canonical-json';
import { type ManifestDraft, type PayloadInput, sha256Hex } from './manifest';
import { pack } from './pack';
import { unpackPackage } from './unpack';
import { validatePackage } from './validate';
import { readZip } from './zip/read';
import { writeZip } from './zip/write';

const UTF8 = new TextEncoder();
const decode = new TextDecoder();

const zeroCounts = (): Record<string, number> =>
  Object.fromEntries(PACKAGE_COUNT_KEYS.map((key) => [key, 0]));

const WORLD: JsonValue = { name: '银松镇', premise: '守夜人与灯塔', genre: ['奇幻'] };

function draft(overrides: Partial<ManifestDraft> = {}): ManifestDraft {
  return {
    kind: 'world',
    id: '0192f0a1-2222-7000-8000-000000000001',
    name: '银松镇',
    createdAt: '2026-09-27T10:00:00.000Z',
    generator: { app: 'SmartTavern', version: '0.1.0', platform: 'web' },
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
    { path: 'README.txt', bytes: UTF8.encode('银松镇，一个单场景世界。') },
  ];
}

/** Rebuild the archive with one manifest field patched — how a hostile file looks. */
async function repackWithManifestPatch(
  archive: Uint8Array,
  patch: (raw: Record<string, unknown>) => void,
): Promise<Uint8Array> {
  const entries = await readZip(archive);
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json');
  if (manifestEntry === undefined) throw new Error('fixture has no manifest');
  const raw = JSON.parse(decode.decode(manifestEntry.bytes)) as Record<string, unknown>;
  patch(raw);
  return writeZip(
    entries.map((entry) =>
      entry.path === 'manifest.json'
        ? { path: entry.path, bytes: canonicalJsonBytes(raw), method: 'deflate' as const }
        : { path: entry.path, bytes: entry.bytes, method: 'deflate' as const },
    ),
  );
}

/** Rebuild the archive with one payload replaced — the "tampered byte" fixture. */
async function repackWithPayload(
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

/* ───────────────────────────── happy path ───────────────────────────────── */

describe('pack', () => {
  it('writes the manifest as the first entry, then the payload in ASCII order', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const entries = await readZip(archive);
    expect(entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'LICENSE.txt',
      'README.txt',
      'data/worlds.json',
    ]);
  });

  it('produces identical bytes for identical input (docs/04 §12 item 1)', async () => {
    const first = await pack({ manifest: draft(), files: payload() });
    const second = await pack({ manifest: draft(), files: payload() });
    expect(second).toEqual(first);
  });

  it('derives entries[] and contents.bytes from the bytes, so they cannot lie', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const { report } = await unpackPackage(archive);
    expect(report.ok).toBe(true);
    const manifest = report.manifest;
    if (manifest === undefined) throw new Error('expected a manifest');

    const worldEntry = manifest.entries.find((entry) => entry.path === 'data/worlds.json');
    expect(worldEntry?.sha256).toBe(await sha256Hex(canonicalJsonBytes(WORLD)));
    expect(worldEntry?.bytes).toBe(canonicalJsonBytes(WORLD).byteLength);
    expect(manifest.contents.bytes).toBe(
      manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    );
  });

  it('refuses a payload path that could escape the package', async () => {
    await expect(
      pack({ manifest: draft(), files: [{ path: '../evil.txt', bytes: UTF8.encode('x') }] }),
    ).rejects.toThrow(/invalid payload path/);
  });

  it('refuses a duplicate payload path', async () => {
    await expect(
      pack({
        manifest: draft(),
        files: [
          { path: 'README.txt', bytes: UTF8.encode('a') },
          { path: 'README.txt', bytes: UTF8.encode('b') },
        ],
      }),
    ).rejects.toThrow(/duplicate payload path/);
  });
});

/* ──────────────────────── round-trip with the reader ────────────────────── */

describe('pack → unpack → pack (docs/04 §12 item 1)', () => {
  it('is byte-identical after a full round-trip', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const { report, files, manifest } = await unpackPackage(archive);

    expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(manifest?.name).toBe('银松镇');
    expect(files.map((file) => file.path)).toEqual([
      'LICENSE.txt',
      'README.txt',
      'data/worlds.json',
    ]);

    const rebuilt = await pack({
      manifest: {
        ...draft(),
        counts: manifest?.contents.counts ?? draft().counts,
        schemaVersions: manifest?.schemaVersions ?? draft().schemaVersions,
      },
      files,
    });
    expect(rebuilt).toEqual(archive);
  });

  it('returns no files at all when validation fails', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const tampered = await repackWithPayload(archive, 'data/worlds.json', UTF8.encode('{}'));
    const { report, files } = await unpackPackage(tampered);
    expect(report.ok).toBe(false);
    expect(files).toEqual([]);
  });
});

/* ───────────────────────────── rejections ───────────────────────────────── */

describe('validatePackage', () => {
  it('accepts a freshly packed package', async () => {
    const report = await validatePackage(await pack({ manifest: draft(), files: payload() }));
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('names the file when a payload byte is changed (docs/04 §12 item 3)', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const tampered = await repackWithPayload(
      archive,
      'data/worlds.json',
      UTF8.encode('{"name":"x"}'),
    );

    const report = await validatePackage(tampered);
    expect(report.ok).toBe(false);
    const hashFinding = report.findings.find((finding) => finding.code === 'entry-hash');
    expect(hashFinding?.path).toBe('data/worlds.json');
    expect(hashFinding?.message).toContain('sha256 mismatch');
  });

  it('still imports a manifest with an unknown field (docs/04 §12 item 4)', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const patched = await repackWithManifestPatch(archive, (raw) => {
      raw.someFutureField = { added: 'by a newer writer' };
    });
    const report = await validatePackage(patched);
    expect(report.ok).toBe(true);
  });

  it('refuses formatVersion 2 and says to upgrade (docs/04 §12 item 5)', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const patched = await repackWithManifestPatch(archive, (raw) => {
      raw.formatVersion = 2;
    });

    const report = await validatePackage(patched);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.code === 'format-version-unsupported');
    expect(finding?.message).toContain('upgrade the application');
  });

  it('refuses a package whose manifest is not the first entry', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const entries = await readZip(archive);
    const manifestEntry = entries[0];
    if (manifestEntry === undefined) throw new Error('fixture has no manifest');
    const reordered = await writeZip([
      ...entries.slice(1).map((entry) => ({ path: entry.path, bytes: entry.bytes })),
      { path: manifestEntry.path, bytes: manifestEntry.bytes },
    ]);

    const report = await validatePackage(reordered);
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain('manifest-not-first');
  });

  it('refuses a file that is present but missing from entries[]', async () => {
    const archive = await pack({ manifest: draft(), files: payload() });
    const entries = await readZip(archive);
    const extended = await writeZip([
      ...entries.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
      { path: 'snuck-in.txt', bytes: UTF8.encode('surprise') },
    ]);

    const report = await validatePackage(extended);
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain('entry-undeclared');
  });

  it('refuses bytes that are not a ZIP at all', async () => {
    const report = await validatePackage(UTF8.encode('this is not a package'));
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('zip-rejected');
  });
});
