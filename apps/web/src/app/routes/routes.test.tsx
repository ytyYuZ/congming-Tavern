/**
 * Route smoke tests (M0-T8).
 *
 * WHY A REAL DOM RENDER AND NOT `renderToStaticMarkup`
 * Two facts, both measured rather than assumed, decide this file's shape:
 * 1. `renderToStaticMarkup` runs no effects, so a view's `useEffect` (loading the
 *    settings row, opening the session) never fires.
 * 2. Zustand v5's `useStore` passes `getInitialState` as React's `getServerSnapshot`,
 *    and React uses that snapshot for a server render. A static render therefore sees
 *    the store's INITIAL state and ignores everything a test seeds — the assertions
 *    would pass against an empty view, which is worse than failing.
 *
 * So these tests mount the real `<App/>` at a real path with `createRoot` and wait for
 * the view to settle. That exercises the wiring properly: the component's own effects
 * load the persisted state, and React re-renders the result. `@testing-library/react`
 * is not installed and this task may not add dependencies, so the (small) async-render
 * helper below is local.
 *
 * WHAT IS STILL STATIC
 * `index.test.ts` keeps its `renderToStaticMarkup`-free mount check, and the pure
 * functions (`chat/prompt.ts`) are tested as functions.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import {
  appendMessage,
  createSession,
  setHeadMessageId,
  writeLocaleSetting,
  writeProviderSettings,
} from '../../db/repository';
// The stores and the database accessors are taken from `mount`, NOT from `state/*` or
// `db/*` directly: Vitest instantiates a module once per environment, and an instance
// reached through another graph would be a different object from the one the mounted
// views read — a test would then seed state, or a database, that nothing renders.
import {
  closeDatabase,
  resetChat,
  resetDatabase,
  resetLocaleStore,
  resetSettingsStore,
  useChatStore,
} from '../../mount';

const API_KEY = 'sk-route-smoke-key';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'route-model';

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;

/**
 * React 19 requires this flag for `act` to mean anything, and without it every `act`
 * call logs "The current testing environment is not configured to support act(...)".
 * jsdom's `window.scrollTo` is a stub that throws "Not implemented", and TanStack
 * Router calls it on a scroll event; stubbing it keeps the suite output honest instead
 * of burying a real failure in noise.
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
  databaseName = `apps-web-routes-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  // This file asserts RENDERED Chinese copy, and the store's documented initial value
  // follows the browser (jsdom reports `en-US`). So the language is pinned by writing the
  // STORED row — the same thing a returning user has — and the shell's own `load()` then
  // adopts it. Poking the store instead would be overwritten by that legitimate read.
  await writeLocaleSetting('zh-CN');
});

afterEach(async () => {
  // ORDER MATTERS: unmount first, because unmounting the view runs `close()`, which
  // unsubscribes its `liveQuery`. Closing the database while a subscription is still
  // live leaves a pending query that rejects with `DatabaseClosedError` after the test
  // has finished, which Vitest reports as an unhandled rejection.
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

/** Mount the app at `path` and wait for `expected` to appear. Returns the container. */
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
  // Let any remaining fire-and-forget reads settle before the assertions run — and
  // before teardown closes the database. Closing it under an in-flight read rejects that
  // read, which Vitest reports as an unhandled error.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return host;
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

/* ────────────────────────────────── tests ────────────────────────────────── */

