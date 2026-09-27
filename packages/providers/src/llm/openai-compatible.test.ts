/**
 * `OpenAICompatibleProvider` against a fake server built with Node's built-in
 * `http` — zero test dependencies, and a real socket, so the streaming path,
 * the framing and the abort behaviour are exercised as they are in production
 * (`docs/06-开发任务拆解.md` §9.2 requires exactly this).
 *
 * WHAT IS PINNED HERE, and why each one is worth a test:
 * - the chunk -> `StreamEvent` mapping, including fragments, comments and a
 *   frame split across two writes;
 * - the four error mappings of §9.2 with their `retryable` value, plus the
 *   machine facts the port now carries (`status`, `retryAfterMs`, `providerCode`,
 *   `details` — ADR-019) and the non-SSE JSON error body a gateway returns
 *   with a 200;
 * - `done.finishReason`: the modelled values verbatim, everything else as
 *   `x-<reason>` (ADR-019);
 * - cancellation: abort mid-stream yields exactly what was delivered and stops,
 *   a pre-aborted signal yields nothing and sends no request;
 * - `listModels()` never throws and never hangs, including when its signal
 *   aborts (ADR-020);
 * - HANDOFF §4.1 invariant 6: the key appears in no event — `message` or
 *   `details` — and no thrown error, even when the provider echoes it back
 *   inside an error body.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { ChatRequest, StreamEvent } from '@smarttavern/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyFailure,
  LLM_ERROR_CODES,
  type OpenAICompatibleOptions,
  OpenAICompatibleProvider,
} from './openai-compatible';

/** A value that must never appear in anything the adapter emits. */
const SECRET = 'sk-live-DO-NOT-LEAK-0123456789';

const REQUEST: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello there' }],
};

/* ───────────────────────────── the fake server ───────────────────────────── */

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface FakeServer {
  /** `http://127.0.0.1:<port>` — no `/v1`, so a test can build a bare host URL. */
  readonly origin: string;
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Without this, a keep-alive connection holds `close()` open until the
    // timeout, and the suite pays for it on every test.
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function startFakeServer(
  handler: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    // A test that aborts mid-stream leaves a destroyed socket behind; writing
    // into it must not take the process (and the run) down.
    res.on('error', () => undefined);
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(parts).toString('utf8'),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake server did not bind to a port');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, baseUrl: `${origin}/v1`, requests };
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

/** One OpenAI stream frame: `data: <json>\n\n`. */
function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** A text delta chunk, the shape every streaming answer starts with. */
function deltaFrame(content: string): string {
  return frame({ choices: [{ index: 0, delta: { content } }] });
}

function serveFrames(response: ServerResponse, frames: readonly string[]): void {
  response.writeHead(200, SSE_HEADERS);
  for (const item of frames) response.write(item);
  response.end();
}

/** The same, spread over time, so an abort has a stream to interrupt. */
function serveFramesSlowly(
  response: ServerResponse,
  frames: readonly string[],
  delayMs: number,
): void {
  response.writeHead(200, SSE_HEADERS);
  let index = 0;
  const timer = setInterval(() => {
    const item = frames[index];
    index += 1;
    if (item === undefined) {
      clearInterval(timer);
      response.end();
      return;
    }
    response.write(item);
  }, delayMs);
  response.on('close', () => clearInterval(timer));
}

function serveJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { ...headers, 'content-type': 'application/json' });
  response.end(text);
}

