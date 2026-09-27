/**
 * Package port — reading, writing and validating `.stpack` files
 * (`docs/04-分享格式规范.md`, `docs/02` §8, tasks M0-T3/T4).
 *
 * THREE RULES THAT SHAPE THIS FILE
 *
 * 1. VALIDATION RETURNS FINDINGS, NEVER A BOOLEAN. `docs/04` §7 requires the
 *    importer to show the user exactly which file failed and why, so
 *    `PackageValidator.validate` answers with a per-file (and per-manifest-field)
 *    list. A `boolean` would force every caller to re-derive the reason, and the
 *    one place that CAN know it is the validator.
 *
 * 2. READING GIVES THE MANIFEST PLUS PAYLOAD BYTES. The manifest is parsed and
 *    checked against `ManifestSchema` + `validateManifestConsistency` (both from
 *    `@smarttavern/schema` — this file re-states neither), and the payload is
 *    handed over as bytes. `unpack` "只落盘字节，绝不执行包内任何内容"
 *    (`docs/06` §8.2 rule 4): that is why `read` can only ever produce bytes and
 *    never a value with behaviour attached.
 *
 * 3. A PATH IS DATA, NOT A PLACE. Every payload path in a package is a
 *    `PackagePath` from the schema, which already rejects `..`, absolute paths and
 *    drive letters — so a reader cannot be talked into traversing by a manifest
 *    it failed to validate.
 *
 * WHAT IS DELIBERATELY ABSENT: merge semantics and signatures. Both are M4 / v2
 * (`docs/06` §8.6) and `signature` is `null` in v1, so the writer writes no
 * signature and the reader does not look for one. Also absent: a boolean
 * validity answer — rule 1 above says a finding list is the answer.
 */
import type { PackageAsset, PackageEntry, PackageManifest, PackagePath } from '@smarttavern/schema';

/* ──────────────────────────────── 校验发现 ─────────────────────────────── */

/**
 * How bad a finding is.
 * - `error`   — the package is not usable; a reader must refuse it.
 * - `warning` — usable, but something is off (an unused asset entry, a size
 *               mismatch inside a `meta` field); shown, not fatal.
 * - `info`    — a note the import UI lists (e.g. "LICENSE.txt present").
 */
export type PackageFindingSeverity = 'error' | 'warning' | 'info';

/** Machine-readable finding code, for tests and for i18n message lookup. */
export type PackageFindingCode =
  | 'zip-corrupt'
  | 'zip-unsupported-compression'
  | 'zip-encrypted'
  | 'zip-nested-archive'
  | 'manifest-missing'
  | 'manifest-not-first'
  | 'manifest-invalid'
  | 'manifest-inconsistent'
  | 'path-invalid'
  | 'path-traversal'
  | 'entry-missing'
  | 'entry-unexpected'
  | 'entry-size-mismatch'
  | 'entry-sha256-mismatch'
  | 'asset-mismatch'
  | 'payload-unparsable'
  | 'schema-version-unsupported'
  | 'unknown-field'
  | 'signature-present'
  | 'io-error';

/**
 * One problem, located. `path` is the in-package path (`undefined` when the
 * finding is about the container or the manifest as a whole), and `detail` is the
 * human sentence the UI shows verbatim.
 */
export interface PackageFinding {
  code: PackageFindingCode;
  severity: PackageFindingSeverity;
  /** Which file it is about; absent for container/manifest-level findings. */
  path?: PackagePath;
  /** Free-form locator inside the target, e.g. `entries[3].sha256`. */
  where?: string;
  detail: string;
}

/* ───────────────────────────────── 读取 ───────────────────────────────── */

/** The bytes and identity of one payload file. */
export interface PackageEntryPayload {
  path: PackagePath;
  bytes: Uint8Array;
}

/**
 * A parsed package: the manifest, the declared entries, the payload bytes, and
 * whatever was found along the way.
 *
 * `findings` is NOT an error channel: a read that could not produce a manifest
 * throws instead, because a caller that gets a result must be able to trust that
 * `manifest` and `entries` are consistent with each other. Use
 * `hasBlockingFindings()` to decide whether to proceed.
 */
export interface PackageReadResult {
  manifest: PackageManifest;
  entries: PackageEntryPayload[];
  findings: PackageFinding[];
}

