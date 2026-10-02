/**
 * `sendTurn` against the REAL `OpenAICompatibleProvider` over a fake `fetch`
 * (M0-T8 acceptance).
 *
 * WHY THE REAL PROVIDER AND A HAND-WRITTEN SSE BODY
 * A mocked `LLMProvider` would only prove that this file can call a function. Driving
 * the real adapter covers the whole slice the milestone is about: the request body the
 * adapter builds, the SSE parser, the event vocabulary, the persistence and the head
 * pointer. The only thing faked is the socket.
 *
 * `fake-indexeddb/auto` supplies IndexedDB, because Node has none. Every test opens a
 * UNIQUE database name and closes it afterwards, so the order of the file cannot matter
 * and nothing leaks into another file.
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { renderParts } from '@smarttavern/core';
import { createTranslator } from '@smarttavern/i18n';
import type { Message, PromptPreset } from '@smarttavern/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, resetDatabase } from '../db/database';
import { deleteDatabase, snapshotAllRows } from '../db/raw-indexeddb.test-helpers';
import {
  appendMessage,
  getSession,
  listSessions,
  readChain,
  readProviderSettings,
  setHeadMessageId,
  writeProviderSettings,
  writeSessionState,
} from '../db/repository';
// A session as a container, with the pins the create flow would have collected (M1-S1): these
// tests are about the turn, the prompt and the wire, not about session creation.
import { createTestSession as createSession } from '../db/session.test-helpers';
import { PROMPT_BUDGET_CODE } from '../i18n/error-keys';
import { errorSentence } from '../state/chat-store';
import { useLocaleStore } from '../state/locale-store';
import { resetSettingsStore, useSettingsStore } from '../state/settings-store';
import { BUILTIN_BUDGET, BUILTIN_PRESET } from './builtin-content';
import { clockOf, composeTurn, promptContext, promptSlots, worldClockText } from './clock';
import { type SendTurnResult, sendTurn } from './send-turn';

/* ─────────────────────────────── the fake wire ───────────────────────────── */

/**
 * The request the adapter sent, as the shape it actually is.
 *
 * A DECLARED interface and not an index-signature bag on purpose: this workspace
 * compiles with `noPropertyAccessFromIndexSignature` (so `body.messages` is an error on
 * a bag), while Biome flags the literal bracket form. A declared shape satisfies both,
 * and it documents which fields these tests read.
 */
interface WireRequest {
  model?: string;
  messages?: { role: string; content: string; speakerId?: string }[];
}

/** The `fetch` the adapter is given. Records the request so it can be asserted. */
interface FakeWire {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The JSON body of the last request. */
  lastBody: () => WireRequest | undefined;
  /** The `Authorization` header the adapter sent — the ONLY place a key may appear. */
  lastAuthorization: () => string | undefined;
  /** The signal the adapter passed, so a test can abort mid-stream. */
  signal: () => AbortSignal | undefined;
  calls: () => number;
}

function fakeWire(
  respond: (url: string, init: RequestInit, attempt: number) => Response,
): FakeWire {
  let body: WireRequest | undefined;
  let authorization: string | undefined;
  let signal: AbortSignal | undefined;
  let calls = 0;
  return {
    fetch: (url, init) => {
      calls += 1;
      const headers = new Headers(init.headers);
      authorization = headers.get('authorization') ?? undefined;
      signal = init.signal ?? undefined;
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body) as WireRequest;
        } catch {
          body = undefined;
        }
      }
      return Promise.resolve(respond(url, init, calls));
    },
    lastBody: () => body,
    lastAuthorization: () => authorization,
    signal: () => signal,
    calls: () => calls,
  };
}

/**
 * An SSE response carrying `chunks`, then a finish reason, then `[DONE]`.
 *
 * The body is STANDARD SSE, not made-up framing: the provider reads the
 * `content-type: text/event-stream` header and parses `parseSseStream`, so the fake has
 * to speak the wire format or it would be testing nothing.
 */