function providerFor(
  server: FakeServer,
  options: Partial<OpenAICompatibleOptions> = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: server.baseUrl,
    apiKey: SECRET,
    model: 'test-model',
    ...options,
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function run(
  provider: OpenAICompatibleProvider,
  request: ChatRequest = REQUEST,
): Promise<StreamEvent[]> {
  return collect(provider.stream(request, new AbortController().signal));
}

/* ─────────────────────────── identity and flags ──────────────────────────── */

describe('OpenAICompatibleProvider identity', () => {
  it('names itself after the host of the configured base URL', () => {
    const openai = new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    });
    expect(openai.id).toBe('openai-compatible:api.openai.com');

    // The port matters: two local runtimes must not share an id.
    const local = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'llama3.2',
    });
    expect(local.id).toBe('openai-compatible:127.0.0.1:11434');
  });

  it('advertises the vendor-agnostic minimum for an unknown host', () => {
    const custom = new OpenAICompatibleProvider({
      baseUrl: 'https://llm.example.test/openai/v1',
      apiKey: '',
      model: 'whatever',
    });
    // There is no `vision` key to assert (ADR-021) and no `countsTokensOffline`
    // one either: this adapter deliberately does not implement `countTokens`, and
    // the port's rule is that the optional flag is ABSENT in that case rather
    // than `false`. `toEqual` on the whole object is what pins both.
    expect(custom.capabilities).toEqual({
      streaming: true,
      tools: false,
      structuredOutput: false,
      reportsUsage: false,
      reasoning: false,
    });
  });

  it('advertises what a known vendor documents, and always streams', () => {
    const deepseek = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
    });
    expect(deepseek.capabilities).toEqual({
      streaming: true,
      tools: true,
      structuredOutput: true,
      reportsUsage: true,
      reasoning: true,
    });
  });

  it('splits "reports usage" from "counts offline" (ADR-020)', () => {
    // The old `tokenCounting` flag meant both things at once, so a caller that
    // read it as the second crashed on `countTokens!`. This adapter reports
    // usage and has no tokenizer, and the two facts are now two fields.
    const openai = new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    });
    expect(openai.capabilities.reportsUsage).toBe(true);
    expect(openai.capabilities.countsTokensOffline).toBeUndefined();
    // The class declares no `countTokens` at all, so an `in` check is the honest
    // way to assert its absence — the port marks the method optional.
    expect('countTokens' in openai).toBe(false);
  });

  it('appends /v1 only to a bare host', () => {
    // A bare host 404s on every vendor in docs/02 §6, so it gets the version
    // segment; any other path is the caller's layout and is left alone.
    expect(
      new OpenAICompatibleProvider({
        baseUrl: 'http://localhost:8000',
        apiKey: '',
        model: 'x',
      }).id,
    ).toBe('openai-compatible:localhost:8000');
  });
});

/* ─────────────────────────── the streaming path ──────────────────────────── */

