/**
 * The `@smarttavern/core` package ports, implemented over the pure packing layer.
 *
 * WHY THIS FILE EXISTS: `pack` / `unpackPackage` / `validatePackage` are the
 * explicit, third-party-friendly API (`docs/04` §11); the application talks to
 * `PackageReader` / `PackageWriter` / `PackageValidator`
 * (`packages/core/src/ports/package.ts`). This is the single place that translates
 * between the two vocabularies — including the finding codes, which are
 * deliberately different: the port's list is a stable UI/i18n contract, this
 * layer's list is whatever the checks happen to detect. `mapValidationFinding` is
 * a `Record` over the internal union, so a new internal code is a compile error
 * until somebody decides what it means to a caller.
 *
 * IT ADDS TWO THINGS THE PURE API DOES NOT:
 *
 * 1. `write` MINTS WHAT THE CALLER LEAVES OUT — id, `createdAt`, `counts` and
 *    `schemaVersions` — because those are exactly the fields a caller gets wrong,
 *    and a manifest that disagrees with its own payload is what
 *    `validateManifestConsistency` exists to reject. Counts are derived from the
 *    payload (array lengths, JSONL line count, asset file count) and schema versions
 *    from `CURRENT_SCHEMA_VERSIONS`, so the derived half is never guessed.
 *
 * 2. `read`/`validate` TAKE A `PackageSource` AND RESOLVE IT THROUGH AN INJECTED
 *    LOADER. This package never touches the filesystem or the network
 *    (HANDOFF §4.1 invariant 1; `docs/06` §8.2 rule 4), so the default loader
 *    accepts only `{kind: 'bytes'}` and says so loudly otherwise; a desktop shell
 *    passes its own loader for `file`/`url` sources.
 */
import type {
  PackageFinding,
  PackageFindingCode,
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
import {
  CURRENT_SCHEMA_VERSIONS,
  MANIFEST_DATA_FILES,
  PACKAGE_COUNT_KEYS,
  type PackageCountKey,
  type PackageCounts,
  type PackageManifest,
  type PackageSchemaVersionKey,
  type PackageSchemaVersions,
  type UuidV7,
} from '@smarttavern/schema';
import type { PartialPackageLimits } from './limits';
import { buildManifest, type ManifestDraft, type PayloadInput, preparePayload } from './manifest';
import { pack } from './pack';
import { unpackPackage } from './unpack';
import { type ValidationFinding, type ValidationFindingCode, validatePackage } from './validate';

/* ───────────────────────────── failure to load ──────────────────────────── */

/** Raised when a source cannot be resolved — almost always a missing loader. */
export class PackageSourceError extends Error {
  constructor(
    message: string,
    readonly source: PackageSource,
  ) {
    super(message);
    this.name = 'PackageSourceError';
  }
}

/**
 * The only source this package can resolve by itself. `file` and `url` need a
 * shell: `packages/packages` is pure logic, and letting it open paths would put
 * filesystem access behind a format parser.
 */
export type PackageLoader = (source: PackageSource) => Promise<Uint8Array>;

export const bytesOnlyLoader: PackageLoader = async (source) => {
  if (source.kind === 'bytes') return source.bytes;
  throw new PackageSourceError(
    `this package cannot resolve a ${source.kind} source: inject a \`load\` function (packages/packages is pure logic and never touches the filesystem or the network)`,
    source,
  );
};

/* ─────────────────────────────── writer ────────────────────────────────── */

/**
 * Mint a UUIDv7 (`docs/04` §4: time-ordered, so ids sort by creation). Injectable
 * for deterministic tests and for a shell that has a better entropy source.
 */
export function mintUuidV7(
  now: () => Date = () => new Date(),
  random: () => number = () => Math.random(),
): UuidV7 {
  const hex = (length: number): string => {
    let out = '';
    while (out.length < length) out += Math.floor(random() * 16).toString(16);
    return out.slice(0, length);
  };
  const stamp = now().getTime().toString(16).padStart(12, '0').slice(-12);
  const variant = ['8', '9', 'a', 'b'][Math.floor(random() * 4)] ?? '8';
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Which count key each entity's payload file feeds (`PACKAGE_COUNT_KEYS` names). */
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

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function countLines(bytes: Uint8Array): number {
  const text = UTF8.decode(bytes);
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() !== '') lines += 1;
  }
  return lines;
}

/** How many entities of each kind the payload holds. Missing categories stay 0. */
export function deriveCounts(files: readonly PayloadInput[]): PackageCounts {
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
      if (file.path.endsWith('.jsonl')) {
        if ('bytes' in file) counts[key] += countLines(file.bytes);
      } else {
        const value: unknown = 'json' in file ? file.json : JSON.parse(UTF8.decode(file.bytes));
        counts[key] += Array.isArray(value) ? value.length : 1;
      }
      continue;
    }
    // `assets/refs.json` is metadata about the assets, not an asset itself.
    if (file.path.startsWith('assets/') && file.path !== 'assets/refs.json') counts.assets += 1;
  }
  return counts as PackageCounts;
}

