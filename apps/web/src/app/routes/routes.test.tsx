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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { snapshotAllRows } from '../../db/raw-indexeddb.test-helpers';
import {
  appendMessage,
  createSession,
  readProviderSettings,
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
  useSettingsStore,
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

/**
 * Type into a CONTROLLED input the way a browser does.
 *
 * React installs its own value tracker on the input's prototype, so assigning `input.value`
 * directly is silently ignored: the framework thinks the value did not change and never fires
 * the change handler. Calling the NATIVE setter (the prototype descriptor) updates the value
 * without touching the tracker, and the `input` event is what React listens for.
 */
async function typeInto(host: HTMLElement, selector: string, value: string): Promise<void> {
  const input = host.querySelector(selector);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Pick an option in a `<select>`, the way a browser does. */
async function chooseIn(host: HTMLElement, selector: string, value: string): Promise<void> {
  const select = host.querySelector(selector);
  if (!(select instanceof HTMLSelectElement)) throw new Error(`no select ${selector}`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Click the button whose label is exactly `label`, inside `host`. */
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

/**
 * Wait until the STORE says so, then let React flush.
 *
 * Used instead of matching a sentence wherever the thing being waited for is a STATE rather
 * than a piece of copy: asserting on wording would make a copy edit a test failure, and the
 * state is what the next assertion actually depends on.
 */
async function waitForState(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the store to settle');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  await settle();
}

describe('route smoke tests', () => {
  it('the setup view shows the SAVED values, including the key', async () => {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });

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

/* ─────────────────── M1-G3: the model list and the passphrase flow ─────────────────── */

/**
 * WHY THESE DRIVE THE REAL VIEW AND THE REAL STORE
 * The two features are decisions about what the SCREEN does with a provider answer, and the
 * decisions are only true end to end: that a fetched list never rewrites the saved model, that
 * picking one really writes the row, and that setting a passphrase really removes the plaintext
 * from the database. Asserting the pure functions (done in `chat/providers.test.ts`) cannot see
 * any of that.
 *
 * `globalThis.fetch` is stubbed per test because the setup view builds its own transport (the
 * same default `testConnection` uses); a stubbed global is the seam the browser path has, and
 * `vi.unstubAllGlobals()` in the teardown puts it back.
 */
describe('M1-G3: the model list', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the endpoint’s models, keeps the saved one, and flags that it is missing', async () => {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: 'retired-model',
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'listed-a' }, { id: 'listed-b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const host = await mountAt('/setup', '服务地址（Base URL）');
    await clickButton(host, '获取模型列表');
    await waitForText(host, '已获取 2 个模型');

    const options = Array.from(host.querySelectorAll('#model-choice option')).map(
      (option) => option.textContent,
    );
    // The saved model comes FIRST and is offered, not replaced; the endpoint's ids follow in the
    // endpoint's own order.
    expect(options).toEqual(['retired-model', 'listed-a', 'listed-b']);
    // THE DECISION, PINNED: the field still holds what was saved, and the screen says why.
    expect((host.querySelector('#model') as HTMLInputElement | null)?.value).toBe('retired-model');
    expect(host.textContent).toContain('当前保存的模型不在该列表中，已保留');
    // Nothing was written by the fetch alone: reading a list is not a change.
    expect((await readProviderSettings()).model).toBe('retired-model');
  });

  it('reports an empty list and an unreachable endpoint as themselves, not as "no models"', async () => {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });

    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const empty = await mountAt('/setup', '服务地址（Base URL）');
    await clickButton(empty, '获取模型列表');
    await waitForText(empty, '服务端返回了空列表');
    // An empty list offers no picker at all rather than an empty one.
    expect(empty.querySelector('#model-choice')).toBeNull();
    await unmount();

    vi.stubGlobal('fetch', () => Promise.reject(new Error('no route to host')));
    const host = await mountAt('/setup', '服务地址（Base URL）');
    await clickButton(host, '获取模型列表');
    await waitForText(host, '无法获取模型列表：服务地址不可达');
    expect((host.querySelector('#model') as HTMLInputElement | null)?.value).toBe(MODEL);
    expect(host.textContent).not.toContain('no route to host');
  });

  it('writes the picked model into the provider row', async () => {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: 'first-model',
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'first-model' }, { id: 'picked-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const host = await mountAt('/setup', '服务地址（Base URL）');
    await clickButton(host, '获取模型列表');
    await waitForText(host, '已获取 2 个模型');

    await chooseIn(host, '#model-choice', 'picked-model');
    await waitForText(host, '已保存');

    // The control WRITES the row (the milestone's wording), through the same save path the
    // 保存 button uses — and the key slot is untouched, because the field still holds the key
    // it was pre-filled with (`secretIntent` maps that to `keep`).
    expect((await readProviderSettings()).model).toBe('picked-model');
    expect((await readProviderSettings()).secret).toEqual({
      kind: 'plaintext',
      apiKey: API_KEY,
    });
    expect((host.querySelector('#model') as HTMLInputElement | null)?.value).toBe('picked-model');
    // No longer missing from the list it was picked from.
    expect(host.textContent).not.toContain('当前保存的模型不在该列表中');
  });
});

describe('M1-G3: the local key encryption section', () => {
  it('seals the stored plaintext key, then locks and unlocks it, without ever echoing it', async () => {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });

    const host = await mountAt('/setup', '本地密钥加密');
    // The screen says which state the key is in, and offers the action that fits: a plaintext
    // key gets 加密保存, and the passphrase hint is visible BEFORE a passphrase is typed.
    expect(host.textContent).toContain('以明文保存在本机数据库中');
    expect(host.textContent).toContain('口令不会被保存');
    expect(buttonLabels(host)).toContain('加密保存');
    expect(buttonLabels(host)).not.toContain('解锁');

    await typeInto(host, '#passphrase', 'a-good-passphrase');
    await clickButton(host, '加密保存');
    await waitForState(() => useSettingsStore.getState().provider.secret.kind === 'encrypted');
    expect(host.textContent).toContain('已加密存储');

    // The row is sealed and the plaintext is gone from the WHOLE database (the assertion
    // `secrets/provider-secret.test.ts` makes at the storage layer, repeated here at the UI
    // because this is the path a user takes to get there).
    expect((await readProviderSettings()).secret.kind).toBe('encrypted');
    expect(await snapshotAllRows(databaseName)).not.toContain(API_KEY);
    expect((await readProviderSettings()).secret).not.toEqual({
      kind: 'plaintext',
      apiKey: API_KEY,
    });

    // Unlocked in this tab: the key field shows the key again, and 锁定 takes it away without
    // touching the row.
    expect((host.querySelector('#apiKey') as HTMLInputElement | null)?.value).toBe(API_KEY);
    expect(buttonLabels(host)).toContain('锁定');
    await clickButton(host, '锁定');
    await waitForState(() => useSettingsStore.getState().locked);
    expect(host.textContent).toContain('锁定状态');
    expect((host.querySelector('#apiKey') as HTMLInputElement | null)?.value).toBe('');
    expect((host.querySelector('#apiKey') as HTMLInputElement | null)?.disabled).toBe(true);
    expect((await readProviderSettings()).secret.kind).toBe('encrypted');

    // A WRONG PASSPHRASE says so and changes nothing.
    await typeInto(host, '#passphrase', 'not-the-passphrase');
    await clickButton(host, '解锁');
    await waitForText(host, '口令不正确');
    expect(host.textContent).not.toContain('not-the-passphrase');
    expect((await readProviderSettings()).secret.kind).toBe('encrypted');
    expect(await snapshotAllRows(databaseName)).not.toContain(API_KEY);

    // The right one opens it — no lockout, no penalty.
    await typeInto(host, '#passphrase', 'a-good-passphrase');
    await clickButton(host, '解锁');
    await waitForState(() => useSettingsStore.getState().key === API_KEY);
    expect((await readProviderSettings()).secret.kind).toBe('encrypted');
    expect(useSettingsStore.getState().key).toBe(API_KEY);
    expect(buttonLabels(host)).toContain('锁定');
  });

  it('refuses a too-short passphrase with a sentence, and stores nothing', async () => {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });

    const host = await mountAt('/setup', '本地密钥加密');
    await typeInto(host, '#passphrase', 'tiny');
    await clickButton(host, '加密保存');
    await waitForText(host, '口令至少需要 8 个字符');

    // The refused seal must leave the row exactly as it was: still readable, still plaintext.
    expect((await readProviderSettings()).secret).toEqual({
      kind: 'plaintext',
      apiKey: API_KEY,
    });
  });

  it('says nothing about encryption on a first run, when there is no key to protect', async () => {
    const host = await mountAt('/setup', '本地密钥加密');

    expect(host.textContent).toContain('尚未保存密钥');
    // No passphrase field, and no seal/unlock button: there is nothing to seal and nothing to
    // open, so offering either would be a control that cannot do anything.
    expect(host.querySelector('#passphrase')).toBeNull();
    expect(buttonLabels(host)).not.toContain('加密保存');
    expect(buttonLabels(host)).not.toContain('解锁');
  });
});

/** The labels of every button in `host`, for "which action is offered here" assertions. */
function buttonLabels(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('button')).map((button) => button.textContent ?? '');
}
