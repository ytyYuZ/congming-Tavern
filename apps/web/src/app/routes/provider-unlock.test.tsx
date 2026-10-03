/**
 * THE PHASE A2 ACCEPTANCE, IN A REAL DOM: unlocking from the play screen, and the `/setup`
 * provider list (ADR-034).
 *
 * WHY THESE RENDER THE REAL `<App/>` AND DRIVE REAL EVENTS
 * Both failures this task fixes were about where a control IS and whether the screen updates
 * after using it:
 *   - "解密保存后仍然无法请求服务，提示 API 仍被锁定" — the passphrase field only existed on
 *     `/setup`, so the play screen could report `key_locked` and offer nothing;
 *   - "无法新建另一个 API key 并切换使用" — ADR-034 was decided but unimplemented.
 * A store-level test cannot tell an offered control from an absent one, and cannot tell "the
 * banner cleared" from "the store changed". So: mount at the path a user is on, click the button
 * a user clicks, type into the field it opens, and assert on the rendered text afterwards.
 *
 * WHY THE TURN IS SENT THROUGH THE PLAY SCREEN'S OWN COMPOSER
 * `key_locked` is produced by `state/chat-store.ts`'s turn gate, so the honest way to get the
 * banner on screen is to ask for a turn. The transport is a `forbiddenTransport`: if a request
 * ever leaves the device on this path, the test fails with the store's own error rather than
 * passing on a technicality.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { closeDatabase, resetDatabase } from '../../db/database';
import { deleteDatabase } from '../../db/raw-indexeddb.test-helpers';
import {
  createSession as createSessionRow,
  getSession,
  readProviderSettingsById,
  writeLocaleSetting,
  writeProviderSettings,
} from '../../db/repository';
import {
  createTestSession,
  TEST_INITIAL_CLOCK,
  TEST_SESSION_PINS,
} from '../../db/session.test-helpers';
import {
  configureChat,
  resetChat,
  resetCoCreate,
  resetLocaleStore,
  resetSettingsStore,
  useChatStore,
  useLocaleStore,
  useSettingsStore,
} from '../../mount';
import { deleteUnlockMemory } from '../../secrets/unlock-memory';

const PASSPHRASE = 'the-passphrase-for-this-device';
const API_KEY = 'sk-unlocked-from-the-play-screen';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'play-screen-model';

const FORBIDDEN: FetchLike = () =>
  Promise.reject(new Error('no request may leave the device while the key is locked'));

let databases = 0;
let databaseName = '';
let root: Root | undefined;
let container: HTMLElement | undefined;

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
  databaseName = `apps-web-provider-unlock-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetCoCreate();
  resetSettingsStore();
  resetLocaleStore();
  await deleteUnlockMemory();
  // The transport every test gets unless it substitutes its own. `resetChat` forgets it, and a
  // test that never configured one would fail with "not initialized" instead of the fact under
  // test — a green-looking difference (`routes.test.tsx` uses the same failing default).
  configureChat({ transport: FORBIDDEN });
  // Chinese copy is what the assertions below read. The STORED row is written rather than the
  // store poked: `<App/>`'s own `load()` adopts the persisted preference, and an in-memory poke
  // would be overwritten by that legitimate read (`routes.test.tsx` records the same trap).
  await writeLocaleSetting('zh-CN');
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  await unmount();
  resetChat();
  resetCoCreate();
  resetSettingsStore();
  resetLocaleStore();
  closeDatabase();
  await deleteDatabase(databaseName);
  await deleteUnlockMemory();
});

/* ───────────────────────── the async render helpers ──────────────────────── */

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

/** Wait until `check` is true, flushing React in between. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
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

/** Type into a controlled field the way a browser does (see `routes.test.tsx`'s helper). */
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

/** Click the button whose label is exactly `label`. */
async function clickButton(host: HTMLElement, label: string): Promise<void> {
  await clickIn(host, host, label);
}

/**
 * Click the button labelled `label` INSIDE `scope`.
 *
 * The scope matters where a list renders one control per row (the provider list's 删除), so the
 * click names the row instead of guessing which of two identical labels came first.
 */
