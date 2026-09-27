/**
 * `StorageAdapter` on IndexedDB, via Dexie — `docs/06-开发任务拆解.md` §9.3, the
 * implementation behind contract #3 of `docs/02-技术架构.md` §13.
 *
 * WHY ONE DEXIE TRANSACTION PER `transaction()` CALL
 * The port's `transaction(fn)` is a callback precisely so a transaction cannot be
 * left open, and Dexie's async transaction API has the same shape: it commits when
 * the scope promise resolves and aborts when it rejects. So the two nest directly:
 * `transaction` opens a Dexie transaction over EVERY table, hands the callback a
 * `Tx` whose collections are bound to that Dexie transaction, and lets Dexie's own
 * abort path do the rollback. Scoping to all tables rather than to the ones the
 * callback touches is deliberate: `Tx.collection(name)` builds a handle lazily,
 * and Dexie rejects a table touched outside the transaction it was declared for,
 * so a narrower scope would need to inspect a callback the adapter cannot see into.
 *
 * WHAT "ROLLBACK" MEANS HERE
 * Nothing in this file restores a snapshot. IndexedDB aborts the whole transaction
 * on a thrown error, and the abort is atomic across every table in the scope —
 * which is why the rollback test asserts that *at least two* collections (a create
 * and an update) go back to their previous state. See `adapter.test.ts`.
 *
 * THE TWO GAPS THE PORT LEAVES, AND HOW THEY ARE FILLED
 * 1. THE PRIMARY KEY. `Collection<T>` addresses rows by `RowBase.id`, so `id` is
 *    the primary key of every table (`indexeddb/schema.ts` argues this in full).
 *    §7 keys two collections otherwise — `settings` by `key`, `migrations` by
 *    `version` — and the port gives `Collection<T>` no way to say so: there is no
 *    `getBy`. ADR-022 settled that in the port's favour rather than adding one:
 *    **`settings` and `migrations` are keyed by `id` too**, holding the config key
 *    and the version number respectively, so the whole port keeps ONE addressing
 *    rule. This adapter therefore treats `id` as the key everywhere, and
 *    `adapter.test.ts` pins both row shapes (ADR-022) so the convention cannot
 *    regress into an undocumented deviation again.
 * 2. ROW SHAPE. `put` requires an `id` and the adapter never mints one. The mock's
 *    `nextId()` is a *test convenience*, not port surface; an adapter inventing
 *    ids would make "the returned row is the row you wrote" untrue.
 *
 * HOW A `Query` IS ANSWERED
 * The port's `Query` is "a plain equality map on `where` plus optional bounds on
 * the indexed field(s)", and `list(query, index?)`'s `index` "names an entry of
 * `INDEXES[collection]`". Three decisions, none of them specified by the port:
 * 1. `index` is VALIDATED and used as a hint, never trusted. It must name a
 *    declared §7 index or the call throws — a typo must be loud rather than
 *    silently degrade into a full scan. When it names an index whose key path can
 *    answer the whole `where` map, that index does the lookup.
 * 2. Equality otherwise uses ANY declared index that answers the whole `where`
 *    map, because `where` is documented as "matched against the indexed fields".
 *    A compound index is only usable when every field it covers is constrained
 *    (Dexie throws on a short tuple rather than narrowing), and a multi-valued
 *    index is never used for equality: `equals(['a','b'])` on a multi-entry index
 *    means "contains a OR b", while `where` means "this value". When no index
 *    answers, the table is scanned and the constraints are matched with the same
 *    structural equality the mock uses (`valuesMatch`), so results are correct
 *    rather than merely fast.
 * 3. Bounds (`from`/`to`) and `order` are applied in memory on top of the scan,
 *    exactly as `core/ports/mock` does. That keeps this adapter's answers
 *    identical to the double the engine tests were written against, instead of
 *    introducing a second, subtly different definition of "range" and "desc" —
 *    which is the trap `mock-storage.test.ts` was written to catch. A bound with
 *    no `field` is REFUSED rather than guessed (ADR-023), with the mock's exact
 *    wording so the two cannot drift. `desc` reverses a COPY in `ordered()`, so
 *    the caller's `Query` object is never mutated, and the port's `order`
 *    therefore composes with `limit`/`offset` ("newest 2" = desc + limit).
 */
import {
  COLLECTION_NAMES,
  type CollectionName,
  INDEXES,
  type Collection as PortCollection,
  type Query,
  RANGE_FIELD_REQUIRED_MESSAGE,
  type RowBase,
  type StorageAdapter,
  StorageQueryError,
  type Tx,
} from '@smarttavern/core';
import type { Id } from '@smarttavern/schema';
import Dexie, { type IndexableType, type Table } from 'dexie';
import { DATABASE_NAME, DATABASE_VERSION, indexedDbSchema } from './schema';

/**
 * A stored row at the adapter boundary. The port's `Collection<T>` is generic over
 * `RowBase`, so inside the adapter a row is only known to be an object with an
 * `id` — which is all Dexie needs to store one.
 */
type Row = Record<string, unknown> & { id: Id };

