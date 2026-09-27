/**
 * The reactive-read seam (`IndexedDbStorage.db`) — M0-T8.
 *
 * WHY THIS FILE EXISTS: ADR-017 makes Dexie's `liveQuery` the way the UI observes
 * the database. But `liveQuery` runs its querier inside a READ-ONLY Dexie
 * transaction, and `StorageAdapter.transaction()` opens `rw` over every table — so
 * the PORT cannot serve a reactive read at all. Called from a querier it throws
 * `ReadOnlyError: Readwrite transaction in liveQuery context` and the subscription
 * never emits a value: in a browser that is a chat transcript that silently stops
 * updating, i.e. exactly the kind of silent wrong answer ADR-023 / ADR-024 exist to
 * eliminate. `Dexie.liveQuery` is also a module-level API over global
 * `storagemutated` events, so it cannot be scoped to a private instance either.
 *
 * The two tests below are the two halves of the answer:
 *   1. the failure is PINNED, so nobody "simplifies" the seam away without seeing
 *      why it is there (if a future Dexie allows a write transaction in a querier,
 *      this test turns red and the seam can be reconsidered deliberately);
 *   2. the property the UI actually needs is PINNED — a row written through the
 *      adapter is observed by a subscriber on the shared instance.
 *
 * `fake-indexeddb/auto` supplies IndexedDB; no jsdom is involved.
 */
import 'fake-indexeddb/auto';
import { COLLECTIONS, type RowBase } from '@smarttavern/core';
import type { Id } from '@smarttavern/schema';
import { liveQuery } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { createIndexedDbStorage, type IndexedDbStorage } from './adapter';

/* ─────────────────────────────── harness ─────────────────────────────────── */

let dbCounter = 0;
const opened: IndexedDbStorage[] = [];

/**
 * A storage adapter over its OWN database name. `fake-indexeddb` keeps databases
 * for the whole process, so sharing one name would let an earlier test's rows show
 * up in a later test's `toArray()`.
 */
function freshStorage(): IndexedDbStorage {
  dbCounter += 1;
  const storage = createIndexedDbStorage({ name: `smarttavern-live-query-${dbCounter}` });
  opened.push(storage);
  return storage;
}

afterEach(async () => {
  for (const storage of opened.splice(0)) await storage.db.delete();
});

/**
 * Only the id matters here: this file is about transaction modes, not entity
 * validity (`adapter.test.ts` is where real schema entities go through the port).
 */
function row(id: string): RowBase {
  return { id: id as Id };
}

/** Poll until `predicate` holds, then fail LOUDLY rather than hang the suite. */
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after 2s: ${message}`);
}

/* ─────────────────────────────── tests ───────────────────────────────────── */

describe('IndexedDbStorage.db — the reactive-read seam', () => {
  it('proves the PORT cannot serve it: transaction() inside a liveQuery querier errors', async () => {
    const storage = freshStorage();
    const values: unknown[] = [];
    const errors: unknown[] = [];

    const subscription = liveQuery(() =>
      storage.transaction((tx) => tx.collection(COLLECTIONS.sessions).list()),
    ).subscribe({
      next: (rows) => values.push(rows),
      error: (error: unknown) => errors.push(error),
    });

    await until(
      () => errors.length > 0 || values.length > 0,
      'liveQuery neither emitted nor errored',
    );

    // The alarm, not the assertion: if this ever passes with a value, Dexie started
    // tolerating a write transaction inside a querier and this seam can go away.
    expect(values, 'the port unexpectedly served a reactive read').toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/readonly|read-only/i);

    subscription.unsubscribe();
  });

  it('serves it: a write through the adapter is observed by a subscriber on `db`', async () => {
    const storage = freshStorage();
    const emissions: string[][] = [];
    const errors: unknown[] = [];

    const subscription = liveQuery(() =>
      storage.db.table<RowBase>(COLLECTIONS.sessions).toArray(),
    ).subscribe({
      next: (rows) => emissions.push(rows.map((r) => r.id)),
      error: (error: unknown) => errors.push(error),
    });

    // The initial value arrives before any write — that is what makes a UI render
    // "empty" instead of "loading forever".
    await until(() => emissions.length > 0, 'liveQuery never emitted an initial value');
    expect(emissions[0]).toEqual([]);

    await storage.transaction((tx) =>
      tx.collection<RowBase>(COLLECTIONS.sessions).put(row('live-query-row')),
    );

    await until(
      () => emissions.at(-1)?.includes('live-query-row') === true,
      'the row written through the adapter was never observed',
    );
    expect(errors).toEqual([]);

    subscription.unsubscribe();
  });
});
