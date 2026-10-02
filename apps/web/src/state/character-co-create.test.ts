/**
 * M1-C2 (角色 AI 生成) and M1-C3 (发言档案自动评估) against real IndexedDB.
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONES' OWN WORDS
 * `docs/06` §2.3 states the two rows this file covers:
 *   • `M1-C2 | 角色 AI 生成 | 基于所选世界的生成 + 共创对话 | M1-W2 | 生成结果符合世界观约束`
 *   • `M1-C3 | 发言档案自动评估 | evaluate_voice_profile 用例（提案形式） | M1-C1 | 生成欲望/能力值并给出
 *     理由；可手动覆盖`
 * So the facts asserted here are:
 *   1. a character generation walks a STEP PLAN — more than one request, each scoped to a strict subset
 *      of the character's own editable paths, and no single proposal touching every field. That is
 *      M1-W3's 「不一次性生成全部」 structure, now over the character inventory;
 *   2. 「基于所选世界的生成」: the world the author is working from travels INTO the instruction (its name,
 *      premise, rules), so the character is written against it — and it is NOT a path the scope allows,
 *      so 「符合世界观约束」 cannot be satisfied by editing the world instead;
 *   3. M1-C3 fills SPECIFIC `voice` fields from the card's own content: rejecting leaves the draft row
 *      byte-identical, accepting applies exactly those fields and nothing else, and undo restores the
 *      payload byte for byte;
 *   4. a proposal that reaches outside the character form (here: the world's own `/premise`, and the
 *      character's `/visual/params/seed` — a field the form renders but the AI must not invent) is
 *      refused as a whole with NOTHING applied, not even the in-scope operations;
 *   5. a card too thin to judge gets a FINDING and no invented numbers — the local precondition sends no
 *      request at all, and the model's own empty patch is reported with its reason.
 *
 * WHY THE WIRE IS REAL AND FAKED AT THE SOCKET ONLY
 * The transport is a fake `fetch` answering standard SSE, so every request goes through the app's one
 * provider path (`co-create/ask.ts` -> `OpenAICompatibleProvider`) and every answer through the app's one
 * reader. Nothing about the store, the scope or the engine is stubbed, which is what makes the
 * assertions statements about the program rather than about a mock.
 */
/** @vitest-environment node */
import 'fake-indexeddb/auto';
import { COLLECTIONS } from '@smarttavern/core';
import type { FetchLike } from '@smarttavern/providers';
import type { CharacterData, JsonValue } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHARACTER_PATCH_PATHS, VOICE_EVALUATED_PATHS } from '../co-create/character';
import { closeDatabase, readTable, resetDatabase } from '../db/database';
import { deleteDatabase } from '../db/raw-indexeddb.test-helpers';
import { characterDraftId, writeProviderSettings } from '../db/repository';
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
  messages?: { role: string; content: string }[];
  response_format?: unknown;
}

interface FakeWire {
  readonly fetch: FetchLike;
  lastBody: () => WireRequest | undefined;
  calls: () => number;
  /** Every system instruction the wire has seen, oldest first — the text the model was asked with. */
  systems: () => string[];
}

/** A standard SSE answer, for `co-create/panel.test.tsx`'s reason: the adapter parses real framing. */
function answer(chunks: readonly string[]): Response {
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

/** One `fetch` that answers `answers()` in turn, recording every request body. */
function fakeWire(answers: readonly (() => Response)[]): FakeWire {
  let body: WireRequest | undefined;
  const seen: WireRequest[] = [];
  let calls = 0;
  return {
    fetch: (_url, init) => {
      calls += 1;
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body) as WireRequest;
          seen.push(body);
        } catch {
          body = undefined;
        }
      }
      const next = answers[Math.min(calls - 1, answers.length - 1)];
      if (next === undefined) throw new Error('no answer queued for this call');
      return Promise.resolve(next());
    },
    lastBody: () => body,
    calls: () => calls,
    systems: () =>
      seen.map(
        (request) => request.messages?.find((message) => message.role === 'system')?.content ?? '',
      ),
  };
}

