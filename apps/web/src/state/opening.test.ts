/**
 * The opening, in all three ways a session can start (M1-S3; docs/06 §2.5, docs/02 §7).
 *
 * WHY THREE SEPARATE OUTCOMES AND NOT ONE
 * The acceptance sentence is 「三种方式均生成合法的首条消息」, and it cannot be read as three
 * spellings of one case: 跳过 writes NO message at all. What it must leave is a valid START
 * STATE — zero rows, a `null` head, and a session the next turn can still begin (`Session.
 * headMessageId` is nullable for exactly that reason). So this file asserts what each way
 * LEAVES, one case per way, plus the one thing all three share: the session is in a position
 * to play on. A test that asserted "one row exists" for all three would have to call 跳过 a
 * failure, and a test that asserted "the chain is not broken" for all three would pass for an
 * implementation where the AI path appended a user turn it should never have written.
 *
 * WHY THE REAL STORE, THE REAL REPOSITORY AND THE REAL TURN PATH
 * The two writing ways are decisions about the DATABASE and about the WIRE — which row is a
 * root, whether a user row exists, how many requests went out, what the request body is. Only
 * the end state can show them, so every case below drives `useChatStore` against
 * `fake-indexeddb` and, where a request is involved, against the REAL `OpenAICompatibleProvider`
 * over a hand-written SSE body (`chat/send-turn.test.ts` records why a mocked provider would
 * prove nothing: the wire body is the evidence that the preset and the composer really ran).
 */
import 'fake-indexeddb/auto';
import { createTranslator } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { Message } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import {
  appendMessage,
  createCheckpoint,
  getChain,
  getSession,
  listChildren,
  restoreCheckpoint,
  setHeadMessageId,
  writeProviderSettings,
} from '../db/repository';
// A session as a container, with the pins the create flow would have collected (M1-S1): this
// file's subject is the opening, not which world the session pins.
import { createTestSession as createSession } from '../db/session.test-helpers';
import { configureChat, resetChat, useChatStore } from './chat-store';
import { useLocaleStore } from './locale-store';
import { resetSettingsStore, useSettingsStore } from './settings-store';

/* ───────────────────────────────── fixtures ──────────────────────────────── */

const API_KEY = 'sk-opening-key-must-not-leak';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'opening-model';

/** The catalog's own opening instruction, read through the same catalog the store uses. */
const INSTRUCTION = createTranslator('zh-CN').t('play.openingInstruction');

