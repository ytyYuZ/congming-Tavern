/**
 * @vitest-environment jsdom
 *
 * Tests for the Tauri transport (M0-T8).
 *
 * The fixture-driven tests are the OTHER HALF OF THE CROSS-LANGUAGE DRIFT ALARM:
 * `apps/desktop/src/transport/fixtures/llm-stream-events.json` is read here and by
 * `src-tauri/tests/llm_transport.rs`. If either side changes the event shape, one of
 * the two suites goes red — which is the only mechanism this repo has for keeping a
 * hand-written TypeScript contract and a hand-written Rust enum in agreement.
 *
 * Everything runs against a fake `EventSink`, i.e. no Tauri runtime and no webview:
 * the framing, the header normalisation, the status pass-through and the abort
 * behaviour are all this module's own logic, and all of it is testable in-process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmStreamEvent, LlmStreamRequest } from './events';
import { createTauriFetch, decodeBase64, type EventSink, normalizeHeaders } from './tauri-fetch';

/**
 * `FetchLike` takes a plain `RequestInit`, and `timeoutMs` is this transport's own
 * extension to it (browsers have no request timeout), so a test that exercises the
 * extension has to say so explicitly rather than widening the shared port type with
 * an option the browser build cannot honour.
 */
function initFor(options: {
  method?: string;
  headers?: HeadersInit;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): RequestInit {
  return options as RequestInit;
}

/* ───────────────────────────── the shared fixture ────────────────────────── */

interface Fixture {
  request: LlmStreamRequest;
  events: LlmStreamEvent[];
  expected: { status: number; headers: [string, string][]; text: string } & Record<string, unknown>;
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'llm-stream-events.json'), 'utf8'),
) as Fixture;

/* ───────────────────────────────── the fake ──────────────────────────────── */

/**
 * A backend that replays a fixed list of events, and holds the stream open until
 * `end` arrives so a test can observe an abort mid-stream.
 */
class FakeSink implements EventSink {
  readonly started: LlmStreamRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly pending: Array<{ emit: (raw: unknown) => void; events: unknown[] }> = [];

  /** Queue one exchange: what the backend does when `start` is called. */
  willStream(...events: unknown[]): void {
    this.pending.push({ emit: () => undefined, events });
  }

  async start(request: LlmStreamRequest, onEvent: (event: unknown) => void): Promise<void> {
    this.started.push(request);
    const script = this.pending.shift();
    if (script === undefined) return;
    for (const event of script.events) onEvent(event);
  }

  async cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
  }
}

/** A sink whose `start` never resolves: the stream is live and silent. */
class HoldingSink extends FakeSink {
  private held: ((event: unknown) => void) | undefined;

  override async start(
    request: LlmStreamRequest,
    onEvent: (event: unknown) => void,
  ): Promise<void> {
    this.started.push(request);
    onEvent({ type: 'response', status: 200, headers: [] });
    await new Promise<void>((resolve) => {
      this.held = onEvent;
      void resolve;
    });
  }

  emit(event: unknown): void {
    this.held?.(event);
  }
}

const response = (status = 200, headers: [string, string][] = []): LlmStreamEvent => ({
  type: 'response',
  status,
  headers,
});
const chunk = (text: string): LlmStreamEvent => ({
  type: 'chunk',
  dataBase64: Buffer.from(text, 'utf8').toString('base64'),
});

/* ─────────────────────────── the fixture round trip ──────────────────────── */

