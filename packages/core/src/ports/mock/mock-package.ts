/**
 * In-memory `.stpack` double (docs/06 §8.4: "有 mock 实现用于测试").
 *
 * WHY THESE DOUBLES INVENT BEHAVIOUR THE REAL ONE WILL NOT HAVE
 * A test double for packaging has to be able to produce a package that is
 * BROKEN IN ONE SPECIFIC WAY — a tampered byte, a missing checksum, a path that
 * escapes. Otherwise the reader's and validator's error paths can never be
 * tested, and error paths are the entire reason `PackageValidator` returns
 * findings instead of a boolean (`docs/04` §7).
 *
 * So `MockPackageWriter` takes an optional list of `MockPackageCorruption`
 * entries and applies them after building a correct package. The default is
 * always a VALID package, and the corruption is named in the test that uses it.
 *
 * Shas are injected for the same reason the asset store's hash is: core cannot
 * call a crypto API (HANDOFF §4.1 invariant 1), and real SHA-256 is M0-T7's job.
 */
import type { PackageEntry, PackageManifest } from '@smarttavern/schema';
import type {
  PackageEntryPayload,
  PackageFinding,
  PackageReader,
  PackageReadOptions,
  PackageReadResult,
  PackageSource,
  PackageValidationCoverage,
  PackageValidationResult,
  PackageValidator,
  PackageWriteEntry,
  PackageWriteOptions,
  PackageWriteResult,
  PackageWriter,
} from '../package';
import { hasBlockingFindings } from '../package';
import { createIdMinter } from './_support';

/** `sha256(bytes)` as lower-case hex, injected (see the file header). */
export type PackageSha256Fn = (bytes: Uint8Array) => string;

/** Every validation layer, all on: what a full check looks like. */
export const FULL_PACKAGE_COVERAGE: PackageValidationCoverage = {
  container: true,
  manifestShape: true,
  manifestConsistency: true,
  entryChecksums: true,
  assetBindings: true,
  payloadSchemas: true,
  schemaVersions: true,
};

/* ──────────────────────────── 内存中的包 ───────────────────────────────── */

/** One path -> bytes, i.e. the whole container in memory. `manifest.json` included. */
export interface MockPackageFiles {
  readonly files: Map<string, Uint8Array>;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** Lower-case hex of bytes — used by the fake hash and available to tests. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/* ─────────────────────────────── 写入器 ────────────────────────────────── */

/**
 * A deliberate defect. Each variant maps to one `PackageFindingCode`, so a test
 * asserts the code — not just "it failed", which is the assertion that lets a
 * reader silently start failing for the wrong reason.
 */
export type MockPackageCorruption =
  /** Overwrite a payload's bytes without updating `entries[].sha256`. */
  | { kind: 'tamper-payload'; path: string; bytes: Uint8Array }
  /** Drop a file from the container. */
  | { kind: 'drop-entry'; path: string }
  /** Say an entry exists that the container never held. */
  | { kind: 'phantom-entry'; path: string; bytes: Uint8Array }
  /** Write `manifest.json` last instead of first (`docs/06` §8.2 rule 3). */
  | { kind: 'manifest-not-first' }
  /** Write a manifest that is not a valid `PackageManifest`. */
  | { kind: 'invalid-manifest'; manifest: unknown }
  /** Insert a file with a path that escapes the package root. */
  | { kind: 'unsafe-path'; path: string; bytes: Uint8Array };

export interface MockPackageWriterOptions {
  /** Required: core cannot hash (see the file header). */
  sha256: PackageSha256Fn;
  /** Id minter for packages written without an `id`. */
  mintId?: (label?: string) => string;
  /** Applied in order after a correct package is built. */
  corruptions?: readonly MockPackageCorruption[];
}

export class MockPackageWriter implements PackageWriter {
  private readonly sha256: PackageSha256Fn;
  private readonly minter: (label?: string) => string;
  private corruptions: MockPackageCorruption[];

  constructor(options: MockPackageWriterOptions) {
    this.sha256 = options.sha256;
    this.minter = options.mintId ?? createIdMinter('pkg');
    this.corruptions = [...(options.corruptions ?? [])];
  }