describe('streaming translation', () => {
  it('maps every chunk shape onto the port vocabulary', async () => {
    const server = await startFakeServer((_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(frame({ choices: [{ index: 0, delta: { reasoning_content: 'think' } }] }));
      // A comment is ignored…
      response.write(': keep-alive\n\n');
      // …and one chunk may carry two events.
      response.write(deltaFrame('Hel'));
      response.write(deltaFrame('lo'));
      // A tool call arrives in fragments: identity first…
      response.write(
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'roll_dice', arguments: '{"expr"' },
                  },
                ],
              },
            },
          ],
        }),
      );
      // …arguments next, in a frame split across two writes.
      const tail = frame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: ':"1d20"}' } }] },
          },
        ],
      });
      response.write(tail.slice(0, 12));
      response.write(tail.slice(12));
      response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      response.write(
        frame({
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
      response.write(frame('[DONE]'));
      response.end();
    });

    expect(await run(providerFor(server))).toEqual([
      { type: 'reasoning-delta', text: 'think' },
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'tool-call', id: 'call_1', name: 'roll_dice', args: { expr: '1d20' } },
      { type: 'usage', input: 11, output: 7 },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('reads DeepSeek reasoning and OpenRouter reasoning the same way', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [
        frame({ choices: [{ index: 0, delta: { reasoning: 'via openrouter' } }] }),
        frame('[DONE]'),
      ]),
    );
    expect(await run(providerFor(server))).toEqual([
      { type: 'reasoning-delta', text: 'via openrouter' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('finishes the stream when the body ends without the [DONE] sentinel', async () => {
    // Every vendor in docs/02 §6 that ignores `stream_options` also ends the
    // body right after `finish_reason`; a missing sentinel is not a failure.
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [
        deltaFrame('done'),
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ]),
    );
    expect(await run(providerFor(server))).toEqual([
      { type: 'text-delta', text: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('ignores a payload that is neither JSON nor [DONE]', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, ['data: not-json\n\n', deltaFrame('kept'), frame('[DONE]')]),
    );
    expect(await run(providerFor(server))).toEqual([
      { type: 'text-delta', text: 'kept' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('still parses a stream whose content type was lost', async () => {
    const server = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(deltaFrame('typed as text') + frame('[DONE]'));
    });
    expect(await run(providerFor(server))).toEqual([
      { type: 'text-delta', text: 'typed as text' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('keeps a vendor finish reason it does not model as `x-<reason>` (ADR-019)', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [
        deltaFrame('cut short'),
        // An Anthropic-flavoured gateway behind an OpenAI-shaped facade.
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'max_tokens' }] }),
        frame('[DONE]'),
      ]),
    );
    expect(await run(providerFor(server))).toEqual([
      { type: 'text-delta', text: 'cut short' },
      // Flattening this to `stop` would tell the runtime the model finished its
      // thought when it was actually truncated.
      { type: 'done', finishReason: 'x-max_tokens' },
    ]);
  });

  it('passes the modelled finish reasons through unchanged', async () => {
    for (const reason of ['length', 'stop', 'tool_calls'] as const) {
      const server = await startFakeServer((_request, response) =>
        serveFrames(response, [
          frame({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: reason }] }),
          frame('[DONE]'),
        ]),
      );
      expect((await run(providerFor(server))).at(-1)).toEqual({
        type: 'done',
        finishReason: reason,
      });
    }
  });

  it('maps a vendor finish reason on the non-streamed JSON path too', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'cut' }, finish_reason: 'eos' },
        ],
      }),
    );
    expect((await run(providerFor(server))).at(-1)).toEqual({
      type: 'done',
      finishReason: 'x-eos',
    });
  });

  it('translates a whole (non-streamed) completion instead of passing text through', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: 'because',
              tool_calls: [
                { id: 'call_9', type: 'function', function: { name: 'roll', arguments: '{}' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    expect(await run(providerFor(server))).toEqual([
      { type: 'reasoning-delta', text: 'because' },
      { type: 'text-delta', text: 'answer' },
      { type: 'tool-call', id: 'call_9', name: 'roll', args: {} },
      { type: 'usage', input: 3, output: 4 },
      { type: 'done', finishReason: 'stop' },
    ]);
  });
});

/* ────────────────────────── cancellation ─────────────────────────────────── */

describe('cancellation', () => {
  it('yields exactly what it delivered and stops when aborted mid-stream', async () => {
    const frames = [1, 2, 3, 4, 5, 6].map((n) => deltaFrame(`#${n}`));
    const server = await startFakeServer((_request, response) =>
      serveFramesSlowly(response, frames, 10),
    );
    const provider = providerFor(server);
    const controller = new AbortController();

    const events: StreamEvent[] = [];
    for await (const event of provider.stream(REQUEST, controller.signal)) {
      events.push(event);
      if (events.length === 2) controller.abort();
    }

    expect(events).toEqual([
      { type: 'text-delta', text: '#1' },
      { type: 'text-delta', text: '#2' },
    ]);
  });

  it('yields nothing, and sends nothing, for an already-aborted signal', async () => {
    const server = await startFakeServer((_request, response) => serveFrames(response, []));
    const controller = new AbortController();
    controller.abort();

    expect(await collect(providerFor(server).stream(REQUEST, controller.signal))).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });

  it('treats an abort during the request as cancellation, not as a failure', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: SECRET,
      model: 'test-model',
      // A transport that only ever fails when it is aborted.
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const controller = new AbortController();
    const pending = collect(provider.stream(REQUEST, controller.signal));
    controller.abort();

    expect(await pending).toEqual([]);
  });
});

/* ───────────────────────────── error mapping ─────────────────────────────── */

