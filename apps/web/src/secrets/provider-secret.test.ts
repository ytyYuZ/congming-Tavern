/**
 * The passphrase session and the plaintext -> encrypted migration (M1-G3).
 *
 * WHAT THIS FILE HAS TO PROVE, IN ORDER OF HOW EASY IT IS TO GET WRONG
 * 1. THE MIGRATION. M0 wrote `{ baseUrl, apiKey: '<plaintext>', model }`; after the user sets
 *    a passphrase, the key must still be readable with that passphrase AND the plaintext must
 *    be GONE — not merely that the new row looks encrypted. So the assertions read the raw
 *    IndexedDB contents (every field of every row), and the plaintext value is what must not
 *    appear. A test that only read the row back through the repository would pass even if a
 *    second copy of the key sat in another field.
 * 2. A FAILED SEAL LOSES NOTHING. A passphrase that is too short must leave the row exactly
 *    as it was, still readable — the one outcome this feature must never produce is a key
 *    nobody can read.
 * 3. A WRONG PASSPHRASE TOUCHES NOTHING. The bytes on disk before and after a failed unlock
 *    are compared as strings, so "we did not re-encrypt/repair/clear it" is checkable rather
 *    than asserted in a comment.
 * 4. A SAVE WHILE LOCKED KEEPS THE KEY. Editing the endpoint must not require the passphrase
 *    and must not drop the envelope.
 *
 * WHY THE STORE IS THE THING UNDER TEST (and not only `secrets/provider-secret.ts`)
 * The migration is a three-step composition — read the row, seal the key, write the row once
 * — and the failure modes live in the composition, not in the primitives: the crypto suite
 * already covers PBKDF2/AES-GCM on its own. Driving `useSettingsStore` is what makes this the
 * behaviour the app actually has.
 */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase, write } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import type { SettingsRow } from '../db/repository';
import { readProviderSettings } from '../db/repository';
import { resetSettingsStore, useSettingsStore } from '../state/settings-store';

