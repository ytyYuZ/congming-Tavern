/**
 * The co-creation state layer against real IndexedDB (M1-W2).
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONE'S OWN WORDS
 * The M1-W2 row in `docs/06` §2.2 is `对话 + JSON Patch 提案 + 右侧实时预览`, and the orchestrator's
 * acceptance is sharper: **提案可接受/拒绝，应用后数据正确且可撤销**. That is four facts about DATA,
 * so each step of this file ends at a row:
 *   1. generating a proposal and REJECTING it leave the draft row byte-identical (a proposal is data,
 *      not a write);
 *   2. 采纳 writes exactly the proposed payload into the draft row, and the editor's draft is that
 *      payload;
 *   3. 撤销 puts the draft row back byte-for-byte — the same bytes it held before the apply;
 *   4. a malformed answer produces a readable finding and NO change to the draft.
 * The fifth thing asserted here is the WIRE: the request is built by the real
 * `OpenAICompatibleProvider` over a fake `fetch`, so the body proves the instruction — not a mocked
 * module — is what the model was asked.
 */
/** @vitest-environment node */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { FetchLike } from '@smarttavern/providers';
import type { JsonValue, WorldData, WorldVersion } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, readTable, resetDatabase } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import {
  latestWorldVersion,
  readWorldDraft,
  worldDraftId,
  writeProviderSettings,
} from '../db/repository';
import { configureCoCreate, resetCoCreate, useCoCreateStore } from './co-create-store';
import { resetContentStore, useContentStore } from './content-store';
import { useLocaleStore } from './locale-store';
import { resetSettingsStore, useSettingsStore } from './settings-store';

/* ─────────────────────────────── the fake wire ───────────────────────────── */

/** The request the adapter sent, as the shape these tests read. */
interface WireRequest {
  model?: string;
  messages?: { role: string; content: string }[];
  response_format?: unknown;
}

/** The `fetch` the adapter is given. Records the request so it can be asserted. */
interface FakeWire {
  readonly fetch: FetchLike;
  lastBody: () => WireRequest | undefined;
  calls: () => number;
}

/**
 * An SSE answer carrying `chunks`, then a finish reason, then `[DONE]`.
 *
 * The body is STANDARD SSE because the provider reads the `content-type` header and parses
 * `parseSseStream` (`chat/send-turn.test.ts` makes the same argument): a made-up framing would be
 * testing the fake rather than the adapter.
 */
function sseResponse(chunks: readonly string[]): Response {
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
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One `fetch` that answers `answer()` for every call, recording the last request body. */
function fakeWire(answer: () => Response): FakeWire {
  let body: WireRequest | undefined;
  let calls = 0;
  return {
    fetch: (_url, init) => {
      calls += 1;
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body) as WireRequest;
        } catch {
          body = undefined;
        }
      }
      return Promise.resolve(answer());
    },
    lastBody: () => body,
    calls: () => calls,
  };
}

/** An answer split across two deltas, to prove the reader sees the WHOLE object and not one chunk. */
function answer(chunks: readonly string[]): Response {
  return sseResponse(chunks);
}

/* ──────────────────────────────── fixtures ──────────────────────────────── */

let databases = 0;
let databaseName = '';

