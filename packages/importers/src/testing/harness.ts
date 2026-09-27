/**
 * Shared test harness for the import/export suites: one fixed clock, one fixed
 * package id, one deterministic id sequence, and the three calls every suite makes
 * (export a session, import bytes, read one payload back out).
 *
 * WHY A HARNESS AND NOT THREE COPIES: the acceptance clauses (`docs/04` §12 items
 * 8–12) and the round-trip/atomicity/secrets suites must all speak about the SAME
 * package, or "it round-trips" and "the clock is restored" become claims about
 * different archives. Literal ids and a frozen clock also mean an expectation in a
 * test can be read off the fixture instead of being recomputed.
 *
 * NOTHING HERE IS A REAL IMPLEMENTATION: the reader/writer come from
 * `memory-package.ts` (the real container lives in `@smarttavern/packages`, which
 * this package may not import) and the storage is `memory-storage.ts`.
 */
import type { CollectionName, PackageValidator, StorageAdapter } from '@smarttavern/core';
import type { PackageManifest, UuidV7 } from '@smarttavern/schema';
import { type ExportResult, exportSessionPackage } from '../export-package';
import { importPackage } from '../import-package';
import type { ImportOptions, ImportReport, PayloadCategory } from '../index';
import {
  decodeContainer,
  MemoryPackageReader,
  MemoryPackageValidator,
  MemoryPackageWriter,
} from './memory-package';
import { MemoryStorageAdapter } from './memory-storage';

/** The frozen `createdAt` of every package the tests build. */
export const FIXED_TIME = new Date('2026-09-27T10:00:00.000Z');

/** The package's own manifest id: a literal, so a report can be read by eye. */
export const PACKAGE_ID: UuidV7 = '0192f0a1-9999-7000-8000-000000000001';

/**
 * A deterministic UUIDv7 sequence, so a remapped id is a literal in the
 * expectation rather than "some id" (and `docs/04` §4 still holds: every minted id
 * is a valid UUIDv7).
 */
export function sequenceMinter(start = 1): () => UuidV7 {
  let next = start;
  return () => {
    const value = `0192f0a1-9999-7000-8000-${String(next).padStart(12, '0')}` as UuidV7;
    next += 1;
    return value;
  };
}

/** A writer with a frozen clock and the fixed package id. */
export function memoryWriter(now: Date = FIXED_TIME): MemoryPackageWriter {
  return new MemoryPackageWriter({ now: () => now, mintId: () => PACKAGE_ID });
}

export interface ExportOptions {
  readonly sessionId?: string;
  readonly writer?: MemoryPackageWriter;
  readonly id?: UuidV7;
  readonly license?: string;
}

/** Export one session with the fixture clock and package id pinned. */
export async function exportSession(
  storage: StorageAdapter,
  options: ExportOptions = {},
): Promise<ExportResult> {
  return exportSessionPackage({
    kind: 'session',
    storage,
    writer: options.writer ?? memoryWriter(),
    id: options.id ?? PACKAGE_ID,
    sessionId: options.sessionId ?? '0192f0a1-4444-7000-8000-000000000001',
    ...(options.license === undefined ? {} : { license: options.license }),
  });
}

export interface ImportHarnessOptions {
  readonly mintId?: () => UuidV7;
  readonly validator?: PackageValidator;
  readonly select?: Partial<Record<PayloadCategory, boolean>>;
  readonly reader?: MemoryPackageReader;
}

/** Import bytes into a storage with the deterministic minter and the double reader. */
export async function importInto(
  storage: StorageAdapter,
  bytes: Uint8Array,
  options: ImportHarnessOptions = {},
): Promise<ImportReport> {
  const importOptions: ImportOptions = {
    reader: options.reader ?? new MemoryPackageReader(),
    storage,
    validator: options.validator ?? new MemoryPackageValidator(),
    mintId: options.mintId ?? sequenceMinter(),
    now: () => FIXED_TIME,
    ...(options.select === undefined ? {} : { select: options.select }),
  };
  return importPackage(bytes, importOptions);
}

/** One payload file out of a memory package, parsed back into a value. */
export function payloadOf(bytes: Uint8Array, path: string): unknown {
  const file = decodeContainer(bytes).get(path);
  if (file === undefined) throw new Error(`the package has no ${path}`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file));
}

/**
 * Rebuild a package with one payload replaced, keeping the manifest's identity and
 * declarations. This is how a test creates a package that is structurally fine but
 * wrong in exactly one way (a `state.json` no checkpoint agrees with, a payload
 * that is valid JSON but not an entity) WITHOUT hand-building an archive — the
 * manifest is re-derived, so a test cannot accidentally pass on a checksum error.
 */
export async function repackage(
  bytes: Uint8Array,
  patch: (files: Map<string, Uint8Array>) => void,
): Promise<Uint8Array> {
  const files = decodeContainer(bytes);
  const manifestBytes = files.get('manifest.json');
  if (manifestBytes === undefined) throw new Error('the package has no manifest');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as {
    kind: PackageManifest['kind'];
    id: PackageManifest['id'];
    name: string;
    createdAt: string;
    license: PackageManifest['license'];
    generator: PackageManifest['generator'];
    refs?: PackageManifest['refs'];
    schemaVersions: PackageManifest['schemaVersions'];
    description?: string;
    tags?: readonly string[];
  };

  patch(files);
  const entries = [...files]
    .filter(([path]) => path !== 'manifest.json')
    .map(([path, content]) => ({ path, bytes: content }));

  const result = await new MemoryPackageWriter({
    now: () => new Date(manifest.createdAt),
    mintId: () => manifest.id,
  }).write(entries, {
    kind: manifest.kind,
    id: manifest.id,
    name: manifest.name,
    createdAt: manifest.createdAt,
    license: manifest.license,
    generator: manifest.generator,
    schemaVersions: manifest.schemaVersions,
    ...(manifest.refs === undefined ? {} : { refs: manifest.refs }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    // `PackageManifest.tags` is `string[]`, not `readonly string[]` — the published
    // schema is the frozen contract, so the copy is made here.
    ...(manifest.tags === undefined ? {} : { tags: [...manifest.tags] }),
  });
  return result.bytes;
}

/** Every file of a memory package, as UTF-8 text — what a static scan looks at. */
export function containerText(bytes: Uint8Array): string {
  let text = '';
  for (const [path, content] of decodeContainer(bytes)) {
    text += `${path}\n${new TextDecoder('utf-8').decode(content)}\n`;
  }
  return text;
}

/** A fresh empty library plus the seeded one, side by side. */
export function emptyLibrary(): MemoryStorageAdapter {
  return new MemoryStorageAdapter();
}

/** Rows of a collection, for the short assertions a clause test needs. */
export function rowsOf<T extends { id: string }>(
  storage: MemoryStorageAdapter,
  name: CollectionName,
): readonly T[] {
  return storage.peek<T>(name);
}
