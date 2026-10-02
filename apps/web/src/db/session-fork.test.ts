/**
 * Forking a session, against real IndexedDB rows (M1-M2).
 *
 * WHAT THIS FILE HAS TO PROVE (docs/06-开发任务拆解.md section 2.6)
 * `M1-M2 | 分叉 | 从任意存档点创建新时间线 | M1-M1 | 原时间线不受影响；新线引用一致`
 *
 * 1. A fork is a NEW SESSION: every row it writes has an id of its own, and none of those ids
 *    collides with an id the origin owns.
 * 2. Its chain is the origin's up to the cut, and it is a CHAIN OF ITS OWN: each copied message's
 *    `parentId` names the copy above it, `headMessageId` names the copy of the fork point, and a
 *    save point that travelled names the copy of the message it was taken at. That is 新线引用一致
 *    stated as the one thing that can be checked: every reference resolves INSIDE the new session.
 * 3. 原时间线不受影响 is asserted on BYTES: every row the origin owns is dumped before the fork and
 *    compared afterwards, through the raw IndexedDB API rather than through the repository that
 *    would parse away a stray field.
 * 4. The lineage names what the fork came from - the origin session, the message it was cut at,
 *    and the save point it was cut from - and every copied row records the origin row id it is a
 *    copy of.
 * 5. What travels is asserted (clock, vars, cast, save points, the pinned refs) and what
 *    deliberately does not is asserted too (turn plans, save points past the cut).
 * 6. The pins are copied VERBATIM and not re-resolved. M1-I2's finding is the reason this is a
 *    test rather than a comment: a version number is not an identity, and a fork that picked "the
 *    latest version of world X" would silently replay old messages under new content.
 *
 * WHY THE FIXTURES ARE REAL ROWS AND NOT HAND-BUILT OBJECTS: a fork reads rows, and the trap it
 * has to avoid is exactly the one a hand-built fixture would skip - resolving a pin, a version or
 * a checkpoint against the table. So a world with TWO versions is created, the origin pins the
 * OLDER one, and the fork is asserted to pin it too.
 */
