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
import { createTranslator } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { Message, SessionState } from '@smarttavern/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { BUILTIN_HOURS_PER_DAY, BUILTIN_MINUTES_PER_HOUR } from '../../chat/builtin-content';
import { clockOf, segmentStep, worldClockText } from '../../chat/clock';
import { snapshotAllRows } from '../../db/raw-indexeddb.test-helpers';
import {
  appendMessage,
  createCheckpoint,
  deleteLeafMessage,
  getChain,
  getMessage,
  getSession,
  listCheckpoints,
  listChildren,
  readProviderSettings,
  setHeadMessageId,
  writeLocaleSetting,
  writeProviderSettings,
} from '../../db/repository';
// A session as a container, with the pins the create flow would have collected (M1-S1): this
// file's subject is what the routes render, not which world a session pins.
import { createTestSession as createSession } from '../../db/session.test-helpers';
import { translate } from '../../i18n/translate';
// The stores and the database accessors are taken from `mount`, NOT from `state/*` or
// `db/*` directly: Vitest instantiates a module once per environment, and an instance
// reached through another graph would be a different object from the one the mounted
// views read — a test would then seed state, or a database, that nothing renders.
import {
  closeDatabase,
  configureChat,
  resetChat,
  resetDatabase,
  resetLocaleStore,
  resetSettingsStore,
  useChatStore,
  useLocaleStore,
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
  // Substituted AFTER `resetChat` (which forgets the transport) and BEFORE anything mounts:
  // every test in this file that does not open the composer gets a transport that fails
  // loudly, so a turn nobody asked for is an error rather than a silent no-op.
  configureChat({ transport: forbiddenTransport });
  // This file asserts RENDERED Chinese copy, and the store's documented initial value
  // follows the browser (jsdom reports `en-US`). So the language is pinned by writing the
  // STORED row — the same thing a returning user has — and the shell's own `load()` then
  // adopts it. Poking the store instead would be overwritten by that legitimate read.
  await writeLocaleSetting('zh-CN');
  // ...and the IN-MEMORY value is pinned too. `useChatStore`'s and `translate`'s non-React
  // callers read the store, and the store's initial value follows the browser; only the
  // shell's mount effect replaces it, which a test body that runs before that read settles
  // would not see. The stored row above is what makes the shell adopt the same language, so
  // the two are pinned to one value rather than to two guesses.
  useLocaleStore.setState({ locale: 'zh-CN' });
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

/**
 * The transport a test gets unless it substitutes its own (M1-S2).
 *
 * WHY A FAILING DEFAULT AND NOT `undefined`: a test whose turn was never meant to happen
 * must not silently pass because nothing was wired. `configureChat` is the app's own seam
 * (`mountApp` calls it), and a rejection here surfaces as the store's error state with the
 * error's own name in it — visibly, in the test that caused it.
 */
const forbiddenTransport: FetchLike = () =>
  Promise.reject(new Error('no transport was substituted for this test'));

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
 * Type into a CONTROLLED field the way a browser does — an `<input>` or a `<textarea>`.
 *
 * React installs its own value tracker on the element's prototype, so assigning `.value`
 * directly is silently ignored: the framework thinks the value did not change and never fires
 * the change handler. Calling the NATIVE setter (the prototype descriptor) updates the value
 * without touching the tracker, and the `input` event is what React listens for. The two
 * element kinds are both handled here because the composer and the opening panel are
 * textareas while the amount and label fields are inputs, and a helper that worked for only
 * one of them would be the kind of difference nobody should have to remember.
 */
async function typeInto(host: HTMLElement, selector: string, value: string): Promise<void> {
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
 * Click one button inside a VARIABLE's row (its own 保存 / 删除).
 *
 * Scoped to the row because the status bar renders one save button per variable, so a
 * whole-document search would have to guess which one belongs to the value under test.
 */
async function clickInRow(host: HTMLElement, variable: string, label: string): Promise<void> {
  const row = host.querySelector(`[data-variable="${variable}"]`);
  if (row === null) throw new Error(`no variable row ${variable}`);
  const button = Array.from(row.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label} in row ${variable}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/**
 * One variable, read through a PARAMETERISED key.
 *
 * `noPropertyAccessFromIndexSignature` rejects `state.vars.hp` and Biome's `useLiteralKeys`
 * rejects `state.vars['hp']`; a parameterised key is the spelling both accept, and it keeps
 * every assertion below readable. The argument is a `SessionState`, a session row or a
 * checkpoint row — every shape that carries the live state — because the assertions below
 * make the same point about all three (`ADR-032`: one state value, in one place).
 */
function variableOf(
  source: SessionState | { readonly state: SessionState } | undefined,
  name: string,
): string | number | boolean | undefined {
  if (source === undefined) return undefined;
  const state = 'state' in source ? source.state : source;
  return state.vars[name];
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

/**
 * The clock sentence the PERSISTED session row says should be on screen right now.
 *
 * Built through `clockOf` + `worldClockText` — the same pair the view renders through — so
 * the assertion follows a catalog wording change instead of breaking on it, and still
 * proves the DOM shows the value the database holds. A hand-typed sentence would not.
 */
async function rememberedClock(sessionId: string): Promise<string> {
  const session = await getSession(sessionId);
  if (session === undefined) throw new Error(`no session ${sessionId}`);
  return worldClockText(clockOf(session), translate);
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

/* ─────────────── M1-T2: the manual advance, and M1-M1/M1-T4: the saves ─────────────── */

/**
 * WHY THESE DRIVE THE REAL VIEW
 * The milestone's acceptance sentences are about what a PERSON sees and what the DATABASE
 * holds at the same moment: 「推进立即反映到 UI 与状态」 and 「读档后时钟与状态一致回滚」. A
 * test of the store alone could not see the clock sentence, and a test of the repository
 * alone could not see that the button wired the two together. So each case clicks the
 * control the user clicks, then reads BOTH the DOM and the persisted row.
 *
 * WHY THE EXPECTED CLOCK SENTENCE IS BUILT, NOT TYPED
 * `worldClockText(clockOf(session), translate)` is the same pair of functions the view
 * renders through, so the assertion follows a wording change instead of breaking on it —
 * and it still proves the DOM shows the value the database holds, which a hardcoded
 * sentence would not.
 */
describe('M1-T2: the manual time advance', () => {
  it('moves the clock by each preset step, immediately, in the DOM and in the row', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');

    // The session starts at its origin (ADR-032), and the screen says so.
    expect(host.textContent).toContain(await rememberedClock(session.id));

    const hour = BUILTIN_MINUTES_PER_HOUR;
    const day = BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR;
    const steps: readonly {
      readonly label: string;
      readonly expectClock: (from: number) => number;
    }[] = [
      { label: '+1 时段', expectClock: (from) => from + segmentStep(session.state) },
      { label: '+1 小时', expectClock: (from) => from + hour },
      { label: '+1 天', expectClock: (from) => from + day },
    ];

    let minute = session.state.clock;
    for (const step of steps) {
      await clickButton(host, step.label);
      minute = step.expectClock(minute);
      await waitForState(() => useChatStore.getState().session?.state.clock === minute);
      // The persisted row is the authority; the sentence above the buttons is rendered
      // from the store, which this same click moved.
      expect((await getSession(session.id))?.state.clock).toBe(minute);
      expect(host.textContent).toContain(await rememberedClock(session.id));
    }
  });

  it('applies a custom amount and refuses one it cannot read', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');
    const start = session.state.clock;

    await typeInto(host, '#advance-minutes', '90');
    await clickButton(host, '推进');
    await waitForState(() => useChatStore.getState().session?.state.clock === start + 90);
    expect((await getSession(session.id))?.state.clock).toBe(start + 90);

    // A refusal says so and writes NOTHING: the clock stays where the last accepted
    // advance put it, and the state layer is not called at all.
    await typeInto(host, '#advance-minutes', '不是数字');
    await clickButton(host, '推进');
    await waitForText(host, '请输入整数分钟数');
    expect((await getSession(session.id))?.state.clock).toBe(start + 90);
    expect(useChatStore.getState().session?.state.clock).toBe(start + 90);
  });

  it('survives a RELOAD through the real read path', async () => {
    // This is the test the previous step could not write: nothing in the app moved the
    // clock, so a persisted value could only be seeded, which this project forbids. The
    // advance now goes through the real control, and the assertion runs after a real
    // close-and-reopen of the database — i.e. through the read the app performs on start.
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');
    await clickButton(host, '+1 天');
    const day = BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR;
    await waitForState(() => useChatStore.getState().session?.state.clock === day);
    await unmount();

    // "Reload": a NEW adapter over the SAME database name, exactly like `mountApp` does.
    closeDatabase();
    resetDatabase(databaseName);
    resetChat();

    const remounted = await mountAt(`/play/${session.id}`, '发送');
    expect((await getSession(session.id))?.state.clock).toBe(day);
    expect(remounted.textContent).toContain(await rememberedClock(session.id));
  });

  it('persists only the clock the user asked for', async () => {
    // A guard against the advance writing through some other path: the row the repository
    // reads back must be the minute the screen is showing.
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '发送');
    await clickButton(host, '+1 小时');
    await waitForState(
      () => useChatStore.getState().session?.state.clock === BUILTIN_MINUTES_PER_HOUR,
    );
    expect((await getSession(session.id))?.state.clock).toBe(BUILTIN_MINUTES_PER_HOUR);
    expect(host.textContent).toContain(await rememberedClock(session.id));
  });
});

describe('M1-M1 / M1-T4: the save-point panel', () => {
  it('saves with a label, lists it, and rolls the clock and the transcript back together', async () => {
    const session = await createSession({ title: 'test-session' });
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    const host = await mountAt(`/play/${session.id}`, '发送');

    await typeInto(host, '#checkpoint-label', '打点之前');
    await clickButton(host, '保存存档点');
    await waitForText(host, '已保存存档点');
    // The row exists, at the current transcript position.
    const saved = await listCheckpoints(session.id);
    expect(saved.map((row) => row.label)).toEqual(['打点之前']);
    expect(saved[0]?.messageId).toBe(first.id);
    expect(host.textContent).toContain('打点之前');

    // Play on: the clock moves and a second message lands.
    await clickButton(host, '+1 天');
    const day = BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR;
    await waitForState(() => useChatStore.getState().session?.state.clock === day);
    const second = await appendMessage({
      sessionId: session.id,
      parentId: first.id,
      role: 'assistant',
      content: '第二句',
    });
    await setHeadMessageId(session.id, second.id);
    await waitForState(() => useChatStore.getState().messageChain.length === 2);
    expect(host.textContent).toContain('第二句');

    // Reading a save point is a DELIBERATE act: the first button only arms it.
    await clickButton(host, '读档');
    expect(host.textContent).toContain('确认回滚');
    // … and nothing has moved yet.
    expect((await getSession(session.id))?.state.clock).toBe(day);
    await clickButton(host, '确认回滚');
    await waitForText(host, '已读档回滚到该存档点');

    // THE ACCEPTANCE: clock, state and transcript tip are back at the saved instant at
    // once. `state` is compared whole for the same reason `repository.test.ts` does it.
    const rolled = await getSession(session.id);
    expect(rolled?.state).toEqual(saved[0]?.state);
    expect(rolled?.state.clock).toBe(session.state.clock);
    expect(rolled?.headMessageId).toBe(first.id);
    // The screen: the saved clock sentence is back, and the later message is off the chain.
    await waitForState(() => useChatStore.getState().messageChain.length === 1);
    expect(host.textContent).toContain('第一句');
    expect(host.textContent).not.toContain('第二句');
    // Nothing was deleted (ADR-010): the row is still in the database, just not on the chain.
    expect(await getChain(session.id)).toHaveLength(1);
  });

  it('saves before the first message: a checkpoint at minute zero round-trips', async () => {
    // `CheckpointSchema.messageId` is `IdSchema.nullable()` and mirrors `Session.headMessageId`
    // (ADR-032), so "save a point before the first message" is a position — `null` — instead of
    // an act the schema cannot spell. A fresh session is the NORMAL case, not an error path.
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '保存存档点');

    await typeInto(host, '#checkpoint-label', '开场前');
    await clickButton(host, '保存存档点');
    await waitForText(host, '已保存存档点');
    const saved = await listCheckpoints(session.id);
    expect(saved.map((row) => row.label)).toEqual(['开场前']);
    expect(saved[0]?.messageId).toBeNull();
    expect(saved[0]?.state.clock).toBe(0);

    // Playing on and then restoring puts the session back at "no transcript" rather than at a
    // message id the checkpoint never named.
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    await waitForState(() => useChatStore.getState().messageChain.length === 1);

    await clickButton(host, '读档');
    await clickButton(host, '确认回滚');
    await waitForText(host, '已读档回滚到该存档点');
    expect((await getSession(session.id))?.headMessageId).toBeNull();
    expect(useChatStore.getState().messageChain).toEqual([]);
  });

  it('blocks a restore until it is confirmed, and deletes only on a second click', async () => {
    const session = await createSession({ title: 'test-session' });
    // A message is stored first so the restore below has a position to move back to; the
    // confirmations under test are about the two-step actions, not about a save point.
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    const host = await mountAt(`/play/${session.id}`, '发送');
    await typeInto(host, '#checkpoint-label', '第一处');
    await clickButton(host, '保存存档点');
    await waitForText(host, '第一处');

    // 「读档」 alone changes nothing: the live state has not moved.
    await clickButton(host, '读档');
    expect(host.textContent).toContain('确认回滚');
    expect((await getSession(session.id))?.state.clock).toBe(0);

    // 「删除」 alone changes nothing either.
    await clickButton(host, '删除');
    expect(host.textContent).toContain('确认删除');
    expect((await listCheckpoints(session.id)).length).toBe(1);

    await clickButton(host, '确认删除');
    await waitForState(() => useChatStore.getState().checkpoints.length === 0);
    expect(await listCheckpoints(session.id)).toEqual([]);
    expect(host.textContent).toContain('还没有存档点');
    // The live session is untouched by a delete.
    expect((await getSession(session.id))?.state.clock).toBe(0);
  });

  it('cannot restore a save point that belongs to another session', async () => {
    // The store refuses it (`restoreCheckpoint` checks `sessionId` before writing), which is
    // what keeps a click on a stale list from pointing this session's head at a message id
    // that is not in its tree — an empty transcript whose head resolves nowhere.
    const mine = await createSession({ title: 'mine' });
    const theirs = await createSession({ title: 'theirs' });
    const foreign = await createCheckpoint({ sessionId: theirs.id, label: '别的存档' });

    const host = await mountAt(`/play/${mine.id}`, '发送');
    // The panel never renders another session's save points (that is the same decision, and
    // the empty list below asserts it), so the guard is driven through the action the panel
    // calls — the only way to reach it.
    expect(host.textContent).toContain('还没有存档点');
    expect(await useChatStore.getState().restoreCheckpoint(foreign?.id ?? '')).toBe(false);
    expect((await getSession(mine.id))?.headMessageId).toBeNull();
    expect((await getSession(theirs.id))?.headMessageId).toBeNull();
  });
});

/* ────────────────────────── M1-S6: the status bar ────────────────────────── */

/**
 * THE MILESTONE'S ACCEPTANCE IS A TRANSITION, NOT A FIELD (docs/06 §2.5, ADR-031)
 * "变量随存档保存与恢复" is proven by: change a variable, take a save point, change it again,
 * restore, and find the checkpointed value back — IN THE SAME ACT that brings the clock back,
 * because ADR-032 made both one `SessionState` value. Asserting the panel's inputs or the
 * rows would pass for an implementation that saved nothing.
 */
describe('M1-S6: the status bar', () => {
  it('edits a typed variable and rolls it back with the clock in one restore', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '状态栏');
    expect(host.textContent).toContain('还没有变量。');

    // ADD, through the typed editor: the kind select is what makes this the NUMBER 10 rather
    // than the string "10", and the row is written to the session row (not just to React).
    await typeInto(host, '#variable-name', 'hp');
    await chooseIn(host, '#variable-kind', 'number');
    await typeInto(host, '#variable-value', '10');
    await clickButton(host, '添加变量');
    await waitForState(() => variableOf(useChatStore.getState().session, 'hp') === 10);
    expect(variableOf(await getSession(session.id), 'hp')).toBe(10);
    expect(host.textContent).toContain('已添加变量');

    // THE SAVE POINT, taken at that instant (the clock is still the session's origin, 0).
    await typeInto(host, '#checkpoint-label', '打点之前');
    await clickButton(host, '保存存档点');
    await waitForText(host, '已保存存档点');
    const saved = await listCheckpoints(session.id);
    expect(variableOf(saved[0]?.state, 'hp')).toBe(10);
    expect(saved[0]?.state.clock).toBe(0);

    // PLAY ON: the clock moves a day and the SAME variable is edited to another value.
    await clickButton(host, '+1 天');
    const day = BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR;
    await waitForState(() => useChatStore.getState().session?.state.clock === day);
    await typeInto(host, '[data-variable="hp"] .variable-value', '3');
    await clickInRow(host, 'hp', '保存');
    await waitForState(() => variableOf(useChatStore.getState().session, 'hp') === 3);
    expect(variableOf(await getSession(session.id), 'hp')).toBe(3);

    // THE ACCEPTANCE, M1-S6 AND M1-T4 IN ONE ACT: restoring moves the variable AND the clock
    // back to the checkpointed instant — they are one state value, so they cannot come apart.
    await clickButton(host, '读档');
    await clickButton(host, '确认回滚');
    await waitForText(host, '已读档回滚到该存档点');

    const rolled = await getSession(session.id);
    expect(variableOf(rolled, 'hp')).toBe(10);
    expect(rolled?.state.clock).toBe(0);
    expect(rolled?.state).toEqual(saved[0]?.state);
    expect(variableOf(useChatStore.getState().session, 'hp')).toBe(10);
    // …and the SCREEN shows the checkpointed value, not the one that was rolled away: the
    // row's draft is reseeded from the restored state.
    expect(
      (host.querySelector('[data-variable="hp"] .variable-value') as HTMLInputElement | null)
        ?.value,
    ).toBe('10');
  });

  it('adds a text variable, refuses text a kind cannot hold, and deletes one row', async () => {
    const session = await createSession({ title: 'test-session' });
    const host = await mountAt(`/play/${session.id}`, '状态栏');

    await typeInto(host, '#variable-name', 'weather');
    await typeInto(host, '#variable-value', 'snow');
    await clickButton(host, '添加变量');
    await waitForState(() => variableOf(useChatStore.getState().session, 'weather') === 'snow');
    expect(variableOf(await getSession(session.id), 'weather')).toBe('snow');

    // A NUMBER that is not one is REFUSED with a sentence, and nothing is written: coercing it
    // (`Number('')` is 0) would store a value nobody typed.
    await typeInto(host, '#variable-name', 'danger');
    await chooseIn(host, '#variable-kind', 'number');
    await typeInto(host, '#variable-value', 'not-a-number');
    await clickButton(host, '添加变量');
    await waitForText(host, '请输入该类型的一个有效值');
    expect(variableOf(await getSession(session.id), 'danger')).toBeUndefined();

    // A blank name is refused too — no macro could address such a key.
    await typeInto(host, '#variable-name', '   ');
    await typeInto(host, '#variable-value', '1');
    await clickButton(host, '添加变量');
    expect((await getSession(session.id))?.state.vars).toEqual({ weather: 'snow' });

    // DELETE is one click here (a variable is a row the user can retype, unlike a save point).
    await clickInRow(host, 'weather', '删除');
    await waitForState(() => variableOf(useChatStore.getState().session, 'weather') === undefined);
    expect((await getSession(session.id))?.state.vars).toEqual({});
    expect(host.textContent).toContain('还没有变量。');
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

/* ──────────────────── M1-S2: the message stream and its tree ──────────────────── */

/**
 * THE MILESTONE'S ACCEPTANCE IS ABOUT THE TREE AND THE BRANCH SWITCH
 * docs/06 §2.5: 「消息树（parentId）正确；切换分支内容正确」. So every case below drives the
 * REAL control in the REAL view and then asserts TWO things: the rendered transcript (the
 * user's half of the sentence) and the persisted tree (the acceptance's own words). A test
 * of the store alone could not see the second answer appear where the first one was, and a
 * test of the repository alone could not see that the arrow wired the switch to it.
 *
 * WHY THE WIRE IS A HAND-WRITTEN SSE BODY AND NOT A MOCKED PROVIDER
 * `send-turn.test.ts` records the argument for the whole app: a mocked `LLMProvider` would
 * only prove that a function can be called. A regeneration has to go through the same
 * adapter, the same composer and the same persistence as the answer it replaces, or "another
 * answer to this prompt" would mean something different from the answer it is replacing.
 *
 * WHAT IS SEEDED AND WHAT IS PERFORMED
 * The rows that would have come from a FIRST turn are seeded through the repository — the
 * fixture is a transcript that already exists. Everything after that is a gesture: the
 * regenerate click, the arrow, the edit's save, the delete's confirmation. Seeding is what
 * makes the assertions literals ("the chain is question, second answer") rather than a
 * re-derivation of what the app just did.
 */
describe('M1-S2: the message stream', () => {
  /** One SSE body carrying `chunks` and a finish reason, in the provider's own wire format. */
  function sseResponse(chunks: readonly string[], finishReason = 'stop'): Response {
    const encoder = new TextEncoder();
    const payloads = [
      ...chunks.map(
        (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      ),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  /**
   * A transport answering the SCRIPTED replies in order, plus the count of requests it got.
   *
   * The queue (and not a fixed answer) is what makes "the second answer differs from the
   * first" observable: a wire answering the same text twice could not tell a real
   * regeneration from a re-read of the row that was already there.
   */
  function scriptedWire(replies: readonly (readonly string[])[]): {
    fetch: FetchLike;
    calls: () => number;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      fetch: () => {
        const reply = replies[calls] ?? [];
        calls += 1;
        return Promise.resolve(sseResponse(reply));
      },
    };
  }

  /** A stored turn: the user's message and one assistant answer under it. */
  async function storedTurn(
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<{ question: Message; answer: Message }> {
    const asked = await appendMessage({
      sessionId,
      parentId: null,
      role: 'user',
      content: question,
    });
    const answered = await appendMessage({
      sessionId,
      parentId: asked.id,
      role: 'assistant',
      content: answer,
    });
    await setHeadMessageId(sessionId, answered.id);
    return { question: asked, answer: answered };
  }

  /** The list of the rendered messages' text, in document order. */
  function bubbleTexts(host: HTMLElement): string[] {
    return Array.from(host.querySelectorAll('.bubble-text')).map((node) => node.textContent ?? '');
  }

  /** The switcher of ONE rendered message, so a sibling assertion cannot pick the wrong row. */
  function switcherOf(
    host: HTMLElement,
    message: { readonly id: string },
  ): { counter: string; previous: HTMLButtonElement; next: HTMLButtonElement } {
    const row = host.querySelector(`[data-message="${message.id}"]`);
    if (row === null) throw new Error(`message ${message.id} is not rendered`);
    const previous = row.querySelector('button[aria-label="上一条"]');
    const next = row.querySelector('button[aria-label="下一条"]');
    const counter = row.querySelector('.sibling-counter');
    if (!(previous instanceof HTMLButtonElement)) {
      throw new Error(`message ${message.id} has no previous arrow`);
    }
    if (!(next instanceof HTMLButtonElement)) {
      throw new Error(`message ${message.id} has no next arrow`);
    }
    return { counter: counter?.textContent ?? '', previous, next };
  }

  /**
   * Click the button whose label is exactly `label`, INSIDE one message's row.
   *
   * A document-wide search would find the first 编辑 / 删除 in the transcript, which is a
   * different message from the one a test is about — the mistake this scoping removes.
   */
  async function clickInMessage(
    host: HTMLElement,
    message: { readonly id: string },
    label: string,
  ): Promise<void> {
    const row = host.querySelector(`[data-message="${message.id}"]`);
    if (row === null) throw new Error(`message ${message.id} is not rendered`);
    const button = Array.from(row.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === label,
    );
    if (button === undefined) throw new Error(`no button labelled ${label} in ${message.id}`);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  /**
   * The switcher of the ACTIVE message — the row the chain currently ends on.
   *
   * WHY THE ACTIVE ROW AND NOT A CAPTURED ONE: the switcher reads the run of siblings in an
   * effect (`play.tsx`'s `MessageBubble`), so between a head change and that read resolving
   * the row on screen can still show the neighbour list from before. `data-message` plus the
   * `bubble-active` mark is how the DOM itself says which row the chain runs through, so a
   * test that clicks the ACTIVE row's arrow is clicking the control a person sees as current.
   */
  function activeSwitcher(host: HTMLElement): {
    previous: HTMLButtonElement;
    next: HTMLButtonElement;
  } {
    const row = host.querySelector('.bubble-active .sibling-switcher');
    if (row === null) throw new Error('no active message has a sibling switcher');
    const previous = row.querySelector('button[aria-label="上一条"]');
    const next = row.querySelector('button[aria-label="下一条"]');
    if (!(previous instanceof HTMLButtonElement) || !(next instanceof HTMLButtonElement)) {
      throw new Error('the active switcher has no arrows');
    }
    return { previous, next };
  }

  /**
   * One message's delete control, found by its accessible name (`play.deleteLabel`).
   *
   * The rows also offer 编辑 and 重新生成, and a document-wide 删除 search would find the
   * first message's control rather than the one under test.
   */
  function deleteButtonOf(
    host: HTMLElement,
    message: { readonly id: string; readonly content: string },
  ): HTMLButtonElement {
    const row = host.querySelector(`[data-message="${message.id}"]`);
    if (row === null) throw new Error(`message ${message.id} is not rendered`);
    const button = row.querySelector(`button[aria-label="删除：${message.content}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`message ${message.id} has no delete control`);
    }
    return button;
  }

  /**
   * Click a button inside the transcript by its exact label.
   *
   * 继续写 belongs to the TIP of the chain rather than to one message's identity, so it has
   * no single row to scope to the way 编辑 / 删除 do; the transcript is the scope that keeps
   * it away from the composer's own 发送 / 停止.
   */
  async function clickInRowless(host: HTMLElement, label: string): Promise<void> {
    const button = Array.from(host.querySelectorAll('.transcript button')).find(
      (candidate) => candidate.textContent === label,
    );
    if (button === undefined) throw new Error(`no transcript button labelled ${label}`);
    if (!(button instanceof HTMLButtonElement)) throw new Error('not a button');
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  /**
   * Type into a message's edit textarea, the way a browser does.
   *
   * The same native-setter trick `typeInto` uses, and for the same reason: React installs
   * its own value tracker on the textarea prototype, so assigning `.value` directly is
   * silently ignored and the change handler never fires.
   */
  async function typeIntoEditor(
    host: HTMLElement,
    message: { readonly id: string },
    value: string,
  ): Promise<void> {
    const input = host.querySelector(`textarea[data-edit="${message.id}"]`);
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('no edit textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /**
   * Wait until the SETTINGS row is loaded, so a turn can be attempted.
   *
   * The play view asks for `SettingsState.loaded` and reads the provider row itself, so a
   * click that arrives before that read settles would be refused by `turnGate` and the test
   * would be asserting against a banner instead of a branch. Waiting for the store's own
   * flag is what makes that impossible rather than unlikely.
   */
  async function waitForSettings(): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (!useSettingsStore.getState().loaded) {
      if (Date.now() > deadline) throw new Error('settings never loaded');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  /** Wait until ONE rendered message's switcher says `expected` (e.g. `第 1 / 2 条`). */
  async function waitForCounter(
    host: HTMLElement,
    message: { readonly id: string },
    expected: string,
  ): Promise<void> {
    const deadline = Date.now() + 4_000;
    for (;;) {
      const row = host.querySelector(`[data-message="${message.id}"] .sibling-counter`);
      if ((row?.textContent ?? '') === expected) return;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${expected}; DOM was ${host.querySelector(`[data-message="${message.id}"]`)?.innerHTML ?? ''}`,
        );
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  /**
   * Store the provider configuration and substitute the transport — the two halves of "the
   * app can send", wired the way `mountApp` and the setup form wire them.
   */
  async function armTheProvider(wire: { readonly fetch: FetchLike }): Promise<void> {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });
    configureChat({ transport: wire.fetch });
  }

  it('regenerates as a SIBLING of the answer it replaces, and the chain follows the head', async () => {
    const session = await createSession({ title: 'regen' });
    const { question, answer } = await storedTurn(session.id, '第一问', '第一个答案');
    const wire = scriptedWire([['第二个答案']]);
    await armTheProvider(wire);

    const host = await mountAt(`/play/${session.id}`, '第一个答案');
    await waitForSettings();
    // One answer exists, so there is no branch to switch to and no count to print.
    expect(host.querySelector('.sibling-switcher')).toBeNull();

    await clickInMessage(host, answer, '重新生成');
    await waitForState(() => useChatStore.getState().messageChain.length === 2);
    // THE ACCEPTANCE, FIRST HALF: the rendered chain now runs through the NEW answer, and
    // the answer it replaced is not on it.
    expect(bubbleTexts(host)).toEqual(['第一问', '第二个答案']);

    // THE ACCEPTANCE, SECOND HALF: the new row is a SIBLING — same `parentId` as the answer
    // it replaces — so the tree has one question with two answers, and the head is on the
    // NEW one. This is the assertion a "regenerate appends a child" implementation fails.
    const siblings = await listChildren(session.id, question.id);
    expect(siblings.map((message) => message.content)).toEqual(['第一个答案', '第二个答案']);
    expect(siblings.map((message) => message.parentId)).toEqual([question.id, question.id]);
    const regenerated = siblings[1];
    if (regenerated === undefined) throw new Error('the regeneration wrote no row');
    expect(regenerated.id).not.toBe(answer.id);
    // The original is untouched — an edit in place would have changed this row.
    expect((await getMessage(answer.id))?.content).toBe('第一个答案');
    expect((await getSession(session.id))?.headMessageId).toBe(regenerated.id);
    // The question was re-asked, and the answer it was asked for was NOT written twice: one
    // request, one new row (the store moved the head before the turn so `sendTurn` appends
    // only the assistant half).
    expect(wire.calls()).toBe(1);

    // The switcher now appears on the answer that is ON the chain and says where the user
    // is. It deliberately does NOT appear on the answer that was replaced: that row is a
    // sibling off the active path, so there is no rendered bubble to attach a switcher to —
    // it is reachable through THIS row's arrow, which is what the count promises.
    await waitForCounter(host, regenerated, '第 2 / 2 条');
    expect(host.querySelector(`[data-message="${answer.id}"]`)).toBeNull();
    // The question has no siblings at all, so nothing about it is a choice.
    expect(host.querySelector(`[data-message="${question.id}"] .sibling-switcher`)).toBeNull();
  });

  it('switches between the siblings in both directions, in the DOM and in the row', async () => {
    const session = await createSession({ title: 'branch-switch' });
    const { question } = await storedTurn(session.id, '第一问', '第一个答案');
    // A second answer, written the way a regeneration writes one: same parent, new id.
    const second = await appendMessage({
      sessionId: session.id,
      parentId: question.id,
      role: 'assistant',
      content: '第二个答案',
    });
    await setHeadMessageId(session.id, second.id);
    await armTheProvider({ fetch: forbiddenTransport });

    const host = await mountAt(`/play/${session.id}`, '第二个答案');
    await waitForCounter(host, second, '第 2 / 2 条');
    // The run is ordered by creation (uuid v7 is time-ordered), so the FIRST answer is the
    // previous one and there is nothing after the second.
    expect(switcherOf(host, second).previous.disabled).toBe(false);
    expect(switcherOf(host, second).next.disabled).toBe(true);

    // BACKWARDS. `switchBranch` is one `setHeadMessageId`, so the render that follows is the
    // other answer — the acceptance's 「切换分支内容正确」, and the DOM is where it is visible.
    // The control is re-queried from the ACTIVE bubble (the row the chain currently ends on)
    // because the switcher learns the run of siblings in an effect of its own, and the click
    // is dispatched the way a person's click arrives — the polling helper below then lets
    // React commit under `act`.
    const first = (await listChildren(session.id, question.id))[0];
    if (first === undefined) throw new Error('the first answer is missing');
    activeSwitcher(host).previous.click();
    await waitForState(() => useChatStore.getState().session?.headMessageId === first.id);
    expect(bubbleTexts(host)).toEqual(['第一问', '第一个答案']);
    expect(host.textContent).not.toContain('第二个答案');
    // The ROW moved: the persisted tip is the first answer, which is what a reload shows.
    expect((await getSession(session.id))?.headMessageId).toBe(first.id);
    // …and the arrows have swapped ends, which is the count and the head agreeing.
    await waitForCounter(host, first, '第 1 / 2 条');
    expect(activeSwitcher(host).previous.disabled).toBe(true);
    expect(activeSwitcher(host).next.disabled).toBe(false);

    // FORWARDS: back to the second answer, so the switch is proven in both directions and
    // not as a one-way mutation of the head.
    activeSwitcher(host).next.click();
    await waitForState(() => useChatStore.getState().session?.headMessageId === second.id);
    expect(bubbleTexts(host)).toEqual(['第一问', '第二个答案']);
    expect(host.textContent).not.toContain('第一个答案');
    expect((await getSession(session.id))?.headMessageId).toBe(second.id);

    // The discarded branch was never deleted (ADR-010): both rows are still there, and only
    // the pointer decided which one is on screen.
    expect((await listChildren(session.id, question.id)).length).toBe(2);
  });

  it('appends after a branch as a child of THAT branch’s tip, not of the other sibling', async () => {
    const session = await createSession({ title: 'cross-branch' });
    const { question } = await storedTurn(session.id, '第一问', '被放弃的答案');
    const kept = await appendMessage({
      sessionId: session.id,
      parentId: question.id,
      role: 'assistant',
      content: '保留的答案',
    });
    await setHeadMessageId(session.id, kept.id);
    const wire = scriptedWire([['续写']]);
    await armTheProvider(wire);

    const host = await mountAt(`/play/${session.id}`, '保留的答案');
    await waitForSettings();
    await clickInRowless(host, '继续写');
    await waitForState(() => useChatStore.getState().messageChain.length === 3);

    // The new message hangs off the BRANCH TIP, not off the question and not off the
    // discarded sibling — the tree edge the acceptance is about.
    const continuation = (await listChildren(session.id, kept.id))[0];
    if (continuation === undefined) throw new Error('the continuation wrote no row');
    expect(continuation.content).toBe('续写');
    expect((await getSession(session.id))?.headMessageId).toBe(continuation.id);
    // The discarded branch is untouched and still a child of the question: a continuation is
    // not a re-parent.
    const siblings = await listChildren(session.id, question.id);
    expect(siblings.map((message) => message.content)).toEqual(['被放弃的答案', '保留的答案']);
    // 继续写 asked the same question again with no new user turn: exactly one request, and
    // the prompt it sent quotes the ACTIVE branch only.
    expect(wire.calls()).toBe(1);
    expect(bubbleTexts(host)).toEqual(['第一问', '保留的答案', '续写']);
  });

  it('edits by writing a NEW SIBLING of the same parent, leaving the original and its replies alone', async () => {
    const session = await createSession({ title: 'edit' });
    const { question, answer } = await storedTurn(session.id, '第一问', '原来的答案');
    await armTheProvider({ fetch: forbiddenTransport });

    const host = await mountAt(`/play/${session.id}`, '原来的答案');
    await waitForSettings();
    // The seed: one answer, no branch yet.
    expect(await listChildren(session.id, question.id)).toHaveLength(1);

    await clickInMessage(host, answer, '编辑');
    await typeIntoEditor(host, answer, '改过的答案');
    await clickInMessage(host, answer, '保存修改');
    await waitForState(() => useChatStore.getState().messageChain.length === 2);
    await waitForText(host, '改过的答案');

    // THE EDIT RULE: the row being edited is never overwritten. Its replacement is a second
    // child of the SAME parent, which is the shape docs/02 §7 gives a regeneration — so the
    // original text and the replies generated from it are still in the tree, and the tree
    // still says which text produced which reply.
    const siblings = await listChildren(session.id, question.id);
    expect(siblings.map((message) => message.content)).toEqual(['原来的答案', '改过的答案']);
    expect(siblings.map((message) => message.parentId)).toEqual([question.id, question.id]);
    expect((await getMessage(answer.id))?.content).toBe('原来的答案');
    // THE HEAD outcome: the new node is the tip, so the edited text is what the next turn
    // quotes and what the switcher shows.
    const edited = siblings[1];
    if (edited === undefined) throw new Error('the edit wrote no row');
    expect((await getSession(session.id))?.headMessageId).toBe(edited.id);
    // The rendered chain is the edited branch, and the original is one arrow away — not
    // deleted, and not silently left on screen beside its replacement.
    expect(bubbleTexts(host)).toEqual(['第一问', '改过的答案']);
    expect(host.textContent).not.toContain('原来的答案');
    await waitForCounter(host, edited, '第 2 / 2 条');
  });

  it('deletes a leaf after a confirmation, moving the head to its parent', async () => {
    const session = await createSession({ title: 'delete' });
    const { question, answer } = await storedTurn(session.id, '第一问', '唯一的答案');
    await armTheProvider({ fetch: forbiddenTransport });

    const host = await mountAt(`/play/${session.id}`, '唯一的答案');
    await waitForSettings();
    await waitForState(() => useChatStore.getState().messageChain.length === 2);

    // A node WITH replies cannot be deleted AT ALL, and the row says so before the click:
    // the control is refused and carries the reason, so the refusal is an affordance rather
    // than a confirmation that could only end in a dead end. Nothing is removed.
    const refused = deleteButtonOf(host, question);
    expect(refused.disabled).toBe(true);
    expect(refused.getAttribute('title')).toContain('这条消息后面还有内容');
    expect(deleteButtonOf(host, answer).disabled).toBe(false);
    expect(await getMessage(question.id)).toBeDefined();
    expect(await getMessage(answer.id)).toBeDefined();
    // The refusal is a DECISION, not a mistake: the repository refuses the same delete, which
    // is what makes the sentence true rather than merely optimistic — and a caller that got
    // past the disabled control is still refused.
    expect(await useChatStore.getState().deleteMessage(question.id)).toBe(false);
    expect(await deleteLeafMessage(session.id, question.id)).toBe(false);
    expect(await listChildren(session.id, null)).toHaveLength(1);

    // A LEAF goes, after its own second click.
    await clickInMessage(host, answer, '删除');
    await clickInMessage(host, answer, '确认删除');
    await waitForState(() => useChatStore.getState().messageChain.length === 1);

    // THE HEAD outcome: it was the deleted leaf, so it moves to the row's own parent — the
    // position the message was generated from — instead of pointing at a row that is gone.
    expect(await getMessage(answer.id)).toBeUndefined();
    expect((await getSession(session.id))?.headMessageId).toBe(question.id);
    expect(bubbleTexts(host)).toEqual(['第一问']);
    expect(host.textContent).not.toContain('唯一的答案');
    // What is left is the whole chain: a delete of the tail leaves a real path, not a head
    // that resolves nowhere.
    expect((await getChain(session.id)).map((message) => message.content)).toEqual(['第一问']);
  });
});

/* ────────────────────── M1-S3: the opening panel ────────────────────── */

/**
 * THE PANEL IS A FUNCTION OF THE START STATE, AND EACH CHOICE LEAVES A DIFFERENT ONE
 * docs/06 §2.5's acceptance is 「三种方式均生成合法的首条消息」, but 跳过 generates no message
 * at all — so the cases below assert what each way leaves, driving the REAL panel: 手写 writes
 * the root from the textarea, AI 生成 goes through the same turn path (one request, no user
 * row), and 跳过 writes nothing while leaving a session whose next message is the root.
 *
 * WHY THE PANEL'S OWN CONDITION IS ASSERTED HERE RATHER THAN IN A UNIT TEST
 * "Only offered when the chain is empty" is a statement about what a person sees, and the
 * condition has two inputs that can disagree (`Session.headMessageId` and the live chain), so
 * the DOM is where it is observable: a fresh session shows the panel, and a session that has
 * started never does — not even for the frame in which `open` has cleared the chain but not
 * yet read it.
 */
describe('M1-S3: the opening panel', () => {
  /**
   * The panel's copy, read from the zh-CN catalog DIRECTLY.
   *
   * WHY NOT THE APP'S `translate`: that reads the live locale store, and a test that wanted a
   * particular sentence would then be asserting whatever the previous case left behind. The
   * suite pins the rendered language by WRITING the stored row (`beforeEach`), which is how a
   * returning user arrives at it, so the expectation has to name the same catalog explicitly.
   */
  const zh = createTranslator('zh-CN');

  /** An SSE body carrying `chunks`, in the provider's own wire format. */
  function sse(chunks: readonly string[]): Response {
    const encoder = new TextEncoder();
    const payloads = [
      ...chunks.map(
        (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      ),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads) controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  /** A transport that answers the replies in order, plus the count of requests it received. */
  function scriptedWire(replies: readonly (readonly string[])[]): {
    fetch: FetchLike;
    calls: () => number;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      fetch: () => {
        const reply = replies[calls] ?? [];
        calls += 1;
        return Promise.resolve(sse(reply));
      },
    };
  }

  /** Store the provider row and substitute the transport, the way `mountApp` wires them. */
  async function armTheProvider(wire: { readonly fetch: FetchLike }): Promise<void> {
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });
    configureChat({ transport: wire.fetch });
  }

  /**
   * Wait until the settings row is loaded, so a turn can be attempted.
   *
   * The play view asks for `SettingsState.loaded` and a click that arrived before that read
   * settled would be refused by `turnGate` — the case under test would then be asserting
   * against a banner instead of an opening.
   */
  async function waitForSettings(): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (!useSettingsStore.getState().loaded) {
      if (Date.now() > deadline) throw new Error('settings never loaded');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }

  /** The panel's own textarea, typed into the way a browser types. */
  async function typeOpening(host: HTMLElement, value: string): Promise<void> {
    const input = host.querySelector('.opening-input');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('no opening textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('offers all three choices while the session has no first message', async () => {
    const session = await createSession({ title: 'opening' });
    const host = await mountAt(`/play/${session.id}`, zh.t('play.openingTitle'));

    // The rendered copy is pinned by the zh-CN row this file writes in `beforeEach`, which is
    // what makes "the panel is in the active language" a checked fact rather than an assumption.
    expect(host.textContent).toContain(zh.t('play.openingHint'));
    expect(buttonLabels(host)).toContain(zh.t('play.openingWrite'));
    expect(buttonLabels(host)).toContain(zh.t('play.openingGenerate'));
    expect(buttonLabels(host)).toContain(zh.t('play.openingSkip'));
    expect(host.querySelector('.opening-input')).not.toBeNull();
    // Nothing is stored by merely showing the panel: offering a choice is not choosing.
    expect(await getChain(session.id)).toEqual([]);
    expect((await getSession(session.id))?.headMessageId).toBeNull();
  });

  it('hand-writes the opening, then takes the panel away and refuses a second one', async () => {
    const session = await createSession({ title: 'opening-hand' });
    const host = await mountAt(`/play/${session.id}`, zh.t('play.openingTitle'));

    await typeOpening(host, '酒馆的门在身后合上。');
    await clickButton(host, zh.t('play.openingWrite'));
    await waitForState(() => useChatStore.getState().messageChain.length === 1);

    // THE ROW: the chain's root, written from the textarea.
    const stored = await getChain(session.id);
    expect(stored.map((message) => message.content)).toEqual(['酒馆的门在身后合上。']);
    expect(stored[0]?.parentId).toBeNull();
    expect(stored[0]?.role).toBe('user');
    expect((await getSession(session.id))?.headMessageId).toBe(stored[0]?.id);
    await waitForText(host, '酒馆的门在身后合上。');

    // THE PANEL IS GONE once the chain is non-empty — the empty-transcript position is what
    // offered the choice, and it no longer holds.
    expect(host.querySelector('.opening-input')).toBeNull();
    expect(buttonLabels(host)).not.toContain(zh.t('play.openingWrite'));

    // AND A SECOND ATTEMPT IS A NO-OP even when a caller reaches the action directly: an
    // opening is a start, so a second row with `parentId: null` must be impossible. Wrapped in
    // `act` because the action updates the store the mounted view subscribes to.
    let written = true;
    await act(async () => {
      written = await useChatStore.getState().startOpening('第二句');
    });
    expect(written).toBe(false);
    expect(await listChildren(session.id, null)).toHaveLength(1);
  });

  it('refuses a blank opening with a sentence, and writes nothing', async () => {
    const session = await createSession({ title: 'opening-blank' });
    const host = await mountAt(`/play/${session.id}`, zh.t('play.openingTitle'));

    await clickButton(host, zh.t('play.openingWrite'));
    await waitForText(host, zh.t('play.openingWriteEmpty'));

    // The panel is still there (nothing was written) and the database is untouched.
    expect(host.querySelector('.opening-input')).not.toBeNull();
    expect(await getChain(session.id)).toEqual([]);
    expect((await getSession(session.id))?.headMessageId).toBeNull();
  });

  it('skips the opening: no row, and the next message is the chain root', async () => {
    const session = await createSession({ title: 'opening-skip' });
    const wire = scriptedWire([['对开的回答']]);
    await armTheProvider(wire);
    const host = await mountAt(`/play/${session.id}`, zh.t('play.openingTitle'));
    await waitForSettings();

    await clickButton(host, zh.t('play.openingSkip'));
    await waitForText(host, zh.t('play.openingSkipped'));
    // THE ACCEPTANCE FOR 跳过: nothing was written and the head is still null, so the session is
    // usable rather than blocked.
    expect(await getChain(session.id)).toEqual([]);
    expect((await getSession(session.id))?.headMessageId).toBeNull();
    expect(host.querySelector('.opening-input')).toBeNull();

    // AND THE NEXT TURN STARTS THE CHAIN FROM THAT NULL HEAD: the user's message is the root.
    await typeInto(host, '#turn-input', '我推开门');
    await clickButton(host, '发送');
    await waitForState(() => useChatStore.getState().messageChain.length === 2);
    const stored = await getChain(session.id);
    expect(stored.map((message) => message.content)).toEqual(['我推开门', '对开的回答']);
    expect(stored[0]?.parentId).toBeNull();
    expect(stored[1]?.parentId).toBe(stored[0]?.id);
    expect((await getSession(session.id))?.headMessageId).toBe(stored[1]?.id);
  });

  it('generates the opening through the panel with exactly one request and no user row', async () => {
    const session = await createSession({ title: 'opening-ai' });
    const wire = scriptedWire([['模型写的开场']]);
    await armTheProvider(wire);
    const host = await mountAt(`/play/${session.id}`, zh.t('play.openingTitle'));
    await waitForSettings();

    await clickButton(host, zh.t('play.openingGenerate'));
    await waitForState(() => useChatStore.getState().messageChain.length === 1);
    await waitForText(host, '模型写的开场');

    // ONE REQUEST, and the answer is the chain's ROOT: `append: {mode: 'none'}` writes no user
    // row, so the instruction is on the wire only.
    expect(wire.calls()).toBe(1);
    const stored = await getChain(session.id);
    expect(stored.map((message) => message.content)).toEqual(['模型写的开场']);
    expect(stored[0]?.role).toBe('assistant');
    expect(stored[0]?.parentId).toBeNull();
    expect((await getSession(session.id))?.headMessageId).toBe(stored[0]?.id);
    // The instruction the request carried was never stored, so no row in the database holds it.
    expect(await snapshotAllRows(databaseName)).not.toContain(zh.t('play.openingInstruction'));
    // The panel is gone, because the chain is no longer empty.
    expect(host.querySelector('.opening-input')).toBeNull();
  });

  it('never offers the panel to a session that already has a message', async () => {
    const session = await createSession({ title: 'opening-done' });
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '早就开始了',
    });
    await setHeadMessageId(session.id, first.id);

    const host = await mountAt(`/play/${session.id}`, '早就开始了');

    // Once the session is open the panel is never offered: the stored row is rendered and the
    // head is set, which is the fact the store's own guard reads. The action call below is the
    // other half — a caller that reaches it directly is refused too.
    await waitForState(() => useChatStore.getState().messageChain.length === 1);
    expect(host.querySelector('.opening-input')).toBeNull();
    expect(buttonLabels(host)).not.toContain(zh.t('play.openingGenerate'));
    // Wrapped in `act` like every other direct store call in this file: the action updates the
    // store, so an unwrapped call would leave React warning that the DOM assertions above may
    // have read a tree it never flushed.
    let refused = true;
    await act(async () => {
      refused = await useChatStore.getState().startOpening('第二条开场');
    });
    expect(refused).toBe(false);
    expect(await listChildren(session.id, null)).toHaveLength(1);
  });

  it('refuses a second opening after a rollback to before the first message', async () => {
    // A ROLLBACK TO BEFORE THE FIRST MESSAGE IS A REAL POSITION, and it is where the two
    // "has this session started" signals disagree: `Session.headMessageId` is back to `null`
    // while the opening row is still in the table (ADR-010 — messages are never deleted). The
    // panel is deliberately OFFERED again there — the live position really is "no transcript"
    // (`messageChain` is `[]`) — and the STORE is what refuses the second opening, because it
    // would have to be a second ROOT that no head can reach. This case pins that refusal: it is
    // the guard, not the panel, that makes a second opening impossible.
    //
    // The state is built the way the app builds it — save a point before the first message
    // (docs/02 §7's nullable `Checkpoint.messageId`), play on, then click 读档 — rather than by
    // poking the session row, so the position under test is one a user can reach.
    const session = await createSession({ title: 'opening-rolled-back' });
    const host = await mountAt(`/play/${session.id}`, zh.t('play.openingTitle'));

    // A save point at "no transcript", taken through the panel's own control.
    await typeInto(host, '#checkpoint-label', '开场前');
    await clickButton(host, zh.t('play.checkpointSave'));
    await waitForState(() => useChatStore.getState().checkpoints.length === 1);
    expect(useChatStore.getState().checkpoints[0]?.messageId).toBeNull();

    // Play on: the opening is written, then a second message hangs off it.
    await typeOpening(host, '开场白');
    await clickButton(host, zh.t('play.openingWrite'));
    await waitForState(() => useChatStore.getState().messageChain.length === 1);
    const opening = await getChain(session.id);
    expect(opening[0]?.parentId).toBeNull();
    const second = await appendMessage({
      sessionId: session.id,
      parentId: opening[0]?.id ?? null,
      role: 'assistant',
      content: '之后的一句',
    });
    await setHeadMessageId(session.id, second.id);
    await waitForState(() => useChatStore.getState().messageChain.length === 2);

    // The rollback, through the panel's two-step control.
    await clickButton(host, zh.t('play.checkpointRestore'));
    await clickButton(host, zh.t('play.checkpointRestoreConfirm'));
    await waitForState(() => useChatStore.getState().session?.headMessageId === null);

    // THE POSITION: a null head, no live transcript, and the opening still stored.
    expect((await getSession(session.id))?.headMessageId).toBeNull();
    expect(await listChildren(session.id, null)).toHaveLength(1);
    expect(useChatStore.getState().messageChain).toEqual([]);

    // AND THE WRITE IS REFUSED FROM THAT POSITION — the guard the panel cannot replace.
    let refused = true;
    await act(async () => {
      refused = await useChatStore.getState().startOpening('再写一条');
    });
    expect(refused).toBe(false);
    // ...and the same is true of the AI path, which must not send a request it would have to
    // write as a second root.
    await expect(useChatStore.getState().generateOpening()).resolves.toBe(false);
    expect(await listChildren(session.id, null)).toHaveLength(1);
  });
});
