/**
 * The appearance preferences against real IndexedDB (`fake-indexeddb`, M1-G2).
 *
 * WHAT THIS FILE HAS TO PROVE
 * 1. Each setting PERSISTS in its own row: after a restart (a fresh store over the same
 *    database) the choice is read back — and the assertion is on the ROW as well as on
 *    the state, because a store that only changed memory would pass a state-only check.
 * 2. A corrupt or out-of-band stored value FALLS BACK instead of throwing: the documented
 *    default for a wrong type, the nearest bound for a number outside the band. This is
 *    the reader rule (`appearance/appearance.ts`) as the repository applies it.
 * 3. The three settings are INDEPENDENT: writing one leaves the other two rows alone, and
 *    a language switch (a different store, a different row) does not disturb the theme.
 * 4. A `load()` that resolves after a `set*` does NOT revert the user's change (the
 *    `loadToken` guard), and a write that FAILS is reported through `error` rather than
 *    rejecting out of a change handler.
 * 5. What the store WRITES is always what it can READ, including for a caller outside
 *    TypeScript: the setters run their argument through the same parser the reader uses.
 *
 * WHY THE STORE IS REACHED THROUGH `mount`
 * Vitest instantiates a module once per ENVIRONMENT and this workspace mixes them; the
 * store the mounted app reads must be the store a test drives (see `mount.ts`).
 *
 * WHY A "FRESH STORE" IS A RESET AND NOT A NEW MODULE
 * `resetAppearanceStore()` puts the store back into its CONSTRUCTED state, `ready: false`
 * included — which is what a page load produces, and the only honest way to assert
 * "a fresh load reads the rows back".
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FONT_SCALE,
  DEFAULT_MESSAGE_WIDTH,
  DEFAULT_THEME,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  MESSAGE_WIDTH_MAX,
  MESSAGE_WIDTH_MIN,
  type Theme,
} from '../appearance/appearance';
import { readTable, write } from '../db/database';
import * as repository from '../db/repository';
import {
  FONT_SCALE_SETTINGS_ID,
  MESSAGE_WIDTH_SETTINGS_ID,
  type SettingsRow,
  THEME_SETTINGS_ID,
  writeThemeSetting,
} from '../db/repository';
// Taken from `mount` so this file shares ONE module instance with the mounted app; the
// repository helpers come from the module `state/appearance-store.ts` itself imports, so
// `vi.spyOn` below replaces the very function the store calls.
import {
  closeDatabase,
  resetAppearanceStore,
  resetDatabase,
  resetLocaleStore,
  useAppearanceStore,
  useLocaleStore,
} from '../mount';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-appearance-${databases}`;
  resetDatabase(databaseName);
  resetAppearanceStore();
  resetLocaleStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetAppearanceStore();
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

/** The RAW stored value of one row, bypassing every parser. */
async function rawValue(id: string): Promise<unknown> {
  const row = await readTable<SettingsRow>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/** Write a value into a `settings` row, bypassing the typed helpers. */
async function putRaw(id: string, value: unknown): Promise<void> {
  await write(async (tx) => {
    // The cast is the point of this helper: several cases below write values the app
    // would never write (`'BLUE'`, `'1.25'`, `999`) to prove the reader refuses them
    // instead of trusting the row.
    await tx.collection<SettingsRow>(COLLECTIONS.settings).put({ id, value } as SettingsRow);
  });
}

/** A value from outside TypeScript — a stored row read elsewhere, a future caller. */
function untrustedTheme(value: string): Theme {
  return value as unknown as Theme;
}

/** The store's value for the setting `id` names. */
function settingValue(id: string): unknown {
  const state = useAppearanceStore.getState();
  if (id === THEME_SETTINGS_ID) return state.theme;
  if (id === FONT_SCALE_SETTINGS_ID) return state.fontScale;
  return state.messageWidth;
}

describe('state/appearance-store', () => {
  it('persists each setting in its own row and reads them back after a restart', async () => {
    await useAppearanceStore.getState().setTheme('dark');
    await useAppearanceStore.getState().setFontScale(1.25);
    await useAppearanceStore.getState().setMessageWidth(60);
    expect(useAppearanceStore.getState().error).toBeUndefined();

    // The ROWS first: a store that only changed memory would pass a state-only check.
    expect(await rawValue(THEME_SETTINGS_ID)).toBe('dark');
    expect(await rawValue(FONT_SCALE_SETTINGS_ID)).toBe(1.25);
    expect(await rawValue(MESSAGE_WIDTH_SETTINGS_ID)).toBe(60);

    // "Restart": drop the in-memory state, then load again from the SAME database.
    resetAppearanceStore();
    expect(useAppearanceStore.getState().ready).toBe(false);
    expect(useAppearanceStore.getState().theme).toBe(DEFAULT_THEME);

    await useAppearanceStore.getState().load();
    expect(useAppearanceStore.getState().theme).toBe('dark');
    expect(useAppearanceStore.getState().fontScale).toBe(1.25);
    expect(useAppearanceStore.getState().messageWidth).toBe(60);
    expect(useAppearanceStore.getState().ready).toBe(true);
  });

  it('starts from the documented defaults when nothing is stored', async () => {
    await useAppearanceStore.getState().load();
    const state = useAppearanceStore.getState();
    expect(state.theme).toBe(DEFAULT_THEME);
    expect(state.fontScale).toBe(DEFAULT_FONT_SCALE);
    expect(state.messageWidth).toBe(DEFAULT_MESSAGE_WIDTH);
    expect(state.ready).toBe(true);
    expect(state.error).toBeUndefined();
  });

  it.each([
    [THEME_SETTINGS_ID, 'BLUE', DEFAULT_THEME],
    [THEME_SETTINGS_ID, 42, DEFAULT_THEME],
    [THEME_SETTINGS_ID, null, DEFAULT_THEME],
    // A string in a numeric row is a writer bug, exactly like `'EN'` for a locale.
    [FONT_SCALE_SETTINGS_ID, '1.25', DEFAULT_FONT_SCALE],
    [FONT_SCALE_SETTINGS_ID, null, DEFAULT_FONT_SCALE],
    [MESSAGE_WIDTH_SETTINGS_ID, '85', DEFAULT_MESSAGE_WIDTH],
    [MESSAGE_WIDTH_SETTINGS_ID, true, DEFAULT_MESSAGE_WIDTH],
  ])('falls back instead of throwing for a corrupt %s row (%j)', async (id, stored, expected) => {
    await putRaw(id, stored);
    await expect(useAppearanceStore.getState().load()).resolves.toBeUndefined();
    expect(settingValue(id)).toBe(expected);
  });

  it.each([
    [FONT_SCALE_SETTINGS_ID, 99, FONT_SCALE_MAX],
    [FONT_SCALE_SETTINGS_ID, -3, FONT_SCALE_MIN],
    [MESSAGE_WIDTH_SETTINGS_ID, 1000, MESSAGE_WIDTH_MAX],
    [MESSAGE_WIDTH_SETTINGS_ID, 0, MESSAGE_WIDTH_MIN],
  ])('clamps an out-of-band %s row (%j) to the nearest bound', async (id, stored, expected) => {
    await putRaw(id, stored);
    await useAppearanceStore.getState().load();
    expect(settingValue(id)).toBe(expected);
  });

  it('writes only the row the changed setting owns', async () => {
    await useAppearanceStore.getState().setTheme('dark');
    await useAppearanceStore.getState().setFontScale(1.25);
    // The font-scale write must not have rewritten the theme row (nor cleared it).
    expect(await rawValue(THEME_SETTINGS_ID)).toBe('dark');
    expect(await rawValue(FONT_SCALE_SETTINGS_ID)).toBe(1.25);

    await useAppearanceStore.getState().setMessageWidth(60);
    expect(await rawValue(THEME_SETTINGS_ID)).toBe('dark');
    expect(await rawValue(FONT_SCALE_SETTINGS_ID)).toBe(1.25);
    expect(await rawValue(MESSAGE_WIDTH_SETTINGS_ID)).toBe(60);
  });

  it('does not disturb the theme when the language changes', async () => {
    // Two features, two stores, two rows: the appearance section shares the setup SCREEN
    // with the language picker and nothing else, and this is the assertion that says so.
    await useAppearanceStore.getState().setTheme('dark');
    await useLocaleStore.getState().setLocale('en');

    expect(useAppearanceStore.getState().theme).toBe('dark');
    expect(await rawValue(THEME_SETTINGS_ID)).toBe('dark');
    // And the other way round: an appearance change leaves the language alone.
    await useAppearanceStore.getState().setFontScale(1.25);
    expect(useLocaleStore.getState().locale).toBe('en');
  });

  it('does not let a late load revert a change the user already made', async () => {
    // The row says light; the user moves the picker before that read answers.
    await writeThemeSetting('light');
    const loading = useAppearanceStore.getState().load();
    await useAppearanceStore.getState().setTheme('dark');
    await loading;

    // The change is newer than the row the read saw, so it wins.
    expect(useAppearanceStore.getState().theme).toBe('dark');
  });

  it('reports a failed write through the store instead of rejecting', async () => {
    // The write is the only thing stubbed: the point is what `setFontScale` does when the
    // storage layer fails, not whether Dexie can be made to fail on demand.
    vi.spyOn(repository, 'writeFontScaleSetting').mockRejectedValue(
      new DOMException('quota', 'QuotaExceededError'),
    );

    await expect(useAppearanceStore.getState().setFontScale(1.25)).resolves.toBeUndefined();
    // The change STANDS (the user asked for it) and the failure is reportable.
    expect(useAppearanceStore.getState().fontScale).toBe(1.25);
    expect(useAppearanceStore.getState().error).toBe('QuotaExceededError');
  });

  it('clears a previous failure once a write succeeds', async () => {
    const writing = vi
      .spyOn(repository, 'writeMessageWidthSetting')
      .mockRejectedValueOnce(new Error('transient'));
    await useAppearanceStore.getState().setMessageWidth(60);
    expect(useAppearanceStore.getState().error).toBe('Error');

    writing.mockRestore();
    await useAppearanceStore.getState().setMessageWidth(70);
    expect(useAppearanceStore.getState().error).toBeUndefined();
    expect(await rawValue(MESSAGE_WIDTH_SETTINGS_ID)).toBe(70);
  });

  it('clamps what a caller passes, so a row it writes is always a row it can read', async () => {
    await useAppearanceStore.getState().setFontScale(99);
    await useAppearanceStore.getState().setMessageWidth(1);
    expect(useAppearanceStore.getState().fontScale).toBe(FONT_SCALE_MAX);
    expect(useAppearanceStore.getState().messageWidth).toBe(MESSAGE_WIDTH_MIN);
    expect(await rawValue(FONT_SCALE_SETTINGS_ID)).toBe(FONT_SCALE_MAX);
    expect(await rawValue(MESSAGE_WIDTH_SETTINGS_ID)).toBe(MESSAGE_WIDTH_MIN);

    // The same totality for the enum: a value from outside TypeScript cannot write a row
    // the reader would then refuse.
    await useAppearanceStore.getState().setTheme(untrustedTheme('BLUE'));
    expect(useAppearanceStore.getState().theme).toBe(DEFAULT_THEME);
    expect(await rawValue(THEME_SETTINGS_ID)).toBe(DEFAULT_THEME);
  });
});
