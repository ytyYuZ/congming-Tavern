/**
 * The token estimator (M1-G4; docs/02-技术架构.md §5.1 「优先用 Provider 的计数
 * 接口，否则用近似分词器并缓存」).
 *
 * THE TWO PROPERTIES THIS FILE PINS DOWN
 *
 * 1. THE ESTIMATE ERRS HIGH, and it errs highest where a naive estimate is worst:
 *    the script-aware rule prices CJK above the Latin spelling of the same
 *    sentence. The estimator sees no tokenizer, so the test states the rule's own
 *    numbers (1 token per non-ASCII code point, `ceil(n / 4)` per ASCII run, plus
 *    framing) rather than pretending to compare against a vendor's tokenizer.
 * 2. THE CACHE IS OBSERVABLE. A counter that increments on every call proves the
 *    long history is asked about once, not once per trim attempt — which is the
 *    whole reason the cache exists.
 *
 * The literal numbers are hand arithmetic over `ASCII_CHARS_PER_TOKEN = 4`,
 * `MESSAGE_OVERHEAD_TOKENS = 4` and `REQUEST_OVERHEAD_TOKENS = 3`.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../ports/llm';
import type { TokenCounter } from './estimate';
import {
  ASCII_CHARS_PER_TOKEN,
  createEstimator,
  estimateTextTokens,
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
} from './estimate';

describe('estimateTextTokens — ASCII runs', () => {
  const table: readonly [text: string, tokens: number][] = [
    ['', 0],
    ['a', 1],
    ['abcd', 1],
    ['abcde', 2],
    ['abcdefgh', 2],
    ['abcdefghi', 3],
  ];

  it.each(table)('%j costs %i tokens', (text, tokens) => {
    expect(estimateTextTokens(text)).toBe(tokens);
  });

  it('rounds a run UP, which is the direction a budget must be wrong in', () => {
    // 5 characters at 4 chars/token is 1.25 tokens: charging 1 would under-count.
    expect(estimateTextTokens('abcde')).toBe(Math.ceil(5 / ASCII_CHARS_PER_TOKEN));
  });
});

describe('estimateTextTokens — non-ASCII', () => {
  it('prices CJK above the Latin spelling of the same greeting', () => {
    // こんにちは世界 ("hello, world"): 7 code points, none ASCII.
    const cjk = '\u3053\u3093\u306b\u3061\u306f\u4e16\u754c';
    expect(estimateTextTokens(cjk)).toBe(7);
    // The same greeting in ASCII: 11 characters, so ceil(11 / 4) = 3.
    expect(estimateTextTokens('hello world')).toBe(3);
    // THE PROPERTY, not just the two values: a flat chars-per-token divisor would
    // have priced the CJK line at ceil(7 / 4) = 2 — under-counting the exact case
    // (a Chinese prompt) where an under-count overflows the model.
    expect(estimateTextTokens(cjk)).toBeGreaterThan(estimateTextTokens('hello world'));
  });

  it('counts an astral character once, not twice for its surrogate pair', () => {
    // 𐍈 (U+10348, Gothic hwair) is two UTF-16 units and one code point.
    expect(estimateTextTokens('\u{10348}')).toBe(1);
  });

  it('charges each family separately inside one text', () => {
    // 'hi ' = 3 ASCII -> 1 token; 世界 = 2; ' ok' = 3 ASCII -> 1. Total 4.
    expect(estimateTextTokens('hi \u4e16\u754c ok')).toBe(4);
  });
});

describe('createEstimator — framing', () => {
  const message: ChatMessage = { role: 'user', content: 'abcd' };

  it('charges per-message framing and one request overhead on the approximation path', () => {
    const estimator = createEstimator();
    expect(estimator.source).toBe('approximation');
    expect(estimator.message(message)).toBe(1 + MESSAGE_OVERHEAD_TOKENS);
    expect(estimator.messages([message])).toBe(
      1 + MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS,
    );
    // An empty assembly is still a request: the overhead is not rounded away.
    expect(estimator.messages([])).toBe(REQUEST_OVERHEAD_TOKENS);
    expect(estimator.text('abcd')).toBe(1);
  });

  it('lets an injected counter own the framing entirely', () => {
    let calls = 0;
    const counter: TokenCounter = () => {
      calls += 1;
      return 10;
    };
    const estimator = createEstimator(counter);
    expect(estimator.source).toBe('injected');
    // 10, not 10 + REQUEST_OVERHEAD_TOKENS: a real counter's per-message answer
    // already contains the framing, and adding it twice would be a fiction.
    expect(estimator.messages([message])).toBe(10);
    expect(calls).toBe(1);
  });
});

describe('createEstimator — the cache is observable', () => {
  it('asks the injected counter once per message, not once per assembly', () => {
    let calls = 0;
    const counter: TokenCounter = () => {
      calls += 1;
      return 10;
    };
    const estimator = createEstimator(counter);
    const message: ChatMessage = { role: 'user', content: 'same text' };

    // The same text twice: one counting call, two identical answers.
    expect(estimator.messages([message])).toBe(10);
    expect(estimator.messages([message])).toBe(10);
    // A repeated message inside one assembly is still one call.
    expect(estimator.messages([message, message])).toBe(20);
    expect(calls).toBe(1);

    // A different role is a different question: framing depends on the role.
    expect(estimator.messages([{ role: 'assistant', content: 'same text' }])).toBe(10);
    expect(calls).toBe(2);

    // A different text is a different question.
    expect(estimator.messages([{ role: 'user', content: 'other text' }])).toBe(10);
    expect(calls).toBe(3);
  });
});