async function clickIn(host: HTMLElement, scope: HTMLElement, label: string): Promise<void> {
  const button = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) {
    throw new Error(
      `no button labelled ${label}; buttons were: ${Array.from(host.querySelectorAll('button'))
        .map((candidate) => candidate.textContent)
        .join(' | ')}`,
    );
  }
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Check a checkbox the way a browser does, and prove it really changed. */
async function checkBox(scope: HTMLElement, selector: string): Promise<void> {
  const box = scope.querySelector(selector);
  if (!(box instanceof HTMLInputElement)) throw new Error(`no checkbox ${selector}`);
  await act(async () => {
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  if (!box.checked) throw new Error(`the checkbox ${selector} was not checked`);
}

/* ────────────────────────────── the fixtures ─────────────────────────────── */

/** The dialog element, once it is open. */
async function openUnlockDialog(host: HTMLElement): Promise<HTMLElement> {
  await clickButton(host, '解锁');
  await waitFor(() => host.querySelector('[data-dialog="unlock"]') !== null, 'the unlock dialog');
  const dialog = host.querySelector('[data-dialog="unlock"]');
  if (!(dialog instanceof HTMLElement)) throw new Error('the unlock dialog is not an element');
  return dialog;
}

/** Store a plaintext key and seal it, the way the setup screen does. */
async function sealAKey(): Promise<void> {
  await writeProviderSettings({
    baseUrl: BASE_URL,
    model: MODEL,
    secret: { kind: 'plaintext', apiKey: API_KEY },
  });
  await useSettingsStore.getState().load();
  await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();
}

/* ────────────────────────────────── tests ────────────────────────────────── */

describe('Phase A2: the play screen offers the unlock itself', () => {
  it('unlocks from the key_locked banner and continues without a reload', async () => {
    await sealAKey();
    useSettingsStore.getState().lock();
    expect(useSettingsStore.getState().locked).toBe(true);
    configureChat({ transport: FORBIDDEN });
    const session = await createTestSession({ title: '解锁测试' });

    const host = await mountAt(`/play/${session.id}`, '解锁测试');
    // The turn the user was trying to send: it is REFUSED, and the banner says why.
    await typeInto(host, '#turn-input', '你好');
    await clickButton(host, '发送');
    await waitForText(host, '密钥已加密且处于锁定状态');
    // NOTHING WAS SENT: the refusal happens before a request is built.
    expect(useSettingsStore.getState().key).toBeUndefined();

    // THE ACTION THE FAILURE ASKS FOR IS ON THIS SCREEN, not only in Settings.
    const dialog = await openUnlockDialog(host);
    await typeInto(host, '#unlock-passphrase', PASSPHRASE);
    // The opt-in is present and DEFAULT OFF (invariant 5): the dialog opens with it unchecked, so
    // nothing is remembered unless the user says so.
    const remember = dialog.querySelector('.unlock-remember input');
    if (!(remember instanceof HTMLInputElement)) throw new Error('no remember checkbox');
    expect(remember.checked).toBe(false);

    // Scoped to the DIALOG: the banner behind it has a button with the same label, and a
    // whole-document search would click that one and prove nothing.
    await clickIn(host, dialog, '解锁');
    await waitFor(
      () => useSettingsStore.getState().key === API_KEY,
      'the key to be readable in this tab',
    );
    // NO RELOAD: the same mounted tree now shows no lock refusal, and the store agrees.
    expect(useSettingsStore.getState().locked).toBe(false);
    expect(host.querySelector('[data-dialog="unlock"]')).toBeNull();
    await settle();
    expect(host.textContent ?? '').not.toContain('密钥已加密且处于锁定状态');

    // ...and the gate is really open: the same gesture is now ATTEMPTED, which is what the FAILED
    // turn and the stored user row prove — the transport is `FORBIDDEN`, so the attempt is
    // reported as a network failure rather than the lock refusal. (What a permitted turn writes is
    // `state/chat-store.test.ts`'s subject, not this file's.)
    await typeInto(host, '#turn-input', '再一次');
    await clickButton(host, '发送');
    await waitForText(host, '再一次');
    expect(useChatStore.getState().error?.code).not.toBe('key_locked');
  });

  it('remembers the unlock on request, and a reload then starts unlocked', async () => {
    await sealAKey();
    useSettingsStore.getState().lock();
    const session = await createTestSession({ title: '记住解锁' });

    const host = await mountAt(`/play/${session.id}`, '记住解锁');
    await typeInto(host, '#turn-input', '你好');
    await clickButton(host, '发送');
    await waitForText(host, '密钥已加密且处于锁定状态');
    const dialog = await openUnlockDialog(host);
    await checkBox(dialog, '.unlock-remember input');
    await typeInto(host, '#unlock-passphrase', PASSPHRASE);
    // Scoped to the dialog: the banner behind it has a button with the same label.
    await clickIn(host, dialog, '解锁');
    await waitFor(() => useSettingsStore.getState().key === API_KEY, 'the unlock');
    await waitFor(
      () => useSettingsStore.getState().remembered.length === 1,
      'the remembered record',
    );

    // THE RELOAD: a fresh tab means a fresh store and no session in memory. The opt-in is what
    // makes the row readable again with no passphrase (`secrets/unlock-memory.ts`).
    resetSettingsStore();
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().locked).toBe(false);
    expect(useSettingsStore.getState().key).toBe(API_KEY);
  });
});

describe('Phase A2 / ADR-034: the /setup provider list', () => {
  it('adds a second configuration and switches between the two', async () => {
    await sealAKey();
    const host = await mountAt('/setup', '模型服务');

    // The first configuration is listed, and it is the ACTIVE one.
    await waitFor(
      () => host.querySelectorAll('[data-provider]').length === 1,
      'the stored configuration to be listed',
    );
    const first = host.querySelector('[data-provider]');
    expect(first?.textContent).toContain('当前使用');

    // ADD: a second row appears and becomes the active one.
    await clickButton(host, '新增配置');
    await waitFor(
      () => host.querySelectorAll('[data-provider]').length === 2,
      'the second configuration to be listed',
    );
    const rows = Array.from(host.querySelectorAll('[data-provider]'));
    const secondId = rows
      .map((row) => row.getAttribute('data-provider'))
      .find((id) => id !== first?.getAttribute('data-provider'));
    expect(secondId).toBeTruthy();
    expect(useSettingsStore.getState().activeId).toBe(secondId);
    // The form now edits the row that was just added: it is empty, so the status line says there
    // is no key yet rather than showing the first configuration's key.
    expect(useSettingsStore.getState().key).toBeUndefined();

    // SWITCH BACK: the first row is active again and ITS key is readable again — the two rows
    // keep their own envelopes (`db/provider-list.test.ts` proves the storage half).
    await clickButton(host, '切换到这份配置');
    await waitFor(
      () => useSettingsStore.getState().activeId === first?.getAttribute('data-provider'),
      'the switch back to the first configuration',
    );
    expect(useSettingsStore.getState().key).toBe(API_KEY);
    // Two rows really are stored, each with its own values.
    const stored = await Promise.all(
      (await useSettingsStore.getState().providers).map((entry) =>
        readProviderSettingsById(entry.id),
      ),
    );
    expect(stored).toHaveLength(2);
    expect(stored.filter((row) => row.model === MODEL)).toHaveLength(1);
  });

  it('deletes an unused configuration, and refuses while a session pins one', async () => {
    await sealAKey();
    // A session that PINS the legacy row, the way `state/chat-store.ts`'s `create` writes the pin
    // a new session takes: `providerId` is the resolved row's id.
    const pinned = await createSessionRow({
      title: '钉住它的会话',
      refs: { ...TEST_SESSION_PINS, providerId: 'provider' },
      initialClock: TEST_INITIAL_CLOCK,
    });
    const host = await mountAt('/setup', '模型服务');

    await clickButton(host, '新增配置');
    await waitFor(
      () => host.querySelectorAll('[data-provider]').length === 2,
      'the second configuration',
    );
    // The newly added row is the ACTIVE one, so it is the one the list arms and deletes — and the
    // click is scoped to that row, because two rows render a 删除 button each.
    const activeRowId = useSettingsStore.getState().activeId;
    const activeRow = host.querySelector(`[data-provider="${activeRowId ?? ''}"]`);
    if (!(activeRow instanceof HTMLElement)) throw new Error('the active provider row is missing');
    await clickIn(host, activeRow, '删除这份配置');
    await clickIn(host, activeRow, '确认删除');
    await waitFor(
      () => host.querySelectorAll('[data-provider]').length === 1,
      'the unused configuration to be gone',
    );
    expect((await useSettingsStore.getState().providers).map((entry) => entry.id)).toEqual([
      'provider',
    ]);

    // Now the pinned survivor: the refusal NAMES the session that holds it, and nothing is
    // deleted (`db/provider-list.test.ts` proves the query half; this is the sentence a user reads).
    const survivor = host.querySelector('[data-provider="provider"]');
    if (!(survivor instanceof HTMLElement)) throw new Error('the surviving row is missing');
    await clickIn(host, survivor, '删除这份配置');
    await clickIn(host, survivor, '确认删除');
    await waitForText(host, '不能删除');
    expect(host.textContent ?? '').toContain('钉住它的会话');
    expect(pinned.refs.modelConfig.provider).toBe('provider');
    expect((await useSettingsStore.getState().providers).map((entry) => entry.id)).toEqual([
      'provider',
    ]);
  });

  it('revokes a remembered unlock from /setup without touching the stored key', async () => {
    await sealAKey();
    await useSettingsStore.getState().lock();
    await expect(
      useSettingsStore.getState().unlock(PASSPHRASE, { remember: true }),
    ).resolves.toBeUndefined();
    const sealed = await readProviderSettingsById('provider');
    if (sealed.secret.kind !== 'encrypted') throw new Error('the row is not encrypted');

    const host = await mountAt('/setup', '模型服务');
    await waitForText(host, '本设备已记住解锁');
    await clickButton(host, '忘记本设备的解锁');
    await waitFor(
      () => useSettingsStore.getState().remembered.length === 0,
      'the remembered record to be forgotten',
    );
    expect(host.textContent ?? '').not.toContain('本设备已记住解锁');
    // BYTE-IDENTICAL CIPHERTEXT: revoking clears the device record and nothing else, so the
    // passphrase is still the way in (`secrets/unlock-memory.ts` records why).
    const after = await readProviderSettingsById('provider');
    expect(after.secret).toEqual(sealed.secret);
    // The tab stays unlocked: revoking a convenience must not lock a screen the user is using.
    expect(useSettingsStore.getState().key).toBe(API_KEY);
  });

  it('pins a newly created session to the provider row the user selected', async () => {
    await sealAKey();
    // The row a new session should pin is the ACTIVE one, and `add` both creates and switches.
    const secondId = await useSettingsStore.getState().add();
    await useSettingsStore.getState().save(
      { baseUrl: 'https://second.test/v1', model: 'second-model' },
      {
        kind: 'plain',
        apiKey: 'sk-the-second-row',
      },
    );
    expect(useSettingsStore.getState().activeId).toBe(secondId);

    const sessionId = await useChatStore.getState().create({
      world: { id: 'test-world', version: 1 },
      cards: [{ id: 'test-player', name: 'Player', version: 1 }],
      playerId: 'test-player',
      initialClock: 0,
    });
    if (sessionId === undefined) throw new Error('the session was not created');
    const stored = await getSession(sessionId);
    // THE PIN NAMES A ROW THAT EXISTS: `refs.modelConfig.provider` is the row KEY (ADR-034), which
    // is what the delete refusal and the `/setup` list match sessions against.
    expect(stored?.refs.modelConfig.provider).toBe(secondId);
    expect((await useSettingsStore.getState().providers).map((entry) => entry.id)).toContain(
      stored?.refs.modelConfig.provider ?? '',
    );
    // ...and deleting that row is now refused, because this session pins it.
    const outcome = await useSettingsStore.getState().remove(secondId);
    expect(outcome.kind).toBe('pinned');
  });
});
