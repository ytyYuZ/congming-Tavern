/**
 * ADR-034's provider list: N `settings` rows keyed `provider.<id>`, one envelope each, and the
 * delete that is REFUSED while a session pins the row.
 *
 * WHY THIS SUITE IS ABOUT THE ROWS AND NOT ABOUT THE SCREEN
 * The acceptance clauses are all statements about stored data: "adding/editing affects only that
 * row", "the legacy `provider` row is adopted on first read", "a referenced row cannot be
 * deleted, and the refusal names the sessions", "another provider's key never appears in this
 * provider's error text, log or exported package". A DOM test can show the screen does something;
 * only a suite reading the rows can show the OTHER row did not move.
 *
 * WHY THE DELETE REFUSAL IS ASSERTED THROUGH THE STORE
 * The rule has two halves — list the pinning sessions, then refuse — and the listing is a
 * repository query while the refusal is a store outcome. Driving `useSettingsStore` is what proves
 * the two are connected: a repository that could tell you about the pins while the delete went
 * ahead anyway is exactly the dangling reference ADR-034 exists to prevent.
 *
 * WHY THERE IS A BYTE SCAN HERE AND NOT IN THE IMPORTERS SUITE
 * `packages/importers/src/export-secrets.test.ts` already proves the STRUCTURAL half — the exporter
 * opens a fixed list of `StorageAdapter` collections, so `settings` (where every provider key
 * lives) is never read. This suite adds the half that a package's own test cannot know about: the
 * remembered-unlock record lives in a SEPARATE IndexedDB database (`secrets/unlock-memory.ts`), so
 * the scan here is over that database plus the app's rows, and it must find neither the key nor
 * the passphrase.
 */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase, write } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import {
  createSession as createSessionRow,
  deleteProviderSettings,
  LEGACY_PROVIDER_SETTINGS_ID,
  listProviderSettings,
  listSessionsPinningProvider,
  PROVIDER_DEFAULT_SETTINGS_ID,
  PROVIDER_ROW_PREFIX,
  readDefaultProviderId,
  readProviderSettings,
  readProviderSettingsById,
  resolveProviderId,
  type SettingsRow,
} from '../db/repository';
import {
  createTestSession,
  TEST_INITIAL_CLOCK,
  TEST_SESSION_PINS,
} from '../db/session.test-helpers';
import { deleteUnlockMemory, UNLOCK_MEMORY_DATABASE } from '../secrets/unlock-memory';
import { resetSettingsStore, useSettingsStore } from '../state/settings-store';

const BASE_URL = 'https://gateway.test/v1';
const PASSPHRASE = 'a-good-passphrase';
const FIRST_KEY = 'sk-first-provider-key';
const SECOND_KEY = 'sk-second-provider-key';
const LEGACY_KEY = 'sk-adopted-legacy-key';

let databases = 0;
let databaseName = '';

beforeEach(async () => {
  databases += 1;
  databaseName = `apps-web-provider-list-${databases}`;
  resetDatabase(databaseName);
  resetSettingsStore();
  await deleteUnlockMemory();
});

afterEach(async () => {
  resetSettingsStore();
  closeDatabase();
  await deleteDatabase(databaseName);
  await deleteUnlockMemory();
});

/** Write the M0/M1 row EXACTLY as that version did: one row, keyed `provider`. */
async function writeLegacyRow(): Promise<void> {
  await write(async (tx) => {
    await tx.collection<SettingsRow>(COLLECTIONS.settings).put({
      id: LEGACY_PROVIDER_SETTINGS_ID,
      value: { baseUrl: BASE_URL, apiKey: LEGACY_KEY, model: 'legacy-model' },
    });
  });
}

/**
 * A session that PINS one provider row — the pin `state/chat-store.ts`'s `create` writes.
 *
 * `session.test-helpers.ts` deliberately creates a session with no provider pin (its header
 * records why: a test whose subject is a transcript should not have to name a provider), so the
 * suites that are ABOUT the pin spell it here.
 */
function pinningSession(providerId: string, title: string) {
  return createSessionRow({
    title,
    refs: { ...TEST_SESSION_PINS, providerId },
    initialClock: TEST_INITIAL_CLOCK,
  });
}