/** Raised for adapter-level contract violations (unknown collection/index). */
export class IndexedDbStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexedDbStorageError';
  }
}

/** Raised when `update` targets an id that does not exist. Mirrors `MockStorageError`. */
export class IndexedDbRowMissingError extends IndexedDbStorageError {
  constructor(id: Id) {
    super(`cannot update ${id}: row does not exist`);
    this.name = 'IndexedDbRowMissingError';
  }
}

/**
 * Structural, order-insensitive comparison. Behaviourally identical to the
 * matcher inside `core/ports/mock/mock-storage.ts` on purpose: the reference
 * double and the real adapter must agree on what `where` means, or every engine
 * test written against the double becomes a lie. Duplicated rather than imported
 * because `core/ports/mock` is a non-barrel subpath and the adapter layer may
 * import only the port barrels.
 */
function valuesMatch(candidate: unknown, expected: unknown): boolean {
  if (Object.is(candidate, expected)) return true;
  if (candidate === null || expected === null) return false;
  if (typeof candidate !== 'object' || typeof expected !== 'object') return false;
  return JSON.stringify(candidate) === JSON.stringify(expected);
}

/** Compare two indexed values; numbers and strings only, totals otherwise. */
function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : 1;
  return 0;
}

/** A value IndexedDB can use as a key; anything else forces a scan. */
function isKeyValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    value instanceof ArrayBuffer
  );
}

/** Equality constraints as a plain list, for the structural scan path. */
function constraintsOf(query: Query<RowBase> | undefined): [string, unknown][] {
  const where = query?.where;
  return where === undefined ? [] : Object.entries(where);
}

/**
 * The §7 index whose key path answers the WHOLE `where` map, if one does.
 *
 * `preferred` (the `index` argument of `list`) is tried first; Dexie derives an
 * index's identity from its key path, so a preferred index still has to satisfy
 * the same completeness test. A compound index needs every field constrained —
 * Dexie raises `SchemaError` on a partial tuple, and guessing a min/max pad would
 * silently change what the query means. A multi-valued index is skipped: see the
 * file header.
 */
function equalityScan(
  name: CollectionName,
  constraints: readonly [string, unknown][],
  preferred?: string,
): { keyPath: string | string[]; value: unknown } | undefined {
  const declared = INDEXES[name];
  const ordered =
    preferred === undefined
      ? declared
      : [
          ...declared.filter((index) => index.name === preferred),
          ...declared.filter((index) => index.name !== preferred),
        ];

  for (const index of ordered) {
    if (index.multiValued === true) continue;
    const values: unknown[] = [];
    let complete = true;
    for (const field of index.fields) {
      const entry = constraints.find(([key]) => key === field);
      if (entry === undefined || !isKeyValue(entry[1])) {
        complete = false;
        break;
      }
      values.push(entry[1]);
    }
    if (!complete) continue;
    return {
      // Dexie must be handed the same shape its `stores()` string produced: a
      // bare field name for a single-field index, an ARRAY for a compound one
      // (the schema's `[a+b]`). A joined string matches nothing and throws
      // `SchemaError: KeyPath a+b ... is not indexed`.
      keyPath: index.fields.length === 1 ? (index.fields[0] as string) : [...index.fields],
      value: values.length === 1 ? values[0] : values,
    };
  }
  return undefined;
}

/**
 * One collection of one transaction. `T` is whatever the caller declared; rows are
 * fetched as `Row` and handed back as `T`, because the adapter never inspects a row
 * beyond its primary key.
 */
class IndexedDbCollection<T extends RowBase> implements PortCollection<T> {
  constructor(
    private readonly table: Table<Row, Id>,
    private readonly name: CollectionName,
  ) {}

  async get(id: Id): Promise<T | undefined> {
    return (await this.table.get(id)) as T | undefined;
  }

  async list(query?: Query<T>, index?: string): Promise<T[]> {
    return (await this.select(query, index)) as T[];
  }

  async put(row: T): Promise<T> {
    const stored = row as unknown as Row;
    if (stored.id === undefined || stored.id === null) {
      throw new IndexedDbStorageError(
        `${this.name}.put requires an id; this adapter never mints one (see the file header)`,
      );
    }
    await this.table.put(stored);
    return row;
  }

  async putMany(rows: readonly T[]): Promise<T[]> {
    const stored = rows as unknown as readonly Row[];
    if (stored.some((row) => row.id === undefined || row.id === null)) {
      throw new IndexedDbStorageError(`${this.name}.putMany requires an id on every row`);
    }
    await this.table.bulkPut(stored);
    return [...rows];
  }

  async update(id: Id, patch: Partial<T>): Promise<T> {
    const changed = await this.table.update(id, patch as unknown as Record<string, unknown>);
    if (changed === 0) throw new IndexedDbRowMissingError(id);
    const next = await this.table.get(id);
    if (next === undefined) throw new IndexedDbRowMissingError(id);
    return next as T;
  }

  async remove(id: Id): Promise<void> {
    await this.table.delete(id);
  }