describe('the shared fixture', () => {
  it('looks like the desktop transport expects', () => {
    expect(fixture.events.map((event) => event.type)).toEqual([
      'response',
      'chunk',
      'chunk',
      'end',
    ]);
    expect(fixture.request.requestId).toBe('req-fixture-1');
    expect(fixture.request.timeoutMs).toBe(30_000);
  });

  it('turns into a Response with the fixture status, headers and streamed text', async () => {
    const sink = new FakeSink();
    sink.willStream(...fixture.events);
    const fetchLike = createTauriFetch(sink);

    const result = await fetchLike(
      fixture.request.url,
      initFor({
        method: 'post',
        headers: fixture.request.headers,
        body: fixture.request.body,
        timeoutMs: fixture.request.timeoutMs,
      }),
    );

    expect(result.status).toBe(fixture.expected.status);
    for (const [name, value] of fixture.expected.headers) {
      expect(result.headers.get(name)).toBe(value);
    }
    // The whole point: the body is a REAL stream, so a streaming TextDecoder read
    // it as an SSE body would. A 4-byte emoji is split across the two chunks, so
    // per-chunk decoding would produce U+FFFD here.
    const text = await result.text();
    expect(text).toBe(fixture.expected.text);
    expect(text).toContain('🐉');
    expect(text).not.toContain('\uFFFD');
    // And the frame was consumed exactly once: a queue that replayed the last event
    // would have duplicated the body instead of ending it.
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it('forwards the fixture request unchanged except for the id it generates', async () => {
    const sink = new FakeSink();
    sink.willStream(...fixture.events);
    const fetchLike = createTauriFetch(sink);
    await fetchLike(
      fixture.request.url,
      initFor({
        method: fixture.request.method,
        headers: fixture.request.headers,
        body: fixture.request.body,
        timeoutMs: fixture.request.timeoutMs,
      }),
    );

    const sent = sink.started[0];
    expect(sent).toBeDefined();
    expect(sent).toMatchObject({
      url: fixture.request.url,
      method: 'POST',
      headers: fixture.request.headers,
      body: fixture.request.body,
      timeoutMs: 30_000,
    });
    // A fresh id per call, because it is the key `llm_cancel` uses.
    expect(sent?.requestId).not.toBe(fixture.request.requestId);
    expect(sent?.requestId).toMatch(/^st-/);
  });
});

/* ───────────────────────────── status pass-through ───────────────────────── */

describe('status pass-through', () => {
  it('does not throw on 401 and lets the body say why', async () => {
    const sink = new FakeSink();
    sink.willStream(
      response(401, [['content-type', 'application/json']]),
      chunk('{"error":{"code":"invalid_api_key"}}'),
      { type: 'end' },
    );
    const result = await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
    });
    expect(result.status).toBe(401);
    expect(result.ok).toBe(false);
    expect(await result.text()).toContain('invalid_api_key');
  });

  it('keeps Retry-After on a 429 so the adapter can compute retryAfterMs', async () => {
    const sink = new FakeSink();
    sink.willStream(
      response(429, [
        ['content-type', 'application/json'],
        ['retry-after', '3'],
      ]),
      chunk('{"error":{"message":"slow down"}}'),
      { type: 'end' },
    );
    const result = await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
    });
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('3');
    expect(await result.text()).toContain('slow down');
  });

  it('rejects with a TypeError when the transport itself fails', async () => {
    const sink = new FakeSink();
    sink.willStream({
      type: 'error',
      kind: 'network',
      message: 'the provider could not be reached',
    });
    await expect(
      createTauriFetch(sink)('https://api.example.test/v1/chat', { method: 'POST' }),
    ).rejects.toThrow(/network/);
  });

  it('surfaces a malformed event instead of silently dropping it', async () => {
    const sink = new FakeSink();
    sink.willStream({ type: 'chunk' }, { type: 'end' });
    await expect(
      createTauriFetch(sink)('https://api.example.test/v1/chat', { method: 'POST' }),
    ).rejects.toThrow(TypeError);
  });
});

/* ───────────────────────────── header shapes ─────────────────────────────── */

describe('headers', () => {
  it('normalises a Headers instance, an array of pairs and a record identically', async () => {
    const expected: [string, string][] = [
      ['accept', 'text/event-stream'],
      ['authorization', 'Bearer sk-test'],
      ['content-type', 'application/json'],
    ];

    const headers = new Headers();
    headers.set('accept', 'text/event-stream');
    headers.set('authorization', 'Bearer sk-test');
    headers.set('content-type', 'application/json');
    expect(normalizeHeaders(headers)).toEqual(expected);

    expect(
      normalizeHeaders([
        ['accept', 'text/event-stream'],
        ['authorization', 'Bearer sk-test'],
        ['content-type', 'application/json'],
      ]),
    ).toEqual(expected);

    expect(
      normalizeHeaders({
        accept: 'text/event-stream',
        authorization: 'Bearer sk-test',
        'content-type': 'application/json',
      }),
    ).toEqual(expected);

    expect(normalizeHeaders(undefined)).toEqual([]);
  });

  it('keeps a duplicated header name that a record would drop', async () => {
    const sink = new FakeSink();
    sink.willStream(response(200), { type: 'end' });
    await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
      headers: [
        ['x-tag', 'a'],
        ['x-tag', 'b'],
      ],
    });
    expect(sink.started[0]?.headers).toEqual([
      ['x-tag', 'a'],
      ['x-tag', 'b'],
    ]);
  });
});

