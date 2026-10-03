/**
 * 「在这台设备上记住解锁」 — the FIVE invariants, each with a named test (Phase A2).
 *
 * WHY THESE ARE THE TESTS THAT MATTER
 * The feature is a convenience that stores a credential, so every part of it that could be
 * weaker than it claims is an invariant rather than a happy path:
 *
 *   1. WHAT IS STORED IS THE DERIVED KEY, NEVER THE PASSPHRASE. `secret-crypto.ts` says the
 *      passphrase "is never stored, never put in an error message, and never returned", and this
 *      suite checks that the new persistence did not become an exception: the passphrase string
 *      is absent from the remembered record's own bytes, its value is a `CryptoKey`, and the
 *      platform refuses to export that key's raw bytes.
 *   2. DEVICE-LOCAL, NOT PART OF THE PORTABLE MODEL. It lives in its OWN IndexedDB database, so
 *      the export path (a fixed list of collections on the `StorageAdapter`) cannot reach it and
 *      a byte scan of an exported package finds nothing.
 *   3. PER PROVIDER ROW (ADR-034). Each row has its own envelope, so a remembered unlock opens
 *      exactly one row and a row that was never remembered stays locked.
 *   4. REVOCABLE, AND REVOKING TOUCHES NOTHING ELSE. The stored ciphertext is byte-identical
 *      afterwards and the passphrase still opens it.
 *   5. DEFAULT OFF. Without the opt-in a reload starts locked exactly as before.
 *
 * WHY THE RAW API IS USED FOR THE RECORD
 * The assertion "the passphrase is not in what we stored" has to be made against what is
 * actually in the database, not against the object this module handed to `put`. Reading the
 * store directly (the same primitive `db/raw-indexeddb.test-helpers.ts` exists for) is what makes
 * it a check on the bytes rather than on the code path.
 *
 * WHY THE EXPORT HALF LIVES IN `db/export-boundary.test.ts`
 * It needs the session row and the exporter, which is the repository's business; this file owns
 * the record and the session, and cross-references the other suite by name.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase } from '../db/database';
import { deleteDatabase, openRaw, request } from '../db/raw-indexeddb.test-helpers';
import { readProviderSettingsById, writeProviderSettings } from '../db/repository';
import { resetSettingsStore, useSettingsStore } from '../state/settings-store';
import { decryptSecret, encryptSecret } from './secret-crypto';
import {
  deleteUnlockMemory,
  hasRememberedUnlock,
  rememberedProviderIds,
  UNLOCK_MEMORY_DATABASE,
  UNLOCK_MEMORY_STORE,
} from './unlock-memory';

const PASSPHRASE = 'the-passphrase-must-never-be-stored';
const API_KEY = 'sk-remember-me-on-this-device';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'remember-model';

const FIRST_ROW = 'provider';
const SECOND_ROW = 'provider.0191f0aa-0000-7000-8000-000000000001';

let databases = 0;
let databaseName = '';

beforeEach(async () => {
  databases += 1;
  databaseName = `apps-web-unlock-memory-${databases}`;
  resetDatabase(databaseName);
  resetSettingsStore();
  // The remembered records live in their own database AND outlive a store reset on purpose, so a
  // suite that writes one has to clear it explicitly.
  await deleteUnlockMemory();
});

afterEach(async () => {
  resetSettingsStore();
  closeDatabase();
  await deleteDatabase(databaseName);
  await deleteUnlockMemory();
});

/**
 * Every row the unlock-memory store actually holds, as the raw values.
 *
 * Why the RAW API rather than this module's own reader: the assertion "the passphrase is not in
 * what we stored" has to be made against what is in the database, not against the object the
 * module handed to `put`. The count is returned as well as the rows because "there are no
 * records" and "there is an empty store" are different facts — an opt-in that wrote nothing must
 * leave no rows, not an empty table.
 */
async function rawRows(name: string): Promise<unknown[]> {
  const database = await openRaw(name);
  try {
    if (!database.objectStoreNames.contains(UNLOCK_MEMORY_STORE)) return [];
    const transaction = database.transaction(UNLOCK_MEMORY_STORE, 'readonly');
    return await request<unknown[]>(transaction.objectStore(UNLOCK_MEMORY_STORE).getAll());
  } finally {
    database.close();
  }
}

/**
 * Everything the unlock-memory store holds, as text.
 *
 * `JSON.stringify` is the honest serialisation here: a `CryptoKey` has no enumerable data (that
 * is the whole point of it), so the string carries the record's scalars. A passphrase that made
 * it into the record would have to appear in this string.
 */
async function rememberedRecord(name: string): Promise<string> {
  return JSON.stringify(await rawRows(name));
}

/** Store one encrypted key in one row, and answer the passphrase that opens it. */
async function sealedRow(providerId: string, apiKey: string): Promise<string> {
  const envelope = await encryptSecret(apiKey, PASSPHRASE);
  await writeProviderSettings(
    { baseUrl: BASE_URL, model: MODEL, secret: { kind: 'encrypted', envelope } },
    providerId,
  );
  return envelope.ciphertext;
}

