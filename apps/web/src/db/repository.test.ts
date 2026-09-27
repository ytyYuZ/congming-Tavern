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
 */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { Message } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase, subscribe, write } from '../db/database';
import {
  appendMessage,
  createSession,
  getChain,
  getSession,
  listSessions,
  readChain,
  readProviderSettings,
  readSessions,
  setHeadMessageId,
  writeProviderSettings,
} from '../db/repository';

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
    const session = await createSession();
    expect(await getChain(session.id)).toEqual([]);
    expect(await getChain('no-such-session')).toEqual([]);
    expect(await getSession('no-such-session')).toBeUndefined();
  });

  it('stops walking a corrupted cycle instead of hanging', async () => {
    const session = await createSession();
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

  it('round-trips the provider settings, including the key', async () => {
    expect(await readProviderSettings()).toEqual({ baseUrl: '', apiKey: '', model: '' });

    await writeProviderSettings({
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'sk-round-trip',
      model: 'test-model-1',
    });
    expect(await readProviderSettings()).toEqual({
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'sk-round-trip',
      model: 'test-model-1',
    });

    // A second write replaces the row rather than adding one (the id IS the key).
    await writeProviderSettings({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'x' });
    expect(await readProviderSettings()).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'x',
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
    await writeProviderSettings({ baseUrl: 'https://gateway.test/v1', apiKey: 'k', model: 'm' });

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
    const session = await createSession();
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

    await createSession({ title: '第一个' });
    await sleep(600);
    expect(seen[seen.length - 1]).toBe(1);
    unsubscribe();
  });
});

/** Write one message row straight through the write path, bypassing the helpers. */
async function putRawMessage(row: Message): Promise<void> {
  await write(async (tx) => {
    await tx.collection<Message>(COLLECTIONS.messages).put(row);
  });
}
