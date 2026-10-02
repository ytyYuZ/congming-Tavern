/**
 * The repository against real IndexedDB (`fake-indexeddb`, M0-T8).
 *
 * WHAT THIS FILE HAS TO PROVE
 * 1. The chain is rebuilt over a BRANCHED tree — the active branch only, in order.
 * 2. Settings round-trip, including the API key (which lives in that one row).
 * 3. "Restart" is a fresh adapter over the same database name, and it still sees the
 *    data. That is the last clause of the milestone's acceptance sentence, and the
 *    only way to test it is to build a second adapter — a page reload is not
 *    expressible in a test process.
 * 4. The `liveQuery` subscription the state layer depends on actually re-fires when a
 *    row it read changes. This is the reactive path, so it is asserted end to end
 *    rather than assumed: `StorageAdapter.transaction` is read-write and Dexie refuses
 *    it inside a querier, which would make the subscription silently never emit.
 * 5. `Session.state` (ADR-032): the live clock and variables survive a restart, and a
 *    row written BEFORE the field existed is completed at the read boundary with the
 *    default derived from `initialClock`. Case 5's first test writes that old row the
 *    way the old CODE wrote it — through the raw write path — because going through
 *    `createSession` would test nothing (it always writes a `state`).
 */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { Message, Session, SessionState } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, readTable, resetDatabase, subscribe, write } from '../db/database';
