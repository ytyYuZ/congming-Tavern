/**
 * Tests for the `@smarttavern/core` port adapter (`ports.ts`).
 *
 * The interesting cases are the ones the pure API cannot cover: what the writer
 * MINTS (and why it cannot be lied to), what the reader REFUSES to do (touch a
 * filesystem), and the finding-code translation — including that a new internal
 * code cannot be added without deciding what a caller sees.
 */
import { hasBlockingFindings } from '@smarttavern/core';
import { PACKAGE_COUNT_KEYS, UUID_V7_PATTERN } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { canonicalJsonBytes } from './canonical-json';
import {
  createPackageReader,
  createPackageValidator,
  createPackageWriter,
  deriveCounts,
  deriveSchemaVersions,
  mapValidationFinding,
  mintUuidV7,
  PackageSourceError,
} from './ports';
import { readZip } from './zip/read';
import { writeZip } from './zip/write';

const UTF8 = new TextEncoder();
const decode = new TextDecoder();

const FIXED_NOW = new Date('2026-09-27T10:00:00.000Z');

/** A writer with an injected clock and id, so the output is comparable byte for byte. */
function writer() {
  let counter = 0;
  return createPackageWriter({
    now: () => FIXED_NOW,
    mintId: () => `0192f0a1-2222-7000-8000-${String(counter++).padStart(12, '0')}`,
  });
}

function entries() {
  return [
    { path: 'data/worlds.json', bytes: canonicalJsonBytes({ name: '银松镇' }) },
    { path: 'data/messages.jsonl', bytes: UTF8.encode('{"id":"m1"}\n{"id":"m2"}\n') },
    { path: 'assets/images/aa.png', bytes: UTF8.encode('PNG-ish') },
    { path: 'LICENSE.txt', bytes: UTF8.encode('CC-BY-4.0') },
  ];
}

async function built(): Promise<Uint8Array> {
  const result = await writer().write(entries());
  return result.bytes;
}

/* ───────────────────────────── id minting ───────────────────────────────── */

describe('mintUuidV7', () => {
  it('produces ids that satisfy the schema pattern', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(UUID_V7_PATTERN.test(mintUuidV7())).toBe(true);
    }
  });

  it('is time-ordered, which is the whole reason for v7', () => {
    const early = mintUuidV7(() => new Date('2026-09-27T10:00:00.000Z'));
    const late = mintUuidV7(() => new Date('2026-09-27T10:00:01.000Z'));
    expect(early < late).toBe(true);
  });
});

/* ───────────────────────── derived manifest ────────────────────────────── */

describe('derivation', () => {
  it('counts what the payload actually holds, and zero-fills the rest', () => {
    const counts = deriveCounts(entries());
    expect(counts.worlds).toBe(1);
    expect(counts.messages).toBe(2); // JSONL lines, not files
    expect(counts.assets).toBe(1); // the image, not assets/refs.json
    expect(Object.keys(counts)).toEqual([...PACKAGE_COUNT_KEYS]);
    for (const key of PACKAGE_COUNT_KEYS) {
      if (!['worlds', 'messages', 'assets'].includes(key)) expect(counts[key]).toBe(0);
    }
  });

  it('declares a schema version for every payload that is present', () => {
    const versions = deriveSchemaVersions(entries(), undefined);
    expect(versions.world).toBe(1);
    expect(versions.message).toBe(1);
    expect(versions.asset).toBe(1);
    expect(versions.character).toBeUndefined();
  });

  it('lets an explicit version win, so a caller can write an older payload', () => {
    const versions = deriveSchemaVersions([{ path: 'data/worlds.json', json: [] }], { world: 7 });
    expect(versions.world).toBe(7);
  });
});

/* ──────────────────────────────── writer ───────────────────────────────── */

describe('createPackageWriter', () => {
  it('mints identity and timestamps, and returns the manifest it wrote', async () => {
    const { bytes, manifest } = await writer().write(entries(), { kind: 'world', name: '银松镇' });

    expect(manifest.id).toMatch(UUID_V7_PATTERN);
    expect(manifest.createdAt).toBe(FIXED_NOW.toISOString());
    expect(manifest.kind).toBe('world');
    expect(manifest.license).toBe('user-provided');
    expect(manifest.contents.counts.messages).toBe(2);
    expect(manifest.contents.bytes).toBe(
      manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    );

    // …and what it returned is exactly what the archive holds.
    const { manifest: reread } = await createPackageReader().read({ kind: 'bytes', bytes });
    expect(reread).toEqual(manifest);
  });

  it('cannot be handed a hash or a size that disagrees with the bytes', async () => {
    const { manifest } = await writer().write(entries());
    for (const entry of manifest.entries) {
      expect(entry.bytes).toBe(
        entries().find((file) => file.path === entry.path)?.bytes.byteLength,
      );
    }
  });

  it('refuses a path that could escape the package', async () => {
    await expect(
      writer().write([{ path: '../evil.txt', bytes: UTF8.encode('x') }]),
    ).rejects.toThrow(/invalid payload path/);
  });
});

/* ──────────────────────────────── reader ───────────────────────────────── */

