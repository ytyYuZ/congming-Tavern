/**
 * The language preference against real IndexedDB (`fake-indexeddb`, M1-G1).
 *
 * WHAT THIS FILE HAS TO PROVE
 * 1. `setLocale` persists: a FRESH store over the same database reads the choice back.
 *    "Restart" is the same trick `db/repository.test.ts` uses — build a second store —
 *    because a page reload is not expressible in a test process.
 * 2. A corrupt stored value FALLS BACK rather than throwing. `'EN'` is a writer bug
 *    (`isLocale` is deliberately exact), and the documented chain is
 *    stored -> `resolveLocale(navigator.languages)` -> `DEFAULT_LOCALE`.
 * 3. The stored value WINS over the browser's list on a load — otherwise the picker
 *    would appear to forget the choice on every reload.
 * 4. A `load()` that resolves after a `setLocale` does NOT revert the user's click (the
 *    `loadToken` guard in `state/locale-store.ts`), and a write that FAILS is reported
 *    through the store's `error` field rather than rejecting out of a click handler.
 *
 * WHY THE STORE IS REACHED THROUGH `mount`
 * Vitest instantiates a module once per ENVIRONMENT, and this workspace mixes them; the
 * store the mounted app reads must be the store a test seeds (see `mount.ts`).
 *
 * WHY A "FRESH STORE" IS A RESET AND NOT A NEW MODULE
 * `resetLocaleStore()` puts the store back into its CONSTRUCTED state, `ready: false`
 * included — which is what a page load produces, and the only honest way to assert
 * "a fresh load reads the row back".
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { write } from '../db/database';
import * as repository from '../db/repository';
import { readLocaleSetting, type SettingsRow, writeLocaleSetting } from '../db/repository';
// The store and the database accessors come from `mount`, so this file shares ONE module
// instance with the mounted app (see the file header). The repository's locale helpers are
// imported from the module `state/locale-store.ts` itself imports, so `vi.spyOn` below
// replaces the very function the store calls.
import { closeDatabase, resetDatabase, resetLocaleStore, useLocaleStore } from '../mount';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-locale-${databases}`;
  resetDatabase(databaseName);
  resetLocaleStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetLocaleStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Write a value into the `settings`/`locale` row, bypassing the typed helper. */
async function putRawLocale(value: unknown): Promise<void> {
  await write(async (tx) => {
    // The row type is named so the collection accepts `value` at all, and the cast is the
    // point of this helper: several cases below write a value the app would never write
    // (`'EN'`, a number) to prove the reader refuses it instead of trusting the row.
    await tx
      .collection<SettingsRow>(COLLECTIONS.settings)
      .put({ id: 'locale', value } as SettingsRow);
  });
}

describe('state/locale-store', () => {
  it('persists a choice and reads it back after a restart', async () => {
    await useLocaleStore.getState().setLocale('en');
    // The switch is applied BEFORE the write is awaited (the optimistic order); the row
    // is what this test then verifies, so the awaited call is the point.
    expect(useLocaleStore.getState().locale).toBe('en');
    expect(useLocaleStore.getState().error).toBeUndefined();

    // "Restart": drop the in-memory state, then load again from the SAME database.
    resetLocaleStore();
    expect(useLocaleStore.getState().ready).toBe(false);

    await useLocaleStore.getState().load();
    expect(useLocaleStore.getState().locale).toBe('en');
    expect(useLocaleStore.getState().ready).toBe(true);
  });

  it('lets the stored value win over the browser list', async () => {
    await writeLocaleSetting('zh-CN');
    // jsdom reports `en-US`, so a load that preferred the browser would answer `en`.
    await useLocaleStore.getState().load();
    expect(useLocaleStore.getState().locale).toBe('zh-CN');
  });

  it('falls back instead of throwing when the stored row is corrupt', async () => {
    await putRawLocale('EN');
    expect(await readLocaleSetting()).toBeUndefined();

    await expect(useLocaleStore.getState().load()).resolves.toBeUndefined();
    // `resolveLocale(navigator.languages)` with jsdom's `en-US`, i.e. a REAL locale and
    // never the unparseable `'EN'`.
    expect(useLocaleStore.getState().locale).toBe('en');
    expect(useLocaleStore.getState().ready).toBe(true);
  });

  it('treats a non-string stored value as absent too', async () => {
    // A number is the least recoverable corruption: `isLocale` refuses it, and the store
    // must not put it in `locale` (whose type would then be a lie).
    await putRawLocale(42);
    expect(await readLocaleSetting()).toBeUndefined();
    await useLocaleStore.getState().load();
    expect(useLocaleStore.getState().locale).toBe('en');
  });

  it('does not let a late load revert a choice the user already made', async () => {
    // The row says zh-CN; the user clicks before that read answers.
    await writeLocaleSetting('zh-CN');
    const loading = useLocaleStore.getState().load();
    await useLocaleStore.getState().setLocale('en');
    await loading;

    // The click is newer than the row the read saw, so it wins.
    expect(useLocaleStore.getState().locale).toBe('en');
  });

  it('reports a failed write through the store instead of rejecting', async () => {
    // The write is the only thing stubbed: the point is what `setLocale` does when the
    // storage layer fails, not whether Dexie can be made to fail on demand.
    vi.spyOn(repository, 'writeLocaleSetting').mockRejectedValue(
      new DOMException('quota', 'QuotaExceededError'),
    );

    await expect(useLocaleStore.getState().setLocale('en')).resolves.toBeUndefined();
    // The switch STANDS (the user asked for it) and the failure is reportable.
    expect(useLocaleStore.getState().locale).toBe('en');
    expect(useLocaleStore.getState().error).toBe('QuotaExceededError');
  });

  it('clears a previous failure once a write succeeds', async () => {
    const writing = vi
      .spyOn(repository, 'writeLocaleSetting')
      .mockRejectedValueOnce(new Error('transient'));
    await useLocaleStore.getState().setLocale('en');
    expect(useLocaleStore.getState().error).toBe('Error');

    writing.mockRestore();
    await useLocaleStore.getState().setLocale('zh-CN');
    expect(useLocaleStore.getState().error).toBeUndefined();
    expect(useLocaleStore.getState().locale).toBe('zh-CN');
  });
});