let databases = 0;
let databaseName = '';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-opening-${databases}`;
  resetDatabase(databaseName);
  resetChat();
  resetSettingsStore();
  // The opening instruction is catalog copy, so the language has to be pinned or the wire
  // assertions below would depend on whatever the host browser reports.
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  resetChat();
  resetSettingsStore();
  closeDatabase();
  await deleteDatabase(databaseName);
});

/** One request the adapter sent, as the shape these tests read. */
interface WireRequest {
  model?: string;
  messages?: { role: string; content: string }[];
}

/** A transport that records every request and answers one SSE body per request. */
interface RecordingWire {
  readonly fetch: FetchLike;
  /** How many requests left the device. Exactly one is the acceptance for the AI path. */
  readonly calls: () => number;
  /** The decoded JSON body of each request, in the order the requests were made. */
  readonly bodies: () => WireRequest[];
}

/**
 * The wire: standard SSE framing, decoded per request.
 *
 * The body is REAL SSE (`content-type: text/event-stream`, `data:` frames, `[DONE]`) because
 * the adapter parses it; anything else would test a made-up format rather than the transport
 * the app ships (`chat/send-turn.test.ts` makes the same choice and the same argument).
 */
function recordingWire(): RecordingWire {
  const bodies: WireRequest[] = [];
  return {
    calls: () => bodies.length,
    bodies: () => [...bodies],
    fetch: (_url: string, init: RequestInit): Promise<Response> => {
      if (typeof init.body === 'string') {
        try {
          bodies.push(JSON.parse(init.body) as WireRequest);
        } catch {
          bodies.push({});
        }
      }
      const encoder = new TextEncoder();
      const payloads = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '开场白' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const payload of payloads) controller.enqueue(encoder.encode(payload));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    },
  };
}

/**
 * Make the provider ready and give the store a transport, the way `mountApp` does.
 *
 * The key is stored in the CLEAR form: sealing it is `chat-store.test.ts`'s subject, and a
 * missing configuration would be refused by `turnGate` before the turn started — a different
 * failure from the one under test.
 */
async function armTheProvider(wire: RecordingWire): Promise<void> {
  await writeProviderSettings({
    baseUrl: BASE_URL,
    model: MODEL,
    secret: { kind: 'plaintext', apiKey: API_KEY },
  });
  await useSettingsStore.getState().load();
  configureChat({ transport: wire.fetch });
}

/** A fresh session, opened through the store so `messageChain` is its live view. */
async function openFreshSession(): Promise<string> {
  const session = await createSession({ title: 'opening' });
  await useChatStore.getState().open(session.id);
  return session.id;
}

/**
 * Wait until the persisted head is set.
 *
 * The chain is a `liveQuery` payload and a turn writes through the repository, so the read has
 * to be waited for; polling the ROW rather than the store's copy is what makes the assertions
 * below independent of how quickly the subscription emits.
 */
async function waitForHead(sessionId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await getSession(sessionId))?.headMessageId === null) {
    if (Date.now() > deadline) throw new Error('the head was never set');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The chain's only row, narrowed — every writing case below leaves exactly one. */
function rootOf(chain: readonly Message[]): Message {
  const [only] = chain;
  if (only === undefined) throw new Error('the chain has no root');
  return only;
}

/* ─────────────────────────── 手写: the user's own text ─────────────────────── */

describe('M1-S3 手写: the user types the opening', () => {
  it('writes the chain ROOT from that text and moves the head to it', async () => {
    const sessionId = await openFreshSession();
    expect(useChatStore.getState().messageChain).toEqual([]);
    expect((await getSession(sessionId))?.headMessageId).toBeNull();

    await expect(useChatStore.getState().startOpening('  酒馆的门在身后合上。  ')).resolves.toBe(
      true,
    );

    const stored = await getChain(sessionId);
    const opening = rootOf(stored);
    expect(stored).toHaveLength(1);
    expect(opening.role).toBe('user');
    // Trimmed: what is stored is what the user meant, not the whitespace around it.
    expect(opening.content).toBe('酒馆的门在身后合上。');
    // THE EDGE: a root has no parent. This is what makes it the chain's FIRST message rather
    // than a child of whatever the head happened to be.
    expect(opening.parentId).toBeNull();
    // THE POINTER: the head names it, so the transcript is one row and the next turn hangs
    // off it.
    expect((await getSession(sessionId))?.headMessageId).toBe(opening.id);
    expect(useChatStore.getState().session?.headMessageId).toBe(opening.id);
    expect(useChatStore.getState().messageChain.map((message) => message.content)).toEqual([
      '酒馆的门在身后合上。',
    ]);
  });
});

/* ─────────── the guard: an opening is a start, so there is only ever one ─────────── */

/**
 * ONE RULE, AND EVERY POSITION IT HAS TO HOLD IN
 *
 * The rule is "an opening may only be written into a session that has no message at all and
 * whose head is `null`". The four cases below are the four positions that rule is asked about:
 * a session that has already started, a blank attempt, the two attempts that arrive together,
 * and the rolled-back position where the head is `null` while the opening row is still there
 * (ADR-010 keeps it). They live in their own block because they are about the GUARD rather than
 * about either writing path — the hand-written and AI paths are two doors into the same row.
 */
describe('M1-S3 guard: one opening, ever', () => {
  it('refuses a second opening as a NO-OP rather than writing a second root', async () => {
    const sessionId = await openFreshSession();
    await useChatStore.getState().startOpening('第一句');

    // The opening is a START, not an append: a second row with `parentId: null` would be a
    // second root, and `headMessageId` can only name one of them — so the other would be a
    // stored message nothing in the UI can reach. The store refuses, and it refuses because it
    // re-read the TABLE (both halves of `startOpening`'s guard), not because a view hid a button.
    await expect(useChatStore.getState().startOpening('第二句')).resolves.toBe(false);

    const stored = await getChain(sessionId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe('第一句');
    // No second root exists anywhere in the session, which is the fact the chain alone could
    // not show: `getChain` walks up from the head, so it would silently omit the orphan.
    expect(await listChildren(sessionId, null)).toHaveLength(1);
    expect((await getSession(sessionId))?.headMessageId).toBe(stored[0]?.id);
  });

  it('refuses a blank opening without writing anything', async () => {
    const sessionId = await openFreshSession();
    await expect(useChatStore.getState().startOpening('   ')).resolves.toBe(false);
    expect(await getChain(sessionId)).toEqual([]);
    expect((await getSession(sessionId))?.headMessageId).toBeNull();
  });

  it('refuses from a ROLLED-BACK position, where the head is null but the opening is still stored', async () => {
    // A rollback to a save point taken before the first message puts the LIVE position back at
    // "no transcript" without deleting anything (ADR-010). The guard therefore cannot be the
    // head alone: at that position a second opening would be a second ROOT, and no head could
    // ever reach it. Both writing paths are checked together because they write the same row.
    const sessionId = await openFreshSession();
    const checkpoint = await createCheckpoint({ sessionId, label: '开场前' });
    if (checkpoint === undefined) throw new Error('the save point was not written');
    await useChatStore.getState().startOpening('开场白');
    expect(await getChain(sessionId)).toHaveLength(1);

    const restored = await restoreCheckpoint(checkpoint.id);
    expect(restored?.headMessageId).toBeNull();
    // The opening row survives the rollback — that is what makes the position ambiguous.
    expect(await listChildren(sessionId, null)).toHaveLength(1);

    const wire = recordingWire();
    await armTheProvider(wire);
    await expect(useChatStore.getState().startOpening('再写一条')).resolves.toBe(false);
    await expect(useChatStore.getState().generateOpening()).resolves.toBe(false);

    expect(wire.calls()).toBe(0);
    // The stored opening survives, and the session's LIVE position is still "no transcript":
    // `getChain` walks up from a `null` head, so the row is reachable only through the table.
    const roots = await listChildren(sessionId, null);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.content).toBe('开场白');
    expect(await getChain(sessionId)).toEqual([]);
  });

  it('lets exactly one of two CONCURRENT attempts write (the claim precedes the first await)', async () => {
    const sessionId = await openFreshSession();
    const [first, second] = await Promise.all([
      useChatStore.getState().startOpening('同时一'),
      useChatStore.getState().startOpening('同时二'),
    ]);

    // A race that could produce two openings must be impossible by construction rather than by
    // timing: `opening` is set synchronously at the top of the action, so the second call is
    // refused before it reads anything.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await listChildren(sessionId, null)).toHaveLength(1);
  });
});

/* ─────────────────── AI 生成: one request, no user row ─────────────────── */

describe('M1-S3 AI 生成: one request through the real turn path', () => {
  it('leaves the same start state the hand-written way does', async () => {
    const sessionId = await openFreshSession();
    const wire = recordingWire();
    await armTheProvider(wire);

    await expect(useChatStore.getState().generateOpening()).resolves.toBe(true);
    await waitForHead(sessionId);

    const stored = await getChain(sessionId);
    const opening = rootOf(stored);
    expect(stored).toHaveLength(1);
    // THE ANSWER IS THE ROOT. `append: {mode: 'none'}` writes no user row, so the assistant
    // turn is the first message of the session — the same start state 手写 leaves, reached
    // from the other side (that one writes the user's own text as the root).
    expect(opening.role).toBe('assistant');
    expect(opening.content).toBe('开场白');
    expect(opening.parentId).toBeNull();
    expect((await getSession(sessionId))?.headMessageId).toBe(opening.id);
    // EXACTLY ONE REQUEST. A retry, a second attempt or a "prefetch" would show up here.
    expect(wire.calls()).toBe(1);
  });

  it('sends the catalog instruction as the turn input and writes NO user row for it', async () => {
    await openFreshSession();
    const wire = recordingWire();
    await armTheProvider(wire);

    await useChatStore.getState().generateOpening();

    // THE WIRE BODY IS THE EVIDENCE that this went through the app's real preset and composer
    // (`chat/builtin-content.ts` + `chat/send-turn.ts`): the preset's system blocks come first,
    // the turn's input is last, and that input is the catalog's instruction — the text the
    // store asked the composer about.
    const [body] = wire.bodies();
    if (body === undefined) throw new Error('no request was made');
    expect(body.model).toBe(MODEL);
    const messages = body.messages ?? [];
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.at(-1)).toEqual({ role: 'user', content: INSTRUCTION });
    // The built-in preset's own instruction is what precedes it — the real assembly, not a
    // hand-made pair of messages.
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain('你是一个交互式小说与 TRPG 的主持人（GM）。');
    // The world pin the test fixture recorded (`db/session.test-helpers.ts`) is what the preset's
    // `{worldId}` slot is filled with, so this proves the slot fill ran too.
    expect(system).toContain('test-world');

    // NO USER ROW WAS WRITTEN, and the proof is the WHOLE database rather than the chain: the
    // instruction must not exist as a row anywhere — not as a message, not in a `meta` field.
    // This is the assertion that fails for an implementation that "just sends the text" the
    // ordinary way (`append` omitted), because that path writes it as a user message.
    const rows = await snapshotAllRows(databaseName);
    expect(rows).not.toContain(INSTRUCTION);
    // ...and the scan is not vacuous: the answer IS on disk.
    expect(rows).toContain('开场白');
  });

  it('refuses when the session already has a message, and sends nothing', async () => {
    const sessionId = await openFreshSession();
    const seed = await appendMessage({
      sessionId,
      parentId: null,
      role: 'user',
      content: '已经开始了',
    });
    await setHeadMessageId(sessionId, seed.id);
    const wire = recordingWire();
    await armTheProvider(wire);

    await expect(useChatStore.getState().generateOpening()).resolves.toBe(false);

    expect(wire.calls()).toBe(0);
    expect(await getChain(sessionId)).toHaveLength(1);
  });

  it('leaves the chain empty when the provider refuses, so the choice is still open', async () => {
    const sessionId = await openFreshSession();
    await armTheProvider(recordingWire());
    // The transport answers an error the way a gateway does; the partial-text policy discards
    // the turn, and a failed opening must NOT look like a successful one.
    configureChat({
      transport: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    await expect(useChatStore.getState().generateOpening()).resolves.toBe(false);
    expect(await getChain(sessionId)).toEqual([]);
    expect((await getSession(sessionId))?.headMessageId).toBeNull();
    // The banner says what happened; the store is settled rather than stuck opening/streaming.
    expect(useChatStore.getState().status).toBe('error');
    expect(useChatStore.getState().opening).toBe(false);
  });
});

/* ────────────────── 跳过: no message, and the session still plays ────────────────── */

describe('M1-S3 跳过: the session stays usable with no first message', () => {
  it('writes no row and leaves a null head, and the NEXT turn starts the chain', async () => {
    const sessionId = await openFreshSession();
    expect(await getChain(sessionId)).toEqual([]);
    expect((await getSession(sessionId))?.headMessageId).toBeNull();

    // 跳过 has no store action on purpose: it writes NOTHING, so there is no row that could
    // remember it — the choice belongs to the screen (`play.tsx` stops offering the panel).
    // What this case asserts is the start state it leaves, not a call.
    const wire = recordingWire();
    await armTheProvider(wire);

    await useChatStore.getState().send('我推开门');
    await waitForHead(sessionId);

    const stored = await getChain(sessionId);
    expect(stored).toHaveLength(2);
    const asked = rootOf(stored);
    // THE ACCEPTANCE FOR SKIP: the next turn starts the chain from a `null` head, with
    // `parentId: null` — i.e. a session that never had an opening behaves exactly like one
    // whose opening was the user's own first line.
    expect(asked.role).toBe('user');
    expect(asked.content).toBe('我推开门');
    expect(asked.parentId).toBeNull();
    expect(stored[1]?.parentId).toBe(asked.id);
    expect((await getSession(sessionId))?.headMessageId).toBe(stored[1]?.id);
    // One request, and the opening instruction is NOT part of it: skipping is not a deferred
    // AI opening, it is a session that starts with the user's own first message.
    expect(wire.calls()).toBe(1);
    expect(JSON.stringify(wire.bodies()[0])).not.toContain(INSTRUCTION);
  });
});
