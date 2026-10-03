/**
 * Exporting the current library to a `.stpack` (M1-A4).
 *
 * WHY THIS RETURNS BYTES AND NOT A DOWNLOAD
 * The bytes are the artifact; the download is a browser gesture. Keeping them apart is what
 * lets a test import exactly what the button would have written — `pack-download.ts` is the
 * only module that touches `Blob`/`URL`, and it cannot change a byte.
 *
 * WHY IT DELEGATES RATHER THAN BUILDS
 * `@smarttavern/importers`' `exportContentPack` owns the format: which collections are
 * portable, the canonical JSON, the head-version rule, the redaction claim in the manifest.
 * A second exporter here is how `settings`/`providers` would eventually leak — the format
 * package's `EXPORTABLE_COLLECTIONS` is the single place that decision lives (ADR-034).
 *
 * WHY THE WHOLE LIBRARY, WITH NO PICKER
 * The acceptance failure was that nothing could be exported at all; choosing a subset is a
 * different, later question (and needs a selection screen). Passing every head row makes the
 * export a faithful copy of the library, which is the thing a round trip can be asserted on.
 */
import type { PackageWriter, StorageAdapter } from '@smarttavern/core';
import type { ExportResult } from '@smarttavern/importers';
import { exportContentPack } from '@smarttavern/importers';
import { createPackageWriter } from '@smarttavern/packages';
import type { UuidV7 } from '@smarttavern/schema';

/** The container's extension. The CLI writes the same bytes with the same suffix. */
export const PACK_EXTENSION = '.stpack';

export interface ExportLibraryRequest {
  readonly storage: StorageAdapter;
  readonly worldIds: readonly string[];
  readonly characterIds: readonly string[];
  readonly name?: string;
  readonly id?: UuidV7;
  readonly createdAt?: string;
  /** Injected by a test that wants byte-stable output; the app lets the exporter decide. */
  readonly writer?: PackageWriter;
}

export interface ExportedPack {
  /** A name a user can recognise, already safe for a filesystem. */
  readonly fileName: string;
  /** The package itself. Nothing in this module reads or writes the DOM. */
  readonly bytes: Uint8Array;
  readonly manifest: ExportResult['manifest'];
  readonly warnings: ExportResult['warnings'];
}

/**
 * A downloadable name for a package.
 *
 * WHY THE SUBSTITUTION IS NOT COSMETIC: the name comes from the user's world cards, and
 * `:` `/` `\` `?` are legal in a world name and illegal in a file name on Windows — a name
 * that survives one OS and not another is a silent failure on the platform this app ships to.
 * Trailing dots and spaces are dropped for the same reason (Windows strips them, so the file
 * that lands is not the file that was named).
 */
export function packFileName(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in a file name is the case this strips.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '')
    .trim();
  return `${cleaned === '' ? 'smarttavern' : cleaned}${PACK_EXTENSION}`;
}

/**
 * Build the package for the given rows through the real exporter.
 *
 * The exporter reads every row inside ONE transaction, so the package is a consistent
 * snapshot: a world created while it runs is either wholly in or wholly out.
 */
export async function exportLibraryPack(request: ExportLibraryRequest): Promise<ExportedPack> {
  const writer = request.writer ?? createPackageWriter();
  const result = await exportContentPack({
    storage: request.storage,
    writer,
    worldIds: request.worldIds,
    characterIds: request.characterIds,
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.id === undefined ? {} : { id: request.id }),
    ...(request.createdAt === undefined ? {} : { createdAt: request.createdAt }),
  });
  return {
    fileName: packFileName(request.name ?? result.manifest.name),
    bytes: result.bytes,
    manifest: result.manifest,
    warnings: result.warnings,
  };
}