/** Seal a row, unlock it WITH the opt-in, and answer the envelope's ciphertext. */
async function rememberRow(providerId: string, apiKey: string): Promise<string> {
  const ciphertext = await sealedRow(providerId, apiKey);
  await useSettingsStore.getState().load();
  await expect(
    useSettingsStore.getState().unlock(PASSPHRASE, { target: { id: providerId }, remember: true }),
  ).resolves.toBeUndefined();
  return ciphertext;
}

describe('invariant 1: what is remembered is the derived key, never the passphrase', () => {
  it('stores the derived key and keeps the passphrase out of the record', async () => {
    await rememberRow(FIRST_ROW, API_KEY);

    // THE RECORD EXISTS — so the assertions below are not vacuous.
    expect(await hasRememberedUnlock(FIRST_ROW)).toBe(true);
    const bytes = await rememberedRecord(UNLOCK_MEMORY_DATABASE);
    expect(bytes).not.toBe('');
    // THE INVARIANT. The passphrase is a string that went through `rederiveSecret` and was
    // dropped; it appears nowhere in what was written.
    expect(bytes).not.toContain(PASSPHRASE);
    // And neither is the API KEY: what is stored opens the envelope, it is not its plaintext.
    expect(bytes).not.toContain(API_KEY);
    // The record carries the envelope's own derivation parameters, which is what lets a recall
    // tell "the envelope I was made for" from "another envelope" without a hash column.
    const stored = await readProviderSettingsById(FIRST_ROW);
    if (stored.secret.kind !== 'encrypted') throw new Error('the row is not encrypted');
    expect(bytes).toContain(stored.secret.envelope.salt);

    // THE MECHANISM, MEASURED RATHER THAN CLAIMED: what was persisted is a `CryptoKey` whose
    // bytes the platform refuses to hand to script code. Were this ever to become an exported
    // byte string, this assertion is what fails.
    const record = await rawRecord(FIRST_ROW);
    const key = rawField(record, 'key');
    expect(typeof key).toBe('object');
    expect(isCryptoKeyLike(key)).toBe(true);
    if (!isCryptoKeyLike(key)) throw new Error('the remembered value is not a CryptoKey');
    expect(key.extractable).toBe(false);
    await expect(
      globalThis.crypto.subtle.exportKey('raw', key as CryptoKey),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe('invariant 2: it is device-local and outside the portable model', () => {
  it('lives in its own database, which is not a collection of the app database', async () => {
    await rememberRow(FIRST_ROW, API_KEY);

    // The app's own database has no such table: the record is not a nineteenth collection.
    const appDatabase = await openRaw(databaseName);
    try {
      expect(Array.from(appDatabase.objectStoreNames)).not.toContain(UNLOCK_MEMORY_STORE);
    } finally {
      appDatabase.close();
    }
    // ...and the device database is a different database with exactly that one store. The export
    // half — "the exporter cannot reach it, and a byte scan finds nothing" — is asserted in
    // `db/provider-list.test.ts`, where a real session package is produced and scanned.
    const deviceDatabase = await openRaw(UNLOCK_MEMORY_DATABASE);
    try {
      expect(Array.from(deviceDatabase.objectStoreNames)).toEqual([UNLOCK_MEMORY_STORE]);
    } finally {
      deviceDatabase.close();
    }
  });
});

describe('invariant 3: one record per provider row (ADR-034)', () => {
  it('opens the row it was remembered for and leaves the other row locked', async () => {
    await rememberRow(FIRST_ROW, API_KEY);
    await sealedRow(SECOND_ROW, 'sk-the-second-provider-key');

    // The second row was never opted in, so it is locked and its key is not readable.
    expect(await hasRememberedUnlock(SECOND_ROW)).toBe(false);
    expect([...(await rememberedProviderIds())]).toEqual([FIRST_ROW]);

    // A reload: the FIRST row's key comes back without a passphrase, and the second's does not.
    resetSettingsStore();
    await useSettingsStore.getState().switch(FIRST_ROW);
    expect(useSettingsStore.getState().key).toBe(API_KEY);
    expect(useSettingsStore.getState().locked).toBe(false);

    resetSettingsStore();
    await useSettingsStore.getState().switch(SECOND_ROW);
    expect(useSettingsStore.getState().key).toBeUndefined();
    expect(useSettingsStore.getState().locked).toBe(true);
  });

  it('does not open a row whose envelope was replaced after the record was written', async () => {
    await rememberRow(FIRST_ROW, API_KEY);

    // A DIFFERENT envelope in the same row: a new key under a new passphrase, which is the one act
    // the policy documents as the recovery for a forgotten passphrase.
    const replaced = await encryptSecret('sk-replaced-on-this-row', 'another-passphrase');
    await writeProviderSettings(
      { baseUrl: BASE_URL, model: MODEL, secret: { kind: 'encrypted', envelope: replaced } },
      FIRST_ROW,
    );

    resetSettingsStore();
    await useSettingsStore.getState().switch(FIRST_ROW);
    // The stale record cannot open it, so the row is locked and the user is asked for the
    // passphrase — never a "wrong passphrase" sentence about a key they never typed.
    expect(useSettingsStore.getState().locked).toBe(true);
    expect(useSettingsStore.getState().key).toBeUndefined();
    // And it was dropped rather than left to fail on every future load.
    expect(await hasRememberedUnlock(FIRST_ROW)).toBe(false);
  });
});

describe('invariant 4: revoking clears only the remembered key', () => {
  it('leaves the ciphertext byte-identical, and the passphrase still opens it', async () => {
    const ciphertext = await rememberRow(FIRST_ROW, API_KEY);
    const before = await rememberedRecord(UNLOCK_MEMORY_DATABASE);

    await useSettingsStore.getState().forgetRemembered(FIRST_ROW);

    // The record is gone, and the ROW was never touched: the ciphertext is the same bytes, so the
    // passphrase — the only copy of the key — is still the way in.
    expect(await hasRememberedUnlock(FIRST_ROW)).toBe(false);
    expect(await rememberedRecord(UNLOCK_MEMORY_DATABASE)).not.toBe(before);
    const stored = await readProviderSettingsById(FIRST_ROW);
    if (stored.secret.kind !== 'encrypted') throw new Error('the row is not encrypted');
    expect(stored.secret.envelope.ciphertext).toBe(ciphertext);
    await expect(decryptSecret(stored.secret.envelope, PASSPHRASE)).resolves.toBe(API_KEY);

    // A reload now starts locked, and the passphrase opens it again.
    resetSettingsStore();
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().locked).toBe(true);
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe(API_KEY);
  });

  it('keeps the row unlocked in this tab: revoking is not locking', async () => {
    await rememberRow(FIRST_ROW, API_KEY);
    await useSettingsStore.getState().forgetRemembered(FIRST_ROW);
    // The convenience is gone from the device; the tab the user is working in keeps working, and
    // 「锁定」 is the separate act that closes it.
    expect(useSettingsStore.getState().key).toBe(API_KEY);
    expect(useSettingsStore.getState().locked).toBe(false);
    useSettingsStore.getState().lock();
    expect(useSettingsStore.getState().locked).toBe(true);
  });

  it('takes the record with the row when the row is deleted', async () => {
    await rememberRow(FIRST_ROW, API_KEY);
    await expect(useSettingsStore.getState().remove(FIRST_ROW)).resolves.toEqual({
      kind: 'removed',
    });
    // A key must not outlive the lock it opens (ADR-034's per-row envelope).
    expect(await hasRememberedUnlock(FIRST_ROW)).toBe(false);
  });
});

describe('invariant 5: default OFF', () => {
  it('starts locked after a reload when the opt-in was not given', async () => {
    await sealedRow(FIRST_ROW, API_KEY);
    await useSettingsStore.getState().load();
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe(API_KEY);

    // NO OPT-IN: nothing was written, so this is exactly the pre-Phase-A2 behaviour.
    expect(await hasRememberedUnlock(FIRST_ROW)).toBe(false);
    expect(await rawRows(UNLOCK_MEMORY_DATABASE)).toHaveLength(0);

    resetSettingsStore();
    resetDatabase(databaseName);
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().locked).toBe(true);
    expect(useSettingsStore.getState().key).toBeUndefined();
  });

  it('does not write a record for a wrong passphrase', async () => {
    await sealedRow(FIRST_ROW, API_KEY);
    await useSettingsStore.getState().load();
    await expect(
      useSettingsStore.getState().unlock('not the passphrase', { remember: true }),
    ).resolves.toBe('wrong-passphrase');
    // A refused unlock has no derived key to remember, so the opt-in cannot store anything —
    // not a record, and not an empty placeholder either.
    expect(await rawRows(UNLOCK_MEMORY_DATABASE)).toHaveLength(0);
    expect(await hasRememberedUnlock(FIRST_ROW)).toBe(false);
  });
});

/* ───────────────────────────── reading the raw record ─────────────────────── */

/** One raw record of the device database, by row id. */
async function rawRecord(providerId: string): Promise<Record<string, unknown>> {
  const database = await openRaw(UNLOCK_MEMORY_DATABASE);
  try {
    const transaction = database.transaction(UNLOCK_MEMORY_STORE, 'readonly');
    const row = await request<unknown>(
      transaction.objectStore(UNLOCK_MEMORY_STORE).get(providerId),
    );
    return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  } finally {
    database.close();
  }
}

/**
 * One field of a raw record.
 *
 * A parameterised key is the ONE spelling this workspace accepts for an index-signature read:
 * Biome's `useLiteralKeys` refuses `record.key` and `noPropertyAccessFromIndexSignature` refuses
 * the dot form (the same rule `secrets/secret-crypto.ts` follows for its own untrusted records).
 */
function rawField(record: Record<string, unknown>, field: string): unknown {
  return record[field];
}

/** The two properties every `CryptoKey` has, without an `instanceof` across module copies. */
function isCryptoKeyLike(value: unknown): value is { extractable: boolean; algorithm: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { extractable?: unknown; algorithm?: unknown };
  return typeof candidate.extractable === 'boolean' && candidate.algorithm !== undefined;
}
