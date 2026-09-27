/**
 * In-memory `StorageAdapter` for this package's tests.
 *
 * WHY NOT `@smarttavern/core`'s DOUBLE: `packages/core`'s `ports/mock` is not
 * reachable from another workspace. `packages/core/src/ports/index.ts` re-exports
 * the port CONTRACTS only (its comment claims `./ports/mock` stays reachable
 * "through the barrel", but the barrel does not re-export it), and
 * `packages/core/package.json` exposes `"."` alone — so `@smarttavern/core/ports/mock`
 * does not resolve either. `packages/core` is outside this task's write scope, so
 * this is the honest alternative, and it lives in `src/` for the same reason core's
 * doubles do: a test-only folder is not importable across workspaces.
 *
 * IT MIRRORS THE PORT'S DOCUMENTED SEMANTICS, because the import's atomicity claim
 * rests on them: a transaction ROLLS BACK when its callback throws, and rows are
 * deep-copied in and out so a caller cannot mutate committed state by keeping a
 * reference. Index names are ignored (this is a linear scan) exactly as the port
 * says a caller must not depend on.
 *
 * TWO HOOKS A REAL ADAPTER HAS NO REASON TO EXPOSE:
 *   - `touched` records every collection a code path opened. `docs/04` §12 item 11
 *     needs to prove the export path cannot reach `settings`, and "it never called
 *     the collection" is a stronger statement than "the key was not in the bytes".
 *   - `failOn` injects a write error mid-`putMany`, so "a failed import leaves the
 *     storage untouched" is tested against a HALF-WRITTEN transaction (the case a
 *     validation failure cannot reach), not only against a refusal.
 */

import {
  type Collection,
  type CollectionName,
  type Query,
  RANGE_BOUND_NOT_COMPARABLE_MESSAGE,
  RANGE_FIELD_REQUIRED_MESSAGE,
  type RowBase,
  type StorageAdapter,
  StorageQueryError,
  type Tx,
} from '@smarttavern/core';
import type { Id } from '@smarttavern/schema';

/** Raised for a write this double refuses (see `failOn`). */
export class MemoryStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryStorageError';
  }
}

