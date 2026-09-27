/**
 * `validate` — the offline check `docs/04` §7 steps 1–6 and §9 describe.
 *
 * DESIGN RULE: REPORT, DO NOT THROW. Reading a package is the one operation where
 * the user needs to know *everything* wrong with a file they just downloaded, so
 * this returns a finding list (each with a stable `code`, an optional `path`, and
 * a human message) instead of failing on the first problem. `pack`/`unpack` style
 * callers turn `ok === false` into a refusal.
 *
 * WHAT THIS DOES NOT DO (deliberate, see `docs/06` §8.6): it does not validate
 * entity payloads field by field. `data/*.json` is checked for well-formedness and
 * for the JSON structure caps only; entity-level validation arrives with the
 * importer in M1.
 */
import {
  CURRENT_SCHEMA_VERSIONS,
  PACKAGE_FORMAT_VERSION,
  type PackageManifest,
  PackageManifestSchema,
  type PackageSchemaVersionKey,
  validateManifestConsistency,
} from '@smarttavern/schema';
import { checkJsonTree, type PartialPackageLimits, resolveLimits } from './limits';
import { MANIFEST_ENTRY_PATH, sha256Hex } from './manifest';
import { ZipError } from './zip/errors';
import { readZip, type ZipReadEntry } from './zip/read';

export type ValidationSeverity = 'error' | 'warning';

