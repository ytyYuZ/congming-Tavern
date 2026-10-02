/**
 * The fork panel as a SCREEN (M1-M2): forking from the play view, and landing in the new timeline.
 *
 * WHY A DOM TEST ON TOP OF `db/session-fork.test.ts`
 * That file proves the ROWS: new ids, a remapped chain, an untouched origin, the lineage. It
 * cannot see whether the panel is wired to any of it - a control that wrote nothing, a fork that
 * never opened, or a screen that kept rendering the origin's transcript while the database held a
 * new session are all invisible there and obvious here. So this file drives the real `<App/>` at
 * the real play route, clicks the panel's own two-step control, and asserts on BOTH halves: what
 * the screen shows afterwards (the new timeline's transcript and its clock) and what the rows say
 * (two sessions, and the origin unchanged on bytes).
 *
 * WHAT ONLY THIS FILE CAN PROVE
 * 1. 从任意存档点创建新时间线 reaches the SCREEN: the fork opens, its transcript is the origin's
 *    up to the cut, and the message the origin wrote after the cut is not in it.
 * 2. The first click ARMS the fork and writes nothing: a mis-aimed click on a row that creates a
 *    whole session must be checkable before it happens (the shape every other row on this screen
 *    uses for a destructive act).
 * 3. 原时间线不受影响 is asserted on the origin's own bytes while the user is looking at the new
 *    timeline - the state the acceptance sentence is actually about.
 *
 * WHY THE HARNESS IS LOCAL AND SMALL: `routes.test.tsx` is tuned to the message tree, the opening
 * flow, the scheduler and the cast intervention; this file needs a mount, a click and the raw dump
 * and nothing else, so it borrows the mount shape from `session-create.test.tsx` rather than
 * exporting a harness the other two files would have to keep in step.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { clockOf, worldClockText } from '../../chat/clock';
import { closeDatabase, resetDatabase } from '../../db/database';
import { deleteDatabase, sessionRows } from '../../db/raw-indexeddb.test-helpers';
import {
  appendMessage,
  createCheckpoint,
  deleteCheckpoint,
  getSession,
  listSessions,
  setHeadMessageId,
  writeLocaleSetting,
  writeSessionState,
} from '../../db/repository';
import { createTestSession } from '../../db/session.test-helpers';
import { translate } from '../../i18n/translate';
// The stores come from `mount`, not from `state/*`: Vitest instantiates a module per environment,
// and a store reached through another graph would be a different object from the one the mounted
// views read (see `mount.ts`'s re-export note).
import {
  configureChat,
  resetChat,
  resetContentStore,
  resetLocaleStore,
  resetSettingsStore,
  useChatStore,
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
  databaseName = `apps-web-session-fork-route-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  resetLocaleStore();
  resetContentStore();
  configureChat({ transport: forbiddenTransport });
  // This file asserts RENDERED Chinese copy, so the language is pinned through the STORED row
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
 * Click one control by its `data-field`.
 *
 * The wait is longer than `settle`'s because a fork writes a whole session row, its messages and
 * its save points, then navigates and opens the result: the click's own `act` has to cover that
 * chain or React reports the updates landing just after it as un-acted.
 */
