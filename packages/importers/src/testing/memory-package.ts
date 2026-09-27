/**
 * In-memory `PackageWriter` / `PackageReader` / `PackageValidator` for this
 * package's tests.
 *
 * WHY THIS EXISTS AT ALL: same reachability argument as `memory-storage.ts` —
 * `packages/core`'s `ports/mock/mock-package.ts` is not exported through the core
 * barrel, and the REAL container implementation (`packages/packages`, a ZIP —
 * ADR-018) is off-limits to this package: `biome.json`'s adapter override and
 * `tools/scripts/check-dependency-direction.mjs` restrict `packages/importers` to
 * `packages/schema` + `packages/core`. An import test therefore needs a
 * port-level double here, and
 * `tools/stpack-cli/src/import.test.ts` is where the REAL writer, the REAL reader
 * and this importer meet over real `.stpack` bytes.
 *
 * IT IS DELIBERATELY NOT A ZIP: the container is a trivial length-prefixed framing
 * (the same choice core's own double makes), so nobody mistakes this for the
 * format. It is otherwise FAITHFUL: the manifest it writes satisfies
 * `PackageManifestSchema` and `validateManifestConsistency`, `entries[].sha256` is
 * a real SHA-256, `schemaVersions` and `contents.counts` are DERIVED from the
 * payload paths exactly as `docs/04` §12-15 requires — so a fixture can never be a
 * package the real writer would refuse to produce, and the importer's identity
 * decisions are made against realistic manifests.
 *
 * NO CORRUPTION HOOKS HERE (unlike core's double): this package's job is to read a
 * good package and write rows. The reader still reports what a real one would
 * (missing entry, size mismatch, sha mismatch, undeclared file, manifest not
 * first), because those findings are what an import report has to carry.
 */
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
} from '@smarttavern/core';
import { hasBlockingFindings } from '@smarttavern/core';
import {
  CURRENT_SCHEMA_VERSIONS,
  MANIFEST_DATA_FILES,
  mintUuidV7,
  PACKAGE_COUNT_KEYS,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type PackageCountKey,
  type PackageCounts,
  type PackageEntry,
  type PackageManifest,
  PackageManifestSchema,
  type PackageSchemaVersionKey,
  type PackageSchemaVersions,
  type UuidV7,
  validateManifestConsistency,
} from '@smarttavern/schema';
import { canonicalJsonBytes } from '../canonical-json';

const UTF8 = new TextEncoder();
const TEXT = new TextDecoder('utf-8', { fatal: true });

/** Lower-case hex SHA-256 (the same WebCrypto call the real writer makes). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/* ───────────────────────────── container framing ─────────────────────────── */

/** "STMP" — a marker, so a stray byte string is refused instead of misparsed. */
const MARKER = Uint8Array.from([0x53, 0x54, 0x4d, 0x50]);

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** `path-length`, `path`, `length`, `bytes` per file, in the given order. */
export function serializeContainer(files: readonly PackageWriteEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [MARKER];
  for (const file of files) {
    const pathBytes = UTF8.encode(file.path);
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint32(0, pathBytes.byteLength);
    view.setUint32(4, file.bytes.byteLength);
    chunks.push(header, pathBytes, file.bytes);
  }
  return concat(chunks);
}

