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
import type { SessionState } from '@smarttavern/schema';
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
  createSession,
  getChain,
  getSession,
  listCheckpoints,
  readProviderSettings,
  setHeadMessageId,
  writeLocaleSetting,
  writeProviderSettings,
} from '../../db/repository';
import { translate } from '../../i18n/translate';
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
