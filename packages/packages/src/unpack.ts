/**
 * `unpack` — read a package once and hand back its payloads.
 *
 * WHY THERE IS NO FILESYSTEM HERE: `docs/04` §11 requires `packages/packages` to
 * be pure logic a third-party tool can reuse, and the Web build has no filesystem
 * at all. Writing the returned files to disk (or to IndexedDB, or to a download)
 * is the caller's job — `tools/stpack-cli` does it for the command line, and the
 * importer will do it for the app.
 *
 * REFUSAL SEMANTICS: a package that fails validation yields **no** files, and the
 * report is always returned so the caller can tell the user exactly what is wrong
 * with the file they just downloaded (docs/04 §7 step 7).
 */
import type { PackageManifest } from '@smarttavern/schema';
import type { PartialPackageLimits } from './limits';
import { MANIFEST_ENTRY_PATH } from './manifest';
import { type ValidationReport, validatePackage } from './validate';

export interface UnpackedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface UnpackResult {
  readonly report: ValidationReport;
  /** Every file in the archive except the manifest, in archive order. */
  readonly files: readonly UnpackedFile[];
  readonly manifest?: PackageManifest;
  /**
   * `manifest.json` exactly as it sits in the archive. Returned separately so a
   * caller that rebuilds a directory tree (the CLI does) can restore the
   * original bytes instead of re-serialising them.
   */
  readonly manifestBytes?: Uint8Array;
}

/** Read a package into memory. Never throws for a bad package — check `report.ok`. */
export async function unpackPackage(
  bytes: Uint8Array,
  limits?: PartialPackageLimits,
): Promise<UnpackResult> {
  const report = await validatePackage(bytes, limits);
  if (!report.ok) {
    return { report, files: [] };
  }

  const files = report.entries
    .filter((entry) => entry.path !== MANIFEST_ENTRY_PATH)
    .map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  const manifestBytes = report.entries.find((entry) => entry.path === MANIFEST_ENTRY_PATH)?.bytes;

  return {
    report,
    files,
    ...(report.manifest === undefined ? {} : { manifest: report.manifest }),
    ...(manifestBytes === undefined ? {} : { manifestBytes }),
  };
}