/** The files of a container, in archive order. */
export function decodeContainer(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  if (bytes.byteLength < MARKER.byteLength || MARKER.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('not a memory package container');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = MARKER.byteLength;
  while (offset < bytes.byteLength) {
    const pathLength = view.getUint32(offset);
    const byteLength = view.getUint32(offset + 4);
    const pathStart = offset + 8;
    const path = TEXT.decode(bytes.subarray(pathStart, pathStart + pathLength));
    const dataStart = pathStart + pathLength;
    files.set(path, bytes.subarray(dataStart, dataStart + byteLength));
    offset = dataStart + byteLength;
  }
  return files;
}

/* ────────────────────────── manifest derivation ──────────────────────────── */

/** Which `contents.counts` key each entity's payload file feeds. */
const ENTITY_COUNT_KEY: Record<PackageSchemaVersionKey, PackageCountKey | undefined> = {
  world: 'worlds',
  worldbook: 'worldbooks',
  character: 'characters',
  promptPreset: 'promptPresets',
  rulepack: 'rulePacks',
  theme: 'themes',
  session: 'sessions',
  message: 'messages',
  checkpoint: 'checkpoints',
  agenda: 'agenda',
  memory: 'memories',
  asset: 'assets',
  turn: undefined,
};

function countLines(bytes: Uint8Array): number {
  return TEXT.decode(bytes)
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}

/** `contents.counts`, derived from the payloads — never taken from the caller. */
export function deriveCounts(files: readonly PackageWriteEntry[]): PackageCounts {
  const counts = Object.fromEntries(PACKAGE_COUNT_KEYS.map((key) => [key, 0])) as Record<
    PackageCountKey,
    number
  >;

  for (const file of files) {
    const entity = (MANIFEST_DATA_FILES as Record<string, PackageSchemaVersionKey | undefined>)[
      file.path
    ];
    if (entity !== undefined) {
      const key = ENTITY_COUNT_KEY[entity];
      if (key === undefined) continue;
      if (file.path.endsWith('.jsonl')) counts[key] += countLines(file.bytes);
      else {
        const value: unknown = JSON.parse(TEXT.decode(file.bytes));
        counts[key] += Array.isArray(value) ? value.length : 1;
      }
      continue;
    }
    if (file.path.startsWith('assets/') && file.path !== 'assets/refs.json') counts.assets += 1;
  }
  return counts as PackageCounts;
}

/** `schemaVersions` for what is present; an explicit declaration wins (`docs/04` §12-15). */
export function deriveSchemaVersions(
  files: readonly PackageWriteEntry[],
  declared?: PackageSchemaVersions,
): PackageSchemaVersions {
  const entities = new Set<PackageSchemaVersionKey>();
  for (const file of files) {
    const entity = (MANIFEST_DATA_FILES as Record<string, PackageSchemaVersionKey | undefined>)[
      file.path
    ];
    if (entity !== undefined) entities.add(entity);
    if (file.path.startsWith('assets/') && file.path !== 'assets/refs.json') entities.add('asset');
  }
  const derived: Record<string, number> = {};
  for (const entity of entities) derived[entity] = CURRENT_SCHEMA_VERSIONS[entity];
  return { ...derived, ...declared } as PackageSchemaVersions;
}

/* ──────────────────────────────── writer ─────────────────────────────────── */

export interface MemoryPackageWriterOptions {
  readonly now?: () => Date;
  readonly mintId?: () => UuidV7;
}

export class MemoryPackageWriter implements PackageWriter {
  private readonly now: () => Date;
  private readonly mintId: () => UuidV7;

  constructor(options: MemoryPackageWriterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.mintId = options.mintId ?? (() => mintUuidV7(this.now));
  }

  async write(
    entries: readonly PackageWriteEntry[],
    options: PackageWriteOptions = {},
  ): Promise<PackageWriteResult> {
    // `docs/04` §2: everything but the manifest in ASCII dictionary order.
    const payload = [...entries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );

    const manifestEntries: PackageEntry[] = [];
    for (const entry of payload) {
      manifestEntries.push({
        path: entry.path,
        bytes: entry.bytes.byteLength,
        sha256: await sha256Hex(entry.bytes),
      });
    }

    const candidate: PackageManifest = {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      kind: options.kind ?? 'bundle',
      id: options.id ?? this.mintId(),
      name: options.name ?? 'Memory package',
      createdAt: options.createdAt ?? this.now().toISOString(),
      generator: options.generator ?? {
        app: '@smarttavern/importers (test double)',
        version: '0.0.0',
        platform: 'cli',
      },
      license: options.license ?? 'user-provided',
      schemaVersions: deriveSchemaVersions(payload, options.schemaVersions),
      entries: manifestEntries,
      contents: {
        counts: deriveCounts(payload),
        bytes: manifestEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      },
      redaction: { apiKeys: 'excluded', absolutePaths: 'excluded' },
      ...(options.i18n === undefined ? {} : { i18n: options.i18n }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(options.tags === undefined ? {} : { tags: [...options.tags] }),
      ...(options.refs === undefined ? {} : { refs: [...options.refs] }),
      ...(options.assets === undefined ? {} : { assets: [...options.assets] }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    };

    const parsed = PackageManifestSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `the memory writer produced an invalid manifest: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const problems = validateManifestConsistency(parsed.data);
    if (problems.length > 0) {
      throw new Error(
        `the memory writer produced an inconsistent manifest: ${problems.join('; ')}`,
      );
    }

    return {
      bytes: serializeContainer([
        { path: 'manifest.json', bytes: canonicalJsonBytes(parsed.data) },
        ...payload,
      ]),
      manifest: parsed.data,
    };
  }
}

/* ──────────────────────────────── reader ─────────────────────────────────── */

/** Every validation layer, with `payloadSchemas` honestly false (see the port). */
export const MEMORY_PACKAGE_COVERAGE: PackageValidationCoverage = {
  container: true,
  manifestShape: true,
  manifestConsistency: true,
  entryChecksums: true,
  assetBindings: true,
  payloadSchemas: false,
  schemaVersions: true,
};

export class MemoryPackageReader implements PackageReader {
  /** Every source it was asked to read, for assertions about the call shape. */
  readonly reads: PackageSource[] = [];

  async read(source: PackageSource, options: PackageReadOptions = {}): Promise<PackageReadResult> {
    this.reads.push(source);
    const files = decodeContainer(bytesOf(source));
    const findings: PackageFinding[] = [];

    const manifestBytes = files.get('manifest.json');
    if (manifestBytes === undefined) {
      // No manifest: nothing a caller could trust, so this is a throw and not a
      // finding (the port says a result always carries a manifest).
      throw new Error('manifest.json is missing from the package');
    }
    if ([...files.keys()][0] !== 'manifest.json') {
      findings.push({
        code: 'manifest-not-first',
        severity: 'error',
        detail: 'manifest.json must be the first entry of the container (docs/04 §2)',
      });
    }

    const parsed = PackageManifestSchema.safeParse(JSON.parse(TEXT.decode(manifestBytes)));
    if (!parsed.success) {
      throw new Error(
        `manifest.json does not satisfy the format: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const manifest = parsed.data;

    for (const problem of validateManifestConsistency(manifest)) {
      findings.push({ code: 'manifest-inconsistent', severity: 'error', detail: problem });
    }

    for (const entry of manifest.entries) {
      const bytes = files.get(entry.path);
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
      const hash = await sha256Hex(bytes);
      if (hash !== entry.sha256) {
        findings.push({
          code: 'entry-sha256-mismatch',
          severity: 'error',
          path: entry.path,
          detail: `${entry.path} hashes to ${hash} but entries[] says ${entry.sha256}`,
        });
      }
    }

    const declared = new Set(manifest.entries.map((entry) => entry.path));
    for (const path of files.keys()) {
      if (path === 'manifest.json' || declared.has(path)) continue;
      findings.push({
        code: 'entry-unexpected',
        severity: 'warning',
        detail: `${path} is in the container but not in entries[]`,
      });
    }

    const entries: PackageEntryPayload[] = manifest.entries.map((entry) => ({
      path: entry.path,
      bytes:
        options.includePayload === false
          ? new Uint8Array()
          : Uint8Array.from(files.get(entry.path) ?? new Uint8Array()),
    }));

    return { manifest, entries, findings };
  }
}

function bytesOf(source: PackageSource): Uint8Array {
  if (source.kind === 'bytes') return source.bytes;
  // The double refuses paths and urls on purpose: reading a real file is the
  // adapter's job, and a double that pretends to have a filesystem hides bugs.
  throw new Error(`MemoryPackageReader only accepts { kind: 'bytes' }, got ${source.kind}`);
}

export class MemoryPackageValidator implements PackageValidator {
  readonly reader: MemoryPackageReader;

  constructor(reader: MemoryPackageReader = new MemoryPackageReader()) {
    this.reader = reader;
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
      coverage: MEMORY_PACKAGE_COVERAGE,
    };
  }
}