describe('route smoke tests', () => {
  it('the setup view shows the SAVED values, including the key', async () => {
    await writeProviderSettings({ baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL });

    const host = await mountAt('/setup', '服务地址（Base URL）');

    // Read the FIELDS, not the markup: react-hook-form sets `value` as a DOM property,
    // so the string that matters is `input.value` and not an attribute in the HTML.
    expect((host.querySelector('#baseUrl') as HTMLInputElement | null)?.value).toBe(BASE_URL);
    expect((host.querySelector('#model') as HTMLInputElement | null)?.value).toBe(MODEL);
    // The key is shown in a password field — the user owns it and has no other way to
    // check what they saved — and nowhere else.
    const key = host.querySelector('#apiKey') as HTMLInputElement | null;
    expect(key?.type).toBe('password');
    expect(key?.value).toBe(API_KEY);
    expect(host.textContent).toContain('测试连接');
    expect(host.textContent).toContain('保存');
  });

  it('the setup view is empty on a first run rather than loading forever', async () => {
    const host = await mountAt('/setup', '服务地址（Base URL）');
    const input = host.querySelector('#baseUrl') as HTMLInputElement | null;
    expect(input?.value).toBe('');
    const model = host.querySelector('#model') as HTMLInputElement | null;
    expect(model?.value).toBe('');
  });

  it('the home view lists the sessions the database holds', async () => {
    const session = await createSession({ title: '重启后仍在' });

    const host = await mountAt('/', '重启后仍在');

    expect(host.textContent).toContain('新建会话');
    expect(host.querySelector(`a[href="/play/${session.id}"]`)).not.toBeNull();
  });

  it('the home view says what to do when there is nothing yet', async () => {
    const host = await mountAt('/', '还没有会话');
    expect(host.textContent).toContain('设置');
  });

  it('the play view renders the PERSISTED chain, oldest first', async () => {
    const session = await createSession({ title: 'test-session' });
    const user = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '我推开门',
    });
    const assistant = await appendMessage({
      sessionId: session.id,
      parentId: user.id,
      role: 'assistant',
      content: '门后是昏暗的酒馆。',
    });
    await setHeadMessageId(session.id, assistant.id);

    const host = await mountAt(`/play/${session.id}`, '门后是昏暗的酒馆。');

    // The transcript came from the database through the store's live subscription, so
    // both rows are on screen — which is the "重启后仍在" half of the acceptance.
    expect(host.textContent).toContain('我推开门');
    const html = host.innerHTML;
    expect(html.indexOf('我推开门')).toBeLessThan(html.indexOf('门后是昏暗的酒馆。'));
    expect(html).toContain('bubble-user');
    expect(html).toContain('bubble-assistant');
    expect(html).toContain('发送');
    expect(html).toContain('停止');
    expect(host.querySelector('#turn-input')).not.toBeNull();
  });

  it('the play view shows the error banner from the adapter code, not the vendor prose', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({
        status: 'error',
        error: {
          code: 'auth',
          message: 'HTTP 401: the API key was rejected',
          retryable: false,
          turnText: '你好',
        },
      });
    });

    expect(host.textContent).toContain('API Key 被拒绝');
    // The vendor's own English sentence is for logs; the banner must not show it.
    expect(host.textContent).not.toContain('the API key was rejected');
    expect(host.textContent).not.toContain(API_KEY);
    expect(host.textContent).not.toContain('重试');
  });

  it('the play view offers to retry only when the adapter said it is retryable', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({
        status: 'error',
        error: {
          code: 'rate_limit',
          message: 'Rate limit reached',
          retryable: true,
          turnText: '再来一次',
        },
      });
    });

    expect(host.textContent).toContain('请求过于频繁');
    expect(host.textContent).toContain('重试');
  });

  it('the play view renders a streaming draft as an assistant bubble', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({
        status: 'streaming',
        draft: { text: '正在写的半句话', started: true },
      });
    });

    expect(host.textContent).toContain('正在写的半句话');
    expect(host.innerHTML).toContain('bubble-assistant');
  });

  it('the play view shows a thinking marker before the first delta', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');

    await act(async () => {
      useChatStore.setState({ status: 'streaming', draft: { text: '', started: false } });
    });

    expect(host.textContent).toContain('正在生成…');
  });

  it('the store the views read is the store a test can drive', async () => {
    // Guards the assumption the two tests above depend on: if a future change made the
    // app import the store through a second module instance, seeding would silently do
    // nothing and every error-state test would pass against an empty view.
    const session = await createSession({ title: 'test-session' });
    await mountAt(`/play/${session.id}`, '发送');
    // Wrapped in `act` like every other seed in this file: an unwrapped update leaves
    // React warning that the DOM assertion below may be reading a tree it never
    // flushed — i.e. the assertion would be green for the wrong reason.
    await act(async () => {
      useChatStore.setState({ status: 'streaming', draft: { text: 'guard', started: true } });
    });
    expect(useChatStore.getState().draft.text).toBe('guard');
    await settle();
    expect(container?.textContent).toContain('guard');
  });
});
