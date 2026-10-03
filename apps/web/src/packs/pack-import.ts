/**
 * Reading a `.stpack` into the library, and the preview that comes first (M1-A4).
 *
 * WHY PREVIEW AND IMPORT ARE TWO CALLS TO THE SAME FUNCTION
 * The user's requirement is "see the report before anything is written". The obvious
 * implementation — parse it once for the report, then write — has two parse paths, and the
 * day they disagree the screen shows one thing and the database gets another. So both entry
 * points run `importPackage` with the SAME reader and the SAME validator; the only difference
 * is the storage port (`dryRunStorage` for the preview). The identity rules, the findings,
 * the counts and the entity list are therefore the importer's, produced once, in one code path.
 *
 * WHY THE READER AND VALIDATOR ARE BUILT HERE AND NOT PASSED IN BY THE VIEW
 * `@smarttavern/packages` is the real container. A view that constructed its own would be a
 * second place that decides how a package is opened; building them at the boundary keeps the
 * view ignorant of the format and gives a test one seam to inject a deliberately broken reader.
 *
 * WHY A CORRUPT FILE IS NOT AN EXCEPTION
 * `importPackage` catches a reader failure and returns a report whose findings carry
 * `code: 'zip-corrupt'` — that is the library's contract, and it is the right one for a file
 * picker: a user who picks the wrong file needs a sentence, not a rejected promise. The only
 * thing that can still throw here is the file input itself (`File.arrayBuffer()`), and the
 * screen turns that into `pack.fileUnreadable`.
 */
import type { PackageReader, PackageValidator, StorageAdapter } from '@smarttavern/core';
import type { ImportReport } from '@smarttavern/importers';
import { buildExampleContentPack, importPackage } from '@smarttavern/importers';
import {
  createPackageReader,
  createPackageValidator,
  createPackageWriter,
} from '@smarttavern/packages';
import { packFileName } from './pack-export';
import { dryRunStorage, packStorage } from './pack-storage';

export interface PackImportRequest {
  readonly bytes: Uint8Array;
  /** Defaults to the app's own library. A test injects a double here. */
  readonly storage?: StorageAdapter;
  /** Defaults to `@smarttavern/packages`' reader/validator; tests replace them to break one. */
  readonly reader?: PackageReader;
  readonly validator?: PackageValidator;
}

/**
 * The reader/validator pair for one request. Shared by both entry points, deliberately: a
 * preview that used a different reader from the import would be a preview of another package.
 */
function portsOf(request: PackImportRequest): {
  reader: PackageReader;
  validator: PackageValidator;
} {
  return {
    reader: request.reader ?? createPackageReader(),
    validator: request.validator ?? createPackageValidator(),
  };
}

/**
 * The report an import WOULD produce, with nothing written.
 *
 * The importer runs its whole decision on a real transaction against the real library — that
 * is what makes the counts and the `reused`/`remapped` verdicts honest — and the transaction is
 * then aborted, so the library is byte-identical afterwards. See `pack-storage.ts`.
 */
export async function previewPack(request: PackImportRequest): Promise<ImportReport> {
  const { reader, validator } = portsOf(request);
  return importPackage(request.bytes, {
    reader,
    validator,
    storage: dryRunStorage(request.storage ?? packStorage()),
  });
}

/** The same import, committed. One transaction, so a refusal here writes nothing either. */
export async function importPack(request: PackImportRequest): Promise<ImportReport> {
  const { reader, validator } = portsOf(request);
  return importPackage(request.bytes, {
    reader,
    validator,
    storage: request.storage ?? packStorage(),
  });
}

export interface ExamplePack {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/**
 * The shipped example, built in process — the reason the app no longer needs the CLI to get it.
 *
 * `buildExampleContentPack` needs no database and no clock: it assembles the 「长日港 + 末班渡」
 * bundle from `@smarttavern/importers/src/examples/content.ts` and runs it through the same
 * container writer the exporter uses. The CLI's `stpack examples` calls the very same function
 * with `platform: 'cli'`, so the CONTENT is identical; only the manifest's `generator` line
 * differs, and it says `web` because a browser built it. What the CLI cannot do is put the rows
 * where the app reads them — it writes a JSON-file library, which is not this app's IndexedDB.
 * That gap is the acceptance failure this button closes: the example is previewed and imported
 * through the SAME path as a file the user picked, so the two cannot diverge.
 */
export async function examplePackBytes(): Promise<ExamplePack> {
  const result = await buildExampleContentPack({ writer: createPackageWriter() });
  return { fileName: packFileName(result.manifest.name), bytes: result.bytes };
}
