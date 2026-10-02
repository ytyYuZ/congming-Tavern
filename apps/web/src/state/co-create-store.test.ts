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
import { WORLD_PATCH_PATHS } from '../co-create/proposal';
import { closeDatabase, readTable, resetDatabase } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import {
  latestWorldVersion,
  readWorldDraft,
  worldDraftId,
  writeProviderSettings,
} from '../db/repository';
import {
  coCreateRequests,
  configureCoCreate,
  resetCoCreate,
  useCoCreateStore,
} from './co-create-store';
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

describe('generation mode — one step at a time (M1-W3)', () => {
  it('asks one request per step, keeps each proposal inside its own fields, and never applies two steps at once', async () => {
    const worldId = await openWorld();
    await draftWithGenre();
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));

    // EVERY step is answered with a proposal that writes something else, so the assertions below are
    // about what the STORE allowed rather than about what the fake said. Step 2 writes only its own
    // three fields: the step-boundary case (a proposal that reaches outside) has its own test below.
    const wire = sequentialWire([
      () => replacement('/premise', '群岛在霜月下沉'),
      () =>
        answer([
          JSON.stringify({
            message: 'basics',
            ops: [
              { op: 'replace', path: '/era', value: '第三纪' },
              { op: 'replace', path: '/techOrMagic', value: '潮汐术' },
              // `replace` and not `add`: `name` is a required member and is always there, so `add`
              // would be `member-exists` — the engine's own rule (`json-patch.ts` records it).
              { op: 'replace', path: '/name', value: '霜月群岛' },
            ],
          }),
        ]),
      // The third answer is never asked for in this flow: the refusal stops the walk (asserted below).
      () => answer(['{"message":"unused","ops":[]}']),
    ]);
    configureCoCreate({ transport: wire.fetch });

    // 1. 从零生成: the FIRST request only, for a scope narrower than the card, and nothing written.
    await store().startGeneration();
    expect(wire.calls()).toBe(1);
    expect(coCreateRequests().map((request) => request.step)).toEqual(['premise']);
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
    expect(store().generation?.plan.steps.length).toBeGreaterThan(1);
    expect(store().generation?.steps[0]?.state).toBe('pending');
    expect(store().generation?.current).toBe(0);
    expect(store().pendingId).toBeDefined();
    expect(store().proposals).toHaveLength(1);

    // The instruction on the WIRE is the scoped one: the step's path is offered and the rest named.
    const first = coCreateRequests()[0];
    expect(first?.kind).toBe('generate-step');
    expect(first?.paths).toEqual(['/premise']);
    expect(lastSystem(wire)).toContain('- /premise  (world.premiseLabel)');
    expect(lastSystem(wire)).toContain('reserved for a later step of this generation');
    expect(lastSystem(wire)).toContain('DO NOT EDIT THESE PATHS IN THIS TURN');

    // 2. 采纳 step 1: only its field moves, and the walk asks for exactly the next step.
    const firstId = store().pendingId;
    if (firstId === undefined) throw new Error('no first proposal');
    expect(await store().accept(firstId)).toBe(true);
    expect(content().worldDraft?.data.premise).toBe('群岛在霜月下沉');
    expect(content().worldDraft?.data.era).toBe('');
    expect(wire.calls()).toBe(2);
    expect(coCreateRequests().map((request) => request.step)).toEqual(['premise', 'basics']);
    expect(coCreateRequests()[1]?.paths).toEqual(['/name', '/era', '/techOrMagic']);
    expect(store().generation?.steps[0]?.state).toBe('accepted');
    expect(store().generation?.current).toBe(1);

    // 3. 否决 step 2: the step is refused, the walk STOPS ASKING, and the draft keeps exactly what
    // step 1 wrote — nothing of step 2 is in it, and nothing of step 1 was lost.
    const secondId = store().pendingId;
    if (secondId === undefined) throw new Error('no second proposal');
    const afterStepOne = JSON.stringify(await storedValue(worldDraftId(worldId)));
    expect(await store().reject(secondId)).toBe(true);
    // The refusal stops the automatic walk: the store did NOT ask for step 3.
    expect(wire.calls()).toBe(2);
    expect(content().worldDraft?.data.name).toBe('霜月群岛');
    expect(content().worldDraft?.data.era).toBe('');
    expect(content().worldDraft?.data.techOrMagic).toBe('');
    expect(content().worldDraft?.data.premise).toBe('群岛在霜月下沉');
    expect(content().worldDraft?.data.regions).toEqual([]);
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(afterStepOne);
    expect(store().generation?.steps[1]?.state).toBe('rejected');
    // ...and the refused step can be generated again, on its own, with a request of its own.
    configureCoCreate({
      transport: sequentialWire([() => replacement('/era', '第三纪')]).fetch,
    });
    await store().generateStep();
    expect(wire.calls()).toBe(2);
    expect(coCreateRequests()).toHaveLength(3);
    expect(coCreateRequests()[2]?.step).toBe('basics');
    const retryId = store().pendingId;
    if (retryId === undefined) throw new Error('no retry proposal');
    expect(await store().accept(retryId)).toBe(true);
    expect(content().worldDraft?.data.era).toBe('第三纪');
    // The retry was step 2's turn, so the walk moved on; the card still holds what step 1 wrote.
    expect(content().worldDraft?.data.premise).toBe('群岛在霜月下沉');
    expect(store().generation?.mode).toBe('manual');

    // 4. EVERY request this walk made was scoped to one step, and no two of them carry the same scope:
    // that is 「不一次性生成全部」 as a fact about the sequence rather than about any one answer.
    const paths = coCreateRequests().map((request) => request.paths.join(','));
    expect(paths).toEqual(['/premise', '/name,/era,/techOrMagic', '/name,/era,/techOrMagic']);
    for (const request of coCreateRequests()) {
      expect(request.paths.length).toBeGreaterThan(0);
      expect(request.instruction).toContain('THIS TURN GENERATES ONE STEP OF A CARD');
    }
    // The path list every request may write is a strict subset of the card's own editable fields, so
    // no request this flow sent could have written the whole card.
    for (const request of coCreateRequests()) {
      expect(request.paths.length).toBeLessThan(WORLD_PATCH_PATHS.length);
    }
  });

  it('refuses a proposal that leaves its step, with a readable finding, and writes nothing', async () => {
    const worldId = await openWorld();
    await draftWithGenre();
    // A draft the author made, so "unchanged" is a statement about a row that exists.
    await content().editWorld({ ...draftData(), premise: '作者自己写的一句' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    configureCoCreate({
      transport: sequentialWire([
        () =>
          answer([
            JSON.stringify({
              message: 'I also changed the era',
              ops: [
                { op: 'replace', path: '/premise', value: 'AI 的一句' },
                { op: 'replace', path: '/era', value: '第三纪' },
              ],
            }),
          ]),
      ]).fetch,
    });

    await store().startGeneration();

    // NO proposal is offered at all: the turn is a finding, and the finding names the path it aimed at.
    expect(store().pendingId).toBeUndefined();
    expect(store().proposals).toHaveLength(0);
    const finding = store().turns.at(-1)?.finding;
    expect(finding?.code).toBe('co-create.outOfScope');
    expect(finding?.detail).toBe('/era');
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
    expect(content().worldDraft?.data.premise).toBe('作者自己写的一句');
    expect(store().undoable).toBeUndefined();
  });

  it('refuses to start from a card that says nothing at all, rather than inventing a direction', async () => {
    await openWorld();
    const wire = sequentialWire([() => answer(['{"message":"m","ops":[]}'])]);
    configureCoCreate({ transport: wire.fetch });
    await store().startGeneration();

    expect(wire.calls()).toBe(0);
    expect(store().finding?.code).toBe('co-create.genreFirst');
    expect(store().generation).toBeUndefined();
  });

  it('generates only the fields the author picked, and none of the steps in between', async () => {
    await openWorld();
    await draftWithGenre();
    // The answers are in the PLAN's order, not in the order the two fields were listed: the second
    // request is the one the author asks for, and it is the step that owns the second field.
    const wire = sequentialWire([
      () => replacement('/premise', '群岛在霜月下沉'),
      () => replacement('/rulesOfNature/taboos', '不可直呼真名'),
    ]);
    configureCoCreate({ transport: wire.fetch });

    // 「逐字段生成」: two fields, from two different steps. The walk takes the plan's own order, and it
    // stops after each one — the request for the next field is the author's, not the store's.
    await store().startFieldGeneration(['/rulesOfNature/taboos', '/premise']);
    expect(coCreateRequests().map((request) => request.step)).toEqual(['premise']);
    expect(coCreateRequests()[0]?.kind).toBe('generate-step');
    // Step 4 (`rules`) owns the other field, and NOTHING of steps 2 and 3 was requested: the walk
    // skipped from `premise` straight to `rules`, which is what "only the fields picked" means.
    expect(store().generation?.plan.steps.map((step) => step.id)).toEqual(['premise', 'rules']);

    const firstId = store().pendingId;
    if (firstId === undefined) throw new Error('no first proposal');
    expect(await store().accept(firstId)).toBe(true);
    // ONE field, not two: the store did not walk on by itself.
    expect(wire.calls()).toBe(1);
    expect(content().worldDraft?.data.premise).toBe('群岛在霜月下沉');
    expect(content().worldDraft?.data.rulesOfNature.taboos).toBe('');

    // The author asks for the other one.
    await store().generateStep();
    expect(coCreateRequests().map((request) => request.step)).toEqual(['premise', 'rules']);
    const secondId = store().pendingId;
    if (secondId === undefined) throw new Error('no second proposal');
    expect(await store().accept(secondId)).toBe(true);
    expect(content().worldDraft?.data.rulesOfNature.taboos).toBe('不可直呼真名');
    // The steps BETWEEN the two chosen ones were never generated.
    expect(content().worldDraft?.data.era).toBe('');
    expect(content().worldDraft?.data.regions).toEqual([]);
    expect(store().generation?.status).toBe('done');
    // With the chosen fields written, a single field is still workable by hand: a settled plan does
    // not hold the field actions hostage.
    await store().askFieldOp('/premise', 'condense');
    expect(coCreateRequests().at(-1)?.kind).toBe('field-op');
  });

  it('says so when nothing is selected', async () => {
    await openWorld();
    await draftWithGenre();
    const wire = sequentialWire([() => answer(['{"message":"m","ops":[]}'])]);
    configureCoCreate({ transport: wire.fetch });
    await store().startFieldGeneration([]);

    expect(wire.calls()).toBe(0);
    expect(store().finding?.code).toBe('co-create.nothingSelected');
  });
});

