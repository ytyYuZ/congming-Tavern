/**
 * In-memory storage double: the rollback guarantee and copying semantics that
 * engine tests will rely on.
 */
import { describe, expect, it } from 'vitest';
import { COLLECTIONS, type Query, StorageQueryError } from '../storage';
import { MockStorageAdapter, MockStorageError } from './mock-storage';

interface WorldRow {
  id: string;
  name: string;
  createdAt: number;
}

interface MessageRow {
  id: string;
  sessionId: string;
  createdAt: number;
}

describe('MockStorageAdapter', () => {
  it('commits every write when the transaction resolves', async () => {
    const db = new MockStorageAdapter();

    const name = await db.transaction(async (tx) => {
      const worlds = tx.collection<WorldRow>(COLLECTIONS.worlds);
      await worlds.put({ id: 'w1', name: 'Eldoria', createdAt: 1 });
      await worlds.put({ id: 'w2', name: 'Karsis', createdAt: 2 });
      return (await worlds.get('w1'))?.name;
    });

    expect(name).toBe('Eldoria');
    expect(db.size(COLLECTIONS.worlds)).toBe(2);
  });

  it('ROLLS BACK every write when the transaction throws', async () => {
    const db = new MockStorageAdapter();

    await db.transaction(async (tx) => {
      await tx
        .collection<WorldRow>(COLLECTIONS.worlds)
        .put({ id: 'w1', name: 'Eldoria', createdAt: 1 });
    });

    await expect(
      db.transaction(async (tx) => {
        const worlds = tx.collection<WorldRow>(COLLECTIONS.worlds);
        await worlds.put({ id: 'w2', name: 'Karsis', createdAt: 2 });
        await worlds.update('w1', { name: 'RENAMED' });
        await tx
          .collection<MessageRow>(COLLECTIONS.messages)
          .put({ id: 'm1', sessionId: 's1', createdAt: 3 });
        throw new Error('domain rule violated mid-transaction');
      }),
    ).rejects.toThrow('domain rule violated mid-transaction');

    // The insert, the update and the write to the OTHER collection are all gone.
    expect(db.size(COLLECTIONS.worlds)).toBe(1);
    expect(db.peek<WorldRow>(COLLECTIONS.worlds)).toEqual([
      { id: 'w1', name: 'Eldoria', createdAt: 1 },
    ]);
    expect(db.size(COLLECTIONS.messages)).toBe(0);
  });

  it('cannot be mutated from outside a transaction: rows are copied in and out', async () => {
    const db = new MockStorageAdapter();
    const row: WorldRow = { id: 'w1', name: 'Eldoria', createdAt: 1 };
    let handed: WorldRow | undefined;

    await db.transaction(async (tx) => {
      const worlds = tx.collection<WorldRow>(COLLECTIONS.worlds);
      await worlds.put(row);
      handed = await worlds.get('w1');
      if (handed === undefined) throw new Error('the row put in this transaction must be readable');
      handed.name = 'MUTATED INSIDE';
      // Mutating the caller's object after `put` must not reach committed state.
      row.name = 'MUTATED OUTSIDE';
    });

    expect(db.peek<WorldRow>(COLLECTIONS.worlds)[0]?.name).toBe('Eldoria');
    expect(handed?.name).toBe('MUTATED INSIDE');
  });

  it('counts transaction starts, so a test can assert the port was used', async () => {
    const db = new MockStorageAdapter();
    await db.transaction(async () => undefined);
    await db.transaction(async () => undefined);
    expect(db.transactionCount).toBe(2);
  });

  it('refuses to update a row that does not exist', async () => {
    const db = new MockStorageAdapter();
    await expect(
      db.transaction(async (tx) =>
        tx.collection<WorldRow>(COLLECTIONS.worlds).update('nope', { name: 'x' }),
      ),
    ).rejects.toBeInstanceOf(MockStorageError);
  });

  it('answers index-shaped queries with equality, range, order and paging', async () => {
    const db = new MockStorageAdapter();
    await db.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      for (let index = 1; index <= 5; index += 1) {
        await messages.put({
          id: `m${index}`,
          sessionId: index <= 3 ? 's1' : 's2',
          createdAt: index,
        });
      }
    });

    await db.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);

      expect((await messages.list({ where: { sessionId: 's1' } })).map((row) => row.id)).toEqual([
        'm1',
        'm2',
        'm3',
      ]);
      expect(await messages.count({ where: { sessionId: 's2' } })).toBe(2);

      const ranged = await messages.list({
        where: { sessionId: 's1' },
        field: 'createdAt',
        from: 2,
        to: 4,
      });
      expect(ranged.map((row) => row.id)).toEqual(['m2', 'm3']);

      const newest = await messages.list({ order: 'desc', limit: 2 });
      expect(newest.map((row) => row.id)).toEqual(['m5', 'm4']);

      const page = await messages.list({ offset: 1, limit: 2 });
      expect(page.map((row) => row.id)).toEqual(['m2', 'm3']);
    });
  });

  it('refuses a range bound that cannot be compared, instead of matching every row (ADR-024)', async () => {
    const db = new MockStorageAdapter();
    await db.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      await messages.put({ id: 'm1', sessionId: 's1', createdAt: 10 });
    });

    await db.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      // `compareValues` answers 0 ("equal") for anything that is not a number or a
      // string, so a `Date` bound used to MATCH EVERY ROW: the query answered the
      // whole table instead of complaining. The port now refuses it at runtime as
      // well, so a cast or a plain JS caller cannot smuggle one past the type.
      // @ts-expect-error a Date is not a comparable bound (ADR-024)
      const dateBound: Query<MessageRow> = { field: 'createdAt', from: new Date(0) };
      await expect(messages.list(dateBound)).rejects.toBeInstanceOf(StorageQueryError);
      await expect(messages.list(dateBound)).rejects.toThrow(/must be a number or a string/);

      // Scalars keep working, unchanged.
      expect(
        (await messages.list({ field: 'createdAt', from: 1, to: 20 })).map((row) => row.id),
      ).toEqual(['m1']);
    });
  });

  it('refuses a range query that does not name its field (ADR-023)', async () => {
    const db = new MockStorageAdapter();
    await db.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      await messages.put({ id: 'm1', sessionId: 's1', createdAt: 10 });
    });

    await db.transaction(async (tx) => {
      const messages = tx.collection<MessageRow>(COLLECTIONS.messages);
      // The old behaviour guessed the range field — the first `where` key, else
      // `id` — so this query range-scanned `createdAt` (which is 10) and answered
      // an empty array. A wrong answer that a test pins down becomes a
      // compatibility promise, so it is a refusal now.
      await expect(messages.list({ where: { createdAt: 10 }, from: 1, to: 5 })).rejects.toThrow(
        /must name `field`/,
      );
      // Naming the field is all it takes. (The row's `createdAt` is 10, so a range
      // that contains it — not the [1, 5] of the refusing query above — is what
      // proves the refusal did not eat a legitimate answer.)
      expect(
        (await messages.list({ field: 'createdAt', from: 1, to: 20 })).map((row) => row.id),
      ).toEqual(['m1']);
    });
  });

  it('keeps putMany and remove idempotent, as a rollback path needs', async () => {
    const db = new MockStorageAdapter();
    await db.transaction(async (tx) => {
      const worlds = tx.collection<WorldRow>(COLLECTIONS.worlds);
      await worlds.putMany([
        { id: 'w1', name: 'A', createdAt: 1 },
        { id: 'w2', name: 'B', createdAt: 2 },
      ]);
      await worlds.remove('w1');
      await worlds.remove('w1');
    });

    expect(db.peek<WorldRow>(COLLECTIONS.worlds).map((row) => row.id)).toEqual(['w2']);
  });

  it('starts empty for a fresh collection name without an explicit create', async () => {
    const db = new MockStorageAdapter();
    await db.transaction(async (tx) => {
      expect(await tx.collection<WorldRow>(COLLECTIONS.turnPlans).count()).toBe(0);
    });
  });
});