/**
 * Where a package's bytes come from. A shell that has already loaded the file
 * passes `bytes`; a desktop shell with a real filesystem passes `path` and lets
 * the adapter read it (core cannot open files — HANDOFF §4.1 invariant 1).
 */
export type PackageSource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

/** Which payloads to materialise. `read` skips nothing by default. */
export interface PackageReadOptions {
  /** When false, `entries` carry paths and empty bytes — cheap manifest-only read. */
  readonly includePayload?: boolean;
  /** Hard cap on a single entry, another anti-zip-bomb belt (§9). */
  readonly maxBytes?: number;
}

/** Reader contract: manifest + payload bytes, with findings rather than a flag. */
export interface PackageReader {
  read(source: PackageSource, options?: PackageReadOptions): Promise<PackageReadResult>;
}

/**
 * True when at least one finding is fatal. Provided as a function so the rule
 * "errors block, warnings do not" lives in exactly one place.
 */
export function hasBlockingFindings(findings: readonly PackageFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

/* ───────────────────────────────── 写入 ───────────────────────────────── */

/** One payload to write. The writer computes `bytes` and `sha256` itself. */
export interface PackageWriteEntry {
  path: PackagePath;
  bytes: Uint8Array;
}

/**
 * A fully built package: the container bytes plus the manifest that was written
 * into it. Returning the manifest saves every caller a re-read (and is the only
 * honest way to report the ids/timestamps the writer minted).
 */
export interface PackageWriteResult {
  bytes: Uint8Array;
  manifest: PackageManifest;
}

/**
 * What the writer fills in for the caller. `entries`, `assets` and `contents`
 * are NOT settable: the writer derives them from what it was handed, because a
 * hand-written `contents.bytes` that disagrees with reality is exactly what
 * `validateManifestConsistency` exists to catch. Everything else is optional, so
 * a caller can supply just the id/name differences of a re-export.
 */
export type PackageWriteOptions = Partial<Omit<PackageManifest, 'entries' | 'contents'>>;

/**
 * Writer contract. Faithful to §6's "packaging is injected" boundary: `write`
 * derives `entries[]`, `assets[]` and `contents` from `entries`, mints what
 * `options` leaves out, and writes `manifest.json` first (`docs/06` §8.2 rule 3).
 */
export interface PackageWriter {
  write(
    entries: readonly PackageWriteEntry[],
    options?: PackageWriteOptions,
  ): Promise<PackageWriteResult>;
}

/* ──────────────────────────────── 校验 ────────────────────────────────── */

/** Which validation layers ran, so a caller can report partial coverage. */
export interface PackageValidationCoverage {
  /** The ZIP container itself (structure, compression, encryption, nesting). */
  container: boolean;
  /** `PackageManifestSchema` shape. */
  manifestShape: boolean;
  /** `validateManifestConsistency` cross-field rules. */
  manifestConsistency: boolean;
  /** Per-entry size and SHA-256 against `entries[]`. */
  entryChecksums: boolean;
  /** `assets[]` against the entries they claim. */
  assetBindings: boolean;
  /** Parse payload JSON against `schema/<entity>-N.json`, when available. */
  payloadSchemas: boolean;
  /** `schemaVersions` against what this build can read. */
  schemaVersions: boolean;
}

/**
 * A complete validation answer.
 *
 * `ok` is a convenience over `findings`; `manifest` is present only when the
 * manifest parsed, so a caller can inspect a broken-but-readable package instead
 * of losing the inspection behind the failure.
 */
export interface PackageValidationResult {
  ok: boolean;
  findings: PackageFinding[];
  manifest?: PackageManifest;
  coverage: PackageValidationCoverage;
}

/**
 * Validator contract: findings, never a bare boolean.
 *
 * `validate` takes a `PackageSource` for the same reason `read` does — the
 * desktop shell validates a path without loading the file into JS first.
 */
export interface PackageValidator {
  validate(source: PackageSource): Promise<PackageValidationResult>;
}

/* ─────────────────────────────── 辅助（纯函数） ────────────────────────── */

/** `assets[]` of a manifest, normalised to an empty array. */
export function packageAssetsOf(manifest: PackageManifest): readonly PackageAsset[] {
  return manifest.assets ?? [];
}

/** `entries[]` of a manifest as `PackageEntry`, unmodified — a typing convenience. */
export function packageEntriesOf(manifest: PackageManifest): readonly PackageEntry[] {
  return manifest.entries;
}
