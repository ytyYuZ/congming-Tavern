/**
 * The create-session screen as a SCREEN (M1-S1): a real form over real rows, ending on the play
 * screen where the opening flow takes over.
 *
 * WHY A DOM TEST ON TOP OF `session/roster.test.ts` AND `db/session-create.test.ts`
 * The pure file proves the RULE (which card is cast, which refusals exist) and the storage file
 * proves the ROW. Neither can see whether a control is wired to the rule: a world whose versions
 * never load, a card tick that does not reach the draft, or a designation that is silently
 * ignored are all invisible there and obvious here. So this file drives the real `<App/>` at the
 * real path, picks options, clicks boxes, and ends by asserting on the SESSION ROW — a value on
 * screen proves a component rendered something; only the row proves the gesture was saved.
 *
 * WHAT IT ASSERTS THAT NOTHING ELSE CAN
 * 1. 「卡司自动生成」 is visible: after ticking two cards and designating one, the ledger under the
 *    list names the other as cast — and the row's `refs.cast` is that same card, so the sentence
 *    and the storage cannot disagree.
 * 2. 「选世界版本」 is a real choice in the UI: with a world that has two versions, the newest is
 *    preselected (and said out loud), picking the older one pins THAT version, and the clock the
 *    form prefills follows the version the user picked.
 * 3. Every refusal the form can reach is a sentence, and NO row is written for any of them.
 * 4. The flow lands on `/play/$sessionId` with the session's chain empty, i.e. where the opening
 *    panel applies (M1-S3) — the "creating a session should land somewhere the opening flow can
 *    take over" half of the task.
 *
 * WHY THE HARNESS IS LOCAL AND SMALL: the editors' harness (`editors.test.tsx`) is tuned to
 * autosave and publish; this screen has no draft and no publish, so it needs six helpers, and
 * sharing them would mean exporting a harness whose behaviour half of it never exercises.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import type { WorldData } from '@smarttavern/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { blankCharacterData } from '../../cards/character';
import { blankWorldData } from '../../cards/world';
import { closeDatabase, resetDatabase } from '../../db/database';
import { deleteDatabase } from '../../db/raw-indexeddb.test-helpers';
import {
  createCharacter,
  createWorld,
  getChain,
  listSessions,
  publishWorld,
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
  databaseName = `apps-web-session-create-route-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  configureChat({ transport: forbiddenTransport });
  // This file asserts RENDERED Chinese labels, so the language is pinned through the STORED row
  // (which the shell's own `load()` adopts) and in memory.
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

/**
 * Click the button whose label is exactly `label`.
 *
 * The wait is longer than the other helpers': 「创建会话」 writes a row and then navigates, so the
 * click's own `act` has to cover the store's create → list refresh → open chain and the play
 * screen's first mount, or React reports the updates that land just after it as un-acted.
 */
async function clickButton(host: Element, label: string): Promise<void> {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}

/**
 * Choose a `<select>` option the way a browser does: the native value setter plus a `change`
 * event, because React's controlled select reads the event, not the property assignment.
 */
