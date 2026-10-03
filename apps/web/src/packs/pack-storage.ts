/**
 * The `StorageAdapter` the pack layer runs on (M1-A4).
 *
 * WHY THIS FILE IS THIS SHORT, AND WHY IT DOES NOT REOPEN `db/database.ts`
 * `db/database.ts` owns the app's one IndexedDB adapter and deliberately does not export it:
 * the only door onto it is `write`, which opens one `rw` transaction (see that file's header).
 * `@smarttavern/importers`' `importPackage` opens a transaction of its OWN, and that single
 * transaction IS its atomicity claim — "a refused import writes nothing" is true because the
 * write path is one transaction that is never entered when the package is refused. Wrapping it
 * in `write` would nest one transaction inside another, so the port's one method is bound
 * straight to `write`: `StorageAdapter.transaction` and `write` already have the same shape.
 * No second write path appears, and every row still lands inside one `storage.transaction`.
 *
 * WHY A PREVIEW NEEDS A FAKE PORT AT ALL
 * `/packs` must show the import's real report BEFORE anything is written, and that report is
 * only produced by `importPackage` — which writes. Reimplementing the report would let the
 * preview and the import disagree, which is the one failure the screen exists to prevent. So
 * `dryRunStorage` runs the importer's own transaction against the real library and then aborts
 * it: the port commits when the callback resolves and rolls back when the callback throws, so
 * throwing AFTER the callback's value has been captured yields the real report with zero
 * observable change. The rollback is the same call, undone — not a second implementation of
 * the identity rules.
 */
import type { StorageAdapter, Tx } from '@smarttavern/core';
import { write } from '../db/database';

/**
 * The app's real adapter, seen through the port.
 *
 * A function rather than a constant so a test that swaps the database name gets the adapter
 * that `db/database.ts` currently holds: `write` reads the module-level `storage` binding on
 * every call, and a captured constant would keep pointing at the database `resetDatabase`
 * replaced.
 */
export function packStorage(): StorageAdapter {
  return { transaction: write };
}

/** Thrown inside the transaction to make the port roll it back. Never escapes this module. */
class PreviewRollback extends Error {
  constructor() {
    super('the preview transaction is deliberately rolled back');
    this.name = 'PreviewRollback';
  }
}

/**
 * An adapter that runs the importer's transaction for real and then aborts it, returning the
 * value the callback produced.
 *
 * HOW THE ABORT IS RECOGNISED: `rolledBack` is set on the statement immediately before the
 * throw, so a rejection that arrives with it set is this module's own rollback and nothing
 * else. A rejection that arrives with it clear came from inside `fn` — a real storage failure
 * — and is rethrown, so a broken database is not reported to the user as a preview.
 *
 * THE VALUE IS CAPTURED IN AN ARRAY, not in a `T | undefined` variable: `T` is allowed to be
 * `undefined`, so a variable cannot say "the callback never ran" without either lying or
 * widening the return type.
 */
export function dryRunStorage(storage: StorageAdapter): StorageAdapter {
  return {
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const captured: { value: T }[] = [];
      let rolledBack = false;
      try {
        await storage.transaction(async (tx) => {
          const value = await fn(tx);
          captured.push({ value });
          rolledBack = true;
          throw new PreviewRollback();
        });
      } catch (cause) {
        if (!rolledBack) throw cause;
      }
      const box = captured[0];
      if (box === undefined) {
        // Unreachable: a callback that did not reach its end rethrows above, and one that did
        // pushes. Kept so the narrowing is honest rather than asserted.
        throw new Error('the preview transaction produced no report');
      }
      return box.value;
    },
  };
}
