/**
 * Building a manifest out of real payload bytes (`docs/04` §3, §6, §11).
 *
 * THE ONE INVARIANT THAT MATTERS HERE: `entries[].sha256` and `contents.bytes`
 * are DERIVED, never supplied. A caller cannot hand us a hash that does not
 * match the bytes it is about to write, so the "tamper one byte → validation
 * fails" guarantee (docs/04 §12 item 3) starts at the writer.
 *
 * `packages/packages` is pure logic: no DOM, no storage, no filesystem. Hashing
 * uses the platform WebCrypto (`crypto.subtle`), which is the same code in Node
 * ≥18 and in a browser.
 */
import {
  type Extensions,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  type PackageAsset,
  type PackageContents,
  type PackageCounts,
  type PackageEntry,
  type PackageGenerator,
  type PackageI18n,
  type PackageManifest,
  PackageManifestSchema,
  type PackagePath,
  PackagePathSchema,
  type PackageRef,
  type PackageSchemaVersions,
  type PackageSource,
  validateManifestConsistency,
} from '@smarttavern/schema';
import { canonicalJsonBytes, type JsonValue } from './canonical-json';
import { checkJsonTree, type PartialPackageLimits, resolveLimits } from './limits';
import { toByteArray } from './zip/stream-types';

/** The manifest is the first ZIP entry and is never listed in `entries[]`. */
export const MANIFEST_ENTRY_PATH = 'manifest.json';

/** Raised for anything that makes a package un-buildable, listing every reason. */
export class PackageError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(problems.length > 0 ? `${message}: ${problems.join('; ')}` : message);
    this.name = 'PackageError';
  }
}

/* ─────────────────────────────── hashing ────────────────────────────────── */

/** Lower-case hex SHA-256 of the given bytes (`docs/04` §3.1 `entries[].sha256`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toByteArray(bytes));
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/* ──────────────────────────── payload normalisation ─────────────────────── */

/**
 * A file to put in the package. Either raw bytes (images, `LICENSE.txt`, an
 * already-serialised transcript) or a JSON value that WE serialise canonically.
 */
export type PayloadInput =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly json: JsonValue };

/** A payload file after canonicalisation and validation. */
export interface PreparedPayload {
  readonly path: PackagePath;
  readonly bytes: Uint8Array;
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Validate paths, serialise the JSON inputs canonically, enforce the size caps,
 * reject duplicates and return the files in **ASCII dictionary order** — the
 * order `docs/04` §2 and §11 require inside the archive, and the reason two
 * runs of the same content produce identical bytes.
 */
export function preparePayload(
  files: readonly PayloadInput[],
  limits?: PartialPackageLimits,
): PreparedPayload[] {
  const resolved = resolveLimits(limits);
  const prepared: PreparedPayload[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const parsedPath = PackagePathSchema.safeParse(file.path);
    if (!parsedPath.success) {
      throw new PackageError(`invalid payload path ${JSON.stringify(file.path)}`, [
        parsedPath.error.issues.map((issue) => issue.message).join(', '),
      ]);
    }
    if (seen.has(parsedPath.data)) {
      throw new PackageError(`duplicate payload path ${parsedPath.data}`);
    }
    seen.add(parsedPath.data);

    let bytes: Uint8Array;
    if ('bytes' in file) {
      bytes = file.bytes;
    } else {
      const tree = checkJsonTree(file.json, resolved);
      if (!tree.ok) {
        throw new PackageError(`payload ${parsedPath.data} exceeds the JSON ${tree.reason} limit`, [
          `${tree.path} vs limit ${tree.limit}`,
        ]);
      }
      bytes = canonicalJsonBytes(file.json);
    }

    if (bytes.byteLength > resolved.maxEntryBytes) {
      throw new PackageError(
        `payload ${parsedPath.data} is ${bytes.byteLength} bytes, over the ${resolved.maxEntryBytes}-byte per-file limit`,
      );
    }
    prepared.push({ path: parsedPath.data, bytes });
  }

  prepared.sort((left, right) => comparePaths(left.path, right.path));

  const total = prepared.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > resolved.maxTotalBytes) {
    throw new PackageError(
      `payload totals ${total} bytes, over the ${resolved.maxTotalBytes}-byte limit`,
    );
  }
  return prepared;
}

/* ─────────────────────────────── manifest ───────────────────────────────── */

/**
 * What the caller must know that the bytes cannot tell us: identity, licence,
 * which schema versions the payloads were written against, and the content
 * counts — a JSONL transcript does not advertise how many messages it holds.
 *
 * Everything derivable (`entries`, `contents.bytes`, `format`, `formatVersion`,
 * `redaction`) is deliberately absent: the writer computes it.
 */
export interface ManifestDraft {
  readonly kind: PackageManifest['kind'];
  readonly id: PackageManifest['id'];
  readonly name: string;
  readonly generator: PackageGenerator;
  readonly license: PackageManifest['license'];
  readonly counts: PackageCounts;
  readonly schemaVersions: PackageSchemaVersions;
  readonly createdAt: string;
  readonly i18n?: PackageI18n;
  readonly description?: string;
  readonly source?: PackageSource;
  readonly tags?: readonly string[];
  readonly refs?: readonly PackageRef[];
  readonly assets?: readonly PackageAsset[];
  readonly extensions?: Extensions;
}

/** `entries[]` plus the byte total `contents` needs, both derived from the bytes. */
export async function deriveEntries(payload: readonly PreparedPayload[]): Promise<{
  entries: PackageEntry[];
  bytes: number;
}> {
  const entries: PackageEntry[] = [];
  let bytes = 0;
  for (const file of payload) {
    entries.push({
      path: file.path,
      bytes: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes),
    });
    bytes += file.bytes.byteLength;
  }
  return { entries, bytes };
}

/**
 * Assemble the manifest, then check it two ways: the Zod shape, and the
 * cross-field rules JSON Schema cannot express (`validateManifestConsistency`).
 * Both failures are collected into one `PackageError`, because a builder that
 * reports one problem per run is a builder people stop using.
 */
export async function buildManifest(
  draft: ManifestDraft,
  payload: readonly PreparedPayload[],
): Promise<PackageManifest> {
  const { entries, bytes } = await deriveEntries(payload);
  const contents: PackageContents = { counts: draft.counts, bytes };

  const candidate: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    kind: draft.kind,
    id: draft.id,
    name: draft.name,
    createdAt: draft.createdAt,
    generator: draft.generator,
    license: draft.license,
    schemaVersions: draft.schemaVersions,
    entries,
    contents,
    redaction: { apiKeys: 'excluded', absolutePaths: 'excluded' },
    ...(draft.i18n === undefined ? {} : { i18n: draft.i18n }),
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.source === undefined ? {} : { source: draft.source }),
    ...(draft.tags === undefined ? {} : { tags: [...draft.tags] }),
    ...(draft.refs === undefined ? {} : { refs: [...draft.refs] }),
    ...(draft.assets === undefined ? {} : { assets: [...draft.assets] }),
    ...(draft.extensions === undefined ? {} : { extensions: draft.extensions }),
  };

  const parsed = PackageManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PackageError(
      'manifest does not satisfy the format',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }

  const problems = validateManifestConsistency(parsed.data);
  if (problems.length > 0) {
    throw new PackageError('manifest is internally inconsistent', problems);
  }
  return parsed.data;
}