/** Schema versions for whatever the payload actually contains (`docs/04` §12-15). */
export function deriveSchemaVersions(
  files: readonly PayloadInput[],
  declared: PackageSchemaVersions | undefined,
): PackageSchemaVersions {
  const entities = new Set<PackageSchemaVersionKey>();
  for (const file of files) {
    const entity = (MANIFEST_DATA_FILES as Record<string, PackageSchemaVersionKey | undefined>)[
      file.path
    ];
    if (entity !== undefined) entities.add(entity);
    if (file.path.startsWith('assets/') && file.path !== 'assets/refs.json') entities.add('asset');
  }
  // An explicit declaration WINS: a caller importing an older payload must be able to
  // say so, and writing that payload under a fresh version number would make the
  // manifest lie about its own contents — the one thing this derivation exists to stop.
  const derived: Record<string, number> = {};
  for (const entity of entities) derived[entity] = CURRENT_SCHEMA_VERSIONS[entity];
  return { ...derived, ...declared } as PackageSchemaVersions;
}

export interface PackageWriterFactoryOptions {
  /** Clock used for `createdAt` (and the id's timestamp). Inject for determinism. */
  readonly now?: () => Date;
  /** Identity generator; defaults to a UUIDv7 minted from `now` and `Math.random`. */
  readonly mintId?: () => UuidV7;
  /** Default `generator` when the caller does not supply one. */
  readonly generator?: ManifestDraft['generator'];
}

const FALLBACK_GENERATOR: ManifestDraft['generator'] = {
  app: 'SmartTavern',
  version: '0.0.0-dev',
  platform: 'web',
};

/**
 * A `PackageWriter` over `pack()`. Everything the port promises to derive —
 * `entries[]`, `contents`, counts, schema versions — is derived here from the
 * bytes handed in, never taken from the caller.
 */
export function createPackageWriter(options: PackageWriterFactoryOptions = {}): PackageWriter {
  const now = options.now ?? (() => new Date());
  const mintId = options.mintId ?? (() => mintUuidV7(now));

  return {
    async write(
      entries: readonly PackageWriteEntry[],
      writeOptions: PackageWriteOptions = {},
    ): Promise<PackageWriteResult> {
      const files: PayloadInput[] = entries.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
      }));

      const draft: ManifestDraft = {
        // Required by the manifest, defaulted here so a caller can write a package
        // without inventing an identity or a licence it does not know yet.
        kind: writeOptions.kind ?? 'bundle',
        id: writeOptions.id ?? mintId(),
        name: writeOptions.name ?? 'Untitled package',
        createdAt: writeOptions.createdAt ?? now().toISOString(),
        generator: writeOptions.generator ?? options.generator ?? FALLBACK_GENERATOR,
        license: writeOptions.license ?? 'user-provided',
        // Derived, not supplied: `PackageWriteOptions` deliberately omits `contents`.
        counts: deriveCounts(files),
        schemaVersions: deriveSchemaVersions(files, writeOptions.schemaVersions),
        ...(writeOptions.i18n === undefined ? {} : { i18n: writeOptions.i18n }),
        ...(writeOptions.description === undefined
          ? {}
          : { description: writeOptions.description }),
        ...(writeOptions.source === undefined ? {} : { source: writeOptions.source }),
        ...(writeOptions.tags === undefined ? {} : { tags: writeOptions.tags }),
        ...(writeOptions.refs === undefined ? {} : { refs: writeOptions.refs }),
        ...(writeOptions.assets === undefined ? {} : { assets: writeOptions.assets }),
        ...(writeOptions.extensions === undefined ? {} : { extensions: writeOptions.extensions }),
      };

      // `pack` derives the same manifest internally from the same inputs, so the
      // value returned here is what the archive holds — no second source of truth.
      const bytes = await pack({ manifest: draft, files });
      const manifest: PackageManifest = await buildManifest(draft, preparePayload(files));
      return { bytes, manifest };
    },
  };
}

/* ─────────────────────────────── reading ───────────────────────────────── */

export interface PackageReaderFactoryOptions {
  /** How a source turns into bytes. Defaults to `bytesOnlyLoader`. */
  readonly load?: PackageLoader;
  /** Caps applied to every read (see `limits.ts`). */
  readonly limits?: PartialPackageLimits;
}