/* ──────────────────────────────── aborting ───────────────────────────────── */

describe('abort', () => {
  it('rejects before starting when the signal is already aborted', async () => {
    const sink = new FakeSink();
    const fetchLike = createTauriFetch(sink);
    await expect(
      fetchLike('https://api.example.test/v1/chat', {
        method: 'POST',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/abort/i);
    expect(sink.started).toHaveLength(0);
  });

  it('calls cancel and errors the stream with an AbortError when aborted mid-stream', async () => {
    const sink = new HoldingSink();
    const controller = new AbortController();
    const result = await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
      signal: controller.signal,
    });

    const reader = result.body?.getReader();
    const reading = reader?.read();
    controller.abort();

    // The adapter checks `signal.aborted` first, so an abort mid-stream usually
    // ends the iteration quietly — but the stream itself must not hang, and the
    // upstream request must be stopped, because an LLM that keeps generating after
    // the user pressed stop costs the user money.
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(sink.cancelled).toEqual([sink.started[0]?.requestId]);
  });

  it('cancels the upstream request when the consumer stops reading early', async () => {
    const sink = new HoldingSink();
    const result = await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
    });
    await result.body?.cancel();
    expect(sink.cancelled).toHaveLength(1);
  });

  it('treats a cancelled error event as an AbortError', async () => {
    const sink = new FakeSink();
    sink.willStream(response(200), { type: 'chunk', dataBase64: 'aGk=' }, chunk(''), {
      type: 'error',
      kind: 'cancelled',
      message: 'the request was cancelled',
    });
    const result = await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
    });
    await expect(result.text()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/* ──────────────────────────────── base64 ─────────────────────────────────── */

describe('decodeBase64', () => {
  it('decodes the known vectors the Rust encoder is tested against', () => {
    // Compared as BYTES, not as text: RFC 4648 §10's high/low vectors include bytes
    // that are not valid UTF-8 on their own, and a `TextDecoder` would replace them
    // with U+FFFD — which would hide a wrong bit shift behind a wrong decode.
    const vectors: { encoded: string; bytes: number[] }[] = [
      { encoded: '', bytes: [] },
      { encoded: 'Zg==', bytes: [0x66] },
      { encoded: 'Zm8=', bytes: [0x66, 0x6f] },
      { encoded: 'Zm9v', bytes: [0x66, 0x6f, 0x6f] },
      { encoded: 'Zm9vYg==', bytes: [0x66, 0x6f, 0x6f, 0x62] },
      { encoded: 'Zm9vYmE=', bytes: [0x66, 0x6f, 0x6f, 0x62, 0x61] },
      { encoded: 'Zm9vYmFy', bytes: [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72] },
      // RFC 4648 §10, which is where a wrong bit shift shows up rather than a
      // wrong alphabet index. (The last two characters matter: dropping them turns
      // the nine bytes into seven, which is exactly how this vector caught a
      // mistyped expectation.)
      {
        encoded: 'ABCDEFGHIJKL',
        bytes: [0x00, 0x10, 0x83, 0x10, 0x51, 0x87, 0x20, 0x92, 0x8b],
      },
      { encoded: '+/8=', bytes: [0xfb, 0xff] },
      { encoded: '////', bytes: [0xff, 0xff, 0xff] },
      // And the CJK content the app actually sends, as UTF-8 bytes.
      { encoded: '5L2g5aW9', bytes: [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd] },
    ];
    for (const { encoded, bytes } of vectors) {
      expect([...decodeBase64(encoded)]).toEqual(bytes);
    }
    expect(new TextDecoder().decode(decodeBase64('5L2g5aW9'))).toBe('你好');
  });

  it('reassembles a multi-byte character split across two chunks', async () => {
    const bytes = Buffer.from('🐉', 'utf8');
    const head = bytes.subarray(0, 2).toString('base64');
    const tail = bytes.subarray(2).toString('base64');
    const sink = new FakeSink();
    sink.willStream(
      response(200),
      { type: 'chunk', dataBase64: head },
      { type: 'chunk', dataBase64: tail },
      { type: 'end' },
    );
    const result = await createTauriFetch(sink)('https://api.example.test/v1/chat', {
      method: 'POST',
    });
    expect(await result.text()).toBe('🐉');
  });

  it('rejects a chunk that is not base64 at all', () => {
    expect(() => decodeBase64('not base64!')).toThrow(TypeError);
  });
});