/** An answer whose operations are the given ones, with a message and a rationale. */
function patch(
  ops: readonly { op: string; path: string; value?: JsonValue }[],
  rationale?: string,
): Response {
  return answer([
    JSON.stringify({
      message: 'here is my proposal',
      ...(rationale === undefined ? {} : { rationale }),
      ops,
    }),
  ]);
}

/* ──────────────────────────────── fixtures ──────────────────────────────── */

let databases = 0;
let databaseName = '';

const store = () => useCoCreateStore.getState();
const content = () => useContentStore.getState();

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-character-co-create-${databases}`;
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
 * A world and a character open in their editors, with a provider configured.
 *
 * BOTH CARDS ARE OPEN ON PURPOSE: M1-C2's row is 「基于所选世界的生成」, so the world has to exist for the
 * character's instruction to be built against it — and the character draft this file compares bytes of is
 * a real one, created through the same content store the library screen uses.
 */
async function openCards(): Promise<{ characterId: string; worldId: string }> {
  const worldId = await content().createWorld('霜月群岛');
  if (worldId === undefined) throw new Error('the world was not created');
  await content().openWorld(worldId);
  await content().editWorld(
    {
      ...draftWorld(),
      premise: '群岛在霜月下沉',
      era: '第三纪',
      rulesOfNature: { ...draftWorld().rulesOfNature, taboos: '不可直呼真名' },
    },
    {},
  );

  const characterId = await content().createCharacter('银松镇的莉安');
  if (characterId === undefined) throw new Error('the character was not created');
  await content().openCharacter(characterId);
  // M1-C2's 「基于所选世界的生成」: opening a character CLOSES the world, so the world to generate against
  // is READ BY ID (`state/co-create-store.ts`'s `loadWorld`) rather than picked up from the open editor.
  await store().loadWorld(worldId);
  await writeProviderSettings({
    baseUrl: 'https://gateway.test/v1',
    model: 'test-model-1',
    secret: { kind: 'plaintext', apiKey: 'sk-test' },
  });
  await useSettingsStore.getState().load();
  return { characterId, worldId };
}

/** The open character's draft payload. */
function draftCharacter(): CharacterData {
  const draft = content().characterDraft;
  if (draft === undefined) throw new Error('no character is open');
  return draft.data;
}

/** The open world's draft payload, for the test that seeds the world the character is written into. */
function draftWorld() {
  const draft = content().worldDraft;
  if (draft === undefined) throw new Error('no world is open');
  return draft.data;
}

/**
 * A character whose card already says something, so 「从零生成」 is willing to start and M1-C3 has
 * evidence to judge (both gates read `cards/character.ts`'s content fields).
 */
async function seedCharacterWithVoiceEvidence(
  voice?: Partial<CharacterData['voice']>,
): Promise<void> {
  const data = draftCharacter();
  await content().editCharacter(
    {
      ...data,
      description: '莉安是银松镇的镇长，说话直接、声音很响，掌握着渡口与粮仓的账目。',
      personality: '急躁、护短，遇到不公会当场发作。',
      ...(voice === undefined ? {} : { voice: { ...data.voice, ...voice } }),
    },
    {},
  );
}

/** One `settings` row's value, read the way the draft reader reads it. */
async function storedValue(id: string): Promise<JsonValue | undefined> {
  const row = await readTable<{ id: string; value: JsonValue }>(COLLECTIONS.settings).get(id);
  return row?.value;
}

/** The character's draft row as the bytes a reject must not change. */
async function characterRow(characterId: string): Promise<string> {
  return JSON.stringify(await storedValue(characterDraftId(characterId)));
}

/* ────────────────────────────────── tests ───────────────────────────────── */

describe('M1-C2 — generating a character, one structured step at a time', () => {
  it('walks the character plan step by step, keeping every request inside a strict subset of the card', async () => {
    const { characterId } = await openCards();
    await seedCharacterWithVoiceEvidence();
    const before = await characterRow(characterId);

    // Every answer writes ONLY its own step's fields, so the assertions below are about what the STORE
    // allowed rather than about what the fake said.
    const wire = fakeWire([
      () => patch([{ op: 'replace', path: '/name', value: '莉安' }]),
      () => patch([{ op: 'replace', path: '/scenario', value: '渡口边的镇长办公室' }]),
    ]);
    configureCoCreate({ transport: wire.fetch });

    await store().startGeneration();

    // FIRST REQUEST ONLY, and nothing written: the flow is a sequence of turns, not one generation.
    expect(wire.calls()).toBe(1);
    expect(store().generation?.plan.kind).toBe('character');
    expect(store().generation?.plan.steps.length).toBeGreaterThan(1);
    expect(coCreateRequests().map((request) => request.card)).toEqual(['character']);
    expect(coCreateRequests().map((request) => request.step)).toEqual(['identity']);
    expect(store().pendingId).toBeDefined();
    expect(await characterRow(characterId)).toBe(before);

    // 「基于所选世界的生成」: the world the author is working from is IN the instruction...
    const first = wire.systems()[0] ?? '';
    expect(first).toContain('THE WORLD THIS CHARACTER HAS TO FIT');
    expect(first).toContain('霜月群岛');
    expect(first).toContain('群岛在霜月下沉');
    expect(first).toContain('不可直呼真名');
    expect(first).toContain('may NOT edit it');
    // ...and it is NOT a path this turn may write: the scope offers character paths only.
    expect(coCreateRequests()[0]?.paths).not.toContain('/premise');

    // 采纳 step 1: only its fields move, and the walk asks for the next step by itself.
    const firstId = store().pendingId;
    if (firstId === undefined) throw new Error('no first proposal');
    expect(await store().accept(firstId)).toBe(true);
    expect(draftCharacter().name).toBe('莉安');
    expect(draftCharacter().scenario).toBe('');
    expect(wire.calls()).toBe(2);
    expect(coCreateRequests().map((request) => request.step)).toEqual(['identity', 'scenario']);
    expect(store().generation?.steps[0]?.state).toBe('accepted');

    const characterPaths = CHARACTER_PATCH_PATHS.map((entry) => entry.path);
    // NO REQUEST COULD WRITE THE WHOLE CARD: each one is a strict, non-empty subset of the character's
    // own editable fields. That is 「AI 采用结构化流程，不一次性生成全部」 as a fact about the wire.
    for (const request of coCreateRequests()) {
      expect(request.paths.length).toBeGreaterThan(0);
      expect(request.paths.length).toBeLessThan(characterPaths.length);
      for (const path of request.paths) expect(characterPaths).toContain(path);
    }
    // ...and the plan as a whole is still narrower than the card: the image and sampling settings are
    // the author's own and no step offers them.
    const planPaths = store().generation?.plan.paths ?? [];
    // THE PLAN COVERS EVERY FIELD THE FORM OFFERS — the coverage assertion in `co-create/plan.ts` holds
    // it to that — and what makes the flow structured is the SPLIT: no step covers the whole card, and
    // the requests proved it above. What the plan deliberately does NOT cover is the AUTHOR'S own
    // settings, and those are named as untouchable rather than silently missing:
    expect(planPaths.length).toBe(characterPaths.length);
    expect(store().generation?.plan.reservedPaths).toContain('/visual/params/seed');
    expect(store().generation?.plan.reservedPaths).toContain('/sampling/temperature');
    expect(planPaths).not.toContain('/sampling/temperature');
    expect(planPaths).not.toContain('/visual/params/seed');
  });

  it('refuses a character proposal that reaches for a world path, and applies nothing at all', async () => {
    const { characterId } = await openCards();
    await seedCharacterWithVoiceEvidence();
    const before = await characterRow(characterId);
    // The model answers with the step's own field AND a world edit. The second operation is the point:
    // 「符合世界观约束」 must not be satisfiable by rewriting the world from the character editor.
    const wire = fakeWire([
      () =>
        patch([
          { op: 'replace', path: '/name', value: '莉安' },
          { op: 'replace', path: '/premise', value: '被改写的世界' },
        ]),
    ]);
    configureCoCreate({ transport: wire.fetch });

    await store().startGeneration();

    expect(store().pendingId).toBeUndefined();
    expect(store().proposals).toHaveLength(0);
    const finding = store().turns.at(-1)?.finding;
    expect(finding?.code).toBe('co-create.outOfScope');
    expect(finding?.detail).toBe('/premise');
    // NOTHING was applied, not the in-scope operation and not the stray one.
    expect(await characterRow(characterId)).toBe(before);
    expect(draftCharacter().name).toBe('银松镇的莉安');
    expect(draftWorld().premise).toBe('群岛在霜月下沉');
    expect(store().undoable).toBeUndefined();
  });

  it('refuses to start from a card that says nothing, rather than inventing a character', async () => {
    await openCards();
    const wire = fakeWire([() => patch([])]);
    configureCoCreate({ transport: wire.fetch });

    await store().startGeneration();

    expect(wire.calls()).toBe(0);
    expect(store().finding?.code).toBe('co-create.characterFirst');
    expect(store().generation).toBeUndefined();
  });
});

describe('M1-C3 — evaluating the speaking profile from the card’s own content', () => {
  it('proposes exactly the evaluable voice fields, applies them on 采纳 and restores the bytes on 撤销', async () => {
    const { characterId } = await openCards();
    await seedCharacterWithVoiceEvidence({ desire: 50, ability: 50, roles: [] });
    const before = await characterRow(characterId);

    const wire = fakeWire([
      () =>
        patch(
          [
            { op: 'replace', path: '/voice/desire', value: 82 },
            { op: 'replace', path: '/voice/ability', value: 64 },
            { op: 'add', path: '/voice/roles', value: '信息提供者' },
          ],
          'The description has her running the town and holding the ledgers, so she speaks often (high desire) and with authority (high ability).',
        ),
    ]);
    configureCoCreate({ transport: wire.fetch });

    await store().askVoiceEvaluation();

    // The request is scoped to the profile fields C3 evaluates, and to nothing else.
    const request = coCreateRequests()[0];
    expect(request?.kind).toBe('voice-profile');
    expect(request?.card).toBe('character');
    expect(request?.paths).toEqual([...VOICE_EVALUATED_PATHS]);
    expect(request?.instruction).toContain('THE CARD CONTENT THIS ASSESSMENT IS BASED ON');
    expect(request?.instruction).toContain('莉安是银松镇的镇长');
    // The hard limits are named as untouchable rather than silently absent.
    expect(request?.instruction).toContain(
      'DO NOT EDIT /voice/maxLinesPerRound OR /voice/cooldown',
    );

    // 「并给出理由」: the reason is on screen with the proposal, and nothing is written yet.
    expect(store().voiceEvaluation?.fields).toEqual([...VOICE_EVALUATED_PATHS]);
    expect(store().voiceEvaluation?.reason).toContain('running the town');
    expect(await characterRow(characterId)).toBe(before);

    // 否决 leaves the draft row BYTE-IDENTICAL, and drops the reason with the proposal.
    const pending = store().pendingId;
    if (pending === undefined) throw new Error('no assessment proposal');
    expect(await store().reject(pending)).toBe(true);
    expect(await characterRow(characterId)).toBe(before);
    expect(draftCharacter().voice.desire).toBe(50);
    expect(store().voiceEvaluation).toBeUndefined();

    // 采纳 of a second turn applies EXACTLY those three fields.
    configureCoCreate({
      transport: fakeWire([
        () =>
          patch([
            { op: 'replace', path: '/voice/desire', value: 82 },
            { op: 'replace', path: '/voice/ability', value: 64 },
            { op: 'add', path: '/voice/roles', value: '信息提供者' },
          ]),
      ]).fetch,
    });
    await store().askVoiceEvaluation();
    const second = store().pendingId;
    if (second === undefined) throw new Error('no second assessment proposal');
    expect(await store().accept(second)).toBe(true);

    const applied = draftCharacter().voice;
    expect(applied.desire).toBe(82);
    expect(applied.ability).toBe(64);
    expect(applied.roles).toEqual(['信息提供者']);
    // THE FIELDS C3 DOES NOT EVALUATE ARE UNTOUCHED: the scheduler's hard limits stay the author's.
    expect(applied.maxLinesPerRound).toBe(1);
    expect(applied.cooldown).toBe(0);
    // ...and the description the assessment read is not a field it wrote.
    expect(draftCharacter().description).toContain('镇长');

    // 撤销 restores the payload byte for byte.
    expect(await store().undoAccept()).toBe(true);
    expect(await characterRow(characterId)).toBe(before);
    expect(draftCharacter().voice.desire).toBe(50);
    expect(draftCharacter().voice.roles).toEqual([]);
    expect(store().undoable).toBeUndefined();
  });

  it('says so, without sending anything, when the card has nothing to judge', async () => {
    const { characterId } = await openCards();
    const before = await characterRow(characterId);
    const wire = fakeWire([() => patch([])]);
    configureCoCreate({ transport: wire.fetch });

    await store().askVoiceEvaluation();

    expect(wire.calls()).toBe(0);
    expect(store().finding?.code).toBe('co-create.voiceTooThin');
    expect(store().pendingId).toBeUndefined();
    expect(await characterRow(characterId)).toBe(before);
  });

  it('reports the model’s own refusal to score, and invents no numbers', async () => {
    const { characterId } = await openCards();
    await seedCharacterWithVoiceEvidence();
    const before = await characterRow(characterId);
    // A model that judges the card too thin answers with NO operations and its reason: the second layer
    // of the too-thin rule, which is a different fact from the local precondition above.
    configureCoCreate({
      transport: fakeWire([
        () =>
          answer([
            JSON.stringify({
              message: 'This is too thin to score.',
              rationale: 'Only one sentence of description and no personality.',
              ops: [],
            }),
          ]),
      ]).fetch,
    });

    await store().askVoiceEvaluation();

    expect(store().pendingId).toBeUndefined();
    expect(store().proposals).toHaveLength(0);
    const finding = store().turns.at(-1)?.finding;
    expect(finding?.code).toBe('co-create.voiceNoSignal');
    // The MODEL's own reason travels as the finding's detail, so the author reads why nothing was scored.
    expect(finding?.detail).toContain('no personality');
    // NOT ONE number was written, and no middle value was invented as a placeholder.
    expect(await characterRow(characterId)).toBe(before);
    expect(draftCharacter().voice.desire).toBe(50);
    expect(store().voiceEvaluation).toBeUndefined();
  });

  it('refuses an assessment that scores a scheduler hard limit, applying nothing', async () => {
    const { characterId } = await openCards();
    await seedCharacterWithVoiceEvidence();
    const before = await characterRow(characterId);
    configureCoCreate({
      transport: fakeWire([
        () =>
          patch([
            { op: 'replace', path: '/voice/desire', value: 90 },
            { op: 'replace', path: '/voice/maxLinesPerRound', value: 5 },
          ]),
      ]).fetch,
    });

    await store().askVoiceEvaluation();

    const finding = store().turns.at(-1)?.finding;
    expect(finding?.code).toBe('co-create.outOfScope');
    expect(finding?.detail).toBe('/voice/maxLinesPerRound');
    expect(store().pendingId).toBeUndefined();
    expect(await characterRow(characterId)).toBe(before);
    expect(draftCharacter().voice.desire).toBe(50);
  });
});

describe('the character form’s own inventory', () => {
  it('offers the editor’s fields, refuses the ones it renders but no model may invent, and labels each', () => {
    const paths = CHARACTER_PATCH_PATHS.map((entry) => entry.path);
    // The fields 「字段完整」 already pins for the editor are the fields a proposal may write...
    expect(paths).toContain('/description');
    expect(paths).toContain('/voice/desire');
    expect(paths).toContain('/voice/roles');
    expect(paths).toContain('/visual/appearance/hair');
    // ...and the ones that are the AUTHOR'S configuration are not offered at all: an invented image seed
    // or sampling temperature is not a character edit (see `co-create/character.ts`).
    expect(paths).not.toContain('/visual/params/seed');
    expect(paths).not.toContain('/sampling/temperature');
    expect(paths).not.toContain('/customFields');
    // Every path carries the form's own label, so the panel prints the word the editor prints.
    for (const entry of CHARACTER_PATCH_PATHS)
      expect(entry.label.startsWith('character.')).toBe(true);
  });
});
