/**
 * Reading what is ACTUALLY on disk, for the invariant-6 suites (M1-G3).
 *
 * WHY THIS EXISTS AS A SHARED HELPER
 * Two suites need the same primitive: "give me every row of every collection, as text". It
 * was written once inside `chat/send-turn.test.ts` and the migration proof needs it too, so
 * it lives here rather than in two copies — the two suites must not be able to disagree
 * about what "on disk" means.
 *
 * WHY THE RAW IndexedDB API AND NOT THE REPOSITORY
 * The whole point of these assertions is that they do not go through the reader that is
 * being trusted. `db/repository.ts` parses a row into a shape and drops unknown fields, so a
 * scan through it could not see a stray copy of a key in a field the parser ignores — which
 * is exactly the leak these tests exist to catch. This is what is actually in the database.
 *
 * WHY THE FILE HAS NO `.test.` IN ITS NAME
 * It is not a suite; it is imported BY suites. The name still contains `.test.` so the same
 * tsconfig rule that keeps test files out of the app's build graph keeps this out of it too
 * (`apps/web/tsconfig.json` excludes `src/**\/*.test.*`), while
 * `apps/web/tsconfig.test.json` typechecks it with them.
 */

/** Every row of every collection in `name`, serialised. One string, one comparison. */
export async function snapshotAllRows(name: string): Promise<string> {
  const database = await openRaw(name);
  try {
    const names = Array.from(database.objectStoreNames);
    const rows: unknown[] = [];
    for (const collection of names) {
      const transaction = database.transaction(collection, 'readonly');
      rows.push(...(await request<unknown[]>(transaction.objectStore(collection).getAll())));
    }
    return JSON.stringify(rows);
  } finally {
    database.close();
  }
}

/** The object stores the database actually has, for a scan that must be exhaustive. */
export async function collectionNames(name: string): Promise<string[]> {
  const database = await openRaw(name);
  try {
    return Array.from(database.objectStoreNames);
  } finally {
    database.close();
  }
}

/** Open the database by name without going through Dexie (or its schema version). */
export function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

/** One IDBRequest as a promise. */
export function request<T>(source: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result as T);
    source.onerror = () => reject(source.error);
  });
}

/**
 * Delete a database, resolving on every outcome.
 *
 * A test that fails mid-way can leave the connection open, and `deleteDatabase` then waits
 * forever instead of reporting the failure it was called from. Resolving on `onblocked` and
 * `onerror` keeps the real assertion the thing that fails.
 */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => resolve();
    deletion.onblocked = () => resolve();
  });
}
