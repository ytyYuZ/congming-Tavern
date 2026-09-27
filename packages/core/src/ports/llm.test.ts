/**
 * The port's shape test: `StreamEvent` must be narrowable by `type` exactly as
 * `docs/02` §6 documents it. This is the test that fails if someone "simplifies"
 * a variant or drops `retryable` from `error`.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderCapabilities, StreamEvent } from './llm';

/** All six variants of §6, declared as `StreamEvent` so a typo cannot slip in. */
const STREAM_EVENTS: readonly StreamEvent[] = [
  { type: 'text-delta', text: 'hello' },
  { type: 'reasoning-delta', text: 'thinking' },
  { type: 'tool-call', id: 'call-1', name: 'roll_dice', args: { expr: '1d20' } },
  { type: 'usage', input: 12, output: 3 },
  { type: 'error', code: 'rate_limit', message: 'slow down', retryable: true },
  { type: 'done', finishReason: 'stop' },
];

describe('StreamEvent (docs/02 §6)', () => {
  it('covers exactly the six documented variants, in order', () => {
    expect(STREAM_EVENTS.map((event) => event.type)).toEqual([
      'text-delta',
      'reasoning-delta',
      'tool-call',
      'usage',
      'error',
      'done',
    ]);
  });

  it('narrows exhaustively by type', () => {
    const seen: string[] = [];
    for (const event of STREAM_EVENTS) {
      switch (event.type) {
        case 'text-delta':
        case 'reasoning-delta':
          seen.push(event.text);
          break;
        case 'tool-call':
          seen.push(`${event.name}(${JSON.stringify(event.args)})`);
          break;
        case 'usage':
          seen.push(`${event.input}+${event.output}`);
          break;
        case 'error':
          // `retryable` is 决定 3 of docs/06 §8.4: a consumer must be able to
          // decide whether to retry without parsing the message.
          seen.push(`${event.code}:${String(event.retryable)}`);
          break;
        case 'done':
          seen.push(event.finishReason);
          break;
        default: {
          const unreachable: never = event;
          throw new Error(`unhandled StreamEvent: ${JSON.stringify(unreachable)}`);
        }
      }
    }
    expect(seen).toEqual([
      'hello',
      'thinking',
      'roll_dice({"expr":"1d20"})',
      '12+3',
      'rate_limit:true',
      'stop',
    ]);
  });

  it('keeps the four §6 capability flags and the two optional ones', () => {
    const capabilities: ProviderCapabilities = {
      tools: true,
      structuredOutput: true,
      vision: false,
      streaming: true,
      tokenCounting: false,
    };
    expect(Object.keys(capabilities).sort()).toEqual([
      'streaming',
      'structuredOutput',
      'tokenCounting',
      'tools',
      'vision',
    ]);
    // `reasoning` is an addition (docs/02 §6 does not list it): a provider that
    // emits `reasoning-delta` needs to be able to say so.
    expect<ProviderCapabilities>({ ...capabilities, reasoning: true }).toEqual({
      ...capabilities,
      reasoning: true,
    });
  });
});