import {
  appendMessage,
  type CheckpointRow,
  createCheckpoint,
  deleteCheckpoint,
  deleteLeafMessage,
  getChain,
  getCheckpoint,
  getMessage,
  getSession,
  hasChildren,
  listCheckpoints,
  listChildren,
  listSessions,
  readChain,
  readProviderSettings,
  readSessions,
  restoreCheckpoint,
  setHeadMessageId,
  writeProviderSettings,
  writeSessionState,
} from '../db/repository';
// A session as a container, with the pins the create flow would have collected (M1-S1): this
// file's subject is the repository's rows and queries, not which world a session pins.
import { createTestSession as createSession } from '../db/session.test-helpers';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-repository-${databases}`;
  resetDatabase(databaseName);
});

afterEach(async () => {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The row shape a plaintext (M0 / fallback) key is written in. */
const PLAINTEXT = { kind: 'plaintext', apiKey: 'sk-round-trip' } as const;

describe('db/repository', () => {
  it('reconstructs the ACTIVE branch of a branched tree, oldest first', async () => {
    const session = await createSession({ title: '分支测试' });

    // Root, then two children. The second is the head, so the first is a discarded
    // branch — the shape a regeneration produces (docs/02 §7).
    const root = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '开场',
    });
    await appendMessage({
      sessionId: session.id,
      parentId: root.id,
      role: 'assistant',
      content: '被放弃的回答',
    });
    const kept = await appendMessage({
      sessionId: session.id,
      parentId: root.id,
      role: 'assistant',
      content: '保留的回答',
    });
    const follow = await appendMessage({
      sessionId: session.id,
      parentId: kept.id,
      role: 'user',
      content: '继续',
    });
    await setHeadMessageId(session.id, follow.id);

    const chain = await getChain(session.id);
    expect(chain.map((message) => message.content)).toEqual(['开场', '保留的回答', '继续']);
    expect(chain.map((message) => message.parentId)).toEqual([null, root.id, kept.id]);
    expect(chain.some((message) => message.content === '被放弃的回答')).toBe(false);

    // The sibling is still stored: branching is a pointer, not a delete.
    expect((await listSessions()).length).toBe(1);
    expect((await readChain(session.id)).length).toBe(3);
    expect((await readSessions())[0]?.id).toBe(session.id);
  });

  it('answers an empty chain before the first message and for an unknown session', async () => {
    const session = await createSession({ title: 'test-session' });
    expect(await getChain(session.id)).toEqual([]);
    expect(await getChain('no-such-session')).toEqual([]);
    expect(await getSession('no-such-session')).toBeUndefined();
  });

  it('stops walking a corrupted cycle instead of hanging', async () => {
    const session = await createSession({ title: 'test-session' });
    // A cycle with no root at all: A's parent is B and B's parent is A. The walk has to
    // terminate on the repetition, not on the 10k bound and certainly not by hanging.
    const a = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: 'a',
    });
    const b = await appendMessage({
      sessionId: session.id,
      parentId: a.id,
      role: 'user',
      content: 'b',
    });
    // Re-point A at B, making the pair a loop.
    await putRawMessage({ ...a, parentId: b.id });
    await setHeadMessageId(session.id, b.id);

    const chain = await getChain(session.id);
    expect(chain.map((message) => message.content)).toEqual(['a', 'b']);
  });

  it('completes a row written before Session.state existed, from initialClock (ADR-032)', async () => {
    // The row is written the way the OLD code wrote it: a raw put with NO `state`.
    // Going through `createSession` would test nothing, since it always writes one.
    const session = await createSession({ title: '旧行' });
    // Destructured rather than typed away: a spread of `Omit<Session, 'state'>` would
    // still CARRY the state at runtime, which is exactly what this test must not do.
    const { state: _droppedState, ...withoutState } = session;
    await putRawSession({ ...withoutState, initialClock: 4321 });
    // The read boundary is what makes the untrusted row usable: the clock is the
    // session's own origin, and everything else is empty rather than invented.
    const readBack = await getSession(session.id);
    expect(readBack?.state).toEqual({
      scene: { title: '', location: '', time: 4321 },
      clock: 4321,
      vars: {},
      sheets: {},
      deadlines: [],
    });
    expect(readBack?.initialClock).toBe(4321);
    expect((await listSessions())[0]?.state.clock).toBe(4321);

    // A malformed state is REPAIRED by the same rule rather than rejecting the row
    // (the `readLocaleSetting` idiom): a half-trusted state is the bug this prevents.
    await putRawSession({ ...withoutState, initialClock: 4321, state: { clock: 'not-a-number' } });
    expect((await getSession(session.id))?.state.clock).toBe(4321);
  });

  it('round-trips the live state: a changed clock and vars survive a restart', async () => {
    const session = await createSession({ title: 'test-session' });
    const advanced: SessionState = {
      ...session.state,
      scene: { title: 'The inn', location: 'Silverpine', time: 90 },
      clock: 90,
      vars: { weather: 'snow', danger: 3 },
    };
    await writeSessionState(session.id, advanced);

    // "Restart": close this connection and open a NEW adapter over the same name, so
    // the assertion runs through the real read path and not against an in-memory copy.
    closeDatabase();
    resetDatabase(databaseName);

    const reloaded = await getSession(session.id);
    expect(reloaded?.state.clock).toBe(90);
    expect(reloaded?.state.vars).toEqual({ weather: 'snow', danger: 3 });
    expect(reloaded?.state.scene.time).toBe(90);
    // The origin is NOT overwritten: the live clock is a different field now, and the
    // default state's clock is the only thing derived from `initialClock`.
    expect(reloaded?.initialClock).toBe(0);
  });

  it('round-trips the provider settings, including the key', async () => {
    expect(await readProviderSettings()).toEqual({
      baseUrl: '',
      model: '',
      secret: { kind: 'none' },
    });

    await writeProviderSettings({
      baseUrl: 'https://gateway.test/v1',
      model: 'test-model-1',
      secret: { ...PLAINTEXT },
    });
    expect(await readProviderSettings()).toEqual({
      baseUrl: 'https://gateway.test/v1',
      model: 'test-model-1',
      secret: { kind: 'plaintext', apiKey: 'sk-round-trip' },
    });

    // A second write replaces the row rather than adding one (the id IS the key). An empty
    // key is stored as `none` rather than as an empty string: "send no Authorization
    // header" is what both mean on the wire, and one spelling is easier to reason about.
    await writeProviderSettings({
      baseUrl: 'http://localhost:11434/v1',
      model: 'x',
      secret: { kind: 'none' },
    });
    expect(await readProviderSettings()).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'x',
      secret: { kind: 'none' },
    });
  });

  it('survives a restart: a fresh adapter over the same database sees the data', async () => {
    const session = await createSession({ title: '重启后仍在' });
    const user = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '重启前的消息',
    });
    await setHeadMessageId(session.id, user.id);
    await writeProviderSettings({
      baseUrl: 'https://gateway.test/v1',
      model: 'm',
      secret: { kind: 'plaintext', apiKey: 'k' },
    });

    // "Restart": close this connection and open a NEW adapter over the same name.
    closeDatabase();
    resetDatabase(databaseName);

    const sessions = await listSessions();
    expect(sessions.map((row) => row.title)).toEqual(['重启后仍在']);
    expect((await getSession(session.id))?.headMessageId).toBe(user.id);
    expect((await getChain(session.id)).map((message) => message.content)).toEqual([
      '重启前的消息',
    ]);
    expect((await readProviderSettings()).model).toBe('m');
  });

  it('re-fires a liveQuery subscription for its own rows, and stops on unsubscribe', async () => {
    const session = await createSession({ title: 'test-session' });
    const seen: string[][] = [];
    const unsubscribe = subscribe(
      () => readChain(session.id),
      (chain) => seen.push(chain.map((message) => message.content)),
      (error) => {
        throw error;
      },
    );

    await sleep(250);
    expect(seen).toEqual([[]]);

    const message = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '订阅到的消息',
    });
    await setHeadMessageId(session.id, message.id);
    await sleep(600);

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toEqual(['订阅到的消息']);

    unsubscribe();
    const afterUnsubscribe = seen.length;
    await appendMessage({
      sessionId: session.id,
      parentId: message.id,
      role: 'assistant',
      content: '取消订阅后写入',
    });
    await sleep(500);
    expect(seen.length).toBe(afterUnsubscribe);
  });

  it('re-fires the session-list subscription too', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribe(
      () => readSessions(),
      (sessions) => seen.push(sessions.length),
      (error) => {
        throw error;
      },
    );
    await sleep(250);
    expect(seen).toEqual([0]);

    await createSession({ title: '第一句' });
    await sleep(600);
    expect(seen[seen.length - 1]).toBe(1);
    unsubscribe();
  });
});

/* ────────────────── M1-M1 / M1-T4: the fixed-point save ─────────────────── */

/**
 * Save and return the stored row, failing loudly when the repository answered nothing.
 *
 * A `checkpoint?.id ?? ''` at every call site would turn an `undefined` into a silent
 * `restoreCheckpoint('')`, which is a green-looking test against a save point that does
 * not exist — the exact shape of failure the assertion below would then be unable to
 * distinguish from a rollback that did nothing.
 */
async function savePoint(sessionId: string, label: string): Promise<CheckpointRow> {
  const stored = await createCheckpoint({ sessionId, label });
  if (stored === undefined) throw new Error('createCheckpoint answered undefined');
  return stored;
}

/**
 * A save point is ONE row holding a full snapshot (ADR-032), so these tests read the
 * ROW SHAPE first and then the transitions → save → change everything → restore → which
 * is where the milestone's acceptance sentence lives ("读档后时钟与状态一致回滚", "存档含消息
 * 位置 + 时钟 + 变量 + 卡司状态"). Asserting the fields one at a time would pass for an
 * implementation that restored the clock and the vars in two separate steps; asserting the
 * whole value at once cannot.
 *
 * WHY THE LIVE CHANGES GO THROUGH THE REAL WRITERS (`writeSessionState`,
 * `appendMessage`, `setHeadMessageId`) rather than a raw put: what is being tested is
 * that a rollback undoes an ordinary afternoon of play, not that it undoes a hand-built
 * row.
 */
describe('db/repository — checkpoints (M1-M1, M1-T4)', () => {
  it('stores a save point as ONE complete row: message position, clock, vars and cast state', async () => {
    const session = await createSession({ title: 'test-session' });
    const opening = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '开场',
    });
    await setHeadMessageId(session.id, opening.id);
    const saved: SessionState = {
      ...session.state,
      scene: { title: 'The inn', location: 'Silverpine', time: 30 },
      clock: 30,
      vars: { weather: 'snow', danger: 3 },
    };
    await writeSessionState(session.id, saved);

    const stored = await createCheckpoint({
      sessionId: session.id,
      label: '进城前',
      castState: { 'char-a': { present: true } },
    });
    // Narrowed once: the rest of this test is about the stored VALUE, and a `?.` on every
    // assertion would hide a `undefined` return as a passing `undefined` comparison.
    if (stored === undefined) throw new Error('createCheckpoint answered undefined');

    // The whole row, in one assertion: one `put` in one collection is what ADR-032 made a
    // save point, and the port's comment about a multi-collection checkpoint predates it.
    expect(stored).toMatchObject({
      sessionId: session.id,
      label: '进城前',
      messageId: opening.id,
      auto: false,
      state: { clock: 30, vars: { weather: 'snow', danger: 3 } },
      castState: { 'char-a': { present: true } },
      agendaStatus: [],
      summary: '',
    });
    expect(typeof stored.id).toBe('string');
    expect(await readTable(COLLECTIONS.checkpoints).count()).toBe(1);

    // Read back through the schema-parsing reader: the stored row IS a `Checkpoint`.
    const readBack = await getCheckpoint(stored.id);
    expect(readBack?.state.clock).toBe(30);
    expect(readBack?.state.scene.location).toBe('Silverpine');
    expect(readBack?.messageId).toBe(opening.id);

    // Newest first, and only this session's rows.
    const other = await createSession({ title: 'other-session' });
    await createCheckpoint({ sessionId: other.id, label: '别的存档' });
    const listed = await listCheckpoints(session.id);
    expect(listed.map((row) => row.label)).toEqual(['进城前']);
    expect(listed.map((row) => row.id)).toEqual([stored.id]);
  });

  it('round-trips a save point taken before the first message (messageId: null)', async () => {
    const session = await createSession({ title: 'test-session' });
    // A session starts with no messages and `Session.headMessageId` is already `null`
    // (ADR-032). `CheckpointSchema.messageId` mirrors it, so minute zero HAS a spelling —
    // this is the act the panel used to refuse, and the state at that moment (clock, scene,
    // vars) is exactly what a save point is for.
    const stored = await savePoint(session.id, '开场前');
    expect(stored.messageId).toBeNull();
    expect(stored.state.clock).toBe(0);

    // Read back through the schema-parsing reader: `null` survives the round trip, and it
    // is not an absent field (`CheckpointSchema` still requires `messageId`).
    const readBack = await getCheckpoint(stored.id);
    expect(readBack?.messageId).toBeNull();

    // Restoring answers the nullable head verbatim and puts the session back at "no
    // transcript" — not at a message id the checkpoint never named.
    expect(await restoreCheckpoint(stored.id)).toEqual({
      sessionId: session.id,
      headMessageId: null,
    });
    expect((await getSession(session.id))?.headMessageId).toBeNull();
    expect(await getChain(session.id)).toEqual([]);

    // One message later the same call still names that message: a nullable field is not a
    // field that stopped being written.
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    const later = await savePoint(session.id, '第一句之后');
    expect(later.messageId).toBe(first.id);
    expect(await restoreCheckpoint(later.id)).toEqual({
      sessionId: session.id,
      headMessageId: first.id,
    });
  });

  it('rolls the clock, vars, scene AND head back together in one restore', async () => {
    const session = await createSession({ title: 'test-session' });
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    const before: SessionState = {
      ...session.state,
      scene: { title: 'The inn', location: 'Silverpine', time: 30 },
      clock: 30,
      vars: { weather: 'snow', danger: 3 },
    };
    await writeSessionState(session.id, before);
    const checkpoint = await savePoint(session.id, '打点');

    // Play on: the clock moves, the vars change, the scene changes, a message lands and
    // the transcript tip follows it. This is the state a rollback has to undo.
    const after: SessionState = {
      ...before,
      scene: { title: 'The keep', location: 'North pass', time: 400 },
      clock: 400,
      vars: { weather: 'storm', danger: 9 },
    };
    await writeSessionState(session.id, after);
    const later = await appendMessage({
      sessionId: session.id,
      parentId: first.id,
      role: 'assistant',
      content: '第二句',
    });
    await setHeadMessageId(session.id, later.id);

    const advanced = await getSession(session.id);
    expect(advanced?.state.clock).toBe(400);
    expect(advanced?.headMessageId).toBe(later.id);

    const restored = await restoreCheckpoint(checkpoint.id);
    expect(restored).toEqual({ sessionId: session.id, headMessageId: first.id });

    // THE ACCEPTANCE, IN ONE ASSERTION SET: all four halves of the state are the saved
    // instant at once. A rollback that moved the clock but not the vars (or the reverse)
    // fails here rather than passing four separate per-field checks.
    const rolled = await getSession(session.id);
    expect(rolled?.state).toEqual(before);
    expect(rolled?.state.clock).toBe(30);
    expect(rolled?.state.vars).toEqual({ weather: 'snow', danger: 3 });
    expect(rolled?.state.scene).toEqual({ title: 'The inn', location: 'Silverpine', time: 30 });
    expect(rolled?.headMessageId).toBe(first.id);
    // The origin is not a rollback target: `initialClock` is where the session began.
    expect(rolled?.initialClock).toBe(0);
    // And the checkpoint itself is untouched by having been loaded — a save point that
    // was consumed by reading it could not be loaded twice.
    expect((await getCheckpoint(checkpoint.id))?.state.clock).toBe(30);
    expect((await listCheckpoints(session.id)).length).toBe(1);
  });

  it('deletes no message on restore: the rows past the save point stay, off the chain', async () => {
    const session = await createSession({ title: 'test-session' });
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    const checkpoint = await savePoint(session.id, '打点');

    const second = await appendMessage({
      sessionId: session.id,
      parentId: first.id,
      role: 'assistant',
      content: '第二句',
    });
    const third = await appendMessage({
      sessionId: session.id,
      parentId: second.id,
      role: 'user',
      content: '第三句',
    });
    await setHeadMessageId(session.id, third.id);
    expect((await getChain(session.id)).map((row) => row.content)).toEqual([
      '第一句',
      '第二句',
      '第三句',
    ]);

    await restoreCheckpoint(checkpoint.id);

    // The chain read back is the checkpoint's chain —

    expect((await getChain(session.id)).map((row) => row.content)).toEqual(['第一句']);
    expect((await readChain(session.id)).map((row) => row.id)).toEqual([first.id]);
    // … and BOTH later rows are still in the database (ADR-010: a rollback is a pointer
    // move, so re-loading the save or taking the other branch again still works).
    expect(await readTable(COLLECTIONS.messages).count()).toBe(3);
    expect((await readTable<Message>(COLLECTIONS.messages).get(second.id))?.content).toBe('第二句');
    expect((await readTable<Message>(COLLECTIONS.messages).get(third.id))?.content).toBe('第三句');
  });

  it('snapshots a COPY: neither direction of a later mutation crosses over', async () => {
    const session = await createSession({ title: 'test-session' });
    const opening = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, opening.id);
    const saved: SessionState = {
      ...session.state,
      clock: 30,
      vars: { weather: 'snow' },
    };
    await writeSessionState(session.id, saved);
    // The state the app is holding in memory while the user plays on. It is the value a
    // naive `createCheckpoint` would store a REFERENCE to.
    const live: SessionState = { ...saved };
    const checkpoint = await savePoint(session.id, '打点');
    const checkpointId = checkpoint.id;

    // Direction 1: an in-place edit of the live state afterwards. An aliasing
    // implementation would follow it, and the save point would stop being "then" at all —
    // which is what makes a rollback meaningless.
    live.clock = 90;
    // `Object.assign` rather than `live.vars.weather = …` or `live.vars['weather'] = …`:
    // `vars` is a `Record`, so the workspace's two rules disagree about the access
    // spelling (`noPropertyAccessFromIndexSignature` demands a bracket, Biome's
    // `useLiteralKeys` forbids the literal one). Assigning through a helper sidesteps
    // neither rule and still mutates the very object the save point must not alias.
    Object.assign(live.vars, { weather: 'storm' });
    await writeSessionState(session.id, live);

    // The live row really did move on —
    expect((await getSession(session.id))?.state.clock).toBe(90);
    // … and the save point did not, in either collection.
    expect((await getCheckpoint(checkpointId))?.state.clock).toBe(30);
    expect((await getCheckpoint(checkpointId))?.state.vars).toEqual({ weather: 'snow' });

    // Direction 2: restore, then mutate the live state again. The checkpoint must stay put,
    // and the state that was restored is a copy too — not the stored object itself.
    await restoreCheckpoint(checkpointId);
    const restored = await getSession(session.id);
    expect(restored?.state.clock).toBe(30);
    expect(restored?.state.vars).not.toBe(saved.vars);

    const second: SessionState = { ...saved, clock: 600, vars: { weather: 'sunny' } };
    await writeSessionState(session.id, second);
    expect((await getCheckpoint(checkpointId))?.state.clock).toBe(30);
    expect((await getCheckpoint(checkpointId))?.state.vars).toEqual({ weather: 'snow' });
  });

  it('deletes one save point without touching the live session', async () => {
    const session = await createSession({ title: 'test-session' });
    const message = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, message.id);
    const kept = await createCheckpoint({ sessionId: session.id, label: '保留' });
    const dropped = await createCheckpoint({ sessionId: session.id, label: '删除' });
    if (kept === undefined || dropped === undefined) {
      throw new Error('createCheckpoint answered undefined');
    }

    await deleteCheckpoint(dropped.id);
    expect((await listCheckpoints(session.id)).map((row) => row.label)).toEqual(['保留']);
    expect(await getCheckpoint(dropped.id)).toBeUndefined();

    // The live position is not a delete's business.
    const live = await getSession(session.id);
    expect(live?.headMessageId).toBe(message.id);
    expect(live?.state.clock).toBe(0);
    expect(await getCheckpoint(kept.id)).toBeDefined();

    // Idempotent: removing what is already gone is not an error (`Collection.remove`).
    await expect(deleteCheckpoint(dropped.id)).resolves.toBeUndefined();
  });

  it('answers undefined for a session or a save point that does not exist', async () => {
    expect(await createCheckpoint({ sessionId: 'no-such-session', label: 'x' })).toBeUndefined();
    expect(await restoreCheckpoint('no-such-checkpoint')).toBeUndefined();
    expect(await listCheckpoints('no-such-session')).toEqual([]);
  });
});

/* ────────────────── M1-S2: the message tree's rows and its delete rule ────────────────── */

/**
 * WHAT THIS SUITE PINS, AND WHY IT IS AT THE ROW LEVEL
 * The two rules the milestone adds to the tree are "the siblings of a node are every child
 * of its parent, including the ones the active chain does not run through" and "a node with
 * children cannot be deleted". Both are properties of the TABLE — the chain cannot show
 * either one (it holds exactly one path, and it never holds a row that is gone) — so they
 * are asserted here, against real rows, before any screen asks about them.
 *
 * The rules' USER-FACING halves (which control is offered, what the head does afterwards)
 * live in `app/routes/routes.test.tsx`, where the gesture can be performed.
 */
describe('db/repository — the message tree (M1-S2)', () => {
  /** One stored turn: a user message with `answers` assistant siblings under it. */
  async function turnWithAnswers(
    sessionId: string,
    question: string,
    answers: readonly string[],
  ): Promise<{ question: Message; answers: Message[] }> {
    const asked = await appendMessage({
      sessionId,
      parentId: null,
      role: 'user',
      content: question,
    });
    const stored: Message[] = [];
    for (const content of answers) {
      stored.push(
        await appendMessage({ sessionId, parentId: asked.id, role: 'assistant', content }),
      );
    }
    return { question: asked, answers: stored };
  }

  it('lists every child of a parent, including the branch the chain does not run through', async () => {
    const session = await createSession({ title: 'siblings' });
    const { question, answers } = await turnWithAnswers(session.id, '问题', [
      '第一个答案',
      '第二个答案',
    ]);
    const first = answers[0];
    const second = answers[1];
    if (first === undefined || second === undefined) throw new Error('fixture is incomplete');
    // Only the second answer is on the active chain; the first is the discarded branch.
    await setHeadMessageId(session.id, second.id);
    expect((await getChain(session.id)).map((row) => row.content)).toEqual(['问题', '第二个答案']);

    const siblings = await listChildren(session.id, question.id);
    // Both, in id order (uuid v7 is time-ordered, so this is also creation order). A
    // `listChildren` that read the chain would answer ONE row — the bug this asserts against.
    expect(siblings.map((row) => row.content)).toEqual(['第一个答案', '第二个答案']);
    expect(siblings.map((row) => row.parentId)).toEqual([question.id, question.id]);

    // The ROOT case: the first message's own "siblings" are the session's other roots, and
    // `null` is the key it is asked with (`Message.parentId` is nullable).
    expect((await listChildren(session.id, null)).map((row) => row.content)).toEqual(['问题']);
    // A session with no such parent answers empty rather than every row in the database.
    expect(await listChildren(session.id, 'no-such-parent')).toEqual([]);
  });

  it('reports whether a node has children, through the same edges', async () => {
    const session = await createSession({ title: 'children' });
    const { question, answers } = await turnWithAnswers(session.id, '问题', ['答案']);
    const answer = answers[0];
    if (answer === undefined) throw new Error('fixture is incomplete');

    expect(await hasChildren(session.id, question.id)).toBe(true);
    expect(await hasChildren(session.id, answer.id)).toBe(false);
    expect(await hasChildren(session.id, 'no-such-message')).toBe(false);
  });

  it('deletes a LEAF and leaves no row behind', async () => {
    const session = await createSession({ title: 'delete-leaf' });
    const { question, answers } = await turnWithAnswers(session.id, '问题', ['答案']);
    const answer = answers[0];
    if (answer === undefined) throw new Error('fixture is incomplete');
    await setHeadMessageId(session.id, answer.id);

    expect(await deleteLeafMessage(session.id, answer.id)).toBe(true);
    expect(await readTable(COLLECTIONS.messages).count()).toBe(1);
    expect(await getMessage(answer.id)).toBeUndefined();
    // The parent is untouched, and the chain now ends at it — the walk from the head ran
    // into the missing row and stopped, which is why the CALLER must repair the pointer
    // (`state/chat-store.ts`'s `deleteMessage` moves it to the parent). Asserted here so the
    // repair's necessity is a recorded fact and not a surprise.
    expect(await getMessage(question.id)).toBeDefined();
    expect((await getSession(session.id))?.headMessageId).toBe(answer.id);
    expect(await getChain(session.id)).toEqual([]);
  });

  it('refuses to delete a node that has replies, and removes nothing', async () => {
    const session = await createSession({ title: 'delete-refused' });
    const { question, answers } = await turnWithAnswers(session.id, '问题', ['答案']);
    const answer = answers[0];
    if (answer === undefined) throw new Error('fixture is incomplete');
    await setHeadMessageId(session.id, answer.id);

    // The refusal is the RULE, not an error: `false` and an untouched database.
    expect(await deleteLeafMessage(session.id, question.id)).toBe(false);
    expect(await deleteLeafMessage(session.id, answer.id)).toBe(true);
    // Having removed the reply, the same call now succeeds — which is what makes the
    // refusal "delete the replies first" rather than "this node can never go".
    expect(await deleteLeafMessage(session.id, question.id)).toBe(true);
    expect(await readTable(COLLECTIONS.messages).count()).toBe(0);
  });

  it('does not mistake another session’s child for this one’s', async () => {
    // The siblings query is per SESSION: two sessions can legitimately hold a message with
    // the same id only by corruption, but a `listChildren` that ignored `sessionId` would
    // splice another transcript's rows into this one's run — the shape of failure the
    // acceptance ("消息树（parentId）正确") is about.
    const mine = await createSession({ title: 'mine' });
    const theirs = await createSession({ title: 'theirs' });
    const myQuestion = await appendMessage({
      sessionId: mine.id,
      parentId: null,
      role: 'user',
      content: '我的问题',
    });
    await appendMessage({
      sessionId: theirs.id,
      parentId: null,
      role: 'user',
      content: '别人的问题',
    });

    expect((await listChildren(mine.id, null)).map((row) => row.content)).toEqual(['我的问题']);
    expect((await listChildren(theirs.id, null)).map((row) => row.content)).toEqual(['别人的问题']);
    // And a delete in one session cannot see the other's rows.
    expect(await deleteLeafMessage(theirs.id, myQuestion.id)).toBe(true);
    expect(await getMessage(myQuestion.id)).toBeUndefined();
  });
});

/** Write one message row straight through the write path, bypassing the helpers. */
async function putRawMessage(row: Message): Promise<void> {
  await write(async (tx) => {
    await tx.collection<Message>(COLLECTIONS.messages).put(row);
  });
}

/**
 * Write one session row exactly as given — the ONLY way to build a row the current
 * typed writer cannot produce (ADR-032's pre-`state` row). Typing it as a `Session`
 * would be the same lie the test exists to disprove, hence the open record.
 */
async function putRawSession(row: Record<string, unknown>): Promise<void> {
  await write(async (tx) => {
    await tx.collection<Session>(COLLECTIONS.sessions).put(row as unknown as Session);
  });
}