describe('createPackageReader', () => {
  it('returns the manifest and the payload bytes', async () => {
    const archive = await built();
    const result = await createPackageReader().read({ kind: 'bytes', bytes: archive });

    expect(result.manifest.name).toBe('Untitled package');
    expect(result.entries.map((entry) => entry.path)).toEqual([
      'LICENSE.txt',
      'assets/images/aa.png',
      'data/messages.jsonl',
      'data/worlds.json',
    ]);
    expect(decode.decode(result.entries.at(-1)?.bytes)).toContain('银松镇');
  });

  it('can read just the manifest when the caller does not want the payload', async () => {
    const archive = await built();
    const result = await createPackageReader().read(
      { kind: 'bytes', bytes: archive },
      { includePayload: false },
    );
    expect(result.manifest.entries).toHaveLength(4);
    for (const entry of result.entries) expect(entry.bytes.byteLength).toBe(0);
  });

  it('refuses a file or url source instead of reaching for a filesystem', async () => {
    const reader = createPackageReader();
    await expect(reader.read({ kind: 'file', path: 'C:/tmp/x.stpack' } as never)).rejects.toThrow(
      PackageSourceError,
    );
  });

  it('uses an injected loader, which is how a shell supplies real files', async () => {
    const archive = await built();
    const reader = createPackageReader({ load: async () => archive });
    const result = await reader.read({ kind: 'file', path: '/tmp/x.stpack' } as never);
    expect(result.manifest.name).toBe('Untitled package');
  });

  it('throws — rather than returning half an answer — when there is no manifest', async () => {
    const notAPackage = UTF8.encode('definitely not a zip');
    await expect(createPackageReader().read({ kind: 'bytes', bytes: notAPackage })).rejects.toThrow(
      PackageSourceError,
    );
  });
});

/* ─────────────────────────────── validator ─────────────────────────────── */

describe('createPackageValidator', () => {
  it('passes a package it just wrote, and states what it actually checked', async () => {
    const result = await createPackageValidator().validate({ kind: 'bytes', bytes: await built() });

    expect(result.ok).toBe(true);
    expect(hasBlockingFindings(result.findings)).toBe(false);
    expect(result.coverage).toMatchObject({ entryChecksums: true, payloadSchemas: false });
  });

  it('reports a tampered payload by file, in the port vocabulary', async () => {
    const entriesInArchive = await readZip(await built());
    const tampered = await writeZip(
      entriesInArchive.map((entry) =>
        entry.path === 'data/worlds.json'
          ? {
              path: entry.path,
              bytes: UTF8.encode('{"name":"tampered"}'),
              method: 'deflate' as const,
            }
          : { path: entry.path, bytes: entry.bytes, method: 'deflate' as const },
      ),
    );

    const result = await createPackageValidator().validate({ kind: 'bytes', bytes: tampered });
    expect(result.ok).toBe(false);
    expect(hasBlockingFindings(result.findings)).toBe(true);
    const finding = result.findings.find((candidate) => candidate.code === 'entry-sha256-mismatch');
    expect(finding?.path).toBe('data/worlds.json');
    expect(finding?.severity).toBe('error');
  });
});

/* ────────────────────────── code translation ───────────────────────────── */

describe('mapValidationFinding', () => {
  it('maps the internal codes onto the port vocabulary', () => {
    const cases: [Parameters<typeof mapValidationFinding>[0], string][] = [
      [
        { severity: 'error', code: 'entry-hash', message: 'm', path: 'a.json' },
        'entry-sha256-mismatch',
      ],
      [{ severity: 'error', code: 'entry-size', message: 'm' }, 'entry-size-mismatch'],
      [{ severity: 'error', code: 'entry-undeclared', message: 'm' }, 'entry-unexpected'],
      [{ severity: 'error', code: 'entry-missing', message: 'm' }, 'entry-missing'],
      [
        { severity: 'error', code: 'manifest-schema', message: 'm', where: 'entries.0.bytes' },
        'manifest-invalid',
      ],
      [{ severity: 'error', code: 'manifest-not-first', message: 'm' }, 'manifest-not-first'],
      [{ severity: 'error', code: 'manifest-inconsistent', message: 'm' }, 'manifest-inconsistent'],
      [{ severity: 'error', code: 'payload-json-invalid', message: 'm' }, 'payload-unparsable'],
      [
        { severity: 'error', code: 'format-version-unsupported', message: 'm' },
        'schema-version-unsupported',
      ],
      [
        { severity: 'warning', code: 'payload-migration-needed', message: 'm' },
        'schema-version-unsupported',
      ],
    ];
    for (const [finding, expected] of cases) {
      const mapped = mapValidationFinding(finding);
      expect(`${finding.code}->${mapped.code}`).toBe(`${finding.code}->${expected}`);
      expect(mapped.detail).toBe('m');
      expect(mapped.severity).toBe(finding.severity);
    }
  });

  it('refines a container rejection by the ZIP rule that caused it', () => {
    const rule = (where: string) =>
      mapValidationFinding({ severity: 'error', code: 'zip-rejected', message: 'm', where }).code;

    expect(rule('encrypted')).toBe('zip-encrypted');
    expect(rule('unsupported-method')).toBe('zip-unsupported-compression');
    expect(rule('path-traversal')).toBe('path-traversal');
    expect(rule('absolute-path')).toBe('path-traversal');
    expect(rule('path-charset')).toBe('path-invalid');
    expect(rule('declared-size-mismatch')).toBe('entry-size-mismatch');
    // An unknown rule must not be silently dropped: `zip-corrupt` is the honest
    // answer, and `where` still carries the precise rule for the UI.
    expect(rule('some-rule-from-the-future')).toBe('zip-corrupt');
  });

  it('keeps the precise rule and the file separate, since a rule is not a path', () => {
    const mapped = mapValidationFinding({
      severity: 'error',
      code: 'zip-rejected',
      message: 'entry path escapes',
      path: 'data/x.json',
      where: 'path-traversal',
    });
    expect(mapped.path).toBe('data/x.json');
    expect(mapped.where).toBe('path-traversal');
  });
});
