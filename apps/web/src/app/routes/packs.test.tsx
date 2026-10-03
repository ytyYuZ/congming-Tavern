/**
 * The `/packs` page in a real DOM (M1-A4).
 *
 * WHY A REAL RENDER AND NOT A STATIC ONE
 * Same two reasons `routes.test.tsx` gives: a static render runs no effects, so the page's own
 * `loadWorlds`/`loadCharacters` never fire, and Zustand v5 hands React `getInitialState` as the
 * server snapshot — the assertions would pass against a view that ignores everything the test
 * seeded. So the real `<App/>` is mounted at `/packs` through the real router.
 *
 * WHAT THIS FILE IS FOR, GIVEN THE OTHER TWO
 * `packs/pack.test.ts` and `packs/pack-preview.test.ts` prove the round trip and the rollback at
 * the database. Neither can prove the thing the acceptance test actually hit: that a PERSON can
 * reach a pack from the app. So the assertions here are the ones only a mounted page can make —
 * the route exists and renders, the example button produces a REAL import, the report is on
 * screen BEFORE anything is written, the library is still empty at that moment, and the page
 * then links to what arrived.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { EXAMPLE_IDS } from '@smarttavern/importers';
import type { FetchLike } from '@smarttavern/providers';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { deleteDatabase } from '../../db/raw-indexeddb.test-helpers';
import { listCharacters, listSessions, listWorlds, writeLocaleSetting } from '../../db/repository';
import {
  closeDatabase,
  configureChat,
  resetChat,
  resetDatabase,
  resetLocaleStore,
  resetSettingsStore,
  useLocaleStore,
} from '../../mount';

/* The copy the page renders, in the language this file pins. */
const PAGE_TITLE = '内容包';
const CLI_GAP = '命令行的 stpack 写入的是 JSON 文件库';
const EXAMPLE_BUTTON = '导入示例内容包';
const PREVIEW_TITLE = '导入报告（尚未写入）';
const CONFIRM = '确认导入';
const RESULT_TITLE = '导入结果';
const OPEN_WORLDS = '打开世界库';
const OPEN_CHARACTERS = '打开角色库';
const START_EXAMPLE = '用示例开局';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;

/** A transport that fails loudly, so a turn nobody asked for is an error and not a no-op. */
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
  databaseName = `apps-web-packs-routes-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  configureChat({ transport: forbiddenTransport });
  // The page's copy is asserted, so the language is pinned the way a returning user's is: by
  // writing the STORED row, which the shell's own mount effect then adopts.
  await writeLocaleSetting('zh-CN');
  useLocaleStore.setState({ locale: 'zh-CN' });
});

afterEach(async () => {
  // Unmount FIRST: unmounting runs the view's `close()`, which unsubscribes its `liveQuery`.
  // Closing the database under a live subscription rejects with `DatabaseClosedError` after the
  // test has finished, which Vitest reports as an unhandled rejection.
  await unmount();
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ───────────────────────── the async render helpers ───────────────────────── */
/* Deliberately the same shape as `routes.test.tsx`: `@testing-library/react` is not installed
 * and this task may not add a dependency, and a second, differently-behaving helper set would
 * make two suites disagree about what "settled" means. */

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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return host;
}

async function waitForText(host: HTMLElement, expected: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((host.textContent ?? '').includes(expected)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected}; DOM was: ${host.innerHTML}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
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

async function clickButton(host: HTMLElement, label: string): Promise<void> {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('/packs', () => {
  it('renders, previews the example, and writes only after the report is confirmed', async () => {
    const host = await mountAt('/packs', EXAMPLE_BUTTON);

    // The page exists as a destination of its own, and it says why the in-app example is here
    // as well as the CLI's — the acceptance gap was exactly that sentence.
    expect(host.textContent).toContain(PAGE_TITLE);
    expect(host.textContent).toContain(CLI_GAP);

    await clickButton(host, EXAMPLE_BUTTON);
    await waitForText(host, PREVIEW_TITLE);

    // The report is on screen BEFORE anything is confirmed: the button to confirm it is there,
    // and the report itself carries the importer's own counts and entity lines.
    expect(host.textContent).toContain(CONFIRM);
    expect(host.textContent).toContain('新增');
    expect(host.querySelectorAll('li').length).toBeGreaterThan(0);

    // The assertion the page exists for. The example was parsed, its identity rules were run and
    // a full report was rendered — and the library is still empty.
    expect(await listWorlds()).toEqual([]);
    expect(await listCharacters()).toEqual([]);

    await clickButton(host, CONFIRM);
    await waitForText(host, RESULT_TITLE);
    await settle();

    // Real rows, in the app's own store, and the page points at the libraries that list them.
    const worlds = await listWorlds();
    const characters = await listCharacters();
    expect(worlds.length).toBeGreaterThan(0);
    expect(characters.length).toBeGreaterThan(0);
    expect(worlds.map((world) => world.id)).toContain(EXAMPLE_IDS.worlds.longdayHarbour.id);
    expect(host.textContent).toContain(OPEN_WORLDS);
    expect(host.textContent).toContain(OPEN_CHARACTERS);
    // ...and the confirmation is no longer on offer, because there is nothing left to confirm.
    expect(host.textContent).not.toContain(PREVIEW_TITLE);
  });

  it('starts a session from the imported example through the app’s own creation path', async () => {
    const host = await mountAt('/packs', EXAMPLE_BUTTON);
    await clickButton(host, EXAMPLE_BUTTON);
    await waitForText(host, PREVIEW_TITLE);
    await clickButton(host, CONFIRM);
    await waitForText(host, RESULT_TITLE);
    await settle();

    expect(await listSessions()).toEqual([]);
    await clickButton(host, START_EXAMPLE);
    await settle();

    // 「用示例开局」 goes through `useChatStore.create` — the same call 「新建会话」 makes — so the
    // row that appears is an ordinary session, pinned to the world that was just imported.
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.refs.world.id).toBe(EXAMPLE_IDS.worlds.longdayHarbour.id);
  });
});
