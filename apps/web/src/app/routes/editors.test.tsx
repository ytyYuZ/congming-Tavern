/**
 * The two card editors as a SCREEN (M1-W1 / M1-C1): a form that writes through a store action.
 *
 * WHY A DOM TEST ON TOP OF THE STORE'S STORAGE ROUND TRIP
 * `state/content-store.test.ts` proves the transitions and the rows; it cannot see whether a
 * CONTROL is wired to them. A `data-field` marker with no handler, a button that calls the wrong
 * action or a subscription that never re-renders are all invisible to a store test and obvious to
 * a user, so this file drives the real screen: it mounts the real `<App/>` at the real path, types
 * into the real input, clicks the real button, and then asserts on the ROW that resulted.
 *
 * WHY THESE ASSERTIONS ARE ABOUT STORAGE AND NOT ABOUT THE DOM
 * A value on screen proves the component rendered something; only the row proves the gesture was
 * saved. So every step ends at `db/repository.ts`: the create form produces a `worlds` row, one
 * keystroke in the editor produces a DRAFT row, and 「发布新版本」 produces version 2 while leaving
 * version 1 byte-identical (ADR-010).
 *
 * WHY THE HARNESS IS LOCAL AND SMALL
 * `routes.test.tsx` has a larger one tuned to the play screen's timing (streaming, checkpoints,
 * the sibling switcher). This file needs four helpers, and sharing them would mean either moving
 * that file's harness — an 1800-line suite whose teardown order is load-bearing — or importing a
 * harness with behaviour this screen never exercises.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { FetchLike } from '@smarttavern/providers';
import type { JsonValue } from '@smarttavern/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { closeDatabase, readTable, resetDatabase } from '../../db/database';
import { deleteDatabase } from '../../db/raw-indexeddb.test-helpers';
import {
  characterDraftId,
  getWorld,
  getWorldVersion,
  listWorlds,
  worldDraftId,
  writeLocaleSetting,
} from '../../db/repository';
// The stores come from `mount`, not from `state/*`: Vitest instantiates a module per environment,
// and a store reached through another graph would be a different object from the one the mounted
// views read (see `mount.ts`'s re-export note).
import {
  configureChat,
  resetChat,
  resetContentStore,
  resetLocaleStore,
  resetSettingsStore,
  useLocaleStore,
} from '../../mount';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;

/** A transport that fails loudly: no screen under test sends anything. */
const forbiddenTransport: FetchLike = () =>
  Promise.reject(new Error('no transport was substituted for this test'));

const originalScrollTo = window.scrollTo;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => undefined;
});

afterAll(() => {
  window.scrollTo = originalScrollTo;
});