describe('field-level operations — one field, three gestures (M1-W4)', () => {
  it('rewrites, expands and condenses ONE field, and never touches another', async () => {
    const worldId = await openWorld();
    // A draft the author made: the bytes this test compares against after the undo.
    await content().editWorld({ ...draftData(), premise: '作者的一句', era: '第三纪' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));

    const answers = ['重写的一句', '扩写后更长的一句', '精简的一句'];
    const wire = sequentialWire(answers.map((value) => () => replacement('/premise', value)));
    configureCoCreate({ transport: wire.fetch });

    for (const [index, fieldOp] of (['rewrite', 'expand', 'condense'] as const).entries()) {
      await store().askFieldOp('/premise', fieldOp);
      const request = coCreateRequests()[index];
      expect(request?.kind).toBe('field-op');
      expect(request?.fieldOp).toBe(fieldOp);
      // THE SCOPING: the request may write exactly one path, and the instruction says so.
      expect(request?.paths).toEqual(['/premise']);
      expect(request?.preamble).toContain('THIS TURN EDITS EXACTLY ONE FIELD OF A CARD: /premise');
      expect(store().generation?.plan.steps.map((step) => step.id)).toEqual(['field-op']);

      const pending = store().pendingId;
      if (pending === undefined) throw new Error(`no proposal for ${fieldOp}`);
      expect(await store().accept(pending)).toBe(true);
      expect(content().worldDraft?.data.premise).toBe(answers[index]);
      // The OTHER field of the card is untouched by every one of the three gestures.
      expect(content().worldDraft?.data.era).toBe('第三纪');
    }
    // Three gestures, three requests, and the same one path every time.
    expect(wire.calls()).toBe(3);
    expect(coCreateRequests().map((request) => request.fieldOp)).toEqual([
      'rewrite',
      'expand',
      'condense',
    ]);
    expect(store().fieldOp).toBeUndefined();
    // 撤销 restores the payload the LAST acceptance was applied on top of, byte for byte — an undo is
    // the M1-W2 snapshot, written back through the same `editWorld`. The two earlier gestures were
    // accepted as the author's own edits, so the snapshot only ever holds the one before the last.
    const snapshot = store().undoable?.data;
    expect(await store().undoAccept()).toBe(true);
    expect(content().worldDraft?.data.premise).toBe('扩写后更长的一句');
    expect(snapshot?.premise).toBe(content().worldDraft?.data.premise);
    expect(content().worldDraft?.data.era).toBe('第三纪');
    // The three gestures are gone from the card, but the author's OWN earlier edit to the same field is
    // still the value: the row is not the bytes it started from, and `before` is what that starting
    // state was — kept here so the difference is a checked fact rather than a comment.
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).not.toBe(before);
    // ...and the snapshot is SPENT, exactly as M1-W2's is: the undo takes back the one acceptance.
    expect(store().undoable).toBeUndefined();
  });

  it('refuses a proposal that touches another field, with a finding, and leaves the row identical', async () => {
    const worldId = await openWorld();
    await content().editWorld({ ...draftData(), premise: '作者的一句', era: '第三纪' }, {});
    const before = JSON.stringify(await storedValue(worldDraftId(worldId)));
    // The model rewrites the field it was asked about AND the one beside it. The second operation is
    // the point: the scope is the feature, so its being violated is what has to be visible.
    configureCoCreate({
      transport: sequentialWire([
        () =>
          answer([
            JSON.stringify({
              message: 'I rewrote the era too',
              ops: [
                { op: 'replace', path: '/premise', value: 'AI 的一句' },
                { op: 'replace', path: '/era', value: '第四纪' },
              ],
            }),
          ]),
      ]).fetch,
    });

    await store().askFieldOp('/premise', 'rewrite');

    expect(store().pendingId).toBeUndefined();
    expect(store().proposals).toHaveLength(0);
    const finding = store().turns.at(-1)?.finding;
    expect(finding?.code).toBe('co-create.outOfScope');
    expect(finding?.detail).toBe('/era');
    // BYTE-IDENTICAL: nothing was applied, not the in-scope operation and not the stray one.
    expect(JSON.stringify(await storedValue(worldDraftId(worldId)))).toBe(before);
    expect(content().worldDraft?.data.premise).toBe('作者的一句');
  });

  it('refuses a second field gesture while one proposal is unanswered', async () => {
    await openWorld();
    await content().editWorld({ ...draftData(), premise: '作者的一句' }, {});
    const wire = sequentialWire([
      () => replacement('/premise', '一句新的'),
      () => replacement('/premise', '又一句'),
    ]);
    configureCoCreate({ transport: wire.fetch });

    await store().askFieldOp('/premise', 'rewrite');
    expect(store().pendingId).toBeDefined();
    await store().askFieldOp('/premise', 'expand');

    expect(wire.calls()).toBe(1);
    expect(store().finding?.code).toBe('co-create.finishFirst');
  });
});