const LEGACY_KEY = 'sk-m0-plaintext-must-not-survive';
const PASSPHRASE = 'a-good-passphrase';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'test-model-1';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-provider-secret-${databases}`;
  resetDatabase(databaseName);
  resetSettingsStore();
});

afterEach(async () => {
  resetSettingsStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/**
 * Write the row EXACTLY as M0 wrote it: a plaintext `apiKey` string in `settings/provider`.
 *
 * Deliberately not `writeProviderSettings({ secret: { kind: 'plaintext' } })`: that would use
 * today's writer, and the migration's whole input is a row produced by the OLD one. Writing
 * the literal shape is what makes this a forward-compatibility test instead of a round trip
 * through the current code.
 */
async function writeLegacyRow(): Promise<void> {
  await write(async (tx) => {
    const row: SettingsRow = {
      id: 'provider',
      value: { baseUrl: BASE_URL, apiKey: LEGACY_KEY, model: MODEL },
    };
    await tx.collection<SettingsRow>(COLLECTIONS.settings).put(row);
  });
}

describe('the plaintext -> encrypted migration', () => {
  it('reads M0 plaintext, seals it, and leaves no plaintext copy anywhere', async () => {
    await writeLegacyRow();

    // The legacy row is read as what it is: a plaintext key, adopted by this tab.
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().provider.secret).toEqual({
      kind: 'plaintext',
      apiKey: LEGACY_KEY,
    });
    expect(useSettingsStore.getState().key).toBe(LEGACY_KEY);
    expect((await snapshotAllRows(databaseName)).split(LEGACY_KEY)).toHaveLength(2);

    // The migration: the user sets a passphrase for the key that is already stored.
    await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();

    const stored = await readProviderSettings();
    expect(stored.secret.kind).toBe('encrypted');
    expect(stored.baseUrl).toBe(BASE_URL);
    expect(stored.model).toBe(MODEL);

    // (b) NO PLAINTEXT LEFT: not in the key slot, not in another field, not in another row.
    // The raw scan is the assertion — one occurrence of the plaintext key in the whole
    // database would fail it, which is what "no plaintext copy behind" has to mean.
    const afterMigration = await snapshotAllRows(databaseName);
    expect(afterMigration).not.toContain(LEGACY_KEY);
    expect(afterMigration).toContain(BASE_URL);
    expect(afterMigration).toContain(MODEL);
    // ...and the envelope really is there, so the assertion above is not vacuous.
    const encrypted = stored.secret;
    if (encrypted.kind !== 'encrypted') throw new Error('the key is not encrypted');
    expect(afterMigration).toContain(encrypted.envelope.ciphertext);
    expect(encrypted.envelope.iterations).toBeGreaterThan(0);

    // (a) THE KEY SURVIVES: a reload starts locked, and the passphrase opens it.
    resetSettingsStore();
    resetDatabase(databaseName);
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().locked).toBe(true);
    expect(useSettingsStore.getState().key).toBeUndefined();
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe(LEGACY_KEY);
    expect(useSettingsStore.getState().locked).toBe(false);
  });

  it('loses nothing when the seal is refused, and rewrites nothing when the passphrase is wrong', async () => {
    await writeLegacyRow();
    await useSettingsStore.getState().load();

    // A refused seal: the policy minimum is enforced before anything is written, so the row
    // is still the plaintext one and the key is still readable.
    await expect(useSettingsStore.getState().encryptStored('short')).resolves.toBe(
      'passphrase-too-short',
    );
    expect((await readProviderSettings()).secret).toEqual({
      kind: 'plaintext',
      apiKey: LEGACY_KEY,
    });
    expect(await snapshotAllRows(databaseName)).toContain(LEGACY_KEY);

    // Now a real migration, so a wrong passphrase has ciphertext to fail against.
    await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();
    const before = await snapshotAllRows(databaseName);

    // A WRONG PASSPHRASE IS A RETRY, NOT A REPAIR: the row is byte-identical afterwards, so
    // the ciphertext (the only copy of the key) cannot have been cleared or re-encrypted.
    useSettingsStore.getState().lock();
    await expect(useSettingsStore.getState().unlock('not the passphrase')).resolves.toBe(
      'wrong-passphrase',
    );
    expect(await snapshotAllRows(databaseName)).toBe(before);
    expect(useSettingsStore.getState().locked).toBe(true);

    // And the right passphrase still works after the failed attempts (no lockout).
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe(LEGACY_KEY);
  });

  it('keeps the envelope while the endpoint is edited with the key locked', async () => {
    await writeLegacyRow();
    await useSettingsStore.getState().load();
    await useSettingsStore.getState().encryptStored(PASSPHRASE);
    const sealed = await readProviderSettings();
    if (sealed.secret.kind !== 'encrypted') throw new Error('the key is not encrypted');
    const ciphertext = sealed.secret.envelope.ciphertext;

    useSettingsStore.getState().lock();
    expect(useSettingsStore.getState().locked).toBe(true);

    // The form cannot express a key it cannot read, so it sends `keep`, and the endpoint and
    // model still save. This is the path a user takes to fix a typo in the base URL.
    await expect(
      useSettingsStore
        .getState()
        .save({ baseUrl: 'https://other.test/v1', model: 'other-model' }, { kind: 'keep' }),
    ).resolves.toBeUndefined();

    const after = await readProviderSettings();
    expect(after.baseUrl).toBe('https://other.test/v1');
    expect(after.model).toBe('other-model');
    expect(after.secret).toEqual({ kind: 'encrypted', envelope: sealed.secret.envelope });
    // Identical ciphertext, not merely "still encrypted": a re-seal would have produced a
    // new envelope, which would have required the passphrase the user was never asked for.
    expect(after.secret.kind === 'encrypted' && after.secret.envelope.ciphertext).toBe(ciphertext);
    expect(await snapshotAllRows(databaseName)).not.toContain(LEGACY_KEY);
  });

  it('re-seals a changed key with the passphrase already open, so only one prompt is needed', async () => {
    await writeLegacyRow();
    await useSettingsStore.getState().load();
    await useSettingsStore.getState().encryptStored(PASSPHRASE);

    // Unlocked: replacing the key needs no passphrase (the session holds the derived key), and
    // the new envelope must open with the SAME passphrase — the salt is reused on purpose.
    await expect(
      useSettingsStore
        .getState()
        .save({ baseUrl: BASE_URL, model: MODEL }, { kind: 'seal', apiKey: 'sk-replaced' }),
    ).resolves.toBeUndefined();

    const replaced = await readProviderSettings();
    expect(replaced.secret.kind).toBe('encrypted');
    expect(await snapshotAllRows(databaseName)).not.toContain('sk-replaced');

    resetSettingsStore();
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().locked).toBe(true);
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe('sk-replaced');
  });
});

describe('the documented plaintext fallback', () => {
  it('stores a key unencrypted when no passphrase was given, and says so in the row', async () => {
    await useSettingsStore.getState().load();
    await expect(
      useSettingsStore
        .getState()
        .save({ baseUrl: BASE_URL, model: MODEL }, { kind: 'plain', apiKey: 'sk-unprotected' }),
    ).resolves.toBeUndefined();

    const stored = await readProviderSettings();
    expect(stored.secret).toEqual({ kind: 'plaintext', apiKey: 'sk-unprotected' });
    // The fallback's own failure mode, stated rather than hidden: the key IS on disk in the
    // clear while no passphrase is set. That is the M0 state, and it is exactly one row.
    expect((await snapshotAllRows(databaseName)).split('sk-unprotected')).toHaveLength(2);
    // The tab can still send, and locking changes nothing: there is nothing to lock.
    expect(useSettingsStore.getState().key).toBe('sk-unprotected');
    useSettingsStore.getState().lock();
    expect(useSettingsStore.getState().key).toBe('sk-unprotected');
    expect(useSettingsStore.getState().locked).toBe(false);
  });

  it('clears the key slot entirely for a local endpoint that needs no key', async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: MODEL }, { kind: 'plain', apiKey: 'sk-temporary' });
    await expect(
      useSettingsStore.getState().save({ baseUrl: BASE_URL, model: MODEL }, { kind: 'clear' }),
    ).resolves.toBeUndefined();

    expect((await readProviderSettings()).secret).toEqual({ kind: 'none' });
    // No `apiKey` field at all, rather than an empty string: the row says "no key" the same
    // way the reader means it (`db/repository.ts`).
    expect(await snapshotAllRows(databaseName)).not.toContain('apiKey');
    expect(useSettingsStore.getState().key).toBeUndefined();
  });

  it('refuses to seal when the stored row holds no plaintext key to seal', async () => {
    await useSettingsStore.getState().load();
    // Nothing stored: there is no key to migrate, and the store says so instead of writing an
    // envelope around nothing.
    await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBe(
      'malformed-envelope',
    );
    expect((await readProviderSettings()).secret).toEqual({ kind: 'none' });
  });
});