function sseResponse(chunks: readonly string[], finishReason = 'stop'): Response {
  const encoder = new TextEncoder();
  const payloads = [
    ...chunks.map(
      (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * An SSE body the TEST controls: it delivers the FIRST chunk and then WAITS.
 *
 * Needed because a fully enqueued body drains in microtasks — faster than any test can
 * abort it — which makes an abort test flaky in a way that looks like a bug in
 * `sendTurn`. Here the abort lands while the body is genuinely still open, so "the text
 * that had arrived is what got persisted" is a real observation and not a race.
 *
 * The remaining entries of the list are the chunks that must NEVER be delivered; the
 * test names them so it can assert they are absent from the database afterwards.
 */
function controlledSseResponse([first = '']: readonly string[]) {
  const encoder = new TextEncoder();
  const event = (text: string): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let aborted = false;

  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        next.enqueue(event(first));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

  return {
    response,
    /**
     * Make the body honour `init.signal`, which `FetchLike` REQUIRES of any transport.
     * A real fetch errors the body stream on abort; without that, the provider is left
     * awaiting a read that never resolves and the app would hang forever on 「停止」.
     * That is a contract of the port, so the fake has to hold it too.
     *
     * There is deliberately no `release()`: the body ERRORS on abort, so the remaining
     * chunks never arrive — which is exactly what the test below asserts.
     */
    honour(signal: AbortSignal): void {
      signal.addEventListener('abort', () => {
        if (aborted || controller === undefined) return;
        aborted = true;
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // Already closed; nothing to do.
        }
      });
    },
  };
}

/** A non-streaming failure, the shape a real gateway answers with. */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* ──────────────────────────────── fixtures ──────────────────────────────── */

const API_KEY = 'sk-must-never-appear-1234567890';
const BASE_URL = 'https://gateway.test/v1';
const MODEL = 'test-model-1';

const CONFIG = { baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL };

let databases = 0;
let databaseName = '';

/** The passphrase the invariant-6 suite seals the row with; never persisted anywhere. */
const PASSPHRASE = 'a-good-passphrase';

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-send-turn-${databases}`;
  resetDatabase(databaseName);
  // The tab's unlocked key lives outside the store (`secrets/provider-secret.ts`), so it has
  // to be forgotten between cases or one test's unlock would be the next one's starting state.
  resetSettingsStore();
  // The prompt's own clock block is assembled by the engine and carries no locale,
  // but the error sentences this file asserts DO come from the catalog. Pinning the
  // language makes the assertions independent of whatever the host browser reports,
  // the same thing `routes.test.tsx` does by writing the stored row.
  useLocaleStore.setState({ locale: 'zh-CN', ready: true });
});

afterEach(async () => {
  resetSettingsStore();
  // Close the connection, or the delete request below is blocked by it.
  closeDatabase();
  await deleteDatabase(databaseName);
});

/**
 * Every row of every store, as JSON — through the RAW IndexedDB API on purpose
 * (`db/raw-indexeddb.test-helpers.ts` holds the implementation and the argument): the whole
 * point of the invariant-6 assertions is that they do not go through the repository's own
 * reader, which could (in principle) be the thing dropping the key. That helper is shared
 * with `secrets/provider-secret.test.ts`, so the two suites cannot disagree about what "on
 * disk" means.
 */

/* ────────────────────────────────── tests ───────────────────────────────── */

/** Poll until `predicate` holds. The fake wire records its signal synchronously. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/* ────────────────────────────────── tests ───────────────────────────────── */

/**
 * The user row an ORDINARY turn wrote, narrowed once.
 *
 * `SendTurnResult.userMessage` became `Message | undefined` in M1-S2: a regeneration and a
 * continuation re-ask a question already in the chain, so those turns write no user row.
 * An ordinary turn always writes one — that is a fact about the CALL, not about the type —
 * so the fact is stated here, once, instead of a `?.` at every field assertion (which would
 * silently compare `undefined` against the expected value and could not fail).
 */
function userRow(result: SendTurnResult): Message {
  const message = result.userMessage;
  if (message === undefined) throw new Error('the turn wrote no user row');
  return message;
}

describe('sendTurn', () => {
  it('persists the user turn and the assistant turn and advances the head', async () => {
    const session = await createSession({ title: 'test-session' });
    const wire = fakeWire(() => sseResponse(['你', '好']));

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );

    expect(result.error).toBeUndefined();
    expect(userRow(result).role).toBe('user');
    expect(userRow(result).content).toBe('第一句');
    expect(userRow(result).parentId).toBeNull();
    expect(result.assistantMessage?.role).toBe('assistant');
    expect(result.assistantMessage?.content).toBe('你好');
    expect(result.assistantMessage?.parentId).toBe(userRow(result).id);
    expect(result.assistantMessage?.meta.model).toBe(MODEL);
    expect(result.headMessageId).toBe(result.assistantMessage?.id);
    expect(result.aborted).toBe(false);

    const stored = await getSession(session.id);
    expect(stored?.headMessageId).toBe(result.assistantMessage?.id);
    expect(stored?.refs.modelConfig.model).toBe(MODEL);

    // The request the adapter actually sent: the built-in assembly, and the key in the
    // `Authorization` header only. The shape is asserted RELATIVE TO THE END and the
    // block count is derived from the preset, so adding a block to the built-in content
    // is a data edit rather than a test edit — while "the input comes last and the
    // preset's system blocks come first" stays pinned.
    const messages = wire.lastBody()?.messages ?? [];
    const systemBlocks = BUILTIN_PRESET.blocks.filter(
      (block) => block.enabled && block.position === 'pre_history',
    ).length;
    expect(messages).toHaveLength(systemBlocks + 1);
    expect(messages.slice(0, systemBlocks).map((message) => message.role)).toEqual(
      Array.from({ length: systemBlocks }, () => 'system'),
    );
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toBe('第一句');
    expect(messages[0]?.content).toContain('世界：test-world');
    expect(wire.lastAuthorization()).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(wire.lastBody())).not.toContain(API_KEY);
  });

  it('sends the active chain as prior turns on the second turn', async () => {
    const session = await createSession({ title: 'test-session' });
    await sendTurn(
      { config: CONFIG, transport: fakeWire(() => sseResponse(['第一次回答'])).fetch },
      { sessionId: session.id, text: '第一次提问', signal: new AbortController().signal },
    );

    const wire = fakeWire(() => sseResponse(['第二次回答']));
    await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '第二次提问', signal: new AbortController().signal },
    );

    const messages = wire.lastBody()?.messages ?? [];
    // Same relative shape: system blocks first, then the ACTIVE CHAIN, then this turn's
    // input. Naming the messages by role+content is what keeps this readable once the
    // preset contributes more than one system block.
    const systemBlocks = BUILTIN_PRESET.blocks.filter(
      (block) => block.enabled && block.position === 'pre_history',
    ).length;
    const tail = messages.slice(systemBlocks);
    expect(tail.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:第一次提问',
      'assistant:第一次回答',
      'user:第二次提问',
    ]);
  });

  it('keeps the partial text when the stream is aborted, and marks it', async () => {
    const session = await createSession({ title: 'test-session' });
    const body = controlledSseResponse(['部分回答', '后面的内容']);
    const wire = fakeWire(() => body.response);

    const controller = new AbortController();
    const pending = sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '写一半就好', signal: controller.signal },
    );
    // Abort AFTER the request is out and after the first chunk has been delivered: a
    // signal that is already aborted would send nothing at all, which is a different
    // behaviour from the one under test.
    await waitFor(() => wire.signal() !== undefined);
    const signal = wire.signal();
    if (signal !== undefined) body.honour(signal);
    // Let the first chunk reach the accumulator before the abort lands.
    await Promise.resolve();
    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.error).toBeUndefined();
    // The policy under test: an abort KEEPS what arrived — a user stop and a `length`
    // stop are the same fact (the model answered), unlike an `error` event, which
    // discards. Everything after the abort must be absent.
    expect(result.assistantMessage?.content).toBe('部分回答');
    expect(result.assistantMessage?.extensions?.['x-aborted']).toBe(true);
    expect(result.headMessageId).toBe(result.assistantMessage?.id);
    expect(await snapshotAllRows(databaseName)).not.toContain('后面的内容');
    expect((await getSession(session.id))?.headMessageId).toBe(result.headMessageId);
  });

  it('reports each delta as it arrives, so the view can render while the answer streams', async () => {
    const session = await createSession({ title: 'test-session' });
    const wire = fakeWire(() => sseResponse(['你', '好', '呀']));
    const seen: string[] = [];

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch, onDelta: (text) => seen.push(text) },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );

    // One call per delta, each carrying the text SO FAR — that running text is what the
    // transcript bubble shows before the row exists.
    expect(seen).toEqual(['你', '你好', '你好呀']);
    expect(result.assistantMessage?.content).toBe('你好呀');
  });

  it('reports an error event and writes NO orphan assistant row', async () => {
    const session = await createSession({ title: 'test-session' });
    const wire = fakeWire(() =>
      errorResponse(401, 'invalid_api_key', 'Incorrect API key provided: sk-must-never'),
    );

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '你好', signal: new AbortController().signal },
    );

    expect(result.error?.code).toBe('auth');
    expect(result.error?.retryable).toBe(false);
    expect(result.assistantMessage).toBeUndefined();
    expect(result.headMessageId).toBe(userRow(result).id);
    expect((await getSession(session.id))?.headMessageId).toBe(userRow(result).id);

    const snapshot = await snapshotAllRows(databaseName);
    expect(snapshot).toContain('你好');
    expect(snapshot).not.toContain('"role":"assistant"');
  });

  it('reports a rate limit as retryable', async () => {
    const session = await createSession({ title: 'test-session' });
    const wire = fakeWire(() =>
      errorResponse(429, 'rate_limit_exceeded', 'Rate limit reached for test-model-1'),
    );

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '你好', signal: new AbortController().signal },
    );

    expect(result.error?.code).toBe('rate_limit');
    expect(result.error?.retryable).toBe(true);
    expect(result.assistantMessage).toBeUndefined();
  });

  it('never puts the API key in a persisted row, an error, or a message meta (invariant 6)', async () => {
    const session = await createSession({ title: 'test-session' });
    const wire = fakeWire(() => sseResponse(['回答']));

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '问题', signal: new AbortController().signal },
    );

    // (a) Nothing on disk contains the key BEFORE the user saves it: a defaulted
    //     baseUrl/apiKey/model written as a side effect of sending would be the leak
    //     this invariant exists to prevent.
    expect(await snapshotAllRows(databaseName)).not.toContain(API_KEY);
    // (b) The message metadata — the field the port's own docs call out — is clean.
    expect(JSON.stringify(result.assistantMessage?.meta)).not.toContain(API_KEY);
    expect(JSON.stringify(result.assistantMessage?.extensions ?? {})).not.toContain(API_KEY);
    // (c) Nothing this call returns carries it either.
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    // (d) After the user saves it, it is in the settings row and NOWHERE else. Counting
    //     occurrences is what makes "nowhere else" checkable: exactly one row holds it,
    //     so any second copy anywhere in the database changes the count. (M1-G3 seals the
    //     same row with WebCrypto; the plaintext form is the documented fallback and the
    //     encrypted form is proven in `secrets/provider-secret.test.ts`.)
    await writeProviderSettings({
      baseUrl: CONFIG.baseUrl,
      model: CONFIG.model,
      secret: { kind: 'plaintext', apiKey: CONFIG.apiKey },
    });
    expect((await readProviderSettings()).secret).toEqual({
      kind: 'plaintext',
      apiKey: API_KEY,
    });
    const rows = await snapshotAllRows(databaseName);
    expect(rows.split(API_KEY)).toHaveLength(2);
  });

  it('redacts a key the gateway echoes back in its own error body', async () => {
    const session = await createSession({ title: 'test-session' });
    // A gateway returning our own Authorization header inside its error text is the one
    // documented leak path (openai-compatible.ts) — and the adapter must redact it.
    const wire = fakeWire(() => errorResponse(403, 'forbidden', `Bearer ${API_KEY} denied`));

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '你好', signal: new AbortController().signal },
    );

    expect(result.error?.code).toBe('auth');
    expect(result.error?.message).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(await snapshotAllRows(databaseName)).not.toContain(API_KEY);
  });

  it('chains a continuation onto the stored head, including across a branch', async () => {
    const session = await createSession({ title: 'test-session' });
    const root = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: '起点',
    });
    const discarded = await appendMessage({
      sessionId: session.id,
      parentId: root.id,
      role: 'assistant',
      content: '被放弃的分支',
    });
    const kept = await appendMessage({
      sessionId: session.id,
      parentId: root.id,
      role: 'assistant',
      content: '保留的分支',
    });
    await setHeadMessageId(session.id, kept.id);
    expect(discarded.id).not.toBe(kept.id);

    const wire = fakeWire(() => sseResponse(['续写']));
    await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '继续', signal: new AbortController().signal },
    );

    // The assembly must quote the ACTIVE branch only: a discarded sibling has to stay
    // out of the prompt, which is what walking `parentId` from the head buys.
    const contents = JSON.stringify(wire.lastBody()?.messages);
    expect(contents).toContain('保留的分支');
    expect(contents).not.toContain('被放弃的分支');
  });
});

/* ─────────────── the two engines, actually wired into the app (M1) ────────────── */

/**
 * The app used to hand-assemble its wire messages (`chat/prompt.ts`, deleted). These
 * four assertions are what makes the replacement real rather than merely compiled:
 * the `TimeEngine`'s reading reaches the prompt, the `PromptComposer`'s slot fill
 * leaves nothing unresolved, its over-budget branch REFUSES the turn instead of
 * sending it, and the clock sentence follows the catalog while the world's own names
 * do not (ADR-030's line between UI copy and content).
 */
describe('the engines are wired in', () => {
  /**
   * WHY THE EXPECTED VALUE IS THE EMPTY LIST: the composer keeps an unknown `{{...}}`
   * VERBATIM (`engine/prompt/macros.ts`, deliberately), so a slot the app forgot to
   * fill does not render as a blank — it ships a literal token to the model, and the
   * model is asked about it. Every macro in the built-in content is either real
   * (`{{date}}`, `{{time}}`, `{{segment}}`) or was supposed to be gone by this point,
   * so "no unresolved macros" is the only correct reading.
   */
  it('leaves no unresolved macro in the built-in prompt', async () => {
    const session = await createSession({ title: 'macro-session' });
    const composed = composeTurn(
      BUILTIN_PRESET,
      promptContext(session, [], '第一句', clockOf(session)),
      BUILTIN_BUDGET,
      promptSlots(session),
    );

    expect(composed.unresolvedMacros).toEqual([]);
    expect(composed.ok).toBe(true);
  });

  /**
   * M1-T3, end to end: the world clock is in the request the adapter actually sends.
   *
   * `renderParts` is the engine's own data half, so on its own this would be circular
   * (it would only prove the app can call the engine twice). The literals beside it are
   * what make it a test: minute 0 of the built-in calendar is inside `晨` (0–6,
   * `builtin-content.ts`), and the session's world pin is `test-world`
   * (`db/session.test-helpers.ts`, the pins a test session carries). A reader can check
   * both against the fixture.
   */
  it('puts the world clock into the request the adapter sends (M1-T3)', async () => {
    const session = await createSession({ title: 'clock-session' });
    const wire = fakeWire(() => sseResponse(['好']));

    await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );

    const system = (wire.lastBody()?.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain(renderParts(clockOf(session)));
    expect(system).toContain('晨');
    expect(system).toContain('test-world');
  });

  /**
   * The over-budget turn is REFUSED, and `wire.calls() === 0` is the assertion that
   * matters: the composer's failure branch exists so that an over-budget request never
   * leaves the device — a vendor rejects it anyway, so the round trip buys nothing and
   * costs an error the user cannot act on. History is deliberately NOT a trim
   * candidate (that is the MemoryManager's job), so one huge stored turn is enough to
   * exhaust the budget with only `required` blocks left, and the error carries the
   * numbers the banner needs.
   */
  it('refuses an over-budget turn instead of sending it', async () => {
    const session = await createSession({ title: 'budget-session' });
    const root = await appendMessage({
      sessionId: session.id,
      parentId: null,
      role: 'user',
      content: 'x'.repeat(40_000),
    });
    await setHeadMessageId(session.id, root.id);

    const wire = fakeWire(() => sseResponse(['好']));
    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '第二句', signal: new AbortController().signal },
    );

    expect(result.error?.code).toBe(PROMPT_BUDGET_CODE);
    expect(wire.calls()).toBe(0);
  });

  /**
   * The clock SENTENCE: the words around the reading come from the catalog, the world's
   * own month and day-part names do not. Asserting the same clock in both locales is
   * the cheapest way to pin ADR-030's line — if someone later "fixes" the missing
   * translation of `晨` by routing it through `t(...)`, the English row changes and
   * this fails.
   */
  it('translates the clock around the reading, not the reading itself', async () => {
    const session = await createSession({ title: 'clock-text-session' });
    const reading = clockOf(session);
    const date = renderParts(reading);

    expect(worldClockText(reading, createTranslator('zh-CN').t)).toBe(`当前 ${date}（晨）`);
    expect(worldClockText(reading, createTranslator('en').t)).toBe(`Now ${date} (晨)`);
  });
});

/* ─────────────────── M1-S6: the session variables, end to end ─────────────────── */

/**
 * WHY THE PRESET IS OVERRIDDEN HERE
 * The built-in content contains no `{{getvar}}` and no write directive (it is the app's
 * shipped default, `chat/builtin-content.ts`), so the only way to drive the variable path
 * through a REAL turn is the documented `preset` seam. These tests are therefore about the
 * app's wiring — `promptContext` passing `session.state.vars` and `sendTurn` persisting the
 * composer's change log — not about the macro engine, which has its own tests in
 * `packages/core`.
 */
describe('M1-S6: variables through a turn', () => {
  /** A one-block preset, so the assembled prompt is exactly the content under test. */
  function presetWith(content: string): PromptPreset {
    return {
      id: 'test-vars-preset',
      name: 'test',
      version: 1,
      blocks: [
        {
          id: 'test-vars-block',
          name: 'test',
          role: 'system',
          content,
          enabled: true,
          position: 'pre_history',
          order: 0,
          budget: { priority: 'required' },
        },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
  }

  /** Every `system` message of the last request, joined — what the model was told. */
  function systemOf(wire: FakeWire): string {
    return (wire.lastBody()?.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
  }

  it('reads the session variables a getvar asks for, and leaves an undefined one verbatim', async () => {
    const session = await createSession({ title: 'vars-session' });
    await writeSessionState(session.id, {
      ...session.state,
      vars: { hp: 12, weather: 'snow' },
    });

    const wire = fakeWire(() => sseResponse(['好']));
    await sendTurn(
      {
        config: CONFIG,
        transport: wire.fetch,
        preset: presetWith('hp={{getvar::hp}} weather={{getvar::weather}} x={{getvar::missing}}'),
      },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );

    // The VALUE the session row holds is in the request. This is the assertion that makes
    // `promptContext`'s `variables: session.state.vars` real: an empty object would leave
    // the token unresolved instead.
    const system = systemOf(wire);
    expect(system).toContain('hp=12');
    expect(system).toContain('weather=snow');
    // An undefined variable stays VERBATIM (ADR-031): silently substituting '' would delete a
    // sentence fragment and nobody would notice.
    expect(system).toContain('x={{getvar::missing}}');
  });

  it('persists the composer’s setvar log, and the next turn reads the written value', async () => {
    const session = await createSession({ title: 'setvar-session' });

    const first = fakeWire(() => sseResponse(['好']));
    await sendTurn(
      {
        config: CONFIG,
        transport: first.fetch,
        preset: presetWith('{{setvar::hp::7}}'),
      },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );

    // The directive is not text: the block expands to an empty string...
    expect(systemOf(first)).toBe('');
    // ...and the change the composer RECORDED is a persisted row. It is the STRING "7"
    // because a macro substitutes into text; the typed NUMBER is the status bar's to write.
    expect((await getSession(session.id))?.state.vars).toEqual({ hp: '7' });

    // The next turn reads what the previous one wrote — the loop ADR-031's contract implies.
    const second = fakeWire(() => sseResponse(['好']));
    await sendTurn(
      { config: CONFIG, transport: second.fetch, preset: presetWith('hp={{getvar::hp}}') },
      { sessionId: session.id, text: '第二句', signal: new AbortController().signal },
    );
    expect(systemOf(second)).toContain('hp=7');
    // No second change was recorded, so the row still holds exactly the one variable.
    expect((await getSession(session.id))?.state.vars).toEqual({ hp: '7' });
  });
});

/* ───────────────── the four surfaces the key must never reach (M1-G3) ───────────────── */

/**
 * HANDOFF §4.1 invariant 6, as four assertions rather than one sentence.
 *
 * The single test above proves the key stays out of the ROWS a turn writes. M1-G3 widens the
 * surface — the key now has a passphrase, a ciphertext and an unlock session — so each way it
 * could escape is checked where it could escape:
 *   (a) an exported `.stpack`
 *   (b) a log
 *   (c) `Message.meta`
 *   (d) user-facing error text, including a gateway that echoes the key back
 *
 * WHY (a) IS PROVEN AT THE SOURCE, AND WHAT THAT DOES AND DOES NOT COVER
 * `apps/web` declares no dependency on `@smarttavern/importers` (there is no workspace link for
 * it), so this file cannot run the exporter. The export side is therefore proven where the
 * exporter lives — `packages/importers/src/export-secrets.test.ts` shows that `settings` and
 * `providers` are never opened by an export at all — and the APP side is proven here, one level
 * upstream: an export can only copy bytes that are in the database, so the assertion is that
 * after the Web-side migration the plaintext key exists in NO row of ANY collection. That is
 * strictly stronger than checking the exporter's own collection list, and it needs no import.
 */
describe('invariant 6: the key cannot reach an export, a log, a meta or an error text', () => {
  /** One stored turn, so the assertions below run against a database that has content. */
  async function runOneTurn(): Promise<void> {
    const session = await createSession({ title: 'invariant-6' });
    const wire = fakeWire(() => sseResponse(['回答']));
    await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '问题', signal: new AbortController().signal },
    );
  }

  it('(a) leaves no plaintext for an exported package to copy, once the row is sealed', async () => {
    await runOneTurn();

    // The documented fallback first (M0's row): the key IS on disk in the clear, exactly once —
    // in the one row an exporter never reads — and nowhere else.
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });
    expect((await snapshotAllRows(databaseName)).split(API_KEY)).toHaveLength(2);

    // Now seal it: the number of copies drops to zero, in every collection, in every field.
    await useSettingsStore.getState().load();
    await expect(useSettingsStore.getState().encryptStored(PASSPHRASE)).resolves.toBeUndefined();

    const onDisk = await snapshotAllRows(databaseName);
    expect(onDisk.split(API_KEY)).toHaveLength(1);
    // ...and the scan is not vacuous: the database has the endpoint, the transcript and the
    // ciphertext of the key that was just sealed, so "the key is absent" means the key, not an
    // empty database.
    expect(onDisk).toContain(BASE_URL);
    expect(onDisk).toContain('回答');
    const sealed = await readProviderSettings();
    if (sealed.secret.kind !== 'encrypted') throw new Error('the key was not sealed');
    expect(onDisk).toContain(sealed.secret.envelope.ciphertext);
  });

  it('(b) writes the key to no console, through a turn, a seal and a failed unlock', async () => {
    // The app logs nothing today, so this guards the FIELDS a future log line would carry
    // (an error's message, a rejected promise, a store label) rather than a statement that
    // exists. `mock` rather than a re-implementation so the real console calls are captured.
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      // The gateway quotes our own Authorization header in its error body — the one documented
      // leak path (`openai-compatible.ts`) — and the log-side field is what it seeds.
      const session = await createSession({ title: 'log-surface' });
      const wire = fakeWire(() => errorResponse(403, 'forbidden', `Bearer ${API_KEY} denied`));
      const result = await sendTurn(
        { config: CONFIG, transport: wire.fetch },
        { sessionId: session.id, text: '问题', signal: new AbortController().signal },
      );

      await writeProviderSettings({
        baseUrl: BASE_URL,
        model: MODEL,
        secret: { kind: 'plaintext', apiKey: API_KEY },
      });
      await useSettingsStore.getState().load();
      await useSettingsStore.getState().encryptStored(PASSPHRASE);
      useSettingsStore.getState().lock();
      // A wrong passphrase is the failure path most likely to quote its input in a message.
      await expect(useSettingsStore.getState().unlock('wrong passphrase')).resolves.toBe(
        'wrong-passphrase',
      );

      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => JSON.stringify(call))
        .join('\n');
      expect(logged).not.toContain(API_KEY);
      expect(logged).not.toContain(PASSPHRASE);
      // The redaction is real, not a consequence of silence: this is the sentence that WOULD be
      // logged (ADR-019 keeps `message` for logs), and the adapter already stripped the echo.
      expect(result.error?.message).toBeDefined();
      expect(result.error?.message).not.toContain(API_KEY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('(c) keeps the key out of Message.meta and extensions, sealed or not', async () => {
    await runOneTurn();
    await writeProviderSettings({
      baseUrl: BASE_URL,
      model: MODEL,
      secret: { kind: 'plaintext', apiKey: API_KEY },
    });
    await useSettingsStore.getState().load();
    await useSettingsStore.getState().encryptStored(PASSPHRASE);

    const chain = await readChain((await listSessions())[0]?.id ?? '');
    expect(chain).toHaveLength(2);
    for (const message of chain) {
      expect(JSON.stringify(message.meta)).not.toContain(API_KEY);
      expect(JSON.stringify(message.extensions ?? {})).not.toContain(API_KEY);
    }
    // The metadata is populated with the model id, so "the key is absent" is not "the object is
    // empty" — the assistant row is the one whose `meta.model` the debug panel reads.
    const assistant = chain[1];
    expect(assistant?.meta.model).toBe(MODEL);
  });

  it('(d) shows the catalog sentence, never the vendor text that quoted the key', async () => {
    const session = await createSession({ title: 'error-surface' });
    const wire = fakeWire(() => errorResponse(403, 'forbidden', `Bearer ${API_KEY} denied`));

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '问题', signal: new AbortController().signal },
    );

    expect(result.error?.code).toBe('auth');
    // The provider's prose is redacted for logs, and the sentence a person reads comes from the
    // catalog by code (ADR-019) — neither carries the key, and neither can: the sentence is
    // selected from a fixed table.
    expect(result.error?.message).not.toContain(API_KEY);
    const shown = errorSentence({ code: result.error?.code ?? 'unknown' });
    expect(shown).toContain('API Key');
    expect(shown).not.toContain(API_KEY);
    expect(await snapshotAllRows(databaseName)).not.toContain(API_KEY);
  });
});
