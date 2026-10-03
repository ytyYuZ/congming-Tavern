/**
 * Renaming a session from the play screen as a SCREEN (M1-T1).
 *
 * WHY A DOM TEST ON TOP OF `session/title.test.ts`
 * That file proves the RULE (what counts as a name, where the ceiling is) and knows nothing about
 * whether the screen is wired to it — a form that never calls the store, a store action that writes
 * and forgets the list behind it, or a refusal that quietly writes the blank name anyway are all
 * invisible there and obvious here. So this file drives the real `<App/>` at the real play route,
 * submits the real form, and asserts on BOTH halves: what the screen shows afterwards (the
 * breadcrumb, the status line) and what the row says.
 *
 * WHAT ONLY THIS FILE CAN PROVE
 * 1. 「播放屏可以重命名」 reaches the database: the row's title changes, and the SCREEN shows the new
 *    name without a reload — the store's memory and the row move together, which is the half a
 *    pure test cannot see.
 * 2. 「其它字段逐字未变」 is asserted against the RAW row (read back from IndexedDB, not through the
 *    schema): a rename is a read-merge-put, and a put that dropped `refs`, `state` or
 *    `headMessageId` would be a session nobody can open. The comparison is structural rather than
 *    byte-wise ON PURPOSE — the re-write goes through `SessionSchema.parse`, which does not promise
 *    JSON key ORDER — and it is made field by field against the row that was there before.
 * 3. A refused name writes NOTHING, proved by a byte-identical raw dump: the one assertion that
 *    cannot be satisfied by "the title happens to look right afterwards".
 *
 * WHY THE HARNESS IS LOCAL AND SMALL: `routes.test.tsx` is tuned to the message tree, the opening
 * flow, the scheduler and the cast intervention, and `session-fork.test.tsx` to forking; this file
 * needs a mount, a field, a click and the raw dump, so it borrows that mount shape rather than
 * exporting a harness the others would have to keep in step.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import type { FetchLike } from '@smarttavern/providers';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App, createAppRouter } from '../../app/app';
import { closeDatabase, resetDatabase } from '../../db/database';
import { deleteDatabase, sessionRows } from '../../db/raw-indexeddb.test-helpers';
import {
  appendMessage,
  createCheckpoint,
  getSession,
  setHeadMessageId,
  writeLocaleSetting,
  writeSessionState,
} from '../../db/repository';
import { createTestSession } from '../../db/session.test-helpers';
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
  databaseName = `apps-web-session-naming-route-${databases}`;
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

/** Wait for a control to exist, for the steps that arrive on a route through navigation. */
async function waitForField(host: Element, selector: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (host.querySelector(selector) !== null) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${selector}; DOM was: ${host.innerHTML}`);
    }
    await settle();
  }
}

/**
 * Click a link the way a person does, so the ROUTER decides the next path.
 *
 * A test that opened `/play/<id>` directly would be asserting on a play screen reached from
 * nowhere: the session list lives in the store's memory and is loaded by the home route, so the
 * "the list behind the session follows the rename" half of the behaviour would be unobservable
 * (the list would be empty, and an empty list updates vacuously).
 */
async function clickLink(host: Element, selector: string): Promise<void> {
  const link = host.querySelector(selector);
  if (!(link instanceof HTMLAnchorElement)) throw new Error(`no link ${selector}`);
  await act(async () => {
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

/**
 * Click one control by its `data-field`.
 *
 * The wait is longer than `settle`'s because a rename writes a row and re-renders what it wrote:
 * the click's own `act` has to cover the store's write → set chain or React reports the updates
 * landing just after it as un-acted.
 */
async function clickField(host: Element, selector: string): Promise<void> {
  const button = host.querySelector(selector);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no button ${selector}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

/** Type into a controlled input the way a browser does. */
async function typeInto(host: Element, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement)) throw new Error(`no field ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The value of an input, so a test can assert what the form seeded itself with. */
function inputValue(host: Element, selector: string): string {
  const field = host.querySelector(selector);
  if (!(field instanceof HTMLInputElement)) throw new Error(`no input ${selector}`);
  return field.value;
}

/* ────────────────────────── reading the raw row ──────────────────────────── */

/**
 * One field of a row that came straight out of IndexedDB.
 *
 * A PARAMETERISED key on purpose: the row is an index signature, so `noPropertyAccessFromIndexSignature`
 * rejects dot access and Biome's `useLiteralKeys` rejects the literal bracket form. Naming the field
 * in a variable is the one spelling both accept.
 */
function fieldOf(row: unknown, field: string): unknown {
  return (row as Record<string, unknown>)[field];
}

/** The session's own stored row, exactly as the database holds it: no schema, no defaults. */
async function rawSessionRow(sessionId: string): Promise<Record<string, unknown>> {
  const rows = JSON.parse(await sessionRows(databaseName, sessionId)) as readonly unknown[];
  const row = rows.find((candidate) => fieldOf(candidate, 'id') === sessionId);
  if (row === undefined) throw new Error(`no stored session row ${sessionId}`);
  return row as Record<string, unknown>;
}

/**
 * The row minus the two fields a rename is entitled to touch.
 *
 * WHY THE RENAME IS COMPARED FIELD BY FIELD AND NOT AS BYTES: the re-write goes through
 * `SessionSchema.parse`, which does not promise to keep the JSON key order the previous write used,
 * so a byte-wise comparison would fail on a row that lost nothing. What must hold is that every
 * OTHER field is `toEqual` what it was — the sentinel this file exists for — and `updatedAt` is
 * excluded because a write always moves it.
 */
function othersOf(row: Record<string, unknown>): Record<string, unknown> {
  const { title: _title, updatedAt: _updatedAt, ...others } = row;
  return others;
}

/* ─────────────────────────── the flow, end to end ────────────────────────── */

describe('the play screen rename form', () => {
  /**
   * A session with every field a rename could lose: versioned pins, a chain with a head message, a
   * live state (clock + variables) and a save point. The world is not one this database holds
   * (`TEST_SESSION_PINS` says why), which is exactly the point — the play screen opens a row whose
   * refs cannot all be resolved, so the rename has to be about the ROW and nothing else.
   */
  async function seedSession(
    title: string,
  ): Promise<{ readonly sessionId: string; readonly messageId: string }> {
    const session = await createTestSession({ title });
    const message = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '我推开门，走进昏暗的酒馆。',
    });
    await setHeadMessageId(session.id, message.id);
    await writeSessionState(session.id, { ...session.state, clock: 300, vars: { hp: 5 } });
    await createCheckpoint({ sessionId: session.id, label: '酒馆门口' });
    return { sessionId: session.id, messageId: message.id };
  }

  it('renames the open session, shows the new name at once, and loses nothing else', async () => {
    const { sessionId, messageId } = await seedSession('霜月群岛');
    const before = await rawSessionRow(sessionId);

    // The way a person gets there: the list, the row it links to, the form on that session. The
    // list is loaded by the home route, which is what makes the next assertion about MEMORY mean
    // something.
    const host = await mountAt('/', '霜月群岛');
    expect(useChatStore.getState().sessions.map((row) => row.title)).toEqual(['霜月群岛']);
    await clickLink(host, '.session-list a');
    await waitForField(host, '#session-rename-name');

    // The form is seeded from the ROW, not from an empty field: renaming starts from the name the
    // session already has.
    expect(inputValue(host, '#session-rename-name')).toBe('霜月群岛');

    await typeInto(host, '#session-rename-name', '雾港的第一夜');
    await clickField(host, '[data-field="session-rename"]');
    await waitForText(host, '已改名为「雾港的第一夜」');

    // THE ROW IS THE PROOF, and it is the only place the new name can be read from after a reload.
    expect((await getSession(sessionId))?.title).toBe('雾港的第一夜');

    // ...and the screen did not wait for a reload: the open session and the list behind it were
    // updated in memory, so going back to `/` shows the new name rather than the old one.
    expect(useChatStore.getState().session?.title).toBe('雾港的第一夜');
    expect(useChatStore.getState().sessions.map((row) => row.title)).toEqual(['雾港的第一夜']);

    // THE SENTINEL: everything the rename was not allowed to touch, compared against the row that
    // was there before it, plus the three fields a dropped merge would take with it.
    const after = await rawSessionRow(sessionId);
    expect(othersOf(after)).toEqual(othersOf(before));
    expect(fieldOf(after, 'headMessageId')).toBe(messageId);
    expect(fieldOf(after, 'refs')).toEqual(fieldOf(before, 'refs'));
    expect((await getSession(sessionId))?.state.clock).toBe(300);
    expect((await getSession(sessionId))?.state.vars).toEqual({ hp: 5 });
  });

  it('refuses a blank name with a sentence and writes nothing at all', async () => {
    const { sessionId } = await seedSession('霜月群岛');
    const before = await sessionRows(databaseName, sessionId);

    const host = await mountAt(`/play/${sessionId}`, '霜月群岛');
    await typeInto(host, '#session-rename-name', '   ');
    await clickField(host, '[data-field="session-rename"]');
    await waitForText(host, '会话名不能为空');

    // Byte-identical: not a title that happens to look unchanged, but no write at all. The schema's
    // `min(1)` would have rejected a stored `'   '`, so a form that passed the raw field through
    // would fail here in the loudest possible way.
    expect(await sessionRows(databaseName, sessionId)).toBe(before);
    expect((await getSession(sessionId))?.title).toBe('霜月群岛');
    // The breadcrumb still shows the real name: a refusal leaves the session as it was.
    expect(host.textContent).toContain('霜月群岛');
  });

  /**
   * The ceiling from the form's side, in the unit the row is really measured in: 200 emoji is 400
   * UTF-16 units and is ACCEPTED (zod counts code points), while one more code point is refused
   * with a sentence and no write.
   */
  it('accepts a name of 200 astral characters and refuses the 201st', async () => {
    const { sessionId } = await seedSession('霜月群岛');

    const host = await mountAt(`/play/${sessionId}`, '霜月群岛');
    await typeInto(host, '#session-rename-name', '😀'.repeat(201));
    await clickField(host, '[data-field="session-rename"]');
    await waitForText(host, '会话名最多 200 个字符');
    expect((await getSession(sessionId))?.title).toBe('霜月群岛');

    await typeInto(host, '#session-rename-name', '😀'.repeat(200));
    await clickField(host, '[data-field="session-rename"]');
    await waitForText(host, `已改名为「${'😀'.repeat(200)}」`);

    // Stored, and readable back through the schema that bounds it.
    const stored = (await getSession(sessionId))?.title ?? '';
    expect([...stored]).toHaveLength(200);
    expect(stored).toBe('😀'.repeat(200));
  });

  /**
   * A status line belongs to the session it reports on, and the field shows the session that is
   * now open.
   *
   * HOW THIS HOLDS TODAY: switching sessions goes through the store, and `open` calls `close`
   * first (`state/chat-store.ts`), which clears `session` — so this screen's session block renders
   * `null` for a frame and the form REMOUNTS on the next one. The guard is therefore a property of
   * the switch, not of this component's state: the test pins the PROPERTY, so a future change that
   * keeps the screen mounted across a switch cannot quietly leave a sentence about session A on
   * session B's screen.
   */
  it('does not carry the rename status into another session', async () => {
    const first = await seedSession('霜月群岛');
    const second = await seedSession('沉钟港');

    const host = await mountAt('/', '霜月群岛');
    await clickLink(host, `.session-list a[href="/play/${first.sessionId}"]`);
    await waitForField(host, '#session-rename-name');
    await typeInto(host, '#session-rename-name', '雾港的第一夜');
    await clickField(host, '[data-field="session-rename"]');
    await waitForText(host, '已改名为「雾港的第一夜」');

    const other = `.session-list a[href="/play/${second.sessionId}"]`;
    await clickLink(host, 'nav a[href="/"]');
    await waitForField(host, other);
    await clickLink(host, other);
    await waitForField(host, '#session-rename-name');

    // The field follows the session that is now open...
    expect(inputValue(host, '#session-rename-name')).toBe('沉钟港');
    // ...and so does the status line, which has nothing to say about a session nobody renamed.
    expect(host.textContent).not.toContain('已改名为');
  });
});