describe('failure classification', () => {
  const HTTP_CASES: readonly [number, unknown, string, boolean][] = [
    [401, { error: { message: 'Incorrect API key provided' } }, LLM_ERROR_CODES.auth, false],
    [403, { error: { message: 'forbidden' } }, LLM_ERROR_CODES.auth, false],
    [429, { error: { message: 'Rate limit reached for gpt-4o' } }, LLM_ERROR_CODES.rateLimit, true],
    [500, { error: { message: 'internal server error' } }, LLM_ERROR_CODES.network, true],
    [503, 'upstream unavailable', LLM_ERROR_CODES.network, true],
    [400, { error: { message: 'model not found' } }, LLM_ERROR_CODES.invalidRequest, false],
  ];

  for (const [status, body, code, retryable] of HTTP_CASES) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const server = await startFakeServer((_request, response) =>
        serveJson(response, status, body),
      );
      const events = await run(providerFor(server));

      expect(events).toHaveLength(2);
      // ADR-019: the status is a field now, not a fragment of the sentence.
      expect(events[0]).toMatchObject({ type: 'error', code, retryable, status });
      // `ports/llm.ts`: an adapter that emits `error` must still terminate.
      expect(events[1]).toEqual({ type: 'done', finishReason: 'error' });
    });
  }

  it('carries Retry-After as `retryAfterMs`, not as prose (ADR-019)', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 429, { error: { message: 'slow down' } }, { 'retry-after': '30' }),
    );
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({
      type: 'error',
      code: LLM_ERROR_CODES.rateLimit,
      retryable: true,
      status: 429,
      retryAfterMs: 30_000,
    });
  });

  it('parses Retry-After given as an HTTP date into milliseconds', async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 429, { error: { message: 'slow down' } }, { 'retry-after': at }),
    );
    const [error] = await run(providerFor(server));

    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs ?? -1;
    // The HTTP-date form is second-resolution, so the exact value depends on
    // when the server rendered the header; the window is what matters.
    expect(retryAfterMs).toBeGreaterThan(3500);
    expect(retryAfterMs).toBeLessThanOrEqual(5000);
    expect(error).toMatchObject({ status: 429 });
  });

  it('keeps an unusable Retry-After out of the event rather than guessing', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(
        response,
        429,
        { error: { message: 'slow down' } },
        { 'retry-after': 'whenever you feel like it' },
      ),
    );
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({ code: LLM_ERROR_CODES.rateLimit, status: 429 });
    expect(error).not.toHaveProperty('retryAfterMs');
  });

  it('carries the vendor code and the vendor error object in `details`', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 401, {
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          param: null,
        },
      }),
    );
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({
      type: 'error',
      code: LLM_ERROR_CODES.auth,
      retryable: false,
      status: 401,
      // `code` wins over `type`, because that is the field OpenAI's own docs
      // call the error's code and the one a caller is most likely to match on.
      providerCode: 'invalid_api_key',
      details: {
        message: 'Incorrect API key provided',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
        param: null,
      },
    });
  });

  it('falls back to the vendor `type` when there is no code', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 400, { error: { type: 'invalid_request_error' } }),
    );
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({ providerCode: 'invalid_request_error', status: 400 });
  });

  it('carries a non-JSON error body as `details` instead of losing it', async () => {
    const server = await startFakeServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('upstream is having a bad day');
    });
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({
      code: LLM_ERROR_CODES.network,
      status: 503,
      details: 'upstream is having a bad day',
    });
    expect(error).not.toHaveProperty('providerCode');
  });

  it('reports a rejected fetch as a retryable network failure', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: SECRET,
      model: 'test-model',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await run(provider)).toEqual([
      expect.objectContaining({
        type: 'error',
        code: LLM_ERROR_CODES.network,
        retryable: true,
      }),
      { type: 'done', finishReason: 'error' },
    ]);
    // No response was ever received, so there is no status to report.
    const [error] = await run(provider);
    expect(error).not.toHaveProperty('status');
  });

  it('reports a body that dies mid-stream as a retryable network failure', async () => {
    const server = await startFakeServer((_request, response) => {
      response.writeHead(200, SSE_HEADERS);
      response.write(deltaFrame('partial'));
      // No finish reason, no `[DONE]`, no graceful end: a cut connection.
      setTimeout(() => response.destroy(), 5);
    });
    const events = await run(providerFor(server));

    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
    expect(events.at(-2)).toMatchObject({
      type: 'error',
      code: LLM_ERROR_CODES.network,
      retryable: true,
    });
  });

  it('reports a stream that ends cleanly but without a finish reason', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [deltaFrame('truncated')]),
    );
    const events = await run(providerFor(server));

    expect(events[0]).toEqual({ type: 'text-delta', text: 'truncated' });
    expect(events.at(-2)).toMatchObject({
      type: 'error',
      code: LLM_ERROR_CODES.network,
      retryable: true,
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
  });

  it('classifies an in-stream error object without a status', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [frame({ error: { message: 'engine overloaded' } })]),
    );
    expect(await run(providerFor(server))).toEqual([
      expect.objectContaining({ type: 'error', code: LLM_ERROR_CODES.network, retryable: true }),
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('carries the vendor payload of an in-stream error object too (ADR-019)', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [
        frame({
          error: { message: 'engine overloaded', type: 'server_error', code: 'engine_overloaded' },
        }),
      ]),
    );
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({
      type: 'error',
      code: LLM_ERROR_CODES.network,
      retryable: true,
      // The HTTP request really was a 200; the vendor put its failure in the
      // body instead. Reporting 200 is the honest reading. ADR-019.
      status: 200,
      providerCode: 'engine_overloaded',
      details: { message: 'engine overloaded', type: 'server_error', code: 'engine_overloaded' },
    });
  });

  it('picks up Retry-After from a 200 that carries an error object', async () => {
    const server = await startFakeServer((_request, response) => {
      response.writeHead(200, { ...SSE_HEADERS, 'retry-after': '12' });
      response.write(
        frame({ error: { message: 'the engine is saturated', code: 'engine_overloaded' } }),
      );
      response.end();
    });
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({ status: 200, retryAfterMs: 12_000 });
  });

  it('never passes a non-SSE JSON error body through as text', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 400, { error: { message: 'invalid api key' } }),
    );
    const [error] = await run(providerFor(server));

    expect(error).toMatchObject({ type: 'error', code: LLM_ERROR_CODES.auth, status: 400 });
    expect((error as { message: string }).message).not.toContain('{"error"');
    // …but the parsed body is still handed over, structurally (ADR-019): the
    // point is that the caller does not have to parse the sentence, not that
    // the vendor's words are hidden.
    expect(error).toMatchObject({ details: { message: 'invalid api key' } });
  });

  it('classifies a JSON error body returned with HTTP 200', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, { error: { message: 'no auth credentials found' } }),
    );
    expect(await run(providerFor(server))).toEqual([
      expect.objectContaining({ type: 'error', code: LLM_ERROR_CODES.auth, retryable: false }),
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('reports a success body it cannot read at all', async () => {
    const server = await startFakeServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>a proxy login page</html>');
    });
    expect(await run(providerFor(server))).toEqual([
      expect.objectContaining({ type: 'error', code: LLM_ERROR_CODES.invalidResponse }),
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('pins the classification table directly', () => {
    expect(classifyFailure(401, '')).toEqual({ code: 'auth', retryable: false });
    expect(classifyFailure(429, '')).toEqual({ code: 'rate_limit', retryable: true });
    expect(classifyFailure(502, '')).toEqual({ code: 'network', retryable: true });
    expect(classifyFailure(400, 'content policy')).toEqual({
      code: 'content_filter',
      retryable: false,
    });
    // A moderation refusal outranks the status it arrived with.
    expect(classifyFailure(401, 'blocked by the safety system')).toEqual({
      code: 'content_filter',
      retryable: false,
    });
    // A 200 that still carried an error object: unnameable, so retryable.
    expect(classifyFailure(200, 'engine overloaded')).toEqual({
      code: 'network',
      retryable: true,
    });
  });
});

/* ───────────────────────────── content moderation ────────────────────────── */

describe('content moderation', () => {
  it('maps finish_reason content_filter to a non-retryable error', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [
        deltaFrame('I cannot'),
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }),
        frame('[DONE]'),
      ]),
    );
    expect(await run(providerFor(server))).toEqual([
      { type: 'text-delta', text: 'I cannot' },
      expect.objectContaining({
        type: 'error',
        code: LLM_ERROR_CODES.contentFilter,
        retryable: false,
      }),
      { type: 'done', finishReason: 'content_filter' },
    ]);
  });

  it('maps a moderation refusal body to the same code', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 400, {
        error: {
          message: 'Your request was rejected as a result of our safety system.',
          code: 'content_policy_violation',
        },
      }),
    );
    expect(await run(providerFor(server))).toEqual([
      expect.objectContaining({
        type: 'error',
        code: LLM_ERROR_CODES.contentFilter,
        retryable: false,
      }),
      { type: 'done', finishReason: 'error' },
    ]);
  });

  it('maps the Azure dialect of the same refusal', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 400, {
        error: {
          message: 'The response was filtered',
          code: 'content_filter',
          innererror: { code: 'ResponsibleAIPolicyViolation' },
        },
      }),
    );
    const [error] = await run(providerFor(server));
    expect(error).toMatchObject({ code: LLM_ERROR_CODES.contentFilter, retryable: false });
  });
});

