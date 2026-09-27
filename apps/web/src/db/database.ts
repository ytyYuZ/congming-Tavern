/**
 * The ONE module that owns the app's `StorageAdapter` (M0-T8, ADR-017) and the
 * reactive-read seam over it.
 *
 * WHY ONE MODULE OWNS THE INSTANCE
 * A Dexie database is one IndexedDB connection per name, and two `Dexie` objects
 * for the same name fight over the schema version (Dexie closes one of them with
 * "another connection wants to upgrade the database"). So the adapter is built
 * once, here, and every caller — settings, sessions, messages, a reload — reaches
 * the same handle.
 *
 * WHY READS AND WRITES GO THROUGH DIFFERENT DOORS (measured, not assumed)
 * ADR-017 makes Dexie's `liveQuery` the reactive-read mechanism, and `liveQuery`
 * runs its querier inside a READ-ONLY Dexie transaction. `StorageAdapter.transaction`
 * opens `rw`, so a querier that called it is aborted with
 * `ReadOnlyError: Readwrite transaction in liveQuery context` and the subscription
 * **never emits at all** — in a browser that is a transcript that silently stops
 * updating. `Dexie.liveQuery` is also a module-level API driven by global
 * `storagemutated` events, so it cannot be scoped to a private instance either.
 *
 * The escape hatch therefore lives in `packages/storage` as
 * `IndexedDbStorage.db` (the port itself is untouched), and the rule it comes with
 * is enforced by this module's shape:
 *   - WRITES: `storage.transaction(...)`, one transaction each, because docs/02
 *     §5.3 requires every state change to be atomic.
 *   - READS for a subscription: `storage.db.table(name)`, which is what `liveQuery`
 *     already opens a read-only transaction around. Reading `db` outside a
 *     subscription is fine too — it is the same table — but nothing may WRITE
 *     through it, which is why `storage` is not exported from here and only the
 *     write helper below is.
 *
 * THE DATABASE IS OPENED LAZILY. Dexie connects on the first operation, so
 * importing this module touches no IndexedDB — which is what lets it be imported
 * in Node before `fake-indexeddb` has loaded.
 */
import type { IndexedDbStorage } from '@smarttavern/storage';
import { createIndexedDbStorage, DATABASE_NAME } from '@smarttavern/storage';
import { liveQuery, type Observable } from 'dexie';

let storage: IndexedDbStorage = createIndexedDbStorage({ name: DATABASE_NAME });

/** Which database is open. Diagnostics; no query uses it. */
export function databaseName(): string {
  return storage.db.name;
}

/**
 * Open a FRESH adapter over `name` — the test seam, and the "restart" seam.
 *
 * Calling it twice with the same name is exactly the restart acceptance test: a new
 * adapter over the same IndexedDB database sees the rows the first one wrote. A
 * browser reload does not need it, because the default name is what makes "restart
 * and the data is still there" true.
 *
 * CLOSING FIRST IS REQUIRED: two open connections to one IndexedDB name block each
 * other's version check, and Dexie reports that as a schema conflict rather than as
 * the test's own mistake.
 */
export function resetDatabase(name: string): void {
  storage.db.close();
  storage = createIndexedDbStorage({ name });
}

/**
 * Close the open connection.
 *
 * Needed by tests, which open a database per case and must not leave the connection
 * holding an IndexedDB delete open; `resetDatabase` closes as well, so a caller that is
 * switching names does not need this first.
 */
export function closeDatabase(): void {
  storage.db.close();
}

/**
 * Run one write inside one transaction.
 *
 * Every write in the app goes through here, so `db.transaction` is the single
 * write path and `storage.db` stays a read-only door (see the file header). The
 * callback receives the port's `Tx`, so the repository keeps speaking the port's
 * vocabulary instead of Dexie's.
 */
export function write<T>(
  fn: (tx: Parameters<Parameters<IndexedDbStorage['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  // The port's `transaction<T>` is generic over its RESULT, and that type parameter is
  // not recoverable from the callback's parameter list alone. The cast is confined to
  // this one line and is exactly the port's own contract ("the value `fn` resolves to").
  return storage.transaction(fn) as Promise<T>;
}

/**
 * The Dexie table a reactive read uses.
 *
 * A separate function rather than an exported `db` on purpose: the only thing this
 * module wants callers to do with the raw instance is read one table, and an
 * exported instance invites the write that the file header forbids.
 */
export function readTable<T>(name: string) {
  return storage.db.table<T, string>(name);
}

/**
 * Subscribe to the result of a read, re-emitted whenever any table that read
 * touched changes.
 *
 * The callback is the whole point: the repository owns WHAT to read (the active
 * message chain, the session list) and this function only owns HOW Dexie reports
 * that it changed. `unsubscribe` is returned rather than an object so a React
 * effect can return it directly.
 */
export function subscribe<T>(
  read: () => Promise<T>,
  onNext: (value: T) => void,
  onError?: (error: unknown) => void,
): () => void {
  const observable: Observable<T> = liveQuery(read);
  const subscription = observable.subscribe({
    next: onNext,
    ...(onError === undefined ? {} : { error: onError }),
  });
  return () => subscription.unsubscribe();
}
