/**
 * THE M1-G1 ACCEPTANCE TEST — "switching the language takes effect across the whole
 * interface" (docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS RENDERS THE REAL `<App/>` AND ASSERTS ON THE DOM
 * The claim under test is about the INTERFACE, not about the store or the catalogs: a
 * test that read `useLocaleStore.getState().locale`, or compared `CATALOGS['en']` against
 * `CATALOGS['zh-CN']`, would pass even if no component ever subscribed to the store. So
 * every assertion below is a string a user could read off the screen, taken from
 * `host.textContent` or from a rendered attribute, and the switch is driven the way a
 * user drives it — through the `<select>` — in one test and through the store in the
 * others (a programmatic caller matters too: `setLocale` is public API).
 *
 * WHY IT LOOKS AT ROUTES OTHER THAN THE CURRENT ONE
 * "The whole interface" is the hard half of the requirement: a header-only conversion
 * would satisfy a test that stayed on one page. So the switch is asserted on the home
 * view and then on the setup and play views, whose own copy must already be in the new
 * language — the language is app state, not per-screen state.
 *
 * WHY THE LOCALE IS PINNED TO zh-CN FIRST
 * The store's documented initial value follows the browser (`resolveLocale(
 * navigator.languages)`), and jsdom reports `en-US`. A test that asserts RENDERED TEXT
 * must therefore say which language it is asserting in; pinning is that statement, and
 * the switch to `en` is then the change under test rather than an accident of the
 * environment.
 *
 * WHY THE STORES COME FROM `mount`
 * Vitest instantiates a module once per ENVIRONMENT and this workspace mixes them, so a
 * store reached through `state/*` could be a different object from the one the mounted
 * components read — a test would then seed state nothing renders (see `mount.ts`).
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../app/app';
import { createSession, writeLocaleSetting } from '../db/repository';
// The stores and the database accessors are taken from `mount`, NOT from `state/*` or
// `db/*` directly — see the file header.
import {
  closeDatabase,
  resetChat,
  resetDatabase,
  resetLocaleStore,
  resetSettingsStore,
  useChatStore,
  useLocaleStore,
} from '../mount';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;

/**
 * React 19 requires this flag for `act` to mean anything, and jsdom's `window.scrollTo`
 * is a stub that throws "Not implemented" while TanStack Router calls it on a scroll
 * event. Neutralising it keeps the suite output honest instead of burying a real failure
 * in noise (the same one-liner `routes.test.tsx` uses).
 */
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
  databaseName = `apps-web-i18n-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  // PIN THE LANGUAGE BY WRITING THE STORED ROW, not by poking the store. The store's
  // documented initial value follows the browser (jsdom reports `en-US`), and the shell's
  // own `load()` adopts the row once it answers — so seeding in memory would either be
  // overwritten by that legitimate read or would have to bypass the very path this
  // milestone adds. Writing the row is what a returning user produces, and it makes the
  // assertion below unambiguous: the initial render IS zh-CN.
  await writeLocaleSetting('zh-CN');
});

afterEach(async () => {
  // ORDER MATTERS: unmount before closing the database, because unmounting runs the
  // view's `close()` and unsubscribes its `liveQuery`. Closing under a live subscription
  // rejects that query after the test finished, which Vitest reports as unhandled.
  await unmount();
  resetChat();
  resetSettingsStore();
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

/* ───────────────────────── the async render helper ───────────────────────── */

interface Mounted {
  host: HTMLElement;
  /** The SAME router the app renders with, so a test can navigate by hand. */
  router: ReturnType<typeof createAppRouter>;
}

/** Mount the app at `path` and wait for `expected` to appear. */
async function mountAt(path: string, expected: string): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.append(host);
  container = host;
  const router = createAppRouter(path);
  await act(async () => {
    root = createRoot(host);
    root.render(<App router={router} />);
  });
  await waitForText(host, expected);
  // Let the app's own fire-and-forget reads settle before teardown closes the database.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return { host, router };
}

/** Wait until the container's text contains `expected`. */
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

/** Let pending state updates inside the app flush. */
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

/** The language picker the shell renders on every route. */
function picker(host: HTMLElement): HTMLSelectElement {
  const found = host.querySelector('select');
  if (!(found instanceof HTMLSelectElement)) {
    throw new Error(`no <select> in the shell; DOM was: ${host.innerHTML}`);
  }
  return found;
}

/** An element a view renders, or a loud failure instead of a `null` dereference. */
function element<T extends Element>(host: HTMLElement, selector: string, of: new () => T): T {
  const found = host.querySelector(selector);
  if (!(found instanceof of)) {
    throw new Error(`no ${selector} in the view; DOM was: ${host.innerHTML}`);
  }
  return found;
}

/** Choose `locale` the way a user does: set the value, then fire `change`. */
async function chooseLocale(host: HTMLElement, locale: string): Promise<void> {
  const select = picker(host);
  await act(async () => {
    select.value = locale;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/* ────────────────────────────────── tests ────────────────────────────────── */

describe('M1-G1: switching the language changes the rendered interface', () => {
  it('re-renders the CURRENT view when the store changes the locale', async () => {
    const { host } = await mountAt('/', '新建会话');
    expect(host.textContent).toContain('还没有会话');

    await act(async () => {
      await useLocaleStore.getState().setLocale('en');
    });

    // The SAME view, in the other language — the home button, its empty-state sentence
    // and the shared header all moved together.
    expect(host.textContent).toContain('New session');
    expect(host.textContent).toContain('No sessions yet');
    expect(host.textContent).toContain('SmartTavern');
    expect(host.textContent).not.toContain('新建会话');

    // And back, so the switch is a toggle and not a one-way door.
    await act(async () => {
      await useLocaleStore.getState().setLocale('zh-CN');
    });
    expect(host.textContent).toContain('新建会话');
    expect(host.textContent).not.toContain('New session');
  });

  it('switches through the picker, and the setup route is already in the new language', async () => {
    const { host, router } = await mountAt('/', '新建会话');

    // The picker offers both languages, each named in its own language: a picker is read
    // by someone who cannot read the interface's current language.
    const options = [...picker(host).options].map((option) => option.textContent);
    expect(options).toEqual(['中文', 'English']);
    // Its accessible name IS translated (a screen reader reads it in the UI language).
    expect(picker(host).getAttribute('aria-label')).toBe('语言');

    await chooseLocale(host, 'en');
    expect(host.textContent).toContain('New session');
    expect(picker(host).getAttribute('aria-label')).toBe('Language');

    // THE HARD HALF: a route other than the one the switch happened on. Navigating does
    // not re-read the preference, so a setup view in English proves the language is app
    // state rather than per-screen state.
    await act(async () => {
      await router.navigate({ to: '/setup' });
    });
    await waitForText(host, 'Test connection');
    expect(host.textContent).toContain('Endpoint (Base URL)');
    expect(host.textContent).toContain('Model name');
    expect(host.textContent).not.toContain('测试连接');
  });

  it('re-renders the play view, including composer copy that lives in attributes', async () => {
    const session = await createSession({ title: 'locale-test' });
    const { host } = await mountAt(`/play/${session.id}`, '发送');

    await chooseLocale(host, 'en');

    // The composer's label is text; its placeholder is an ATTRIBUTE. The checker's
    // attribute rule is what stops either from being a bare literal, and this is the
    // rendered proof that they follow the locale too.
    expect(host.textContent).toContain('Type your action or line');
    expect(host.textContent).toContain('Send');
    expect(host.textContent).toContain('Stop');
    expect(host.textContent).not.toContain('发送');
    expect(element(host, '#turn-input', HTMLTextAreaElement).getAttribute('placeholder')).toBe(
      'For example: I push the door open and step into the dim tavern.',
    );
  });
});

describe('M1-G1: the choice survives a restart, through the real mount path', () => {
  it('restores the stored language when the app mounts again', async () => {
    // 1. Arrange a stored preference that differs from the browser's (`en-US` in jsdom)
    //    WITHOUT touching the store: this is what a returning user has on disk.
    await writeLocaleSetting('zh-CN');

    const first = await mountAt('/', '新建会话');
    expect(first.host.textContent).toContain('新建会话');

    // 2. Switch through the picker, which is what persists the row.
    await chooseLocale(first.host, 'en');
    expect(first.host.textContent).toContain('New session');
    await settle();

    // 3. "Restart": unmount and forget everything in memory, so the store falls back to
    //    the browser's `en-US` => `en`. That is deliberately the SAME value the row now
    //    holds, so the second half of the test is arranged the other way round below:
    //    see step 4, which proves the read by switching back.
    await unmount();
    resetLocaleStore();
    expect(useLocaleStore.getState().locale).toBe('en');

    const second = await mountAt('/', 'New session');
    expect(second.host.textContent).toContain('New session');
    expect(second.host.textContent).not.toContain('新建会话');

    // 4. The decisive step: choose zh-CN through the picker, restart once more, and the
    //    stored row — now the OPPOSITE of the browser's `en` — must be what renders. This
    //    is the assertion the browser-derived initial value cannot fake.
    await chooseLocale(second.host, 'zh-CN');
    expect(second.host.textContent).toContain('新建会话');
    await settle();

    await unmount();
    resetLocaleStore();
    expect(useLocaleStore.getState().locale).toBe('en');

    const third = await mountAt('/', '新建会话');
    expect(third.host.textContent).toContain('新建会话');
    expect(third.host.textContent).not.toContain('New session');
  });
});

describe('M1-G1: the error banner falls back instead of rendering nothing', () => {
  it('shows the generic sentence for a code no catalog knows', async () => {
    const session = await createSession({ title: 'locale-error' });
    const { host } = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({
        status: 'error',
        error: {
          code: 'insufficient_quota_v2',
          message: 'vendor prose that must not be rendered',
          retryable: false,
          turnText: '',
        },
      });
    });

    // The banner is not empty and does not fall back to the provider's English sentence.
    expect(host.textContent).toContain('发生未知错误');
    expect(host.textContent).not.toContain('vendor prose');
  });

  it('resolves a KNOWN code through the active catalog, not a frozen sentence', async () => {
    const session = await createSession({ title: 'locale-known-error' });
    const { host } = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({
        status: 'error',
        error: {
          code: 'rate_limit',
          message: 'Rate limit reached',
          retryable: true,
          turnText: 'x',
        },
      });
    });
    expect(host.textContent).toContain('请求过于频繁');

    await act(async () => {
      await useLocaleStore.getState().setLocale('en');
    });
    expect(host.textContent).toContain('Too many requests');
    expect(host.textContent).not.toContain('请求过于频繁');
  });

  it('names the missing configuration instead of the generic sentence', async () => {
    const session = await createSession({ title: 'locale-not-configured' });
    const { host } = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({
        status: 'error',
        error: { code: 'not_configured', message: 'log-only', retryable: false, turnText: '' },
      });
    });

    expect(host.textContent).toContain('请先在「设置」中填写服务地址与模型名');
    expect(host.textContent).not.toContain('发生未知错误');
  });
});