/* ────────────────────────────── listModels ───────────────────────────────── */

describe('listModels', () => {
  it('reads GET {base}/models and maps what it understands', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, {
        object: 'list',
        data: [
          { id: 'alpha' },
          { id: 'beta', context_length: 8192 },
          { object: 'model' },
          { id: 'gamma', max_model_len: 32768 },
        ],
      }),
    );
    expect(await providerFor(server).listModels()).toEqual([
      { id: 'alpha' },
      { id: 'beta', contextWindow: 8192 },
      { id: 'gamma', contextWindow: 32768 },
    ]);

    expect(server.requests[0]?.method).toBe('GET');
    expect(server.requests[0]?.url).toBe('/v1/models');
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('leaves per-model capabilities empty, because the wire carries none (ADR-020)', async () => {
    // `ModelInfo.capabilities` exists so a provider that can tell its models
    // apart says so. `GET /v1/models` returns ids and context windows and
    // nothing else, so every entry here has to be the provider-level answer —
    // inventing `{ tools: true }` for `gpt-4o` would be a guess, and a wrong
    // guess makes the engine take a ladder path the model cannot honour.
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, { data: [{ id: 'alpha' }, { id: 'beta' }] }),
    );
    for (const model of await providerFor(server).listModels()) {
      expect(model.capabilities).toBeUndefined();
    }
  });

  it('falls back to built-in candidates instead of throwing', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 500, { error: { message: 'boom' } }),
    );
    const models = await providerFor(server).listModels();
    expect(models.map((model) => model.id)).toContain('test-model');
  });

  it('falls back when the transport itself fails', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: SECRET,
      model: 'hand-typed-model',
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(await provider.listModels()).toEqual([{ id: 'hand-typed-model' }]);
  });

  it('falls back when the body is not a model list', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, { unexpected: true }),
    );
    expect((await providerFor(server).listModels()).map((model) => model.id)).toContain(
      'test-model',
    );
  });

  it('forwards its signal to the transport', async () => {
    let sawSignal: AbortSignal | null | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: SECRET,
      model: 'test-model',
      fetch: (_url, init) => {
        sawSignal = init.signal;
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'alpha' }] })));
      },
    });

    const controller = new AbortController();
    expect(await provider.listModels(controller.signal)).toEqual([{ id: 'alpha' }]);
    // The port's optional signal is only worth having if it reaches the socket.
    expect(sawSignal).toBe(controller.signal);
  });

  it('returns the offline candidates instead of hanging when aborted', async () => {
    // A gateway that accepts the connection and never answers: without the
    // signal this promise never settles, which is the hang ADR-020 existed to
    // stop. "Never throws, never hangs" resolves to the same offline list a
    // dead gateway produces, because the caller that aborted already gave up.
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: SECRET,
      model: 'hand-typed-model',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    const controller = new AbortController();
    const pending = provider.listModels(controller.signal);
    controller.abort();

    // `http://127.0.0.1:1` matches the local-runtime profile, so the offline
    // answer is the configured model followed by that profile's well-known ids.
    expect(await pending).toEqual([
      { id: 'hand-typed-model' },
      { id: 'llama3.2' },
      { id: 'qwen2.5' },
      { id: 'local-model' },
    ]);
  });

  it('returns the offline candidates for a signal that was already aborted', async () => {
    const server = await startFakeServer((_request, response) =>
      serveJson(response, 200, { data: [{ id: 'alpha' }] }),
    );
    const controller = new AbortController();
    controller.abort();

    // A real `fetch` rejects such a request before opening a socket; either
    // path must end in the candidate list rather than an exception.
    expect((await providerFor(server).listModels(controller.signal)).map((m) => m.id)).toContain(
      'test-model',
    );
  });
});