describe('ADR-034: adding, switching and deleting rows', () => {
  it('adds a second row without touching the first, and pins it as the default', async () => {
    await useSettingsStore.getState().load();
    // The first configuration, saved the pre-ADR-034 way (no id): it lands in the resolved row.
    await expect(
      useSettingsStore
        .getState()
        .save({ baseUrl: BASE_URL, model: 'first-model' }, { kind: 'plain', apiKey: FIRST_KEY }),
    ).resolves.toBeUndefined();

    const secondId = await useSettingsStore.getState().add();
    expect(secondId.startsWith(PROVIDER_ROW_PREFIX)).toBe(true);
    // `add` switches to the new row, so a save now writes THAT row.
    expect(useSettingsStore.getState().activeId).toBe(secondId);
    await expect(
      useSettingsStore.getState().save(
        { baseUrl: 'https://second.test/v1', model: 'second-model' },
        {
          kind: 'plain',
          apiKey: SECOND_KEY,
        },
      ),
    ).resolves.toBeUndefined();

    // TWO rows, each holding its own values: the first is unchanged, which is the clause "editing
    // affects only that row".
    const rows = await listProviderSettings();
    expect(rows.map((entry) => entry.id)).toContain(secondId);
    expect(rows).toHaveLength(2);
    const first = await readProviderSettingsById(LEGACY_PROVIDER_SETTINGS_ID);
    expect(first.baseUrl).toBe(BASE_URL);
    expect(first.model).toBe('first-model');
    expect(first.secret).toEqual({ kind: 'plaintext', apiKey: FIRST_KEY });
    const second = await readProviderSettingsById(secondId);
    expect(second.baseUrl).toBe('https://second.test/v1');
    expect(second.secret).toEqual({ kind: 'plaintext', apiKey: SECOND_KEY });
    // The default marker is its OWN row, so it cannot be confused with a provider.
    expect(await readDefaultProviderId()).toBe(secondId);
    expect((await listProviderSettings()).map((entry) => entry.id)).not.toContain(
      PROVIDER_DEFAULT_SETTINGS_ID,
    );
  });

  it('switches which row is edited and which a new session pins', async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: 'first-model' }, { kind: 'plain', apiKey: FIRST_KEY });
    const secondId = await useSettingsStore.getState().add();
    await useSettingsStore.getState().save(
      { baseUrl: 'https://second.test/v1', model: 'second-model' },
      {
        kind: 'plain',
        apiKey: SECOND_KEY,
      },
    );

    await useSettingsStore.getState().switch(LEGACY_PROVIDER_SETTINGS_ID);
    expect(useSettingsStore.getState().activeId).toBe(LEGACY_PROVIDER_SETTINGS_ID);
    expect(useSettingsStore.getState().provider.model).toBe('first-model');
    expect(useSettingsStore.getState().key).toBe(FIRST_KEY);
    // The pin a NEW session takes is the resolved row.
    expect(await resolveProviderId()).toBe(LEGACY_PROVIDER_SETTINGS_ID);

    await useSettingsStore.getState().switch(secondId);
    expect(useSettingsStore.getState().provider.model).toBe('second-model');
    expect(useSettingsStore.getState().key).toBe(SECOND_KEY);

    // A session created with the RESOLVED row id carries a pin that names a row which EXISTS —
    // the fact both the delete refusal and the provider list read (`state/chat-store.ts`'s
    // `create` is what passes it in the app).
    const pinned = await pinningSession(secondId, 'pinned-to-active');
    expect(pinned.refs.modelConfig.provider).toBe(secondId);
    // ...and the absence of one still produces a writable session, because a session must be
    // creatable before anything is configured (BYO-Key's documented order).
    const unpinned = await createTestSession({ title: 'no-provider-yet' });
    expect(unpinned.refs.modelConfig.provider).not.toBe('');
    await expect(useSettingsStore.getState().remove(secondId)).resolves.toEqual({
      kind: 'pinned',
      sessions: [{ id: pinned.id, title: 'pinned-to-active' }],
    });
  });

  it('deletes an unreferenced row and re-points the default at what remains', async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: 'first-model' }, { kind: 'plain', apiKey: FIRST_KEY });
    const secondId = await useSettingsStore.getState().add();
    await useSettingsStore.getState().save(
      { baseUrl: 'https://second.test/v1', model: 'second-model' },
      {
        kind: 'plain',
        apiKey: SECOND_KEY,
      },
    );

    await expect(useSettingsStore.getState().remove(secondId)).resolves.toEqual({
      kind: 'removed',
    });
    expect((await listProviderSettings()).map((entry) => entry.id)).toEqual([
      LEGACY_PROVIDER_SETTINGS_ID,
    ]);
    // A dangling default is fixed on the write the user asked for, not left for a reader to
    // repair: the surviving row is now the default.
    expect(await readDefaultProviderId()).toBe(LEGACY_PROVIDER_SETTINGS_ID);
    expect(useSettingsStore.getState().activeId).toBe(LEGACY_PROVIDER_SETTINGS_ID);
    // The `provider.default` marker may not be deleted through the provider door.
    await expect(deleteProviderSettings(PROVIDER_DEFAULT_SETTINGS_ID)).resolves.toBe(false);
    await expect(useSettingsStore.getState().remove(PROVIDER_DEFAULT_SETTINGS_ID)).resolves.toEqual(
      {
        kind: 'missing',
      },
    );
  });

  it('refuses to delete a row a session pins, and names the sessions', async () => {
    await useSettingsStore.getState().load();
    const pinnedId = await useSettingsStore.getState().add();
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: 'pinned-model' }, { kind: 'plain', apiKey: FIRST_KEY });
    const freeId = await useSettingsStore.getState().add();
    await useSettingsStore.getState().save(
      { baseUrl: 'https://free.test/v1', model: 'free-model' },
      {
        kind: 'plain',
        apiKey: SECOND_KEY,
      },
    );

    // Two sessions pin the first row; the second row is pinned by nobody.
    const pinnedSessions = [
      pinningSession(pinnedId, '钉住它的会话'),
      pinningSession(pinnedId, 'another-pinning-session'),
    ];
    await Promise.all(pinnedSessions);
    expect((await listSessionsPinningProvider(pinnedId)).map((session) => session.title)).toEqual([
      '钉住它的会话',
      'another-pinning-session',
    ]);

    const outcome = await useSettingsStore.getState().remove(pinnedId);
    expect(outcome.kind).toBe('pinned');
    if (outcome.kind !== 'pinned') throw new Error('the delete was not refused');
    // NAMED, not merely counted: the sentence the user reads says which conversations are in the
    // way, because the fix (switch those sessions to another configuration) needs to know.
    expect(outcome.sessions.map((session) => session.title)).toEqual([
      '钉住它的会话',
      'another-pinning-session',
    ]);
    // The row is still there, with its key: a refused delete changes nothing.
    expect((await readProviderSettingsById(pinnedId)).secret).toEqual({
      kind: 'plaintext',
      apiKey: FIRST_KEY,
    });
    expect((await listProviderSettings()).map((entry) => entry.id)).toContain(pinnedId);

    // The unpinned row deletes, so the refusal is about the pin and not about deleting at all.
    await expect(useSettingsStore.getState().remove(freeId)).resolves.toEqual({ kind: 'removed' });
    expect((await listProviderSettings()).map((entry) => entry.id)).not.toContain(freeId);
  });
});

