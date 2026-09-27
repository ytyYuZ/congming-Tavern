/**
 * The four subcommands (`docs/06-开发任务拆解.md` §8.3, M1-M3 for `import`).
 *
 * This file is argument plumbing, exit codes and output only. Every decision
 * about what a `.stpack` may contain lives in `@smarttavern/packages`, and every
 * decision about what an IMPORT does (identity reuse vs remap, reference
 * rewriting, the report) lives in `@smarttavern/importers`; a CLI that re-decided
 * any of it would be a second implementation of the format.
 *
 * `import` is where the M1-M3 acceptance clause "导入报告可见" becomes visible while
 * there is no UI for it: the report a person reads here is the same
 * `ImportReport` object the app will render.
 *
 * EXIT CODES ARE PART OF THE CONTRACT (`§8.3`: "非法包的退出码与提示可预测"):
 *   0  the package is fine (for `unpack`: the files were written; for `import`:
 *      the rows were written, or a dry run showed they would be)
 *   1  the package is invalid, or the import was refused — the findings say why
 *   2  usage error (unknown command, missing argument, bad flag)
 *   3  I/O error (unreadable input, unwritable target/library, refusing to overwrite)
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type ImportReport,
  importPackage,
  PAYLOAD_CATEGORIES,
  type PayloadCategory,
} from '@smarttavern/importers';
import {
  createPackageReader,
  createPackageValidator,
  unpackPackage,
  validatePackage,
} from '@smarttavern/packages';
import {
  type CliIo,
  formatCounts,
  formatEntries,
  formatFindings,
  formatImportReport,
  formatLibrarySizes,
  summarizeManifest,
  toJson,
} from './format';
import { JsonLibraryStorage } from './library';

export const EXIT = { ok: 0, invalid: 1, usage: 2, io: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read the archive, reporting an I/O failure through `io` instead of throwing. */
async function readArchive(file: string, io: CliIo): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (cause) {
    io.err(`stpack: cannot read ${file}: ${messageOf(cause)}`);
    return undefined;
  }
}

/* ──────────────────────────────── validate ──────────────────────────────── */

export interface CommonOptions {
  readonly json: boolean;
}

export async function runValidate(
  file: string,
  options: CommonOptions,
  io: CliIo,
): Promise<number> {
  const bytes = await readArchive(file, io);
  if (bytes === undefined) return EXIT.io;

  const report = await validatePackage(bytes);
  const summary = report.manifest === undefined ? undefined : summarizeManifest(report.manifest);

  if (options.json) {
    io.out(toJson({ file, ok: report.ok, manifest: summary, findings: report.findings }));
  } else {
    for (const line of formatFindings(report.findings)) io.out(line);
    const errors = report.findings.filter((finding) => finding.severity === 'error').length;
    io.out(report.ok ? `${file}: OK` : `${file}: INVALID (${errors} error(s))`);
  }
  return report.ok ? EXIT.ok : EXIT.invalid;
}

/* ───────────────────────────────── inspect ──────────────────────────────── */

export async function runInspect(file: string, options: CommonOptions, io: CliIo): Promise<number> {
  const bytes = await readArchive(file, io);
  if (bytes === undefined) return EXIT.io;

  const report = await validatePackage(bytes);
  const manifest = report.manifest;
  if (manifest === undefined) {
    if (options.json) {
      io.out(toJson({ file, ok: false, findings: report.findings }));
    } else {
      for (const line of formatFindings(report.findings)) io.out(line);
      io.out(`${file}: no readable manifest`);
    }
    return EXIT.invalid;
  }

  const summary = summarizeManifest(manifest);
  if (options.json) {
    io.out(
      toJson({
        file,
        ok: report.ok,
        summary,
        manifest,
        findings: report.findings,
      }),
    );
    return report.ok ? EXIT.ok : EXIT.invalid;
  }

  io.out(`${summary.name}  (${summary.kind}, formatVersion ${summary.formatVersion})`);
  io.out(`  id         ${summary.id}`);
  io.out(`  created    ${summary.createdAt}`);
  io.out(`  license    ${summary.license}`);
  io.out(`  generator  ${summary.generator}`);
  if (summary.description !== undefined) io.out(`  about      ${summary.description}`);
  if (summary.tags !== undefined) io.out(`  tags       ${summary.tags.join(', ')}`);

  io.out('');
  io.out('contents:');
  for (const line of formatCounts(report)) io.out(line);
  io.out(`  ${'bytes'.padEnd(14)} ${manifest.contents.bytes}`);

  io.out('');
  io.out(`entries (${manifest.entries.length}):`);
  for (const line of formatEntries(report)) io.out(line);

  const assets = manifest.assets ?? [];
  if (assets.length > 0) {
    io.out('');
    io.out(`assets (${assets.length}):`);
    for (const asset of assets) {
      io.out(`  ${asset.kind.padEnd(10)} ${asset.width}x${asset.height}  ${asset.path}`);
    }
  }

  if (!report.ok) {
    io.out('');
    for (const line of formatFindings(report.findings)) io.out(line);
  }
  return report.ok ? EXIT.ok : EXIT.invalid;
}

/* ───────────────────────────────── unpack ───────────────────────────────── */

export interface UnpackOptions extends CommonOptions {
  readonly force: boolean;
}