const store = () => useCoCreateStore.getState();
const content = () => useContentStore.getState();

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-co-create-${databases}`;
  resetDatabase(databaseName);
  resetContentStore();
  resetCoCreate();
  resetSettingsStore();
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  resetCoCreate();
  resetContentStore();
  resetSettingsStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/**
 * A world card open in the editor, with a provider configured.
 *
 * The card is created through the content store — the same path the library screen uses — so the
 * draft this file compares bytes of is a real one (`settings` row and all), not a hand-built object.
 */
async function openWorld(): Promise<string> {
  const id = await content().createWorld('霜月群岛');
  if (id === undefined) throw new Error('the world was not created');
  await content().openWorld(id);
  await writeProviderSettings({
    baseUrl: 'https://gateway.test/v1',
    model: 'test-model-1',
    secret: { kind: 'plaintext', apiKey: 'sk-test' },
  });
  await useSettingsStore.getState().load();
  return id;
}

/** One `settings` row's value, read the way the draft reader reads it. */
async function storedValue(id: string): Promise<JsonValue | undefined> {
  const row = await readTable<{ id: string; value: JsonValue }>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/* ────────────────────────────────── tests ───────────────────────────────── */

describe('a proposal is data, not a write', () => {
  it('records the proposal and leaves the draft row byte-identical', async () => {
    const worldId = await openWorld();
    // Make the draft a real row first, so "unchanged" is a statement about an EXISTING row.
    await content().editWorld({ ...draftData(), premise: '作者自己写的一句' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));

    const wire = fakeWire(() =>
      answer([
        '{"message":"我补一句设定","ops":[{"op":"replace","path":"/premise",',
        '"value":"群岛在霜月下沉"}]}',
      ]),
    );
    configureCoCreate({ transport: wire.fetch });
    await store().send('写一句设定');

    expect(store().pendingId).toBeDefined();
    expect(store().proposals).toHaveLength(1);
    // ...and NOTHING was written: the row is the bytes it held before the turn.
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
    expect(content().worldDraft?.data.premise).toBe('作者自己写的一句');
  });

  it('rejecting leaves the draft row byte-identical and clears the pending proposal', async () => {
    const worldId = await openWorld();
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    const wire = fakeWire(() =>
      answer(['{"message":"m","ops":[{"op":"replace","path":"/premise","value":"x"}]}']),
    );
    configureCoCreate({ transport: wire.fetch });
    await store().send('改一句');

    const pending = store().pendingId;
    expect(pending).toBeDefined();
    if (pending === undefined) return;
    expect(await store().reject(pending)).toBe(true);

    expect(store().pendingId).toBeUndefined();
    expect(store().proposals[0]?.status).toBe('rejected');
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
    expect(content().worldDraft?.data.premise).toBe('');
  });

  it('an answer the reader cannot parse is a finding, and the draft does not move', async () => {
    const worldId = await openWorld();
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    configureCoCreate({
      transport: fakeWire(() => answer(['I would rather ask you a question first.'])).fetch,
    });
    await store().send('开始吧');

    expect(store().pendingId).toBeUndefined();
    expect(store().proposals).toHaveLength(0);
    const finding = store().turns.at(-1)?.finding;
    expect(finding?.code).toBe('co-create.malformedNoJson');
    // The model's own words survive, so 「再试一次」 is an informed decision.
    expect(store().turns.at(-1)?.text).toBe('I would rather ask you a question first.');
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
  });

  it('a turn that only talks offers nothing to accept', async () => {
    await openWorld();
    configureCoCreate({
      transport: fakeWire(() => answer(['{"message":"先聊聊题材？","ops":[]}'])).fetch,
    });
    await store().send('你好');

    expect(store().pendingId).toBeUndefined();
    expect(store().turns.at(-1)?.text).toBe('先聊聊题材？');
    expect(store().proposals).toHaveLength(0);
  });
});

describe('accept and undo', () => {
  it('applies exactly the proposed payload, then restores the pre-apply bytes', async () => {
    const worldId = await openWorld();
    // A draft the author made: the pre-apply bytes this test compares against after the undo.
    await content().editWorld({ ...draftData(), premise: '作者的一句', era: '第三纪' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));

    configureCoCreate({
      transport: fakeWire(() =>
        answer([
          '{"message":"补充禁忌","ops":[{"op":"replace","path":"/rulesOfNature/taboos",',
          '"value":"不可直呼真名"},{"op":"replace","path":"/premise","value":"群岛在霜月下沉"}]}',
        ]),
      ).fetch,
    });
    await store().send('补两条');
    const pending = store().pendingId;
    expect(pending).toBeDefined();
    if (pending === undefined) return;

    expect(await store().accept(pending)).toBe(true);

    // THE PROPOSED PAYLOAD IS WHAT THE DRAFT NOW IS — asserted on the ROW and on the editor's value.
    const applied = await readWorldDraft(worldId, await latestVersion(worldId));
    expect(applied?.data.premise).toBe('群岛在霜月下沉');
    expect(applied?.data.rulesOfNature.taboos).toBe('不可直呼真名');
    expect(applied?.data.era).toBe('第三纪');
    expect(content().worldDraft?.data.rulesOfNature.taboos).toBe('不可直呼真名');
    expect(store().proposals[0]?.status).toBe('accepted');
    expect(store().undoable).toBeDefined();

    // UNDO RESTORES THE DATA, byte for byte.
    expect(await store().undoAccept()).toBe(true);
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
    expect(content().worldDraft?.data.premise).toBe('作者的一句');
    expect(content().worldDraft?.data.rulesOfNature.taboos).toBe('');
    // The snapshot is spent, so the button cannot offer to undo the same acceptance twice.
    expect(store().undoable).toBeUndefined();
  });

  it('does not offer an undo for a proposal that was never applied', async () => {
    await openWorld();
    configureCoCreate({
      transport: fakeWire(() => answer(['{"message":"m","ops":[]}'])).fetch,
    });
    await store().send('聊聊');
    expect(store().undoable).toBeUndefined();
    // ...and an undo with nothing to restore writes nothing and answers `false`.
    expect(await store().undoAccept()).toBe(false);
  });
});

describe('the provider path', () => {
  it('sends the instruction, the payload and the JSON response format in one real request', async () => {
    await openWorld();
    const wire = fakeWire(() => answer(['{"message":"m","ops":[]}']));
    configureCoCreate({ transport: wire.fetch });
    await store().send('把时代背景写成第三纪');

    expect(wire.calls()).toBe(1);
    const body = wire.lastBody();
    expect(body?.model).toBe('test-model-1');
    const system = body?.messages?.find((message) => message.role === 'system')?.content ?? '';
    // The wire body is the proof that this went through the provider AND that the instruction asked
    // for something machine-readable — the whole reason a malformed answer is a possibility at all.
    expect(system).toContain('co-writing a WORLD CARD');
    expect(system).toContain('{"message": "<your reply to the author>"');
    expect(system).toContain('/rulesOfNature/taboos');
    expect(system).toContain('"premise":');
    expect(body?.messages?.at(-1)).toEqual({ role: 'user', content: '把时代背景写成第三纪' });
    expect(JSON.stringify(body?.response_format)).toContain('json_schema');
  });

  it('carries the earlier turns back, so a second turn is a conversation', async () => {
    await openWorld();
    let round = 0;
    const wire = fakeWire(() => {
      round += 1;
      return answer([
        round === 1 ? '{"message":"先说是哪种魔法","ops":[]}' : '{"message":"好","ops":[]}',
      ]);
    });
    configureCoCreate({ transport: wire.fetch });
    await store().send('第一句');
    await store().send('第二句');

    const body = wire.lastBody();
    expect(body?.messages?.map((message) => message.content)).toEqual([
      expect.stringContaining('co-writing a WORLD CARD'),
      '第一句',
      '先说是哪种魔法',
      '第二句',
    ]);
  });

  it('refuses locally, with a readable sentence, when nothing is configured', async () => {
    const id = await content().createWorld('没有配置的世界');
    if (id === undefined) return;
    await content().openWorld(id);
    // No `writeProviderSettings`: the row is empty, so there is no endpoint to send to.
    const wire = fakeWire(() => answer(['{"message":"m","ops":[]}']));
    configureCoCreate({ transport: wire.fetch });
    await store().send('你好');

    expect(wire.calls()).toBe(0);
    expect(store().finding?.code).toBe('error.notConfigured');
    expect(store().busy).toBe(false);
  });

  it('drops an answer whose conversation was reset while it was in flight', async () => {
    await openWorld();
    configureCoCreate({ transport: fakeWire(() => answer(['{"message":"m","ops":[]}'])).fetch });
    // `reset` bumps the token synchronously, exactly as closing the panel does mid-request.
    const inFlight = store().send('你好');
    store().reset();
    await inFlight;

    expect(store().turns).toEqual([]);
    expect(store().proposals).toEqual([]);
    expect(store().pendingId).toBeUndefined();
  });
});

/* ──────────────────────────────── helpers ───────────────────────────────── */

/** The open world's draft payload. The editor has one whenever a world is open. */
function draftData(): WorldData {
  const draft = content().worldDraft;
  if (draft === undefined) throw new Error('no world is open');
  return draft.data;
}

/** The newest published version of a world — the base a stored draft is completed against. */
async function latestVersion(worldId: string): Promise<WorldVersion> {
  const version = await latestWorldVersion(worldId);
  if (version === undefined) throw new Error('no published version');
  return version;
}