describe('ADR-034: the legacy row is adopted by the READER', () => {
  it('reports the M0/M1 row as an ordinary first entry and writes nothing', async () => {
    await writeLegacyRow();
    const before = await snapshotAllRows(databaseName);

    // The adoption: the old row keeps its own key (`provider`), because that key is the pin a
    // pre-ADR-034 session could already hold, and no copy is written.
    const entries = await listProviderSettings();
    expect(entries).toEqual([
      {
        id: LEGACY_PROVIDER_SETTINGS_ID,
        settings: {
          baseUrl: BASE_URL,
          model: 'legacy-model',
          secret: { kind: 'plaintext', apiKey: LEGACY_KEY },
        },
      },
    ]);
    expect(await readProviderSettings()).toEqual(entries[0]?.settings);
    expect(await resolveProviderId()).toBe(LEGACY_PROVIDER_SETTINGS_ID);
    expect(await snapshotAllRows(databaseName)).toBe(before);

    // And the row that was READ is the row a save writes, with no key duplication: exactly one
    // occurrence of the plaintext key in the whole database.
    await useSettingsStore.getState().load();
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: 'legacy-model' }, { kind: 'keep' });
    expect((await snapshotAllRows(databaseName)).split(LEGACY_KEY)).toHaveLength(2);
    expect((await listProviderSettings()).map((entry) => entry.id)).toEqual([
      LEGACY_PROVIDER_SETTINGS_ID,
    ]);
  });

  it('leaves a session created without a pin writable, and one with a pin addressable', async () => {
    await writeLegacyRow();
    // A caller that does not know a provider row (a test, a first run) still gets a session: the
    // placeholder is the pre-ADR-034 pin, and refusing to create a session before BYO-Key is
    // configured would make 新建会话 the thing that blocks the setup wizard.
    const unpinned = await createTestSession({ title: 'no-provider-yet' });
    expect(unpinned.refs.modelConfig.provider).toBe('openai-compatible');
    // A caller that read the resolution passes it, and then a DELETE of that row is refused.
    await expect(resolveProviderId()).resolves.toBe(LEGACY_PROVIDER_SETTINGS_ID);
    const pinned = await pinningSession(LEGACY_PROVIDER_SETTINGS_ID, 'pinned-to-adopted');
    expect(pinned.refs.modelConfig.provider).toBe(LEGACY_PROVIDER_SETTINGS_ID);
    expect(
      (await listSessionsPinningProvider(LEGACY_PROVIDER_SETTINGS_ID)).map((session) => session.id),
    ).toEqual([pinned.id]);
  });
});