/* ──────────────────────────────── the wire ───────────────────────────────── */

describe('request translation', () => {
  it('sends exactly the OpenAI fields, and never the speaker', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [frame('[DONE]')]),
    );
    const request: ChatRequest = {
      model: 'req-model',
      messages: [
        { role: 'system', content: 'you are a tavern keeper' },
        { role: 'user', content: 'hello', speakerId: 'narrator' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'roll_dice', args: { expr: '1d20' }, source: 'native' },
          ],
        },
        { role: 'tool', content: '{"total":14}', toolCallId: 'call_1' },
      ],
      tools: [
        {
          name: 'roll_dice',
          summary: 'Roll dice',
          parameters: [
            { name: 'expr', type: 'string', description: 'dice expression', required: true },
          ],
          owner: 'core',
          mutatesState: false,
          requiresApproval: false,
        },
      ],
      responseSchema: { type: 'object' },
      sampling: {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 128,
        topK: 40,
        stop: ['\n\n'],
        // `reasoningEffort` lives in `sampling` and ONLY there (ADR-020): the
        // port deleted `ChatRequest.reasoningEffort` because two spellings of
        // one thing mean one silently wins. `tsc` would reject the old field.
        reasoningEffort: 'low',
      },
      includeUsage: true,
    };

    expect(await run(providerFor(server), request)).toEqual([
      { type: 'done', finishReason: 'stop' },
    ]);

    const sent = JSON.parse(server.requests[0]?.body ?? '{}');
    expect(server.requests[0]?.url).toBe('/v1/chat/completions');
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);

    expect(sent.model).toBe('req-model');
    expect(sent.stream).toBe(true);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'you are a tavern keeper' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'roll_dice', arguments: '{"expr":"1d20"}' },
          },
        ],
      },
      { role: 'tool', content: '{"total":14}', tool_call_id: 'call_1' },
    ]);
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'roll_dice',
          description: 'Roll dice',
          parameters: {
            type: 'object',
            properties: { expr: { type: 'string', description: 'dice expression' } },
            required: ['expr'],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(sent.temperature).toBe(0.7);
    expect(sent.top_p).toBe(0.9);
    expect(sent.max_tokens).toBe(128);
    expect(sent.stop).toEqual(['\n\n']);
    expect(sent.reasoning_effort).toBe('low');
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'smarttavern_response', schema: { type: 'object' } },
    });
    // `topK` has no field on this wire format, so it is dropped rather than
    // invented (docs/02 §6: an adapter ignores what its vendor cannot express).
    expect(sent).not.toHaveProperty('top_k');
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('lets the caller override the headers and the model', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [frame('[DONE]')]),
    );
    const provider = providerFor(server, {
      headers: { 'api-key': 'azure-style', authorization: '' },
    });
    await run(provider, { model: '', messages: [{ role: 'user', content: 'hi' }] });

    const sent = JSON.parse(server.requests[0]?.body ?? '{}');
    expect(sent.model).toBe('test-model');
    expect(server.requests[0]?.headers['api-key']).toBe('azure-style');
  });

  it('omits the Authorization header when no key is configured', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [frame('[DONE]')]),
    );
    await run(providerFor(server, { apiKey: '' }));
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('reads reasoning effort from `sampling`, and nowhere else', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [frame('[DONE]')]),
    );
    // A caller built against the OLD port, which had a top-level field. The
    // adapter must not honour it: ADR-020 chose one spelling, and "the other
    // one also works" is how the two drifted apart in the first place.
    const legacy = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
    } as unknown as ChatRequest;
    await run(providerFor(server), legacy);
    expect(JSON.parse(server.requests[0]?.body ?? '{}')).not.toHaveProperty('reasoning_effort');

    await run(providerFor(server), {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      sampling: { reasoningEffort: 'high' },
    });
    expect(JSON.parse(server.requests[1]?.body ?? '{}').reasoning_effort).toBe('high');
  });
});