/** The injected failure: which collection, which method. */
export interface MemoryStorageFailure {
  readonly collection: CollectionName;
  readonly method: 'put' | 'putMany';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asRecord(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

/** Structural, order-insensitive match for the `where` selector values. */
function matches(candidate: unknown, expected: unknown): boolean {
  if (Object.is(candidate, expected)) return true;
  if (candidate === null || expected === null) return false;
  if (typeof candidate !== 'object' || typeof expected !== 'object') return false;
  return JSON.stringify(candidate) === JSON.stringify(expected);
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : 1;
  return 0;
}

class MemoryCollection<T extends RowBase> implements Collection<T> {
  constructor(
    private readonly name: CollectionName,
    private readonly store: MemoryStorageAdapter,
  ) {}

  async get(id: Id): Promise<T | undefined> {
    const row = this.store.rowsOf(this.name).get(id);
    return row === undefined ? undefined : clone(row as T);
  }

  async list(query?: Query<T>, index?: string): Promise<T[]> {
    void index;
    return this.select(query).map((row) => clone(row as T));
  }

  async put(row: T): Promise<T> {
    this.store.failBefore(this.name, 'put');
    const stored = clone(row);
    this.store.rowsOf(this.name).set(stored.id, stored);
    return clone(stored);
  }

  /**
   * Writes one row at a time and re-checks the injected failure after each, so a
   * `putMany` failure happens with part of the batch already in the store — the
   * case a rollback has to undo.
   */
  async putMany(rows: readonly T[]): Promise<T[]> {
    const stored: T[] = [];
    for (const row of rows) {
      this.store.failBefore(this.name, 'putMany');
      const saved = clone(row);
      this.store.rowsOf(this.name).set(saved.id, saved);
      stored.push(clone(saved));
    }
    return stored;
  }

  async update(id: Id, patch: Partial<T>): Promise<T> {
    const existing = this.store.rowsOf(this.name).get(id);
    if (existing === undefined) {
      throw new MemoryStorageError(`cannot update ${id}: row does not exist`);
    }
    const next = { ...clone(existing), ...clone(patch) } as RowBase;
    this.store.rowsOf(this.name).set(id, next);
    return clone(next as T);
  }

  async remove(id: Id): Promise<void> {
    this.store.rowsOf(this.name).delete(id);
  }

  async count(query?: Query<T>): Promise<number> {
    return this.select(query).length;
  }

  private select(query?: Query<T>): RowBase[] {
    let rows = [...this.store.rowsOf(this.name).values()];

    const where = query?.where;
    if (where !== undefined) {
      rows = rows.filter((row) =>
        Object.keys(where).every((key) => matches(asRecord(row)[key], asRecord(where)[key])),
      );
    }

    if (query?.from !== undefined || query?.to !== undefined) {
      for (const bound of [query.from, query.to]) {
        if (bound !== undefined && typeof bound !== 'number' && typeof bound !== 'string') {
          throw new StorageQueryError(RANGE_BOUND_NOT_COMPARABLE_MESSAGE, query);
        }
      }
      const field = query.field;
      if (field === undefined) throw new StorageQueryError(RANGE_FIELD_REQUIRED_MESSAGE, query);
      rows = rows.filter((row) => {
        const value = asRecord(row)[field];
        if (value === undefined) return false;
        if (query.from !== undefined && compare(value, query.from) < 0) return false;
        if (query.to !== undefined && compare(value, query.to) > 0) return false;
        return true;
      });
    }

    if (query?.order === 'desc') rows.reverse();
    const offset = query?.offset ?? 0;
    const end = query?.limit === undefined ? undefined : offset + query.limit;
    return rows.slice(offset, end);
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<CollectionName, Map<Id, RowBase>>();

  /** Every collection a caller opened, in order, duplicates included. */
  readonly touched: CollectionName[] = [];

  /** Transactions started — "as few as the port allows" is asserted with this. */
  transactionCount = 0;

  /** When set, a write to this collection throws (see the file header). */
  failOn: MemoryStorageFailure | undefined;

  async transaction<TResult>(fn: (tx: Tx) => Promise<TResult>): Promise<TResult> {
    this.transactionCount += 1;
    // Rows are replaced, never mutated, so sharing the row objects is enough to
    // make the snapshot a real rollback point.
    const snapshot = new Map<CollectionName, Map<Id, RowBase>>(
      [...this.store].map(([name, rows]) => [name, new Map(rows)]),
    );

    const tx: Tx = {
      collection: <TRow extends RowBase>(name: CollectionName): Collection<TRow> => {
        this.touched.push(name);
        return new MemoryCollection<TRow>(name, this);
      },
    };

    try {
      return await fn(tx);
    } catch (error) {
      this.store = snapshot;
      throw error;
    }
  }

  /* ─────────────────────────── test conveniences ────────────────────────── */

  /** Rows of a collection, bypassing transactions (assertions only). */
  peek<TRow extends RowBase>(name: CollectionName): readonly TRow[] {
    return [...this.rowsOf(name).values()] as TRow[];
  }

  /** Row count of a collection without a transaction. */
  size(name: CollectionName): number {
    return this.rowsOf(name).size;
  }

  /** Drop everything, including the collections created so far. */
  reset(): void {
    this.store = new Map();
    this.touched.length = 0;
    this.transactionCount = 0;
    this.failOn = undefined;
  }

  /**
   * Seeded rows for a fixture; bypasses `failOn` on purpose. Generic in the row
   * type so a caller can seed a `settings` row (`{id, value}`) or any other
   * shape a test needs, not just the entities the ports name.
   */
  seed<TRow extends RowBase>(name: CollectionName, rows: readonly TRow[]): void {
    for (const row of rows) this.rowsOf(name).set(row.id, clone(row));
  }

  /** @internal — the write hooks the port does not have. */
  failBefore(name: CollectionName, method: 'put' | 'putMany'): void {
    if (this.failOn?.collection === name && this.failOn.method === method) {
      throw new MemoryStorageError(`injected ${method} failure on ${name}`);
    }
  }

  /** @internal */
  rowsOf(name: CollectionName): Map<Id, RowBase> {
    let rows = this.store.get(name);
    if (rows === undefined) {
      rows = new Map();
      this.store.set(name, rows);
    }
    return rows;
  }
}
