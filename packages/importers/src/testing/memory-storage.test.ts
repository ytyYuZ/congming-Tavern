/**
 * Tests for the storage double this package's import tests run against.
 *
 * WHY IT NEEDS ITS OWN TEST: the import's atomicity claim ("a failed import leaves
 * the storage untouched") is only as true as the double's rollback. A double that
 * silently commits half a write would make every atomicity test pass while proving
 * nothing, so the rollback, the copy-in/copy-out behaviour and the injected failure
 * are pinned here, on their own.
 *
 * The port's refusal rules are pinned too (`RANGE_FIELD_REQUIRED_MESSAGE` and
 * `RANGE_BOUND_NOT_COMPARABLE_MESSAGE` come from `@smarttavern/core`), because a
 * double that answers a query the port refuses would let a test pass on behaviour
 * the real adapter will never have.
 */
import {
  COLLECTIONS,
  RANGE_BOUND_NOT_COMPARABLE_MESSAGE,
  RANGE_FIELD_REQUIRED_MESSAGE,
  StorageQueryError,
  type Tx,
} from '@smarttavern/core';
import { describe, expect, it } from 'vitest';
import { MemoryStorageAdapter } from './memory-storage';

interface Row {
  id: string;
  value?: number;
}

function put(tx: Tx, rows: readonly Row[]): Promise<unknown> {
  return tx.collection<Row>(COLLECTIONS.worlds).putMany(rows);
}

describe('MemoryStorageAdapter', () => {
  it('rolls back every write when the callback throws', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.transaction(async (tx) => {
      await tx.collection<Row>(COLLECTIONS.worlds).put({ id: 'a', value: 1 });
    });

    await expect(
      storage.transaction(async (tx) => {
        await put(tx, [
          { id: 'b', value: 2 },
          { id: 'c', value: 3 },
        ]);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');

    expect(storage.peek<Row>(COLLECTIONS.worlds).map((row) => row.id)).toEqual(['a']);
    expect(storage.transactionCount).toBe(2);
  });

  it('hands out copies, so committed state cannot be mutated by reference', async () => {
    const storage = new MemoryStorageAdapter();
    const original: Row = { id: 'a', value: 1 };
    const stored = await storage.transaction((tx) =>
      tx.collection<Row>(COLLECTIONS.worlds).put(original),
    );

    stored.value = 99;
    original.value = 42;

    const read = await storage.transaction((tx) => tx.collection<Row>(COLLECTIONS.worlds).get('a'));
    expect(read?.value).toBe(1);
  });

  it('writes nothing at all when a failure is injected before the first row', async () => {
    const storage = new MemoryStorageAdapter();
    storage.failOn = { collection: COLLECTIONS.worlds, method: 'put' };

    await expect(
      storage.transaction((tx) => tx.collection<Row>(COLLECTIONS.worlds).put({ id: 'a' })),
    ).rejects.toThrow('injected put failure on worlds');
    expect(storage.size(COLLECTIONS.worlds)).toBe(0);
  });

  it('stops mid-batch, leaving something for the rollback to undo', async () => {
    const storage = new MemoryStorageAdapter();
    storage.failOn = { collection: COLLECTIONS.worlds, method: 'putMany' };

    await expect(storage.transaction((tx) => put(tx, [{ id: 'a' }, { id: 'b' }]))).rejects.toThrow(
      'injected putMany failure on worlds',
    );
    expect(storage.size(COLLECTIONS.worlds)).toBe(0);
  });

  it("refuses the two queries the port refuses, with the port's own wording", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.transaction((tx) => tx.collection<Row>(COLLECTIONS.worlds).put({ id: 'a' }));

    await expect(
      storage.transaction((tx) => tx.collection<Row>(COLLECTIONS.worlds).list({ from: 'a' })),
    ).rejects.toThrow(RANGE_FIELD_REQUIRED_MESSAGE);

    await expect(
      storage.transaction((tx) =>
        tx.collection<Row>(COLLECTIONS.worlds).list({
          field: 'id',
          // A Date bound compares as "equal" and would match every row (ADR-024).
          from: new Date(0) as unknown as string,
        }),
      ),
    ).rejects.toThrow(RANGE_BOUND_NOT_COMPARABLE_MESSAGE);

    const error = await storage
      .transaction((tx) => tx.collection<Row>(COLLECTIONS.worlds).list({ from: 'a' }))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StorageQueryError);
  });

  it('records every collection a code path opened', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.transaction(async (tx) => {
      await tx.collection<Row>(COLLECTIONS.worlds).list();
      await tx.collection<Row>(COLLECTIONS.settings).list();
    });
    expect(storage.touched).toEqual([COLLECTIONS.worlds, COLLECTIONS.settings]);
  });
});
