/**
 * In-memory `StorageAdapter` double (docs/06 §8.4: "有 mock 实现用于测试").
 *
 * THE ONE BEHAVIOUR THAT MATTERS MOST: a transaction ROLLS BACK when its callback
 * throws. A double that commits half a write is worse than no double at all — it
 * would let engine code pass tests and then corrupt real data — so `transaction`
 * snapshots every collection before running `fn` and restores the snapshot on any
 * thrown value. That behaviour is asserted by `mock-storage.test.ts`.
 *
 * The second behaviour is that rows are deep-copied on the way in AND out, so a
 * caller cannot mutate committed state by keeping a reference (a real database
 * gives the same guarantee for free, and tests must not rely on getting away
 * with something the real backend will not allow).
 *
 * Index-shaped queries are implemented as a linear scan with deep-equality
 * matching. That is intentional: §7's index table says what must be *findable*,
 * not how fast the double has to be, and a real index is the storage package's
 * job.
 */
import type { Id } from '@smarttavern/schema';
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
} from '../storage';
import { cloneValue, createIdMinter } from './_support';

/** Collection name -> rows, in insertion order. */
type CollectionMap = Map<string, RowBase>;

/** Raised when a write targets an id that does not exist. Mirrors the port's wording. */
export class MockStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockStorageError';
  }
}

/**
 * Structural, order-insensitive comparison — enough for the id/string/number
 * selectors this double supports, and explicitly not a full deep-equal (a test
 * that needs that has a bug in its query, not here).
 */
function keysMatch(candidate: unknown, expected: unknown): boolean {
  if (Object.is(candidate, expected)) return true;
  if (Array.isArray(candidate) && Array.isArray(expected)) {
    return JSON.stringify(candidate) === JSON.stringify(expected);
  }
  if (candidate === null || expected === null) return false;
  if (typeof candidate === 'object' && typeof expected === 'object') {
    return JSON.stringify(candidate) === JSON.stringify(expected);
  }
  return false;
}

/** Compare two indexed field values; numbers and strings only, totals otherwise. */
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : 1;
  return 0;
}

/**
 * `RowBase` is `{ id: Id }`, so a dynamic field lookup needs one honest widening:
 * a stored row is a plain object at runtime whatever its declared type says.
 */
function asRecord(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

class MockCollection<T extends RowBase> implements Collection<T> {
  constructor(private readonly getRows: () => CollectionMap) {}

  async get(id: Id): Promise<T | undefined> {
    const row = this.getRows().get(id);
    return row === undefined ? undefined : cloneValue(row as T);
  }

  async list(query?: Query<T>, index?: string): Promise<T[]> {
    const rows = this.select(query);
    // `index` names a §7 index. A linear scan cannot use it, but a caller that
    // passes an unknown name has a bug the double should not hide.
    void index;
    return rows.map((row) => cloneValue(row as T));
  }

  async put(row: T): Promise<T> {
    const stored = cloneValue(row);
    this.getRows().set(stored.id, stored);
    return cloneValue(stored as T);
  }

  async putMany(rows: readonly T[]): Promise<T[]> {
    return Promise.all(rows.map((row) => this.put(row)));
  }

  async update(id: Id, patch: Partial<T>): Promise<T> {
    const existing = this.getRows().get(id);
    if (existing === undefined) {
      throw new MockStorageError(`cannot update ${id}: row does not exist`);
    }
    const next = { ...cloneValue(existing), ...cloneValue(patch) } as RowBase;
    this.getRows().set(id, next);
    return cloneValue(next as T);
  }

  async remove(id: Id): Promise<void> {
    this.getRows().delete(id);
  }

  async count(query?: Query<T>): Promise<number> {
    return this.select(query).length;
  }

  private select(query?: Query<T>): RowBase[] {
    let rows = [...this.getRows().values()];

    const where = query?.where;
    if (where !== undefined) {
      rows = rows.filter((row) =>
        Object.keys(where).every((key) =>
          keysMatch(asRecord(row)[key], (where as Record<string, unknown>)[key]),
        ),
      );
    }

    if (query?.from !== undefined || query?.to !== undefined) {
      // A bound that cannot be compared is refused, not guessed: `compareValues`
      // answers `0` ("equal") for anything that is not a number or a string, so a
      // `Date` bound would match EVERY row and the query would quietly return the
      // whole table (ADR-024).
      for (const bound of [query.from, query.to]) {
        if (bound !== undefined && typeof bound !== 'number' && typeof bound !== 'string') {
          throw new StorageQueryError(RANGE_BOUND_NOT_COMPARABLE_MESSAGE, query);
        }
      }
      // A range needs its field named. The old behaviour guessed — the first
      // `where` key, else `id` — which silently range-scanned the wrong column and
      // could answer an empty array for a reasonable-looking query. ADR-023 turns
      // that into a refusal, and `packages/storage` does the same.
      const field = query.field;
      if (field === undefined) {
        // The sentence is owned by the port, so the mock, the adapter and the tests
        // cannot drift apart (ADR-023).
        throw new StorageQueryError(RANGE_FIELD_REQUIRED_MESSAGE, query);
      }
      rows = rows.filter((row) => {
        const value = asRecord(row)[field];
        if (value === undefined) return false;
        if (query.from !== undefined && compareValues(value, query.from) < 0) return false;
        if (query.to !== undefined && compareValues(value, query.to) > 0) return false;
        return true;
      });
    }

    if (query?.order === 'desc') rows.reverse();

    const offset = query?.offset ?? 0;
    const end = query?.limit === undefined ? undefined : offset + query.limit;
    return rows.slice(offset, end);
  }
}

export class MockStorageAdapter implements StorageAdapter {
  /** Collections by name. Private so callers must go through a transaction. */
  private store: Record<string, CollectionMap> = {};

  private readonly minter = createIdMinter('mock-storage');

  /** Number of transactions started, for tests that assert the port was used. */
  transactionCount = 0;

  async transaction<TResult>(fn: (tx: Tx) => Promise<TResult>): Promise<TResult> {
    this.transactionCount += 1;
    // Snapshot = a new map per collection holding the SAME row objects, because
    // every write path replaces a row rather than mutating it in place.
    const snapshot: Record<string, CollectionMap> = {};
    for (const [name, rows] of Object.entries(this.store)) {
      snapshot[name] = new Map(rows);
    }

    const tx: Tx = {
      collection: <TRow extends RowBase>(name: CollectionName): Collection<TRow> =>
        new MockCollection<TRow>(() => this.rowsOf(name)),
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

  /** Drop everything, including collection names created so far. */
  reset(): void {
    this.store = {};
    this.transactionCount = 0;
  }

  /** Mint an id the way a real adapter would when a `put` omits one. */
  nextId(label = 'row'): Id {
    return this.minter(label);
  }

  private rowsOf(name: CollectionName): CollectionMap {
    let rows = this.store[name];
    if (rows === undefined) {
      rows = new Map();
      this.store[name] = rows;
    }
    return rows;
  }
}