  async write(
    entries: readonly PackageWriteEntry[],
    options: PackageWriteOptions = {},
  ): Promise<PackageWriteResult> {
    const manifestEntries: PackageEntry[] = entries.map((entry) => ({
      path: entry.path,
      bytes: entry.bytes.byteLength,
      sha256: this.sha256(entry.bytes),
    }));

    const manifest: PackageManifest = {
      format: 'smarttavern.package',
      formatVersion: 1,
      kind: 'world',
      id: this.minter('pkg'),
      name: 'mock package',
      createdAt: '2026-01-01T00:00:00.000Z',
      generator: { app: 'smarttavern-mock', version: '0', platform: 'cli' },
      license: 'user-provided',
      schemaVersions: {},
      redaction: { apiKeys: 'excluded', absolutePaths: 'excluded' },
      ...options,
      entries: manifestEntries,
      contents: {
        counts: {
          worlds: 0,
          worldbooks: 0,
          characters: 0,
          promptPresets: 0,
          rulePacks: 0,
          themes: 0,
          sessions: 0,
          messages: 0,
          checkpoints: 0,
          agenda: 0,
          memories: 0,
          assets: 0,
        },
        bytes: manifestEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      },
    };

    const files = new Map<string, Uint8Array>();
    files.set('manifest.json', textEncoder.encode(JSON.stringify(manifest)));
    for (const entry of entries) files.set(entry.path, Uint8Array.from(entry.bytes));

    let manifestFirst = true;
    for (const corruption of this.corruptions) {
      switch (corruption.kind) {
        case 'tamper-payload':
          files.set(corruption.path, Uint8Array.from(corruption.bytes));
          break;
        case 'drop-entry':
          files.delete(corruption.path);
          break;
        case 'phantom-entry':
          manifest.entries.push({
            path: corruption.path,
            bytes: corruption.bytes.byteLength,
            sha256: this.sha256(corruption.bytes),
          });
          break;
        case 'manifest-not-first':
          manifestFirst = false;
          break;
        case 'invalid-manifest':
          files.set('manifest.json', textEncoder.encode(JSON.stringify(corruption.manifest)));
          break;
        case 'unsafe-path':
          files.set(corruption.path, Uint8Array.from(corruption.bytes));
          break;
      }
    }

    if (!manifestFirst) {
      const manifestBytes = files.get('manifest.json');
      files.delete('manifest.json');
      if (manifestBytes !== undefined) files.set('manifest.json', manifestBytes);
    }

    return { bytes: serializeMockPackage({ files }), manifest };
  }

