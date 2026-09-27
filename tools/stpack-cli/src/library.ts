/**
 * A file-backed `StorageAdapter` for the CLI, so `stpack import` has somewhere to
 * put a library.
 *
 * WHY THIS EXISTS AT ALL: the browser app stores rows in IndexedDB
 * (`packages/storage`), which Node does not have, and this project takes no new
 * dependencies — so a Node-hosted import needs a store. The format is the obvious
 * one: ONE JSON document, `{ "<collection>": [rows…] }`, which is also what makes
 * the CLI a usable demo of M1-M3 (`stpack import save.stpack library.json` twice
 * shows "reused", which is `docs/04` §12 item 9 with real bytes).
 *
 * IT DELEGATES THE SEMANTICS, AND THAT IS THE POINT: transaction rollback,
 * deep-copy-on-read/write and the port's query refusals come from
 * `MemoryStorageAdapter` (`@smarttavern/importers`). A CLI that re-implemented
 * them would be a fourth opinion about what a transaction means, and the import's
 * atomicity proof would stop applying to the store the CLI actually uses.
 *
 * THE FILE IS WRITTEN ATOMICALLY TOO: the caller imports into memory and only then
 * serialises, through a temp file plus a rename — so a crash (or a rejected
 * package) can never leave a half-written library behind.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  COLLECTIONS,
  type CollectionName,
  type RowBase,
  type StorageAdapter,
  type Tx,
} from '@smarttavern/core';
import { MemoryStorageAdapter } from '@smarttavern/importers';

/** The on-disk shape: collection name → rows. */
export type LibraryDocument = Record<string, RowBase[]>;

const COLLECTION_SET: ReadonlySet<string> = new Set<string>(Object.values(COLLECTIONS));

export class JsonLibraryStorage implements StorageAdapter {
  private readonly memory: MemoryStorageAdapter;

  private constructor(memory: MemoryStorageAdapter) {
    this.memory = memory;
  }

  /** An empty library. */
  static empty(): JsonLibraryStorage {
    return new JsonLibraryStorage(new MemoryStorageAdapter());
  }

  /** A library from a parsed document, ignoring unknown collection names. */
  static fromDocument(document: LibraryDocument): JsonLibraryStorage {
    const storage = JsonLibraryStorage.empty();
    for (const [name, rows] of Object.entries(document)) {
      if (!COLLECTION_SET.has(name)) continue;
      storage.memory.seed(name as CollectionName, rows);
    }
    return storage;
  }

  /**
   * Read a library file. A missing file is an EMPTY library — the first import is
   * how a library comes to exist — while an unreadable or malformed file is an
   * error the caller must report (silently starting empty would look like data
   * loss).
   */
  static async load(path: string): Promise<JsonLibraryStorage> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return JsonLibraryStorage.empty();
      throw cause;
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path} is not a library document (expected a JSON object of collections)`);
    }
    return JsonLibraryStorage.fromDocument(parsed as LibraryDocument);
  }

  /** Write the library to `path`, atomically (temp file + rename). */
  async save(path: string): Promise<void> {
    const document = this.toDocument();
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  /** The rows, by collection, with empty collections dropped. */
  toDocument(): LibraryDocument {
    const document: LibraryDocument = {};
    for (const name of Object.values(COLLECTIONS)) {
      const rows = this.memory.peek(name);
      if (rows.length > 0) document[name] = [...rows];
    }
    return document;
  }

  /** Row count per collection — what the CLI prints as the library summary. */
  sizes(): Record<string, number> {
    const sizes: Record<string, number> = {};
    for (const name of Object.values(COLLECTIONS)) {
      const count = this.memory.size(name);
      if (count > 0) sizes[name] = count;
    }
    return sizes;
  }

  /** Count of transactions started, so a caller can prove "one, atomic". */
  get transactionCount(): number {
    return this.memory.transactionCount;
  }

  /** Seeding hook (the same one the fixtures use), for tests and demos. */
  seed<TRow extends RowBase>(name: CollectionName, rows: readonly TRow[]): void {
    this.memory.seed(name, rows);
  }

  transaction<TResult>(fn: (tx: Tx) => Promise<TResult>): Promise<TResult> {
    return this.memory.transaction(fn);
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT'
  );
}