beforeEach(async () => {
  databases += 1;
  databaseName = `apps-web-editors-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  configureChat({ transport: forbiddenTransport });
  // This file asserts RENDERED Chinese labels, exactly as `routes.test.tsx` does, so the language
  // is pinned through the STORED row (which the shell's own `load()` adopts) and in memory.
  await writeLocaleSetting('zh-CN');
  useLocaleStore.setState({ locale: 'zh-CN' });
});

afterEach(async () => {
  await unmount();
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ───────────────────────────── the local harness ─────────────────────────── */

async function mountAt(path: string, expected: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  container = host;
  const router = createAppRouter(path);
  await act(async () => {
    root = createRoot(host);
    root.render(<App router={router} />);
  });
  await waitForText(host, expected);
  await settle();
  return host;
}

/*
 * The helpers below take an `Element` rather than an `HTMLElement`: a test that scopes a click to
 * one section (`[data-list="world-regions"]`) holds the result of `querySelector`, and everything
 * they do — `textContent`, `querySelector`, `querySelectorAll` — is `Element` API.
 */
async function waitForText(host: Element, expected: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((host.textContent ?? '').includes(expected)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected}; DOM was: ${host.innerHTML}`);
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function unmount(): Promise<void> {
  const current = root;
  root = undefined;
  if (current !== undefined) {
    await act(async () => {
      current.unmount();
    });
  }
  container?.remove();
  container = undefined;
}

/** Type into a controlled field the way a browser does (the value tracker needs the native setter). */
async function typeInto(host: Element, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error(`no field ${selector}`);
  }
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Click the button whose label is exactly `label`. */
async function clickButton(host: Element, label: string): Promise<void> {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** One `settings` row's value, read the way the draft reader reads it. */
async function storedValue(id: string): Promise<JsonValue | undefined> {
  const row = await readTable<{ id: string; value: JsonValue }>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/** Wait until `read` answers something truthy (a row that lands after a fire-and-forget write). */
async function waitForRow<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await settle();
  }
  throw new Error('timed out waiting for a stored row');
}

/* ────────────────────────────────── worlds ───────────────────────────────── */

describe('the world editor', () => {
  it('creates from the library, autosaves into the draft ROW, and publishes a new version', async () => {
    const host = await mountAt('/worlds', '新建世界卡');
    // The empty library says so rather than showing nothing.
    expect(host.textContent).toContain('还没有世界卡。');

    await typeInto(host, '#world-name', '霜月群岛');
    await clickButton(host, '新建世界卡');

    // The editor rendered, and it is showing the PUBLISHED payload (no draft row yet).
    await waitForText(host, '发布新版本');
    const worlds = await listWorlds();
    expect(worlds).toHaveLength(1);
    const worldId = worlds[0]?.id ?? '';
    expect(worlds[0]?.name).toBe('霜月群岛');
    expect(await storedValue(worldDraftId(worldId))).toBeUndefined();
    const publishedBefore = JSON.stringify(await getWorldVersion(worldId, 1));

    // ONE KEYSTROKE, and the draft row holds it — this is 「自动保存可用」.
    await typeInto(host, '[data-field="world-name"]', '银松群岛');
    const draft = await waitForRow(async () => storedValue(worldDraftId(worldId)));
    expect(JSON.stringify(draft)).toContain('银松群岛');
    // ...while the published version did not move (ADR-010).
    expect(JSON.stringify(await getWorldVersion(worldId, 1))).toBe(publishedBefore);
    // The status line names the version the draft came from and the one a publish would create.
    expect(host.querySelector('[data-status="draft-base"]')?.textContent).toContain('v1');
    // The validation panel is always visible, and this payload has nothing wrong with it.
    expect(host.querySelector('[data-status="issues-none"]')).not.toBeNull();

    await clickButton(host, '发布新版本');
    const second = await waitForRow(() => getWorldVersion(worldId, 2));
    expect(second.data.name).toBe('银松群岛');
    expect(second.lineage?.parentVersion).toBe(1);
    expect(await storedValue(worldDraftId(worldId))).toBeUndefined();
    expect((await getWorld(worldId))?.headVersion).toBe(2);
  });

  it('renders a list row per region, and adds and removes one through the row', async () => {
    const host = await mountAt('/worlds', '新建世界卡');
    await typeInto(host, '#world-name', 'w');
    await clickButton(host, '新建世界卡');
    await waitForText(host, '发布新版本');

    const regions = host.querySelector('[data-list="world-regions"]');
    expect(regions).not.toBeNull();
    if (regions === null) return;
    expect(regions.textContent).toContain('暂无条目');

    await clickButton(regions, '添加');
    expect(regions.querySelector('[data-field="region-0-name"]')).not.toBeNull();
    await typeInto(host, '[data-field="region-0-name"]', '银松镇');

    const worlds = await listWorlds();
    const worldId = worlds[0]?.id ?? '';
    const draft = await waitForRow(async () => storedValue(worldDraftId(worldId)));
    expect(JSON.stringify(draft)).toContain('银松镇');

    await clickButton(regions, '删除');
    expect(regions.querySelector('[data-field="region-0-name"]')).toBeNull();
  });
});

/* ──────────────────────────────── characters ─────────────────────────────── */

describe('the character editor', () => {
  it('creates a card and renders the ST, voice and visual groups with no identity field', async () => {
    const host = await mountAt('/characters', '新建角色卡');
    expect(host.textContent).toContain('还没有角色卡。');

    await typeInto(host, '#character-name', '莉安');
    await clickButton(host, '新建角色卡');
    await waitForText(host, '发布新版本');

    // The three M1-C1 groups, and the ST field names (verbatim upstream names, so the mapping I1
    // will write has something stable to read).
    expect(host.textContent).toContain('发言档案');
    expect(host.textContent).toContain('视觉档案');
    expect(host.querySelector('[data-field="character-first_mes"]')).not.toBeNull();
    expect(host.querySelector('[data-field="character-post_history_instructions"]')).not.toBeNull();
    expect(host.querySelector('[data-field="voice-desire"]')).not.toBeNull();
    expect(host.querySelector('[data-field="appearance-hair"]')).not.toBeNull();
    expect(host.querySelector('[data-field="visual-seed-policy"]')).not.toBeNull();

    // ADR-010's absence, made legible: the hint explains it and no such control exists.
    expect(host.textContent).toContain('身份由会话决定');
    for (const forbidden of ['isPlayer', '玩家角色', '卡司标记']) {
      expect(host.querySelector(`[data-field="${forbidden}"]`)).toBeNull();
    }

    // A voice edit autosaves like every other field.
    await typeInto(host, '[data-field="voice-desire"]', '80');
    const characters = await readTable<{ id: string; name: string }>(
      COLLECTIONS.characters,
    ).toArray();
    const characterId = characters[0]?.id ?? '';
    const draft = await waitForRow(async () => storedValue(characterDraftId(characterId)));
    expect(JSON.stringify(draft)).toContain('"desire":80');
  });
});