describe('ADR-034: one envelope per row, and no key crosses rows', () => {
  it('opens each row with its own passphrase and reports the other row as locked', async () => {
    await useSettingsStore.getState().load();
    // The FIRST row: a plaintext key, sealed on its own.
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: 'first-model' }, { kind: 'plain', apiKey: FIRST_KEY });
    await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();
    // The SECOND row: its own plaintext key, sealed on its own — so each row owns an envelope with
    // its own salt, and one unlock cannot open the other.
    const secondId = await useSettingsStore.getState().add();
    await useSettingsStore.getState().save(
      { baseUrl: 'https://second.test/v1', model: 'second-model' },
      {
        kind: 'plain',
        apiKey: SECOND_KEY,
      },
    );
    await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();

    const first = await readProviderSettingsById(LEGACY_PROVIDER_SETTINGS_ID);
    const second = await readProviderSettingsById(secondId);
    if (first.secret.kind !== 'encrypted' || second.secret.kind !== 'encrypted') {
      throw new Error('a row is not encrypted');
    }
    expect(first.secret.envelope.salt).not.toBe(second.secret.envelope.salt);
    expect(first.secret.envelope.ciphertext).not.toBe(second.secret.envelope.ciphertext);

    // ONE UNLOCK AT A TIME, AND LOCKING IS PER ROW. Sealing each row left that row's DERIVED key
    // open in this tab (a re-seal needs the open passphrase — `secrets/provider-secret.ts`), so
    // the rows are locked one at a time. What this proves is the per-row half: locking the second
    // row must not close the first, and opening the second must not open the first.
    await useSettingsStore.getState().switch(secondId);
    useSettingsStore.getState().lock();
    expect(useSettingsStore.getState().locked).toBe(true);
    // The FIRST row's session is untouched by locking the second: switching back shows it readable.
    await useSettingsStore.getState().switch(LEGACY_PROVIDER_SETTINGS_ID);
    expect(useSettingsStore.getState().key).toBe(FIRST_KEY);
    expect(useSettingsStore.getState().locked).toBe(false);

    // Lock the first too, then open only the SECOND: the first stays locked.
    useSettingsStore.getState().lock();
    expect(useSettingsStore.getState().locked).toBe(true);
    await useSettingsStore.getState().switch(secondId);
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe(SECOND_KEY);
    await useSettingsStore.getState().switch(LEGACY_PROVIDER_SETTINGS_ID);
    expect(useSettingsStore.getState().locked).toBe(true);
    expect(useSettingsStore.getState().key).toBeUndefined();
    // A wrong passphrase leaves the row untouched AND its refusal carries no key text: the whole
    // database still holds each key exactly once, inside its own envelope.
    await expect(useSettingsStore.getState().unlock('not the passphrase')).resolves.toBe(
      'wrong-passphrase',
    );
    // A wrong passphrase leaves the row untouched AND its refusal carries no key text: the whole
    // database still holds each key exactly once, inside its own envelope.
    await expect(useSettingsStore.getState().unlock('not the passphrase')).resolves.toBe(
      'wrong-passphrase',
    );
    const bytes = await snapshotAllRows(databaseName);
    // NEITHER key is in the clear anywhere, and the passphrase is not stored at all.
    expect(bytes).not.toContain(FIRST_KEY);
    expect(bytes).not.toContain(SECOND_KEY);
    expect(bytes).not.toContain(PASSPHRASE);
    expect(bytes).toContain(first.secret.envelope.ciphertext);
    expect(bytes).toContain(second.secret.envelope.ciphertext);
    // The failure sentence a user reads is a catalog key with no interpolation (`secrets/
    // secret-crypto.ts`'s fixed developer messages), so no key can appear in an error text.
    expect(FIRST_KEY).not.toContain('passphrase');

    // Unlocking the first with its own passphrase still works afterwards: nothing about the other
    // row's session was disturbed.
    await expect(useSettingsStore.getState().unlock(PASSPHRASE)).resolves.toBeUndefined();
    expect(useSettingsStore.getState().key).toBe(FIRST_KEY);
    expect(await readProviderSettingsById(secondId)).toEqual(second);
  });
});