/** One thing wrong (or worth knowing) about a package. */
export interface ValidationFinding {
  readonly severity: ValidationSeverity;
  /** Stable identifier, for tests and for UI filtering. */
  readonly code: string;
  readonly message: string;
  /** The file the finding is about, when it is about one. */
  readonly path?: string;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly findings: readonly ValidationFinding[];
  /** Present only when the manifest itself parsed. */
  readonly manifest?: PackageManifest;
  /** The archive entries, so a reader never has to parse the ZIP a second time. */
  readonly entries: readonly ZipReadEntry[];
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Check a `.stpack` from its bytes. Never throws for a bad package — a throw here
 * means a bug in this module, not in the file.
 */
export async function validatePackage(
  bytes: Uint8Array,
  limits?: PartialPackageLimits,
): Promise<ValidationReport> {
  const resolved = resolveLimits(limits);
  const findings: ValidationFinding[] = [];
  let entries: ZipReadEntry[] = [];
  const report = (manifest?: PackageManifest): ValidationReport => ({
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
    entries,
    ...(manifest === undefined ? {} : { manifest }),
  });
  const fail = (code: string, message: string, path?: string): void => {
    findings.push({ severity: 'error', code, message, ...(path === undefined ? {} : { path }) });
  };

  /* ── step 1: it has to be a ZIP we accept (docs/04 §9) ── */
  try {
    entries = await readZip(bytes, resolved);
  } catch (cause) {
    const rule = cause instanceof ZipError ? cause.context?.rule : undefined;
    fail('zip-rejected', cause instanceof Error ? cause.message : String(cause), rule);
    return report();
  }

  /* ── step 1b: the manifest is the first entry and only appears once ── */
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (entries[0]?.path !== MANIFEST_ENTRY_PATH) {
    fail(
      'manifest-not-first',
      `the first ZIP entry must be ${MANIFEST_ENTRY_PATH} (docs/04 §2), found ${JSON.stringify(entries[0]?.path ?? null)}`,
    );
  }
  const manifestEntry = byPath.get(MANIFEST_ENTRY_PATH);
  if (manifestEntry === undefined) {
    fail('manifest-missing', `${MANIFEST_ENTRY_PATH} is not in the archive`);
    return report();
  }

  /* ── step 1c: parse it, bounded ── */
  let raw: unknown;
  try {
    raw = JSON.parse(UTF8.decode(manifestEntry.bytes));
  } catch (cause) {
    fail('manifest-unparsable', `cannot decode ${MANIFEST_ENTRY_PATH}: ${String(cause)}`);
    return report();
  }
  const tree = checkJsonTree(raw, resolved);
  if (!tree.ok) {
    fail(
      'manifest-json-limit',
      `${MANIFEST_ENTRY_PATH} exceeds the JSON ${tree.reason} limit at ${tree.path} (limit ${tree.limit})`,
    );
    return report();
  }

  /* ── step 2: version gate BEFORE the shape check, so the user gets told to
   *    upgrade rather than being buried in schema errors from a newer format ── */
  const declaredVersion = (raw as { formatVersion?: unknown }).formatVersion;
  if (typeof declaredVersion === 'number' && declaredVersion > PACKAGE_FORMAT_VERSION) {
    fail(
      'format-version-unsupported',
      `package is formatVersion ${declaredVersion}, this build reads ${PACKAGE_FORMAT_VERSION} — upgrade the application`,
    );
    return report();
  }

  /* ── step 3: the shape ── */
  const parsed = PackageManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      fail(
        'manifest-schema',
        `${MANIFEST_ENTRY_PATH}${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
      );
    }
    return report();
  }
  const manifest = parsed.data;

  /* ── step 3b: cross-field consistency ── */
  for (const problem of validateManifestConsistency(manifest)) {
    fail('manifest-inconsistent', problem);
  }

  /* ── step 4/5: integrity — every declared entry exists and matches ── */
  const declared = new Set<string>();
  for (const entry of manifest.entries) {
    declared.add(entry.path);
    const actual = byPath.get(entry.path);
    if (actual === undefined) {
      fail(
        'entry-missing',
        `${entry.path} is declared in entries[] but absent from the archive`,
        entry.path,
      );
      continue;
    }
    if (actual.bytes.byteLength !== entry.bytes) {
      fail(
        'entry-size',
        `${entry.path}: entries[] declares ${entry.bytes} bytes, the archive holds ${actual.bytes.byteLength}`,
        entry.path,
      );
    }
    const hash = await sha256Hex(actual.bytes);
    if (hash !== entry.sha256) {
      fail(
        'entry-hash',
        `${entry.path}: sha256 mismatch — declared ${entry.sha256}, actual ${hash}`,
        entry.path,
      );
    }
  }

  /* ── step 5b: and nothing is hiding beyond entries[] ── */
  for (const entry of entries) {
    if (entry.path === MANIFEST_ENTRY_PATH || declared.has(entry.path)) continue;
    fail(
      'entry-undeclared',
      `${entry.path} is in the archive but missing from entries[] (docs/04 §3.1)`,
      entry.path,
    );
  }

  /* ── step 6: payload JSON is well-formed and within the structure caps ── */
  for (const entry of manifest.entries) {
    if (!entry.path.endsWith('.json')) continue;
    const actual = byPath.get(entry.path);
    if (actual === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(UTF8.decode(actual.bytes));
    } catch (cause) {
      fail(
        'payload-json-invalid',
        `${entry.path} is not valid UTF-8 JSON: ${String(cause)}`,
        entry.path,
      );
      continue;
    }
    const payloadTree = checkJsonTree(value, resolved);
    if (!payloadTree.ok) {
      fail(
        'payload-json-limit',
        `${entry.path} exceeds the JSON ${payloadTree.reason} limit at ${payloadTree.path}`,
        entry.path,
      );
    }
  }

  /* ── schema versions: newer than us is fatal, older needs a migration ── */
  for (const [entity, version] of Object.entries(manifest.schemaVersions)) {
    if (typeof version !== 'number') continue;
    const current = CURRENT_SCHEMA_VERSIONS[entity as PackageSchemaVersionKey];
    if (current === undefined) continue;
    if (version > current) {
      fail(
        'payload-newer-than-build',
        `${entity} is schema v${version}, this build reads v${current} — upgrade the application`,
      );
    } else if (version < current) {
      findings.push({
        severity: 'warning',
        code: 'payload-migration-needed',
        message: `${entity} is schema v${version} and will be migrated to v${current}`,
      });
    }
  }

  return report(manifest);
}
