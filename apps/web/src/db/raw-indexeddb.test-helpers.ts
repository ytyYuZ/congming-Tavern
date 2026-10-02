/**
 * Reading what is ACTUALLY on disk, for the invariant-6 suites (M1-G3).
 *
 * WHY THIS EXISTS AS A SHARED HELPER
 * Suites need the same primitive: "give me every row of every collection, as text". It
 * was written once inside `chat/send-turn.test.ts` and the migration proof needs it too, so
 * it lives here rather than in two copies — the two suites must not be able to disagree
 * about what "on disk" means. M1-M2's fork added the second shape of the same question — "every
 * row ONE SESSION owns" — because a fork writes a new session into the same database and the
 * invariant is about the origin's rows rather than about the total (`sessionRows` below).
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
import { COLLECTIONS } from '@smarttavern/core';

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

/**
 * Every row ONE SESSION owns, serialised — read through the raw IndexedDB API.
 *
 * WHY THIS IS A DIFFERENT PRIMITIVE FROM `snapshotAllRows` (M1-M2)
 * The invariant "the timeline a fork came from is untouched" cannot be asserted over the WHOLE
 * database: a fork writes a new session into the same one, so the total can never be equal
 * before and after. What must not move is the ORIGIN's own rows, and the way to name them is the
 * field every one of them carries — `Session.id`, and `sessionId` on the rows that belong to a
 * session. Selecting by it and comparing the bytes is the assertion; a whole-database dump would
 * have to be filtered by hand at every call site, which is how a test ends up asserting less than
 * it says.
 *
 * It goes through the raw API for the reason this file's header gives (a repository read parses
 * rows into shapes and drops unknown fields, so it could not see a stray byte), and it takes the
 * four collections a session OWNS: its row, its messages, its save points and its turn plans.
 */
export async function sessionRows(name: string, sessionId: string): Promise<string> {
  const database = await openRaw(name);
  try {
    const rows: unknown[] = [];
    for (const collection of SESSION_COLLECTIONS) {
      for (const row of await rowsOf(database, collection)) {
        if (fieldOf(row, 'id') === sessionId || fieldOf(row, 'sessionId') === sessionId) {
          rows.push(row);
        }
      }
    }
    return JSON.stringify(rows);
  } finally {
    database.close();
  }
}

/**
 * The collections a session owns. Named through the port's own constants rather than as string
 * literals, so a rename of a collection cannot leave this helper reading a store that no longer
 * exists (an empty result would make "untouched" pass trivially).
 */
const SESSION_COLLECTIONS = [
  COLLECTIONS.sessions,
  COLLECTIONS.messages,
  COLLECTIONS.checkpoints,
  COLLECTIONS.turnPlans,
] as const;

/** Every row of one collection, through the raw API. */
async function rowsOf(database: IDBDatabase, collection: string): Promise<unknown[]> {
  const transaction = database.transaction(collection, 'readonly');
  return request<unknown[]>(transaction.objectStore(collection).getAll());
}

/**
 * One field of a raw row, by name.
 *
 * A parameterised key is the spelling this workspace accepts for an index-signature read:
 * `noPropertyAccessFromIndexSignature` rejects dot access on `Record<string, unknown>` and
 * Biome's `useLiteralKeys` rejects the literal bracket form.
 */
function fieldOf(row: unknown, field: string): unknown {
  if (row === null || typeof row !== 'object') return undefined;
  return (row as Record<string, unknown>)[field];
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