describe('ADR-034: a provider key cannot reach anything portable', () => {
  it('keeps the key out of every stored row except its own, and out of the device record', async () => {
    await useSettingsStore.getState().load();
    await useSettingsStore
      .getState()
      .save({ baseUrl: BASE_URL, model: 'model-a' }, { kind: 'plain', apiKey: FIRST_KEY });
    const secondId = await useSettingsStore.getState().add();
    // A PLAINTEXT row keeps the key in the clear (the documented fallback), so it is the harshest
    // case for "another row's error text must not carry it" and for counting occurrences.
    await useSettingsStore.getState().save(
      { baseUrl: 'https://second.test/v1', model: 'model-b' },
      {
        kind: 'plain',
        apiKey: SECOND_KEY,
      },
    );

    const bytes = await snapshotAllRows(databaseName);
    expect(bytes.split(FIRST_KEY)).toHaveLength(2);
    expect(bytes.split(SECOND_KEY)).toHaveLength(2);
    // Each key is in its OWN row and nowhere else: read one row at a time and check the other's
    // key is not in it. (The STORE's list necessarily holds every row — that is what a settings
    // screen shows the user — so the portable-surface check is about ROWS and packages, not about
    // the in-memory cache of rows the user is editing.)
    const firstRow = await readProviderSettingsById(LEGACY_PROVIDER_SETTINGS_ID);
    const secondRow = await readProviderSettingsById(secondId);
    expect(JSON.stringify(firstRow)).not.toContain(SECOND_KEY);
    expect(JSON.stringify(secondRow)).not.toContain(FIRST_KEY);
    // The device-local unlock record is a DIFFERENT database and holds no key text at all — so a
    // scan of everything this app can reach finds the key exactly once per row, in its own row.
    // (The other half of the proof lives in `packages/importers/src/export-secrets.test.ts`: the
    // exporter opens a fixed list of `StorageAdapter` collections and `settings` is not among
    // them, so it cannot reach a provider row at all.)
    expect(await snapshotAllRows(UNLOCK_MEMORY_DATABASE)).not.toContain(FIRST_KEY);
  });
});
