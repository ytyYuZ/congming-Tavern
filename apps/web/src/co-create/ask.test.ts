/**
 * `askCoCreate`'s degradation ladder (A3, docs/02 §5.3), driven through the REAL
 * `OpenAICompatibleProvider` over a fake `fetch`.
 *
 * WHY THE REAL ADAPTER AND A HAND-WRITTEN WIRE BODY
 * Everything this file proves is about the WIRE. Level ② of §5.3's 降级策略 is the request
 * WITH `response_format: json_schema`; level ③ is the SAME request with that one key left
 * out; and there is no level ④. A mocked provider could not show any of that, because the
 * difference between the levels IS the body `packages/providers`' `chatBody` builds. So the
 * only thing faked is the socket, exactly as `chat/send-turn.test.ts` does it.
 *
 * WHY THE REFUSALS ARE SHAPED THE WAY THEY ARE
 * A provider's refusal reaches this module as the adapter's own sentence, `HTTP {status}:
 * {label} ({the vendor's own words})` — the only carrier of the parameter's NAME, which is
 * what the ladder is stated over. So each case answers with the error object a real endpoint
 * sends rather than an invented event, and one case refuses with a failure that names nothing
 * to show that no second request is spent on it.
 */
/** @vitest-environment node */
import type { FetchLike } from '@smarttavern/providers';
import { describe, expect, it } from 'vitest';
import { askCoCreate } from './ask';
import { PROPOSAL_RESPONSE_SCHEMA } from './proposal';

/* ─────────────────────────────── the fake wire ───────────────────────────── */

/**
 * A request body, as the shape these tests read.
 *
 * A DECLARED interface and not an index-signature bag, for the reason
 * `chat/send-turn.test.ts` records: this workspace compiles with
 * `noPropertyAccessFromIndexSignature` (so `body.model` is an error on a bag) while Biome
 * flags the literal bracket form. The declared shape also documents which fields are read —
 * including the ONE field these tests exist for.
 */
interface WireBody {
  model?: string;
  messages?: { role: string; content: string }[];
  /** Level ② of the ladder: present on the constrained attempt, ABSENT on the degraded one. */
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
}

/** The `fetch` the adapter is given: it records every body and answers per attempt. */
interface FakeWire {
  readonly fetch: FetchLike;
  /** Every request body the adapter built, oldest first. */
  readonly bodies: () => readonly WireBody[];
}

function fakeWire(respond: (attempt: number) => Response): FakeWire {
  const bodies: WireBody[] = [];
  return {
    fetch: (_url, init) => {
      if (typeof init.body === 'string') bodies.push(JSON.parse(init.body) as WireBody);
      // `bodies.length` after the push IS the attempt number, so a test can answer the
      // constrained request differently from the retry without counting anywhere else.
      return Promise.resolve(respond(bodies.length));
    },
    bodies: () => bodies,
  };
}

/**
 * A refusal the way a real gateway answers one: a non-2xx status and the vendor's own words
 * in the error object. `failureEvent` turns this into the `message` the ladder matches on.
 */
function refusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A standard SSE answer, so the real adapter's parser is what turns it into text. */
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

/* ──────────────────────────────── fixtures ──────────────────────────────── */

const CONFIG = { baseUrl: 'https://gateway.test/v1', apiKey: 'sk-test', model: 'test-model-1' };
const DEPS = { config: CONFIG, instruction: 'co-write a WORLD CARD', history: [] };
const SIGNAL = new AbortController().signal;

/* ────────────────────────────────── tests ───────────────────────────────── */

describe('askCoCreate', () => {
  it('retries once without the schema when the refusal names response_format', async () => {
    const wire = fakeWire((attempt) =>
      attempt === 1
        ? refusal(400, "Invalid parameter: 'response_format' is not supported by this endpoint")
        : answer(['{"message":"One region added.","ops":[]}']),
    );

    const result = await askCoCreate({ ...DEPS, transport: wire.fetch }, { signal: SIGNAL });

    const bodies = wire.bodies();
    // EXACTLY two requests: the ladder has one step below ② and takes it once.
    expect(bodies).toHaveLength(2);
    // Level ② went out first, and it is the proposal schema — the exact value the port sends.
    expect(bodies[0]?.response_format?.type).toBe('json_schema');
    expect(bodies[0]?.response_format?.json_schema?.schema).toEqual(PROPOSAL_RESPONSE_SCHEMA);
    // Level ③ is the SAME question minus that one key: same model, same messages.
    expect(bodies[1]?.response_format).toBeUndefined();
    expect(bodies[1]?.model).toBe(CONFIG.model);
    expect(bodies[1]?.messages).toEqual(bodies[0]?.messages);
    // …and the caller is told which level produced the text.
    expect(result).toEqual({
      ok: true,
      text: '{"message":"One region added.","ops":[]}',
      degraded: true,
    });
  });

  it('retries when the refusal names json_schema instead of response_format', async () => {
    // The two names are both the parameter (one is the field, one is the format's `type`), and
    // §5.3's ladder is stated over the pair — a vendor may refuse by quoting either.
    const wire = fakeWire((attempt) =>
      attempt === 1
        ? refusal(400, 'Unsupported value: response_format.type must be text, got json_schema')
        : answer(['{"message":"Nothing to change.","ops":[]}']),
    );

    const result = await askCoCreate({ ...DEPS, transport: wire.fetch }, { signal: SIGNAL });

    expect(wire.bodies()).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('does NOT retry a refusal that names neither, and reports what the server said', async () => {
    const wire = fakeWire(() => refusal(400, 'model not found'));

    const result = await askCoCreate({ ...DEPS, transport: wire.fetch }, { signal: SIGNAL });

    // ONE request: a second one would spend the author's quota on a failure this module cannot
    // lift, and the honest report is the refusal itself.
    expect(wire.bodies()).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(false);
    if (result.ok) throw new Error('a refused request must not come back ok');
    expect(result.error.code).toBe('invalid_request');
    expect(result.error.status).toBe(400);
    expect(result.error.retryable).toBe(false);
    // The sentence the panel shows is the adapter's, i.e. the status and the server's own words.
    expect(result.error.message).toContain('HTTP 400');
    expect(result.error.message).toContain('model not found');
    expect(result.error.message).not.toContain('response_format');
  });

  it('stops after the single retry even when the retry is refused the same way', async () => {
    let attempts = 0;
    const wire = fakeWire(() => {
      attempts += 1;
      return refusal(400, "Invalid parameter: 'response_format' is not supported");
    });

    const result = await askCoCreate({ ...DEPS, transport: wire.fetch }, { signal: SIGNAL });

    // TWO, not three: the ladder descends once and never loops.
    expect(attempts).toBe(2);
    expect(wire.bodies()).toHaveLength(2);
    expect(result.ok).toBe(false);
    // …and it still says the schema had been given up on, because that fact is about the REQUEST.
    expect(result.degraded).toBe(true);
    if (result.ok) throw new Error('a refused retry must not come back ok');
    expect(result.error.status).toBe(400);
  });

  it('says nothing was degraded when the constrained attempt simply succeeds', async () => {
    const wire = fakeWire(() => answer(['{"message":"Fine.","ops":[]}']));

    const result = await askCoCreate({ ...DEPS, transport: wire.fetch }, { signal: SIGNAL });

    expect(wire.bodies()).toHaveLength(1);
    expect(result).toEqual({ ok: true, text: '{"message":"Fine.","ops":[]}', degraded: false });
  });
});