  async count(query?: Query<T>): Promise<number> {
    return (await this.select(query)).length;
  }

  /* ────────────────────────────── query planner ───────────────────────────── */

  private async select(query: Query<T> | undefined, index?: string): Promise<Row[]> {
    if (index !== undefined) this.assertIndex(index);
    const asRowQuery = query as Query<RowBase> | undefined;
    const constraints = constraintsOf(asRowQuery);
    const equality = equalityScan(this.name, constraints, index);
    const rows =
      equality === undefined
        ? await this.table.toArray()
        : await this.table
            // `equalityScan` only returns values that passed `isKeyValue`, which
            // is exactly Dexie's `IndexableType`; the cast just says so.
            .where(equality.keyPath)
            .equals(equality.value as IndexableType)
            .toArray();
    return this.ordered(this.filtered(rows, asRowQuery), asRowQuery);
  }

  private assertIndex(index: string): void {
    const declared = INDEXES[this.name];
    if (declared.some((candidate) => candidate.name === index)) return;
    throw new IndexedDbStorageError(
      `collection ${this.name} has no index ${index}; declared: ${
        declared.map((candidate) => candidate.name).join(', ') || '(none)'
      }`,
    );
  }

  /**
   * The residual filter: `where` equality for every constraint the index scan did
   * not already answer, then the bounds. Bounds are applied even when the scan
   * fixed the same field, because `core/ports/mock` does the same thing and this
   * adapter must not be cleverer than the double (see the header).
   *
   * A bound (`from`/`to`) whose `field` is omitted is refused, not guessed —
   * ADR-023. The old fallback here was copied from the mock (`field ?? first
   * `where` key ?? 'id'`), and it made `{where: {createdAt: 10}, from: 1, to: 5}`
   * range-scan `createdAt` and answer an EMPTY ARRAY for a query that looks
   * perfectly reasonable. A wrong answer that a test pins down becomes a
   * compatibility promise, so both implementations now throw the same
   * `StorageQueryError` with the same message.
   */
  private filtered(rows: Row[], query: Query<RowBase> | undefined): Row[] {
    const constraints = constraintsOf(query);
    const bounds = query?.from !== undefined || query?.to !== undefined;
    if (constraints.length === 0 && !bounds) return rows;

    const rangeField = query?.field;
    if (query !== undefined && bounds && rangeField === undefined) {
      throw new StorageQueryError(RANGE_FIELD_REQUIRED_MESSAGE, query);
    }

    return rows.filter((row) => {
      if (!constraints.every(([key, expected]) => valuesMatch(row[key], expected))) return false;
      // The `rangeField === undefined` half is unreachable: a bounded query
      // without a field threw above. It keeps the indexed access type-safe.
      if (!bounds || rangeField === undefined) return true;
      const value = row[rangeField];
      if (value === undefined) return false;
      if (query?.from !== undefined && compare(value, query.from) < 0) return false;
      if (query?.to !== undefined && compare(value, query.to) > 0) return false;
      return true;
    });
  }

  private ordered(rows: Row[], query: Query<RowBase> | undefined): Row[] {
    const offset = query?.offset ?? 0;
    const limit = query?.limit;
    if (query?.order !== 'desc' && offset === 0 && limit === undefined) return rows;
    // `[...rows]` so a desc order never reverses the array it was handed, which
    // would also mutate anything the caller still holds.
    const ordered = query?.order === 'desc' ? [...rows].reverse() : rows;
    const end = limit === undefined ? undefined : offset + limit;
    return ordered.slice(offset, end);
  }
}

/** Options for `createIndexedDbStorage`. */
export interface IndexedDbStorageOptions {
  /** Database name. Defaults to `DATABASE_NAME`; tests pass a unique one. */
  name?: string;
}

/**
 * Build the adapter. The database is described eagerly but opened lazily by Dexie
 * on the first transaction, so importing this module never touches IndexedDB —
 * which matters in Node, where `globalThis.indexedDB` only exists once
 * `fake-indexeddb` has been imported.
 */
export function createIndexedDbStorage(options: IndexedDbStorageOptions = {}): StorageAdapter {
  const db = new Dexie(options.name ?? DATABASE_NAME);
  db.version(DATABASE_VERSION).stores(indexedDbSchema());

  return {
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      // `db.transaction`'s async-callback form (Dexie 4 has no static
      // `Dexie.transaction`), which does not rely on zone tracking, so an `await`
      // inside `fn` that is not a Dexie operation cannot make Dexie abort early.
      const result = await db.transaction('rw', db.tables, async (dexieTx) => {
        const resolve = (name: CollectionName): Table<Row, Id> => {
          if (!COLLECTION_NAMES.includes(name)) {
            throw new IndexedDbStorageError(`unknown collection ${name}`);
          }
          return dexieTx.table(name) as Table<Row, Id>;
        };
        const tx: Tx = {
          collection: <TRow extends RowBase>(name: CollectionName): PortCollection<TRow> =>
            new IndexedDbCollection<TRow>(resolve(name), name),
        };
        return fn(tx);
      });
      return result as T;
    },
  };
}
