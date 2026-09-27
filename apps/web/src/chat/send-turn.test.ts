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
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, resetDatabase } from '../db/database';
import {
  appendMessage,
  createSession,
  getSession,
  readProviderSettings,
  setHeadMessageId,
  writeProviderSettings,
} from '../db/repository';
import { sendTurn } from './send-turn';

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

beforeEach(() => {
  databases += 1;
  databaseName = `apps-web-send-turn-${databases}`;
  resetDatabase(databaseName);
});

afterEach(async () => {
  // Close the connection, or the delete request below is blocked by it.
  closeDatabase();
  await deleteDatabase(databaseName);
});

/**
 * Every row of every store, as JSON.
 *
 * Read through the RAW IndexedDB API on purpose: the whole point of the invariant-6
 * assertions is that they do not go through the repository's own reader, which could
 * (in principle) be the thing dropping the key. This is what is actually on disk.
 */
async function snapshotAllRows(): Promise<string> {
  const database = await openRaw(databaseName);
  try {
    const names = Array.from(database.objectStoreNames);
    const rows: unknown[] = [];
    for (const name of names) {
      const transaction = database.transaction(name, 'readonly');
      rows.push(...(await request<unknown[]>(transaction.objectStore(name).getAll())));
    }
    return JSON.stringify(rows);
  } finally {
    database.close();
  }
}

function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

function request<T>(source: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result as T);
    source.onerror = () => reject(source.error);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => resolve();
    deletion.onblocked = () => resolve();
  });
}

/** Poll until `predicate` holds. The fake wire records its signal synchronously. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/* ────────────────────────────────── tests ───────────────────────────────── */

describe('sendTurn', () => {
  it('persists the user turn and the assistant turn and advances the head', async () => {
    const session = await createSession();
    const wire = fakeWire(() => sseResponse(['你', '好']));

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '第一句', signal: new AbortController().signal },
    );

    expect(result.error).toBeUndefined();
    expect(result.userMessage.role).toBe('user');
    expect(result.userMessage.content).toBe('第一句');
    expect(result.userMessage.parentId).toBeNull();
    expect(result.assistantMessage?.role).toBe('assistant');
    expect(result.assistantMessage?.content).toBe('你好');
    expect(result.assistantMessage?.parentId).toBe(result.userMessage.id);
    expect(result.assistantMessage?.meta.model).toBe(MODEL);
    expect(result.headMessageId).toBe(result.assistantMessage?.id);
    expect(result.aborted).toBe(false);

    const stored = await getSession(session.id);
    expect(stored?.headMessageId).toBe(result.assistantMessage?.id);
    expect(stored?.refs.modelConfig.model).toBe(MODEL);

    // The request the adapter actually sent: the built-in assembly, and the key in the
    // `Authorization` header only.
    const messages = wire.lastBody()?.messages ?? [];
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toContain('世界：builtin-default');
    expect(messages[1]?.content).toBe('第一句');
    expect(wire.lastAuthorization()).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(wire.lastBody())).not.toContain(API_KEY);
  });

  it('sends the active chain as prior turns on the second turn', async () => {
    const session = await createSession();
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
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[1]?.content).toBe('第一次提问');
    expect(messages[2]?.content).toBe('第一次回答');
    expect(messages[3]?.content).toBe('第二次提问');
  });

  it('keeps the partial text when the stream is aborted, and marks it', async () => {
    const session = await createSession();
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
    expect(await snapshotAllRows()).not.toContain('后面的内容');
    expect((await getSession(session.id))?.headMessageId).toBe(result.headMessageId);
  });

  it('reports each delta as it arrives, so the view can render while the answer streams', async () => {
    const session = await createSession();
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
    const session = await createSession();
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
    expect(result.headMessageId).toBe(result.userMessage.id);
    expect((await getSession(session.id))?.headMessageId).toBe(result.userMessage.id);

    const snapshot = await snapshotAllRows();
    expect(snapshot).toContain('你好');
    expect(snapshot).not.toContain('"role":"assistant"');
  });

  it('reports a rate limit as retryable', async () => {
    const session = await createSession();
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
    const session = await createSession();
    const wire = fakeWire(() => sseResponse(['回答']));

    const result = await sendTurn(
      { config: CONFIG, transport: wire.fetch },
      { sessionId: session.id, text: '问题', signal: new AbortController().signal },
    );

    // (a) Nothing on disk contains the key BEFORE the user saves it: a defaulted
    //     baseUrl/apiKey/model written as a side effect of sending would be the leak
    //     this invariant exists to prevent.
    expect(await snapshotAllRows()).not.toContain(API_KEY);
    // (b) The message metadata — the field the port's own docs call out — is clean.
    expect(JSON.stringify(result.assistantMessage?.meta)).not.toContain(API_KEY);
    expect(JSON.stringify(result.assistantMessage?.extensions ?? {})).not.toContain(API_KEY);
    // (c) Nothing this call returns carries it either.
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    // (d) After the user saves it, it is in the settings row and NOWHERE else. Counting
    //     occurrences is what makes "nowhere else" checkable: exactly one row holds it,
    //     so any second copy anywhere in the database changes the count.
    await writeProviderSettings(CONFIG);
    expect((await readProviderSettings()).apiKey).toBe(API_KEY);
    const rows = await snapshotAllRows();
    expect(rows.split(API_KEY)).toHaveLength(2);
  });

  it('redacts a key the gateway echoes back in its own error body', async () => {
    const session = await createSession();
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
    expect(await snapshotAllRows()).not.toContain(API_KEY);
  });

  it('chains a continuation onto the stored head, including across a branch', async () => {
    const session = await createSession();
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
