/**
 * Package double: a valid package round-trips, and every named corruption is
 * reported as a FINDING with a path — never as a bare boolean (docs/04 §7).
 */
import { describe, expect, it } from 'vitest';
import { hasBlockingFindings, type PackageFindingCode } from '../package';
import {
  fakeSha256,
  MockPackageReader,
  MockPackageValidator,
  MockPackageWriter,
  mockBytes,
  mockPackageEntry,
} from './index';

const WORLDS = 'data/worlds.json';
const LICENSE = 'LICENSE.txt';

async function buildPackage(
  corruptions: Parameters<MockPackageWriter['setCorruptions']>[0] = [],
): Promise<Uint8Array> {
  const writer = new MockPackageWriter({ sha256: fakeSha256 });
  writer.setCorruptions(corruptions);
  const result = await writer.write([
    mockPackageEntry(WORLDS, '{"worlds":[]}'),
    mockPackageEntry(LICENSE, 'AGPL-3.0-only'),
  ]);
  return result.bytes;
}

function codesOf(findings: readonly { code: PackageFindingCode }[]): PackageFindingCode[] {
  return findings.map((finding) => finding.code);
}

describe('MockPackageWriter / MockPackageReader', () => {
  it('round-trips a well-formed package with no findings', async () => {
    const bytes = await buildPackage();
    const reader = new MockPackageReader({ sha256: fakeSha256 });

    const result = await reader.read({ kind: 'bytes', bytes });

    expect(result.findings).toEqual([]);
    expect(hasBlockingFindings(result.findings)).toBe(false);
    expect(result.manifest.name).toBe('mock package');
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([WORLDS, LICENSE]);
    expect(result.entries.map((entry) => entry.path)).toEqual([WORLDS, LICENSE]);
  });

  it('derives entries and contents.bytes from the payloads it was given', async () => {
    const writer = new MockPackageWriter({ sha256: fakeSha256 });
    const { manifest } = await writer.write([mockPackageEntry(WORLDS, '{"worlds":[]}')]);

    expect(manifest.contents.bytes).toBe(manifest.entries[0]?.bytes);
    expect(manifest.entries[0]?.sha256).toBe(fakeSha256(mockBytes('{"worlds":[]}')));
  });

  it('skips payload bytes when the caller only wants the manifest', async () => {
    const bytes = await buildPackage();
    const reader = new MockPackageReader({ sha256: fakeSha256 });

    const result = await reader.read({ kind: 'bytes', bytes }, { includePayload: false });

    expect(result.manifest.entries).toHaveLength(2);
    expect(result.entries.every((entry) => entry.bytes.byteLength === 0)).toBe(true);
  });

  it('reports a tampered payload by path', async () => {
    const bytes = await buildPackage([
      { kind: 'tamper-payload', path: WORLDS, bytes: mockBytes('{"worlds":["tampered"]}') },
    ]);

    const result = await new MockPackageReader({ sha256: fakeSha256 }).read({
      kind: 'bytes',
      bytes,
    });

    expect(codesOf(result.findings)).toContain('entry-sha256-mismatch');
    const finding = result.findings.find((one) => one.code === 'entry-sha256-mismatch');
    expect(finding?.path).toBe(WORLDS);
    expect(finding?.severity).toBe('error');
    expect(hasBlockingFindings(result.findings)).toBe(true);
  });

  it('reports a declared entry the container does not hold', async () => {
    const bytes = await buildPackage([{ kind: 'drop-entry', path: WORLDS }]);
    const result = await new MockPackageReader({ sha256: fakeSha256 }).read({
      kind: 'bytes',
      bytes,
    });

    expect(codesOf(result.findings)).toContain('entry-missing');
    expect(result.findings[0]?.path).toBe(WORLDS);
  });

  it('reports a manifest that is not the first entry', async () => {
    const bytes = await buildPackage([{ kind: 'manifest-not-first' }]);
    const result = await new MockPackageReader({ sha256: fakeSha256 }).read({
      kind: 'bytes',
      bytes,
    });

    expect(codesOf(result.findings)).toContain('manifest-not-first');
  });

  it('warns about a file the container holds but entries[] does not declare', async () => {
    const bytes = await buildPackage([
      { kind: 'unsafe-path', path: 'assets/orphan.png', bytes: mockBytes('png') },
    ]);
    const result = await new MockPackageReader({ sha256: fakeSha256 }).read({
      kind: 'bytes',
      bytes,
    });

    const orphan = result.findings.find((finding) => finding.code === 'entry-unexpected');
    expect(orphan?.path).toBe('assets/orphan.png');
    expect(orphan?.severity).toBe('warning');
    expect(hasBlockingFindings(result.findings)).toBe(false);
  });

  it('refuses a source it cannot read, instead of pretending to have a filesystem', async () => {
    const reader = new MockPackageReader({ sha256: fakeSha256 });
    await expect(reader.read({ kind: 'file', path: 'D:/packs/x.stpack' })).rejects.toThrow(
      'only accepts',
    );
  });

  it('records the sources it was asked to read', async () => {
    const bytes = await buildPackage();
    const reader = new MockPackageReader({ sha256: fakeSha256 });
    const source = { kind: 'bytes' as const, bytes };
    await reader.read(source);
    expect(reader.reads).toEqual([source]);
  });
});

describe('MockPackageValidator', () => {
  it('returns ok with full coverage for a valid package', async () => {
    const bytes = await buildPackage();
    const result = await new MockPackageValidator({ sha256: fakeSha256 }).validate({
      kind: 'bytes',
      bytes,
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.manifest).toBeDefined();
    expect(Object.values(result.coverage).every(Boolean)).toBe(true);
  });

  it('returns findings rather than a bare boolean when a file fails', async () => {
    // Same byte length as the original, so the ONLY defect is the wrong content:
    // one finding, one reason, one path.
    const bytes = await buildPackage([
      { kind: 'tamper-payload', path: LICENSE, bytes: mockBytes('MIT-licensed!') },
    ]);
    const result = await new MockPackageValidator({ sha256: fakeSha256 }).validate({
      kind: 'bytes',
      bytes,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    // docs/04 §7: the user must be told exactly WHICH file failed.
    expect(result.findings[0]).toMatchObject({
      code: 'entry-sha256-mismatch',
      severity: 'error',
      path: LICENSE,
    });
    expect(result.findings[0]?.detail).toContain(LICENSE);
  });

  it('reports a corrupt container as a finding, not an exception', async () => {
    const result = await new MockPackageValidator({ sha256: fakeSha256 }).validate({
      kind: 'bytes',
      bytes: mockBytes('not a package at all'),
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result.findings)).toEqual(['zip-corrupt']);
    expect(result.manifest).toBeUndefined();
  });
});