export async function runUnpack(
  file: string,
  target: string,
  options: UnpackOptions,
  io: CliIo,
): Promise<number> {
  const bytes = await readArchive(file, io);
  if (bytes === undefined) return EXIT.io;

  const result = await unpackPackage(bytes);
  if (!result.report.ok || result.manifestBytes === undefined) {
    if (options.json) {
      io.out(toJson({ file, target, ok: false, findings: result.report.findings }));
    } else {
      for (const line of formatFindings(result.report.findings)) io.err(line);
      io.err(`${file}: refused, nothing was written`);
    }
    return EXIT.invalid;
  }

  const root = resolve(target);
  const planned = [{ path: 'manifest.json', bytes: result.manifestBytes }, ...result.files];

  // Defence in depth: the reader already rejects traversal, and this makes it
  // impossible for a future refactor to turn that into a write outside `root`.
  for (const plannedFile of planned) {
    const destination = resolve(join(root, plannedFile.path));
    if (destination !== root && !destination.startsWith(root + sep)) {
      io.err(`stpack: refusing to write outside ${root}: ${plannedFile.path}`);
      return EXIT.invalid;
    }
  }

  try {
    await mkdir(root, { recursive: true });
    for (const plannedFile of planned) {
      const destination = resolve(join(root, plannedFile.path));
      if (!options.force && (await exists(destination))) {
        io.err(`stpack: ${plannedFile.path} already exists (pass --force to overwrite)`);
        return EXIT.io;
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, plannedFile.bytes);
    }
  } catch (cause) {
    io.err(`stpack: cannot write into ${root}: ${messageOf(cause)}`);
    return EXIT.io;
  }

  if (options.json) {
    io.out(toJson({ file, target: root, ok: true, files: planned.map((entry) => entry.path) }));
  } else {
    io.out(`${root}: wrote ${planned.length} file(s)`);
    for (const plannedFile of planned) io.out(`  ${plannedFile.path}`);
  }
  return EXIT.ok;
}

/* ───────────────────────────────── import ───────────────────────────────── */

export interface ImportOptions extends CommonOptions {
  /** Validate and report, but never write the library file. */
  readonly dryRun: boolean;
  /** Categories to import; everything else is reported as skipped. */
  readonly only?: readonly string[];
}

/**
 * Turn `--select a,b` into the importer's selection map.
 *
 * The importer's map is "false means skip", so an allow-list is expressed by
 * setting every OTHER category to `false`: that keeps one meaning of the map
 * (`undefined`/`true` = import) instead of two conventions to get wrong. An
 * unknown name returns `undefined`, which the caller reports as a usage error.
 */
export function parseSelection(
  only: readonly string[] | undefined,
): Partial<Record<PayloadCategory, boolean>> | undefined {
  if (only === undefined || only.length === 0) return {};
  const wanted = new Set(only);
  for (const name of wanted) {
    if (!(PAYLOAD_CATEGORIES as readonly string[]).includes(name)) return undefined;
  }
  const selection: Partial<Record<PayloadCategory, boolean>> = {};
  for (const category of PAYLOAD_CATEGORIES) selection[category] = wanted.has(category);
  return selection;
}

/**
 * Import a package into a JSON library, then print the report (`docs/04` §7 steps
 * 7–9). The library is loaded, imported into memory and only written on success —
 * so a refused package or a failed write leaves the file exactly as it was.
 */
export async function runImport(
  file: string,
  libraryPath: string,
  options: ImportOptions,
  io: CliIo,
): Promise<number> {
  const bytes = await readArchive(file, io);
  if (bytes === undefined) return EXIT.io;

  const selection = parseSelection(options.only);
  if (selection === undefined) {
    io.err(`stpack: --select must name payload categories: ${PAYLOAD_CATEGORIES.join(', ')}`);
    return EXIT.usage;
  }

  let library: JsonLibraryStorage;
  try {
    library = await JsonLibraryStorage.load(libraryPath);
  } catch (cause) {
    io.err(`stpack: cannot read ${libraryPath}: ${messageOf(cause)}`);
    return EXIT.io;
  }

  let report: ImportReport;
  try {
    report = await importPackage(bytes, {
      // The wiring this package cannot do for itself: the real container lives in
      // `@smarttavern/packages` and `@smarttavern/importers` may not import it.
      reader: createPackageReader(),
      validator: createPackageValidator(),
      storage: library,
      select: selection,
    });
  } catch (cause) {
    // A storage failure is I/O, not a package finding; the transaction rolled back.
    io.err(`stpack: import failed, ${libraryPath} was not modified: ${messageOf(cause)}`);
    return EXIT.io;
  }

  if (report.ok && !options.dryRun) {
    try {
      await library.save(libraryPath);
    } catch (cause) {
      io.err(`stpack: cannot write ${libraryPath}: ${messageOf(cause)}`);
      return EXIT.io;
    }
  }

  if (options.json) {
    io.out(
      toJson({
        file,
        library: libraryPath,
        dryRun: options.dryRun,
        ok: report.ok,
        package: report.package,
        counts: report.counts,
        entities: report.entities,
        findings: report.findings,
        librarySizes: library.sizes(),
      }),
    );
    return report.ok ? EXIT.ok : EXIT.invalid;
  }

  for (const line of formatImportReport(report, file, libraryPath, options.dryRun)) io.out(line);
  if (!options.dryRun && report.ok) {
    io.out('');
    io.out(`library contents (${libraryPath}):`);
    for (const line of formatLibrarySizes(library.sizes())) io.out(line);
  }
  return report.ok ? EXIT.ok : EXIT.invalid;
}