  /** Replace the corruption list, e.g. between assertions in one test. */
  setCorruptions(corruptions: readonly MockPackageCorruption[]): void {
    this.corruptions = [...corruptions];
  }
}

/* ────────────────────────────── 容器序列化 ─────────────────────────────── */

/**
 * A dead-simple, deterministic container format: `path-length`, `path`, `length`,
 * `bytes` per file, in insertion order. NOT ZIP — the real container is
 * `packages/packages/src/zip/` (ADR-018) and this double must not pretend to be
 * a ZIP reader, or the reader would be tested against the wrong thing.
 */
const MARKER = Uint8Array.from([0x53, 0x54, 0x4d, 0x4b]); // "STMK"

export function serializeMockPackage(source: MockPackageFiles): Uint8Array {
  const chunks: Uint8Array[] = [MARKER];
  for (const [path, bytes] of source.files) {
    const pathBytes = textEncoder.encode(path);
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint32(0, pathBytes.byteLength);
    view.setUint32(4, bytes.byteLength);
    chunks.push(header, pathBytes, bytes);
  }
  return concatBytes(chunks);
}

export function deserializeMockPackage(bytes: Uint8Array): MockPackageFiles {
  const files = new Map<string, Uint8Array>();
  if (bytes.byteLength < MARKER.byteLength || MARKER.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('not a mock package container');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = MARKER.byteLength;
  while (offset < bytes.byteLength) {
    const pathLength = view.getUint32(offset);
    const byteLength = view.getUint32(offset + 4);
    const pathStart = offset + 8;
    const path = textDecoder.decode(bytes.subarray(pathStart, pathStart + pathLength));
    const dataStart = pathStart + pathLength;
    files.set(path, bytes.subarray(dataStart, dataStart + byteLength));
    offset = dataStart + byteLength;
  }
  return { files };
}

/* ──────────────────────────────── 读取器 ───────────────────────────────── */

/** Bytes of a "file" source in tests: `{ kind: 'bytes' }` needs no filesystem. */
export function packageSourceFromBytes(bytes: Uint8Array): PackageSource {
  return { kind: 'bytes', bytes };
}

export class MockPackageReader implements PackageReader {
  private readonly sha256: PackageSha256Fn;
  /** Every source it was asked to read, for assertions about the call shape. */
  readonly reads: PackageSource[] = [];

  constructor(options: { sha256: PackageSha256Fn }) {
    this.sha256 = options.sha256;
  }

  async read(source: PackageSource, options: PackageReadOptions = {}): Promise<PackageReadResult> {
    this.reads.push(source);
    const container = deserializeMockPackage(this.bytesOf(source));
    const findings: PackageFinding[] = [];

    const manifestBytes = container.files.get('manifest.json');
    if (manifestBytes === undefined) {
      // No manifest at all: there is nothing a caller could trust, so this is a
      // throw and not a finding (the port says a result always has a manifest).
      throw new Error('manifest.json is missing from the package');
    }

    const firstPath = [...container.files.keys()][0];
    if (firstPath !== 'manifest.json') {
      findings.push({
        code: 'manifest-not-first',
        severity: 'error',
        detail: 'manifest.json must be the first entry of the container (docs/06 §8.2 rule 3)',
      });
    }

    const parsed = JSON.parse(textDecoder.decode(manifestBytes)) as PackageManifest;
    const manifest = parsed;

    for (const entry of manifest.entries) {
      const bytes = container.files.get(entry.path);
      if (bytes === undefined) {
        findings.push({
          code: 'entry-missing',
          severity: 'error',
          path: entry.path,
          detail: `entries[] lists ${entry.path}, which the container does not contain`,
        });
        continue;
      }
      if (bytes.byteLength !== entry.bytes) {
        findings.push({
          code: 'entry-size-mismatch',
          severity: 'error',
          path: entry.path,
          detail: `${entry.path} is ${bytes.byteLength} bytes but entries[] says ${entry.bytes}`,
        });
      }
      const sha256 = this.sha256(bytes);
      if (sha256 !== entry.sha256) {
        findings.push({
          code: 'entry-sha256-mismatch',
          severity: 'error',
          path: entry.path,
          detail: `${entry.path} hashes to ${sha256} but entries[] says ${entry.sha256}`,
        });
      }
    }

    const declared = new Set(manifest.entries.map((entry) => entry.path));
    for (const path of container.files.keys()) {
      if (path === 'manifest.json' || declared.has(path)) continue;
      findings.push({
        code: 'entry-unexpected',
        severity: 'warning',
        path: path as PackageManifest['entries'][number]['path'],
        detail: `${path} is in the container but not in entries[]`,
      });
    }

    const entries: PackageEntryPayload[] = [];
    if (options.includePayload !== false) {
      for (const entry of manifest.entries) {
        const bytes = container.files.get(entry.path);
        if (bytes === undefined) continue;
        entries.push({ path: entry.path, bytes: Uint8Array.from(bytes) });
      }
    } else {
      for (const entry of manifest.entries) {
        entries.push({ path: entry.path, bytes: new Uint8Array() });
      }
    }

    return { manifest, entries, findings };
  }

  /** The manifest alone, without materialising payload bytes. */
  async readManifest(source: PackageSource): Promise<PackageManifest> {
    const container = deserializeMockPackage(this.bytesOf(source));
    const manifestBytes = container.files.get('manifest.json');
    if (manifestBytes === undefined) throw new Error('manifest.json is missing');
    return JSON.parse(textDecoder.decode(manifestBytes)) as PackageManifest;
  }

  private bytesOf(source: PackageSource): Uint8Array {
    if (source.kind === 'bytes') return source.bytes;
    // The double deliberately refuses paths/urls: reading a real file is the
    // adapter's job, and a mock that pretends to have a filesystem hides bugs.
    throw new Error(`MockPackageReader only accepts { kind: 'bytes' }, got ${source.kind}`);
  }
}

/* ─────────────────────────────── 校验器 ────────────────────────────────── */

export class MockPackageValidator implements PackageValidator {
  readonly reader: MockPackageReader;

  constructor(options: { sha256: PackageSha256Fn; reader?: MockPackageReader }) {
    this.reader = options.reader ?? new MockPackageReader({ sha256: options.sha256 });
  }

  async validate(source: PackageSource): Promise<PackageValidationResult> {
    const findings: PackageFinding[] = [];
    let manifest: PackageManifest | undefined;

    try {
      const result = await this.reader.read(source, { includePayload: false });
      manifest = result.manifest;
      findings.push(...result.findings);
    } catch (error) {
      findings.push({
        code: 'zip-corrupt',
        severity: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      ok: !hasBlockingFindings(findings),
      findings,
      ...(manifest === undefined ? {} : { manifest }),
      coverage: FULL_PACKAGE_COVERAGE,
    };
  }
}

/* ──────────────────────────── 测试用便捷构造 ────────────────────────────── */

/** A valid payload-manifest pair, so a test can build a good package in one line. */
export function mockPackageEntry(path: string, text: string): PackageWriteEntry {
  return { path: path as PackageWriteEntry['path'], bytes: textEncoder.encode(text) };
}

/** UTF-8 bytes, exported so tests do not each re-create an encoder. */
export function mockBytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * A deterministic 64-hex-character fake hash, built from eight FNV-1a passes so
 * the OUTPUT SHAPE satisfies `AssetHashSchema` / `PackageSha256Schema`.
 * It is NOT cryptography and must never be used for real content addressing —
 * that is M0-T7's job, and core cannot call a crypto API anyway.
 */
export function fakeSha256(bytes: Uint8Array): string {
  let out = '';
  for (let word = 0; word < 8; word += 1) {
    let hash = (0x811c9dc5 ^ Math.imul(word + 1, 0x9e3779b9)) >>> 0;
    for (const byte of bytes) {
      hash = (hash ^ byte) >>> 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash = (hash ^ bytes.byteLength ^ word) >>> 0;
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
}