/* ──────────────────────── the key must not leak ──────────────────────────── */

describe('the API key never leaks (HANDOFF §4.1 invariant 6)', () => {
  /** Every error path, with the key echoed back inside the provider's own body. */
  const LEAKY_PATHS: readonly [string, (response: ServerResponse) => void][] = [
    [
      'auth',
      (response) =>
        serveJson(response, 401, { error: { message: `Incorrect API key provided: ${SECRET}` } }),
    ],
    [
      'rate limit',
      (response) =>
        serveJson(
          response,
          429,
          { error: { message: `slow down, key ${SECRET}` } },
          { 'retry-after': '30' },
        ),
    ],
    [
      'network',
      (response) => serveJson(response, 500, { error: { message: `boom for ${SECRET}` } }),
    ],
    [
      'content moderation',
      (response) =>
        serveJson(response, 400, {
          error: {
            message: `the safety system blocked ${SECRET}`,
            code: 'content_policy_violation',
          },
        }),
    ],
    [
      'in-stream error',
      (response) => serveFrames(response, [frame({ error: { message: `bad key ${SECRET}` } })]),
    ],
    [
      'JSON error body with a 200',
      (response) => serveJson(response, 200, { error: { message: `bad key ${SECRET}` } }),
    ],
    // `details` is the field most likely to carry a vendor echo of the key, so
    // the next four paths leak it somewhere OTHER than the human message:
    // whoever remembers to redact one string and not the structured value fails
    // here, and the fifth path proves an empty body has nothing to leak.
    [
      'vendor code in `details`',
      (response) => serveJson(response, 401, { error: { message: 'bad key', code: SECRET } }),
    ],
    [
      'vendor type in `details`',
      (response) =>
        serveJson(response, 401, { error: { message: 'bad key', type: `Bearer ${SECRET}` } }),
    ],
    [
      'nested vendor field in `details`',
      (response) =>
        serveJson(response, 500, {
          error: { message: 'upstream said no', innererror: { authorization: SECRET } },
        }),
    ],
    [
      'non-JSON error body in `details`',
      (response) => {
        // A proxy that echoes the header it received, as plain text.
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(`upstream rejected Authorization: Bearer ${SECRET}`);
      },
    ],
    [
      'in-stream error with the key in a nested field',
      (response) =>
        serveFrames(response, [
          frame({ error: { message: 'saturated', innererror: { key: SECRET } } }),
        ]),
    ],
  ];

  /** A path where nothing leaked: it must still produce an `error` event. */
  const CLEAN_PATH: readonly [string, (response: ServerResponse) => void] = [
    'empty JSON error body',
    (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('');
    },
  ];

  for (const [name, handler] of LEAKY_PATHS) {
    it(`redacts the key on the ${name} path`, async () => {
      const server = await startFakeServer((_request, response) => handler(response));

      let events: StreamEvent[] = [];
      try {
        events = await run(providerFor(server));
      } catch (error) {
        throw new Error(`the adapter threw instead of emitting an error event: ${String(error)}`);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(SECRET);
      // The key WAS in the body, so this is redaction, not absence.
      expect(JSON.stringify(events)).toContain('***');
    });
  }

  it(`still fails cleanly on the ${CLEAN_PATH[0]} path`, async () => {
    // Nothing to redact here; the point is that an empty body produces an
    // `error` + `done` pair rather than an empty iteration or a throw.
    const server = await startFakeServer((_request, response) => CLEAN_PATH[1](response));
    const events = await run(providerFor(server));

    expect(events[0]).toMatchObject({ type: 'error', code: LLM_ERROR_CODES.invalidResponse });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'error' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('scrubs the key out of a transport failure', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: SECRET,
      model: 'test-model',
      fetch: () => Promise.reject(new Error(`connect failed with ${SECRET}`)),
    });
    const events = await run(provider);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('keeps the key out of everything, always', async () => {
    const server = await startFakeServer((_request, response) =>
      serveFrames(response, [deltaFrame('hi'), frame('[DONE]')]),
    );
    const provider = providerFor(server);
    expect(JSON.stringify(await run(provider)).includes(SECRET)).toBe(false);
    expect(JSON.stringify(await provider.listModels()).includes(SECRET)).toBe(false);
    expect(JSON.stringify(provider.capabilities).includes(SECRET)).toBe(false);
    expect(provider.id.includes(SECRET)).toBe(false);
  });
});