/** @vitest-environment node */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { Checkpoint, EntityPin, Id, Message, SessionState } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankCharacterData } from '../cards/character';
import { blankWorldData } from '../cards/world';
import { checkpointCastOf } from '../session/cast';
import { forkLineageOf, forkOriginIdOf } from '../session/fork';
import { BUILTIN_PRESET_CHOICE, presetPinOf } from '../session/roster';
import { closeDatabase, readTable, resetDatabase } from './database';
import { deleteDatabase, sessionRows } from './raw-indexeddb.test-helpers';
import {
  appendMessage,
  createCharacter,
  createCheckpoint,
  createSession,
  createWorld,
  forkSession,
  getChain,
  getSession,
  listCheckpoints,
  listTurnPlans,
  publishWorld,
  removeMessage,
  setHeadMessageId,
  writeSessionState,
  writeTurnPlan,
} from './repository';

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-session-fork-${databases}`;
  resetDatabase(databaseName);
});

afterEach(async () => {
  closeDatabase();
  await deleteDatabase(databaseName);
});

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** A world with TWO versions; the caller is handed the pin of the OLDER one. */
async function worldWithTwoVersions(): Promise<EntityPin> {
  const created = await createWorld({ name: '霜月群岛', data: blankWorldData('霜月群岛') });
  if (created === undefined) throw new Error('the world fixture was refused');
  const worldId = created.world.id;
  const second = await publishWorld({
    worldId,
    data: { ...blankWorldData('霜月群岛'), startMinute: 999 },
    baseVersion: 1,
    reason: 'test fixture',
  });
  expect(second?.version.version).toBe(2);
  return { id: worldId, version: 1 };
}

/** A card, created the way the editor creates one, as the `{id, version}` a session pins. */
async function cardNamed(name: string): Promise<EntityPin> {
  const created = await createCharacter({ name, data: blankCharacterData(name) });
  if (created === undefined) throw new Error('the card fixture was refused');
  return { id: created.character.id, version: created.version.version };
}

/**
 * The origin of most cases below: three messages, two save points and one turn plan.
 *
 * `cut` is the save point the tests fork from (taken after two messages, with its own clock,
 * variables and cast), and `past` is a save point taken LATER, at the third message - the one a
 * fork at `cut` must not carry, because the fork does not have that message.
 */
interface Origin {
  readonly sessionId: Id;
  readonly messages: readonly Message[];
  readonly cut: Checkpoint;
  readonly past: Checkpoint;
  readonly liveState: SessionState;
}

async function withOrigin(): Promise<Origin> {
  const world = await worldWithTwoVersions();
  const player = await cardNamed('莉安');
  const npc = await cardNamed('米拉');
  const session = await createSession({
    title: '第一场',
    refs: {
      world,
      playerCharacter: player,
      cast: [npc],
      promptPreset: presetPinOf(BUILTIN_PRESET_CHOICE),
    },
    initialClock: 100,
  });

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
    speakerId: npc.id,
  });
  await setHeadMessageId(session.id, second.id);

  // A state the live session will move AWAY from, so "what travels" is a real question: the save
  // point's clock, variables and cast are its own, not the row's.
  const saved: SessionState = {
    ...session.state,
    scene: { title: '酒馆', location: '门厅', time: 500 },
    clock: 500,
    cast: { [npc.id]: { present: true, muted: true } },
    vars: { hp: 7, name: '莉安' },
  };
  await writeSessionState(session.id, saved);
  const cut = await createCheckpoint({
    sessionId: session.id,
    label: '存档一',
    castState: checkpointCastOf(saved),
  });
  if (cut === undefined) throw new Error('the save point fixture was refused');

  const third = await appendMessage({
    sessionId: session.id,
    parentId: second.id,
    role: 'assistant',
    content: '她抬起了头。',
  });
  await setHeadMessageId(session.id, third.id);
  const liveState: SessionState = {
    ...saved,
    clock: 900,
    vars: { hp: 1, name: '莉安' },
  };
  await writeSessionState(session.id, liveState);
  const past = await createCheckpoint({ sessionId: session.id, label: '存档二' });
  if (past === undefined) throw new Error('the second save point fixture was refused');
  // A scheduling decision of the ORIGIN's own: it must not travel with the fork.
  await writeTurnPlan({
    sessionId: session.id,
    round: 0,
    mode: 'user',
    entries: [],
    excluded: [],
    overriddenByUser: false,
  });

  return { sessionId: session.id, messages: [first, second, third], cut, past, liveState };
}

/** The fork point of a save point, as the store's own vocabulary spells it. */
function atCheckpoint(checkpointId: Id) {
  return { kind: 'checkpoint', checkpointId } as const;
}

/* ─────────────────────────── the fork, clause by clause ──────────────────── */

describe('forking a session at a save point (M1-M2)', () => {
  it('writes a new session whose chain is the origin up to the cut, and leaves the origin on bytes', async () => {
    const origin = await withOrigin();
    const before = await sessionRows(databaseName, origin.sessionId);

    const forked = await forkSession({
      sessionId: origin.sessionId,
      forkPoint: atCheckpoint(origin.cut.id),
      title: '新时间线',
    });
    expect(forked).toBeDefined();
    if (forked === undefined) return;

    // THE ORIGIN IS PROVED UNTOUCHED ON ITS OWN ROWS, through the raw API: same bytes, same order.
    expect(await sessionRows(databaseName, origin.sessionId)).toBe(before);
    // ... and the origin's live position did not move either (a fork is not a rollback).
    const live = await getSession(origin.sessionId);
    expect(live?.headMessageId).toBe(origin.messages[2]?.id);
    expect(live?.state.clock).toBe(900);
    expect((await listCheckpoints(origin.sessionId)).map((row) => row.label)).toEqual([
      '存档二',
      '存档一',
    ]);

    // A NEW SESSION ROW: its own id, its own timestamps, and the caller's title.
    expect(forked.id).not.toBe(origin.sessionId);
    expect(forked.title).toBe('新时间线');

    // ITS CHAIN IS THE ORIGIN'S UP TO THE CUT, in order.
    const chain = await getChain(forked.id);
    expect(chain.map((message) => message.content)).toEqual(['我推开门', '门后是昏暗的酒馆。']);
    expect(chain.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(chain.map((message) => message.speakerId)).toEqual([
      undefined,
      origin.messages[1]?.speakerId,
    ]);

    // NO ID COLLIDES WITH THE ORIGIN'S, and every reference in the new session points at the
    // copies: the root has no parent, the child hangs off the copy above it, and the head is the
    // copy of the fork point.
    const originIds = new Set<Id>([
      origin.sessionId,
      ...origin.messages.map((message) => message.id),
      origin.cut.id,
      origin.past.id,
    ]);
    const copiedIds = new Set<Id>(chain.map((message) => message.id));
    expect(chain.every((message) => !originIds.has(message.id))).toBe(true);
    expect(copiedIds.size).toBe(chain.length);
    expect(chain[0]?.parentId).toBeNull();
    expect(chain[1]?.parentId).toBe(chain[0]?.id);
    expect(chain[1]?.sessionId).toBe(forked.id);
    expect(forked.headMessageId).toBe(chain[1]?.id);

    // The message that is PAST the cut did not travel, and neither did the save point taken there.
    expect(chain.map((message) => message.content)).not.toContain('她抬起了头。');
    const checkpoints = await listCheckpoints(forked.id);
    expect(checkpoints.map((row) => row.label)).toEqual(['存档一']);
    const only = checkpoints[0];
    expect(only?.id).not.toBe(origin.cut.id);
    expect(only?.sessionId).toBe(forked.id);
    expect(only?.messageId).toBe(chain[1]?.id);
    expect(only?.state.clock).toBe(500);
  });

  it('carries the save point state - clock, variables and cast - and not the live one', async () => {
    const origin = await withOrigin();
    const forked = await forkSession({
      sessionId: origin.sessionId,
      forkPoint: atCheckpoint(origin.cut.id),
      title: '新时间线',
    });
    if (forked === undefined) throw new Error('the fork was refused');

    // THE SAVE POINT'S STATE, value for value. `origin.liveState` is what a fork at the HEAD
    // would carry, so this comparison is what separates the two fork points.
    expect(forked.state).toEqual(origin.cut.state);
    expect(forked.state.clock).toBe(500);
    expect(forked.state.vars).toEqual({ hp: 7, name: '莉安' });
    expect(forked.state.cast).toEqual(origin.cut.state.cast);
    expect(forked.state.scene.title).toBe('酒馆');
    // THE FORK BEGINS WHERE IT WAS CUT (ADR-012): the origin's own start minute is not inherited,
    // because the new timeline's first message is not its first message.
    expect(forked.initialClock).toBe(500);
    expect(origin.cut.state.clock).toBe(500);

    // A COPY, not an alias: moving the fork's state must not move the save point's.
    expect(forked.state).not.toBe(origin.cut.state);
    expect(forked.state.cast).not.toBe(origin.cut.state.cast);
  });

  it('copies the pinned refs verbatim, and never re-resolves one to the newest version', async () => {
    const origin = await withOrigin();
    const parent = await getSession(origin.sessionId);
    const forked = await forkSession({
      sessionId: origin.sessionId,
      forkPoint: atCheckpoint(origin.cut.id),
      title: '新时间线',
    });
    if (parent === undefined || forked === undefined) throw new Error('the fork was refused');

    // The world has TWO versions and the origin pinned v1 - M1-I2's trap, in this milestone's
    // shape: the fork must pin v1 too rather than look the world up again.
    expect(forked.refs.world).toEqual({ id: parent.refs.world.id, version: 1 });
    expect(forked.refs).toEqual(parent.refs);
    expect(forked.schedulerMode).toBe(parent.schedulerMode);
    // A copy again: the two rows must not share an object graph.
    expect(forked.refs).not.toBe(parent.refs);
    expect(forked.refs.cast[0]).not.toBe(parent.refs.cast[0]);
  });

  it('records the lineage: the origin, the cut message and the save point it came from', async () => {
    const origin = await withOrigin();
    const forked = await forkSession({
      sessionId: origin.sessionId,
      forkPoint: atCheckpoint(origin.cut.id),
      title: '新时间线',
    });
    if (forked === undefined) throw new Error('the fork was refused');

    const chain = await getChain(forked.id);
    // The ORIGIN's ids, not the fork's: a lineage names the row it came from, and that row is
    // still there and still readable (which is also why a back-pointer on the origin is not
    // needed - this direction answers the same question).
    expect(forkLineageOf(forked)).toEqual({
      sessionId: origin.sessionId,
      messageId: origin.messages[1]?.id,
      checkpointId: origin.cut.id,
    });
    expect(forkLineageOf(forked)?.messageId).not.toBe(chain[1]?.id);

    // EVERY COPIED ROW RECORDS THE ROW IT IS A COPY OF, so the remap is auditable in the database
    // rather than only inferable from position.
    expect(chain.map(forkOriginIdOf)).toEqual([origin.messages[0]?.id, origin.messages[1]?.id]);
    const copied = (await listCheckpoints(forked.id))[0];
    expect(copied === undefined ? undefined : forkOriginIdOf(copied)).toBe(origin.cut.id);
    // The ORIGIN's own rows carry no such claim: a lineage belongs to the row that was created.
    const originRow = await getSession(origin.sessionId);
    expect(originRow === undefined ? undefined : forkLineageOf(originRow)).toBeUndefined();
    expect((await getChain(origin.sessionId)).map(forkOriginIdOf)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('does not restate the origin turn plans, and writes no row into any other collection', async () => {
    const origin = await withOrigin();
    const forked = await forkSession({
      sessionId: origin.sessionId,
      forkPoint: atCheckpoint(origin.cut.id),
      title: '新时间线',
    });
    if (forked === undefined) throw new Error('the fork was refused');

    // The origin's decision stays the origin's; a copied message may still POINT at it through
    // `meta.turnPlanId`, but the fork signs no plan of its own.
    expect((await listTurnPlans(origin.sessionId)).length).toBe(1);
    expect(await listTurnPlans(forked.id)).toEqual([]);
    // Nothing else was written anywhere: one session row per session, one message row per message
    // and one save point per save point (the fork added its own and copied the one that travels).
    expect(await readTable(COLLECTIONS.sessions).count()).toBe(2);
    expect(await readTable(COLLECTIONS.messages).count()).toBe(5);
    expect(await readTable(COLLECTIONS.checkpoints).count()).toBe(3);
    expect(await readTable(COLLECTIONS.turnPlans).count()).toBe(1);
  });
});

/* ────────────────────────── the live position, and refusals ──────────────── */

describe('forking at the live position (M1-M2)', () => {
  it('carries the whole chain and the state the session holds right now', async () => {
    const origin = await withOrigin();
    const forked = await forkSession({
      sessionId: origin.sessionId,
      forkPoint: { kind: 'head' },
      title: '从此刻',
    });
    if (forked === undefined) throw new Error('the fork was refused');

    const chain = await getChain(forked.id);
    expect(chain.map((message) => message.content)).toEqual([
      '我推开门',
      '门后是昏暗的酒馆。',
      '她抬起了头。',
    ]);
    expect(forked.headMessageId).toBe(chain[2]?.id);
    expect(forked.state).toEqual(origin.liveState);
    expect(forked.initialClock).toBe(900);
    // BOTH save points travel here: the cut is past both of them.
    expect((await listCheckpoints(forked.id)).map((row) => row.label)).toEqual([
      '存档二',
      '存档一',
    ]);
    // A live-position fork names the message it was cut at and no save point.
    expect(forkLineageOf(forked)).toEqual({
      sessionId: origin.sessionId,
      messageId: origin.messages[2]?.id,
    });
  });

  it('forks a session whose chain is still empty, as an empty timeline with the same state', async () => {
    // The other session is here so "the fork wrote exactly one new session and moved nothing"
    // has two rows to be true about.
    const origin = await withOrigin();
    const fresh = await createSession({
      title: '空会话',
      refs: {
        world: { id: 'test-world', version: 1 },
        playerCharacter: { id: 'test-player', version: 1 },
        cast: [],
        promptPreset: presetPinOf(BUILTIN_PRESET_CHOICE),
      },
      initialClock: 42,
    });
    const before = [
      await sessionRows(databaseName, origin.sessionId),
      await sessionRows(databaseName, fresh.id),
    ];

    const forked = await forkSession({
      sessionId: fresh.id,
      forkPoint: { kind: 'head' },
      title: '空时间线',
    });
    if (forked === undefined) throw new Error('the fork was refused');

    expect(await getChain(forked.id)).toEqual([]);
    expect(forked.headMessageId).toBeNull();
    expect(forked.state).toEqual(fresh.state);
    // NO MESSAGE TO NAME, so the lineage names the session only (`IdSchema` refuses `''`).
    expect(forkLineageOf(forked)).toEqual({ sessionId: fresh.id });
    // Both sessions that already existed are untouched, on bytes.
    expect([
      await sessionRows(databaseName, origin.sessionId),
      await sessionRows(databaseName, fresh.id),
    ]).toEqual(before);
  });
});

describe('a fork that cannot be made', () => {
  it('refuses a save point of another session, a missing save point and an unknown session', async () => {
    const origin = await withOrigin();
    const other = await createSession({
      title: '别处',
      refs: {
        world: { id: 'test-world', version: 1 },
        playerCharacter: { id: 'test-player', version: 1 },
        cast: [],
        promptPreset: presetPinOf(BUILTIN_PRESET_CHOICE),
      },
      initialClock: 0,
    });
    const theirs = await createCheckpoint({ sessionId: other.id, label: '别人的存档' });
    if (theirs === undefined) throw new Error('the checkpoint fixture was refused');

    const before = await sessionRows(databaseName, origin.sessionId);
    // A save point of ANOTHER transcript names a position this session's chain cannot reach, so
    // copying "up to" it would produce a head that resolves nowhere.
    expect(
      await forkSession({
        sessionId: origin.sessionId,
        forkPoint: atCheckpoint(theirs.id),
        title: '不该存在',
      }),
    ).toBeUndefined();
    expect(
      await forkSession({
        sessionId: origin.sessionId,
        forkPoint: atCheckpoint('no-such-checkpoint'),
        title: '不该存在',
      }),
    ).toBeUndefined();
    expect(
      await forkSession({
        sessionId: 'no-such-session',
        forkPoint: { kind: 'head' },
        title: '不该存在',
      }),
    ).toBeUndefined();

    // Nothing was written by any of the three refusals.
    expect(await readTable(COLLECTIONS.sessions).count()).toBe(2);
    expect(await sessionRows(databaseName, origin.sessionId)).toBe(before);
  });

  it('refuses a session whose head names a row that is no longer there', async () => {
    // THE GUARD `planFork` STATES, REACHED THE WAY A USER CAN REACH IT: a head that names a
    // missing row (the row was removed directly - `deleteMessage` repairs the head, but nothing
    // makes a hand-made or half-finished state impossible) yields an EMPTY chain, so the anchor
    // and the chain disagree. Planning anyway would store a session whose `headMessageId` points
    // at a message the new timeline does not contain.
    const session = await createSession({
      title: '悬空头',
      refs: {
        world: { id: 'test-world', version: 1 },
        playerCharacter: { id: 'test-player', version: 1 },
        cast: [],
        promptPreset: presetPinOf(BUILTIN_PRESET_CHOICE),
      },
      initialClock: 0,
    });
    const first = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, first.id);
    await removeMessage(first.id);

    expect(
      await forkSession({ sessionId: session.id, forkPoint: { kind: 'head' }, title: '不该存在' }),
    ).toBeUndefined();
    expect(await readTable(COLLECTIONS.sessions).count()).toBe(1);
  });

  it('keeps a parent the origin itself cannot resolve, instead of inventing one', async () => {
    // A tree whose edge points at a row that does not exist is a stored fact the ORIGIN has; a
    // fork copies the chain as it is rather than re-rooting the message, which would change what
    // the transcript says about where the line came from.
    const session = await createSession({
      title: '断链',
      refs: {
        world: { id: 'test-world', version: 1 },
        playerCharacter: { id: 'test-player', version: 1 },
        cast: [],
        promptPreset: presetPinOf(BUILTIN_PRESET_CHOICE),
      },
      initialClock: 0,
    });
    const dangling = await appendMessage({
      sessionId: session.id,
      parentId: 'gone',
      role: 'user',
      content: '第一句',
    });
    await setHeadMessageId(session.id, dangling.id);

    const forked = await forkSession({
      sessionId: session.id,
      forkPoint: { kind: 'head' },
      title: '断链副本',
    });
    if (forked === undefined) throw new Error('the fork was refused');
    const chain = await getChain(forked.id);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.parentId).toBe('gone');
  });
});