async function clickField(host: Element, selector: string): Promise<void> {
  const button = host.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no button ${selector}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

/**
 * The clock sentence the VIEW renders for a session row, built through the same pair the view
 * renders through (`clockOf` + `worldClockText`) with the store's own calendar - so the assertion
 * follows a catalog wording change instead of breaking on it, and still proves the screen shows
 * the minute the database holds.
 */
function clockSentenceOf(sessionId: string): Promise<string> {
  return getSession(sessionId).then((session) => {
    if (session === undefined) throw new Error(`no session ${sessionId}`);
    return worldClockText(clockOf(useChatStore.getState().calendar, session), translate);
  });
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

interface Origin {
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly thirdId: string;
}

/**
 * The origin: two messages, a save point at the second one with a clock and variables of its own,
 * then a third message and a later clock. The two clocks and the two variable values differ, so
 * "the fork carried the SAVE POINT's state" is a real question rather than a coincidence.
 */
async function seedOrigin(): Promise<Origin> {
  const session = await createTestSession({ title: '原时间线' });
  const first = await appendMessage({
    sessionId: session.id,
    parentId: null,
    role: 'user',
    content: '我推开门',
  });
  const second = await appendMessage({
    sessionId: session.id,
    parentId: first.id,
    role: 'assistant',
    content: '门后是昏暗的酒馆。',
  });
  await setHeadMessageId(session.id, second.id);

  await writeSessionState(session.id, {
    ...session.state,
    clock: 300,
    vars: { hp: 5 },
  });
  const checkpoint = await createCheckpoint({ sessionId: session.id, label: '进城前' });
  if (checkpoint === undefined) throw new Error('the save-point fixture was refused');

  const third = await appendMessage({
    sessionId: session.id,
    parentId: second.id,
    role: 'assistant',
    content: '她抬起了头。',
  });
  await setHeadMessageId(session.id, third.id);
  await writeSessionState(session.id, { ...session.state, clock: 700, vars: { hp: 1 } });

  return { sessionId: session.id, checkpointId: checkpoint.id, thirdId: third.id };
}

/** The session the fork created: the one that is not the origin. */
async function forkedSession(originId: string) {
  const forked = (await listSessions()).find((session) => session.id !== originId);
  if (forked === undefined) throw new Error('the fork wrote no session');
  return forked;
}

/* ────────────────────────────── the two fork points ──────────────────────── */

describe('the fork panel', () => {
  it('forks from a save point, opens the new timeline, and leaves the origin on bytes', async () => {
    const origin = await seedOrigin();
    const before = await sessionRows(databaseName, origin.sessionId);
    const host = await mountAt(`/play/${origin.sessionId}`, '进城前');

    // The panel is offered beside the save point it forks, and the FIRST click only arms the act:
    // a fork creates a session, so nothing may be written before it is confirmed.
    expect(host.textContent).toContain('分叉时间线');
    await clickField(host, `[data-field="fork-${origin.checkpointId}"]`);
    expect(host.textContent).toContain('确认分叉');
    expect(await listSessions()).toHaveLength(1);

    await clickField(host, `[data-field="fork-confirm-${origin.checkpointId}"]`);
    // The new session's title is what tells the two screens apart, so it is the thing to wait for.
    await waitForText(host, '（分叉）');

    // THE NEW ROW: written, titled, and cut where the user pointed.
    const forked = await forkedSession(origin.sessionId);
    expect(forked.title).toBe('原时间线（分叉）');
    expect(forked.state.clock).toBe(300);
    expect(forked.state.vars).toEqual({ hp: 5 });

    // THE SCREEN IS THE NEW TIMELINE: its transcript, its clock, and none of what the origin
    // wrote after the cut.
    expect(host.textContent).toContain('我推开门');
    expect(host.textContent).toContain('门后是昏暗的酒馆。');
    expect(host.textContent).not.toContain('她抬起了头。');
    expect(host.textContent).toContain(await clockSentenceOf(forked.id));
    expect(host.textContent).not.toContain(await clockSentenceOf(origin.sessionId));

    // 原时间线不受影响: same bytes, same head, same clock - while the user is in the new timeline.
    expect(await sessionRows(databaseName, origin.sessionId)).toBe(before);
    const live = await getSession(origin.sessionId);
    expect(live?.headMessageId).toBe(origin.thirdId);
    expect(live?.state.clock).toBe(700);
  });

  it('forks from right now, carrying the whole transcript and the live state', async () => {
    const origin = await seedOrigin();
    const before = await sessionRows(databaseName, origin.sessionId);
    const host = await mountAt(`/play/${origin.sessionId}`, '分叉时间线');

    await clickField(host, '[data-field="fork-head"]');
    expect(host.textContent).toContain('确认分叉');
    expect(await listSessions()).toHaveLength(1);

    await clickField(host, '[data-field="fork-confirm-head"]');
    await waitForText(host, '（分叉）');

    const forked = await forkedSession(origin.sessionId);
    // Everything the origin had, because the cut is at its tip.
    expect(forked.state.clock).toBe(700);
    expect(forked.state.vars).toEqual({ hp: 1 });
    expect(forked.headMessageId).not.toBe(origin.thirdId);
    expect(host.textContent).toContain('她抬起了头。');
    expect(host.textContent).toContain(await clockSentenceOf(forked.id));
    // The origin is still exactly where it was.
    expect(await sessionRows(databaseName, origin.sessionId)).toBe(before);
    expect((await getSession(origin.sessionId))?.headMessageId).toBe(origin.thirdId);
  });

  it('keeps a title that is already at the schema’s ceiling writable, with the suffix intact', async () => {
    // `SessionSchema` caps `title` at 200 characters, and a fork's title is the origin's PLUS a
    // suffix - so without a cut the sessions with the most deliberate names would be the ones
    // whose fork the schema refuses (and the transaction would roll back, writing nothing).
    const session = await createTestSession({ title: '长'.repeat(200) });
    const host = await mountAt(`/play/${session.id}`, '分叉时间线');

    await clickField(host, '[data-field="fork-head"]');
    await clickField(host, '[data-field="fork-confirm-head"]');
    await waitForText(host, '（分叉）');

    const forked = await forkedSession(session.id);
    expect([...forked.title]).toHaveLength(200);
    expect(forked.title.endsWith('（分叉）')).toBe(true);
  });

  it('says so when the save point is gone, and writes no session', async () => {
    // The list on screen is read once per `open`, so a save point another tab deleted is still
    // CLICKABLE here - and the act must fail with a sentence rather than a button that did
    // nothing (or, worse, a session forked from a position that is no longer stored).
    const origin = await seedOrigin();
    const host = await mountAt(`/play/${origin.sessionId}`, '进城前');
    await deleteCheckpoint(origin.checkpointId);

    await clickField(host, `[data-field="fork-${origin.checkpointId}"]`);
    await clickField(host, `[data-field="fork-confirm-${origin.checkpointId}"]`);
    await waitForText(host, '未能分叉');

    expect(await listSessions()).toHaveLength(1);
  });
});