export function createPackageReader(options: PackageReaderFactoryOptions = {}): PackageReader {
  const load = options.load ?? bytesOnlyLoader;

  return {
    async read(
      source: PackageSource,
      readOptions: PackageReadOptions = {},
    ): Promise<PackageReadResult> {
      const limits: PartialPackageLimits = {
        ...options.limits,
        ...(readOptions.maxBytes === undefined ? {} : { maxEntryBytes: readOptions.maxBytes }),
      };
      const result = await unpackPackage(await load(source), limits);

      // The port's rule: a result must be trustworthy, so a read that cannot produce
      // a manifest throws rather than returning half an answer.
      if (result.manifest === undefined) {
        throw new PackageSourceError(
          `cannot read a package from this source: ${result.report.findings
            .filter((finding) => finding.severity === 'error')
            .map((finding) => finding.message)
            .join('; ')}`,
          source,
        );
      }

      return {
        manifest: result.manifest,
        entries: result.files.map((file) => ({
          path: file.path,
          bytes: readOptions.includePayload === false ? new Uint8Array() : file.bytes,
        })),
        findings: result.report.findings.map(mapValidationFinding),
      };
    },
  };
}

/* ────────────────────────────── validation ─────────────────────────────── */

/**
 * Which checks this build actually performs. Honest rather than aspirational:
 * `payloadSchemas` is `false` because M0 validates payload JSON for well-formedness
 * and the structure caps, not against per-entity schemas — that arrives with the
 * importer in M1 (`docs/06` §8.6).
 */
export const DEFAULT_PACKAGE_COVERAGE: PackageValidationCoverage = Object.freeze({
  container: true,
  manifestShape: true,
  manifestConsistency: true,
  entryChecksums: true,
  assetBindings: true,
  payloadSchemas: false,
  schemaVersions: true,
});

export interface PackageValidatorFactoryOptions {
  readonly load?: PackageLoader;
  readonly limits?: PartialPackageLimits;
}

export function createPackageValidator(
  options: PackageValidatorFactoryOptions = {},
): PackageValidator {
  const load = options.load ?? bytesOnlyLoader;

  return {
    async validate(source: PackageSource): Promise<PackageValidationResult> {
      const report = await validatePackage(await load(source), options.limits);
      return {
        ok: report.ok,
        findings: report.findings.map(mapValidationFinding),
        coverage: DEFAULT_PACKAGE_COVERAGE,
        ...(report.manifest === undefined ? {} : { manifest: report.manifest }),
      };
    },
  };
}

/* ─────────────────────── finding-code translation ──────────────────────── */

/** Internal code → the port's stable vocabulary. Exhaustive by construction. */
const FINDING_CODE_MAP: Record<ValidationFindingCode, PackageFindingCode> = {
  'manifest-missing': 'manifest-missing',
  'manifest-not-first': 'manifest-not-first',
  'manifest-unparsable': 'manifest-invalid',
  'manifest-json-limit': 'manifest-invalid',
  'manifest-schema': 'manifest-invalid',
  'manifest-inconsistent': 'manifest-inconsistent',
  'format-version-unsupported': 'schema-version-unsupported',
  'payload-newer-than-build': 'schema-version-unsupported',
  'payload-migration-needed': 'schema-version-unsupported',
  'entry-missing': 'entry-missing',
  'entry-size': 'entry-size-mismatch',
  'entry-hash': 'entry-sha256-mismatch',
  'entry-undeclared': 'entry-unexpected',
  'payload-json-invalid': 'payload-unparsable',
  'payload-json-limit': 'payload-unparsable',
  // Container rejections are refined below by the ZIP rule that caused them.
  'zip-rejected': 'zip-corrupt',
};

/**
 * ZIP rejection rule → the port's container codes. The reader is deliberately
 * fine-grained (≈40 rules, `zip/read.ts`); the port's list is coarser, so this maps
 * families and keeps the precise rule in `where` for the UI.
 */
const ZIP_RULE_MAP: Record<string, PackageFindingCode> = {
  encrypted: 'zip-encrypted',
  'unsupported-method': 'zip-unsupported-compression',
  'method-mismatch': 'zip-unsupported-compression',
  'path-traversal': 'path-traversal',
  'absolute-path': 'path-traversal',
  'drive-letter': 'path-traversal',
  backslash: 'path-invalid',
  'dot-path': 'path-invalid',
  'empty-path': 'path-invalid',
  'control-character': 'path-invalid',
  'path-charset': 'path-invalid',
  'path-too-long': 'path-invalid',
  'declared-size-mismatch': 'entry-size-mismatch',
  'size-mismatch': 'entry-size-mismatch',
};

/** Translate one internal finding into the port's vocabulary. */
export function mapValidationFinding(finding: ValidationFinding): PackageFinding {
  const code =
    finding.code === 'zip-rejected'
      ? (ZIP_RULE_MAP[finding.where ?? ''] ?? 'zip-corrupt')
      : FINDING_CODE_MAP[finding.code];

  return {
    code,
    severity: finding.severity,
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.where === undefined ? {} : { where: finding.where }),
    detail: finding.message,
  };
}