async function selectOption(host: Element, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLSelectElement)) throw new Error(`no select ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Type into a controlled input the way a browser does. */
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Click a checkbox or radio. */
async function clickField(host: Element, selector: string): Promise<void> {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement)) throw new Error(`no checkbox/radio ${selector}`);
  await act(async () => {
    field.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The value of an input, so a test can assert what the form prefilled. */
function inputValue(host: Element, selector: string): string {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement)) throw new Error(`no input ${selector}`);
  return field.value;
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** A world whose clock starts at `startMinute`, created as head + version 1. */
async function seedWorld(name: string, startMinute: number): Promise<string> {
  const data: WorldData = { ...blankWorldData(name), startMinute };
  const created = await createWorld({ name, data });
  if (created === undefined) throw new Error('the world fixture was refused');
  return created.world.id;
}

/** A card, created as head + version 1. */
async function seedCharacter(name: string): Promise<string> {
  const created = await createCharacter({ name, data: blankCharacterData(name) });
  if (created === undefined) throw new Error('the card fixture was refused');
  return created.character.id;
}

/* ─────────────────────────── the flow, end to end ────────────────────────── */

describe('the create-session screen', () => {
  it('creates from a world and two cards, derives the cast, and opens the play screen', async () => {
    const worldId = await seedWorld('霜月群岛', 720);
    const lianId = await seedCharacter('莉安');
    const miraId = await seedCharacter('米拉');

    const host = await mountAt('/sessions/new', '霜月群岛');

    // Nothing is chosen yet, and the ledger of the derived cast is not shown: there is no answer
    // to "who is cast" before a player is designated.
    expect(host.querySelector('[data-status="session-cast"]')).toBeNull();

    await selectOption(host, '#session-world', worldId);
    await waitForText(host, '本次会话固定 v1');
    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickField(host, `[data-field="session-card-${miraId}"]`);
    await clickField(host, `[data-field="session-player-${lianId}"]`);

    // 「卡司自动生成」, made visible BEFORE the button: the other ticked card, and only it.
    await waitForText(host, '卡司（自动生成）: 米拉');
    const ledger = host.querySelector('[data-status="session-cast"]')?.textContent ?? '';
    expect(ledger).not.toContain('莉安');

    await clickButton(host, '创建会话');

    // THE ROW IS THE PROOF. Versioned pins, the derived cast, the world's start minute as both
    // the origin and the live clock, and no message yet.
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.title).toBe('新会话');
    expect(session?.refs.world).toEqual({ id: worldId, version: 1 });
    expect(session?.refs.playerCharacter).toEqual({ id: lianId, version: 1 });
    expect(session?.refs.cast).toEqual([{ id: miraId, version: 1 }]);
    expect(session?.refs.promptPreset).toEqual({ id: 'builtin-default', version: 1 });
    expect(session?.initialClock).toBe(720);
    expect(session?.state.clock).toBe(720);
    expect(session?.headMessageId).toBeNull();
    expect(await getChain(session?.id ?? '')).toEqual([]);

    // ...and the flow ends where the opening is offered (M1-S3): the play screen of that session,
    // with its three choices and an empty transcript.
    await waitForText(host, '开场');
    expect(host.textContent).toContain('写开场');
    expect(host.querySelector('.transcript')?.textContent).toBe('');
  });

  it('offers every version of the chosen world and pins the one that was chosen', async () => {
    const worldId = await seedWorld('霜月群岛', 60);
    const published = await publishWorld({
      worldId,
      data: { ...blankWorldData('霜月群岛'), startMinute: 120 },
      baseVersion: 1,
      reason: 'test fixture',
    });
    expect(published?.version.version).toBe(2);
    const lianId = await seedCharacter('莉安');

    const host = await mountAt('/sessions/new', '霜月群岛');
    await selectOption(host, '#session-world', worldId);

    // The newest version is preselected, said out loud, and the clock follows ITS start minute.
    await waitForText(host, '本次会话固定 v2');
    expect(host.textContent).toContain('该世界最新版本为 v2');
    expect(inputValue(host, '#session-clock')).toBe('120');

    // Picking the OLDER version moves both the sentence and the clock default.
    await selectOption(host, '#session-world-version', '1');
    await waitForText(host, '本次会话固定 v1');
    expect(host.textContent).toContain('该世界最新版本为 v2');
    expect(inputValue(host, '#session-clock')).toBe('60');

    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickField(host, `[data-field="session-player-${lianId}"]`);
    await clickButton(host, '创建会话');

    const session = (await listSessions())[0];
    // NOT merely the latest: the chosen one, with the clock the chosen version starts at.
    expect(session?.refs.world.version).toBe(1);
    expect(session?.initialClock).toBe(60);
    expect(session?.state.clock).toBe(60);
    expect(session?.refs.cast).toEqual([]);
  });

  it('refuses every missing choice with a sentence, and writes nothing', async () => {
    const worldId = await seedWorld('霜月群岛', 0);
    const lianId = await seedCharacter('莉安');
    const miraId = await seedCharacter('米拉');

    const host = await mountAt('/sessions/new', '霜月群岛');

    // No world and no cards: both sentences, because both choices are missing.
    await clickButton(host, '创建会话');
    await waitForText(host, '请选择一个世界卡及其版本');
    expect(host.textContent).toContain('请至少勾选一张角色卡');

    // The world is chosen, so its sentence goes away and the cards' stays.
    await selectOption(host, '#session-world', worldId);
    await clickButton(host, '创建会话');
    await waitForText(host, '请至少勾选一张角色卡');
    expect(host.textContent).not.toContain('请选择一个世界卡及其版本');

    // Two cards ticked, no designation yet.
    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickField(host, `[data-field="session-card-${miraId}"]`);
    await clickButton(host, '创建会话');
    await waitForText(host, '请指定一张角色卡作为玩家角色');

    // A clock that is not a minute is refused too — and the empty field is NOT a refusal: it is
    // the world's own start minute, which is what the hint promises.
    await clickField(host, `[data-field="session-player-${lianId}"]`);
    await typeInto(host, '#session-clock', 'abc');
    await clickButton(host, '创建会话');
    await waitForText(host, '初始时钟必须是整数分钟');
    expect(await listSessions()).toEqual([]);

    // Unticking the player's card clears the designation rather than leaving a player who is not
    // taking part: the sentence is back, and still nothing was written.
    await typeInto(host, '#session-clock', '');
    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickButton(host, '创建会话');
    await waitForText(host, '请指定一张角色卡作为玩家角色');
    expect(host.textContent).not.toContain('指定的玩家角色不在已勾选的角色卡中');
    expect(await listSessions()).toEqual([]);
  });

  /**
   * 「创建时可填会话名」, the half a screen can prove: the FIELD is wired to the row.
   *
   * The hint is asserted before the click because it is the promise the blank case below keeps —
   * a hint that named a different default than the store writes would be worse than no hint.
   */
  it('stores the name the user typed, trimmed, as the stored title', async () => {
    const worldId = await seedWorld('霜月群岛', 720);
    const lianId = await seedCharacter('莉安');

    const host = await mountAt('/sessions/new', '霜月群岛');
    expect(host.textContent).toContain('留空则使用默认名「新会话」');

    await typeInto(host, '#session-name', ' 霜月群岛的第一夜 ');
    await selectOption(host, '#session-world', worldId);
    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickField(host, `[data-field="session-player-${lianId}"]`);
    await clickButton(host, '创建会话');

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    // The edges are gone, the inner text is not: a padded name is a typo, not a different name.
    expect(sessions[0]?.title).toBe('霜月群岛的第一夜');

    // ...and the name the row holds is the name the play screen shows, in its breadcrumb.
    await waitForText(host, '霜月群岛的第一夜');
  });

  /**
   * The default, which must stay BYTE-FOR-BYTE today's behaviour: the untouched field, and a field
   * holding only spaces, both store `home.defaultSessionTitle` (the first case of this file pins
   * the same value through a form where the field was never touched).
   *
   * WHY SPACES GET THEIR OWN ASSERTION: `titleNameOf` trims, and the schema's `min(1)` would
   * reject `'   '` — a form that passed the raw field through would write a row nothing can read.
   */
  it('leaves the default title when the name is blank or only spaces', async () => {
    const worldId = await seedWorld('霜月群岛', 720);
    const lianId = await seedCharacter('莉安');

    const host = await mountAt('/sessions/new', '霜月群岛');
    await selectOption(host, '#session-world', worldId);
    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickField(host, `[data-field="session-player-${lianId}"]`);
    await typeInto(host, '#session-name', '   ');
    await clickButton(host, '创建会话');

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe('新会话');
  });

  /**
   * The ceiling, from the screen's side: an emoji name at the limit is ACCEPTED and the next code
   * point is REFUSED with a sentence and no row.
   *
   * WHY 200 EMOJI AND NOT 200 LETTERS: zod measures the stored title in code points, so 200 emoji
   * is 400 UTF-16 units — a form that counted units (or a `maxLength` attribute, which counts
   * units) would refuse a name `SessionSchema` stores happily. The pair below is the boundary
   * itself: one over is refused, exactly at it lands.
   */
  it('refuses a name past the limit the row accepts, and accepts one exactly at it', async () => {
    const worldId = await seedWorld('霜月群岛', 720);
    const lianId = await seedCharacter('莉安');

    const host = await mountAt('/sessions/new', '霜月群岛');
    await selectOption(host, '#session-world', worldId);
    await clickField(host, `[data-field="session-card-${lianId}"]`);
    await clickField(host, `[data-field="session-player-${lianId}"]`);

    await typeInto(host, '#session-name', '😀'.repeat(201));
    await clickButton(host, '创建会话');
    await waitForText(host, '会话名最多 200 个字符');
    // The refusal is the whole outcome: no row, and the flow did not move to the play screen.
    expect(await listSessions()).toEqual([]);

    await typeInto(host, '#session-name', '😀'.repeat(200));
    await clickButton(host, '创建会话');

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect([...(sessions[0]?.title ?? '')]).toHaveLength(200);
    expect(sessions[0]?.title).toBe('😀'.repeat(200));
  });
});
