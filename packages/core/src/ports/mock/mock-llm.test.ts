/**
 * Scripted LLM double: event sequences, mid-stream abort, and what-was-sent
 * assertions (docs/06 §8.4 requires mock implementations for the tests).
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest, StreamEvent } from '../llm';
import { allVariantsScript, defaultScript, deferredScript, MockLLMProvider } from './index';

/** Drain a stream to the end. */
async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * Drain a stream while aborting the SAME signal after `abortAfter` events — the
 * consumer-side abort that `stream`'s contract has to honour.
 */
async function collectWhileAborting(
  stream: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
  abortAfter: number,
): Promise<StreamEvent[]> {
  const controller = new AbortController();
  const events: StreamEvent[] = [];
  for await (const event of stream(controller.signal)) {
    events.push(event);
    if (events.length >= abortAfter) controller.abort();
  }
  return events;
}

const REQUEST: ChatRequest = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'hello there' }],
};

describe('MockLLMProvider', () => {
  it('yields the scripted events in order', async () => {
    const provider = new MockLLMProvider({ script: [defaultScript('hi')] });
    expect(await collect(provider.stream(REQUEST, new AbortController().signal))).toEqual([
      { type: 'text-delta', text: 'hi' },
      { type: 'usage', input: 2, output: 2 },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('can emit every variant of §6 in one stream', async () => {
    const provider = new MockLLMProvider({ script: [allVariantsScript()] });
    const events = await collect(provider.stream(REQUEST, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual([
      'reasoning-delta',
      'text-delta',
      'tool-call',
      'usage',
      'error',
      'done',
    ]);
  });

  it('reuses the last turn once the script is exhausted', async () => {
    const provider = new MockLLMProvider({
      script: [[{ type: 'text-delta', text: 'first' }], [{ type: 'text-delta', text: 'last' }]],
    });
    const signal = new AbortController().signal;
    expect(await collect(provider.stream(REQUEST, signal))).toEqual([
      { type: 'text-delta', text: 'first' },
    ]);
    expect(await collect(provider.stream(REQUEST, signal))).toEqual([
      { type: 'text-delta', text: 'last' },
    ]);
    expect(await collect(provider.stream(REQUEST, signal))).toEqual([
      { type: 'text-delta', text: 'last' },
    ]);
  });

  it('stops mid-stream when the signal aborts', async () => {
    const provider = new MockLLMProvider({
      script: [
        deferredScript([
          { type: 'text-delta', text: 'one' },
          { type: 'text-delta', text: 'two' },
          { type: 'text-delta', text: 'three' },
          { type: 'done', finishReason: 'stop' },
        ]),
      ],
    });
    const events = await collectWhileAborting((signal) => provider.stream(REQUEST, signal), 2);
    expect(events).toEqual([
      { type: 'text-delta', text: 'one' },
      { type: 'text-delta', text: 'two' },
    ]);
  });

  it('delivers nothing when the signal was already aborted', async () => {
    const provider = new MockLLMProvider({ script: [defaultScript('never')] });
    const controller = new AbortController();
    controller.abort();
    // Cancellation ENDS the stream; it is not an error to catch (see isAborted).
    expect(await collect(provider.stream(REQUEST, controller.signal))).toEqual([]);
  });

  it('records exactly what was sent', async () => {
    const provider = new MockLLMProvider();
    const request: ChatRequest = {
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'you are a tavern keeper' },
        { role: 'user', content: 'hello there' },
      ],
      sampling: { temperature: 0.8, topP: 0.95 },
    };
    await collect(provider.stream(request, new AbortController().signal));

    expect(provider.requests).toHaveLength(1);
    expect(provider.lastRequest).toEqual(request);
    expect(provider.requestsMatching('tavern')).toHaveLength(1);
    expect(provider.requestsMatching('nothing like this')).toHaveLength(0);
  });

  it('lists models and counts tokens, deterministically', async () => {
    const provider = new MockLLMProvider({
      models: [{ id: 'mock-a' }, { id: 'mock-b', contextWindow: 8192 }],
      tokens: 42,
    });
    expect(await provider.listModels()).toEqual([
      { id: 'mock-a' },
      { id: 'mock-b', contextWindow: 8192 },
    ]);
    expect(await provider.countTokens(REQUEST)).toBe(42);
  });

  it('accepts a token-counting function, the way a real adapter would compute it', async () => {
    const provider = new MockLLMProvider({
      tokens: async (request) => request.messages.length * 10,
    });
    expect(await provider.countTokens(REQUEST)).toBe(10);
  });
});