/** The open world's draft payload. The editor has one whenever a world is open. */
function draftData(): WorldData {
  const draft = content().worldDraft;
  if (draft === undefined) throw new Error('no world is open');
  return draft.data;
}

/**
 * A draft the author has started: a genre, because 「从零生成」 refuses a card that says nothing at all
 * (see the store's `genreFirst`). The value is stored through the content store, so the row this file
 * compares bytes of is a real one.
 */
async function draftWithGenre(): Promise<void> {
  await content().editWorld({ ...draftData(), genre: ['冰海奇幻'] }, {});
}

/** A wire that answers each call in turn from `answers`, recording every request body. */
function sequentialWire(answers: readonly (() => Response)[]): FakeWire {
  let index = 0;
  return fakeWire(() => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === undefined) throw new Error('no answer queued for this call');
    return answer();
  });
}

/** The system message of the LAST request the wire saw — the instruction, asserted on the wire. */
function lastSystem(wire: FakeWire): string {
  const body = wire.lastBody();
  const messages = body?.messages ?? [];
  return messages.find((message) => message.role === 'system')?.content ?? '';
}

/** An answer whose single operation replaces one field. */
function replacement(path: string, value: string): Response {
  return answer([
    JSON.stringify({
      message: `filled ${path}`,
      ops: [{ op: 'replace', path, value }],
    }),
  ]);
}

/** The newest published version of a world — the base a stored draft is completed against. */
async function latestVersion(worldId: string): Promise<WorldVersion> {
  const version = await latestWorldVersion(worldId);
  if (version === undefined) throw new Error('no published version');
  return version;
}
