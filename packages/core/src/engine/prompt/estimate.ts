/**
 * Token measurement for the prompt budget (M1-G4; docs/02-技术架构.md §5.1
 * 「Token 预算」: 总预算 = 模型上下文长度 − 预留输出长度, and 「优先用 Provider 的计数
 * 接口，否则用近似分词器并缓存」).
 *
 * THE ONE RULE THIS FILE OBEYS: an estimate that is too HIGH trims a little too
 * much; an estimate that is too LOW sends a request the model rejects. A wasted
 * round trip plus a vendor error is the worse failure, so the approximation is
 * built to over-count, and the two ways it does that are named constants rather
 * than magic numbers buried in a loop.
 *
 * WHY THE COUNTER IS SYNCHRONOUS. `LLMProvider.countTokens` is async
 * (`(req: ChatRequest) => Promise<number>`, ports/llm.ts) while trimming
 * evaluates one candidate assembly per droppable block. Awaiting a provider once
 * per candidate would turn a local decision into N network round trips, and
 * `packages/core` does no I/O at all (HANDOFF §4.1 invariant 1). So the injected
 * counter here is a SYNC `(messages) => number`; a caller whose only counter is
 * the provider's adapts it (e.g. a cached closure over `countTokens`), which is
 * §5.1's 「优先用 Provider 的计数接口」 in the form a pure engine can use.
 *
 * WHY THE CACHE IS PER MESSAGE, NOT PER ASSEMBLY. Trimming re-measures the whole
 * assembly after every drop, so a long history would be re-tokenised once per
 * trimmed block. One cached number per (role, content) pair turns each of those
 * re-measurements into a map lookup, and asks the injected counter about a given
 * message exactly once — which `estimate.test.ts` counts.
 */
import type { ChatMessage } from '../../ports/llm';

/**
 * Characters per token for ASCII (and only ASCII) runs.
 *
 * WHY 4: BPE tokenizers of the GPT-4/Claude class average roughly four ASCII
 * characters per token on prose, and `Math.ceil` on each run keeps the result at
 * or above that average rather than below it. A dense run (digits, punctuation,
 * code) can tokenise tighter than 4 chars/token; that residue is covered by the
 * framing overhead below, and a caller who needs a real number injects a counter.
 */
export const ASCII_CHARS_PER_TOKEN = 4;

/**
 * Framing charged for every message: the role marker, the delimiters around the
 * content and the separator between messages.
 *
 * WHY IT IS CHARGED EVEN THOUGH IT IS NOT IN `content`: every provider pays it,
 * so an estimate that counts only characters is systematically LOW by 4 tokens
 * per message — exactly the direction this file must not be wrong in. Four is
 * the common upper end for chat formats (three for the framing plus one for the
 * role name).
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Framing charged once per request (assistant priming, tool section header).
 * Deliberately counted even for an empty assembly: an empty request is still a
 * request, and rounding it to zero is the kind of "free" a budget must not
 * believe in.
 */
export const REQUEST_OVERHEAD_TOKENS = 3;

/**
 * A caller-supplied measurement of one assembly, used instead of the
 * approximation. See the file header for why this is synchronous.
 */
export type TokenCounter = (messages: readonly ChatMessage[]) => number;

/** Which measurement produced the numbers in a `BudgetReport`. */
export type MeasureSource = 'injected' | 'approximation';

/** The measurement surface the budget and the trim loop use. */
export interface TokenEstimator {
  /** Where the numbers come from — surfaced so a report can say so. */
  readonly source: MeasureSource;
  /** Tokens for one text, framing excluded (cached). */
  text(text: string): number;
  /** Tokens for one message, framing included (cached). */
  message(message: ChatMessage): number;
  /** Tokens for a whole assembly, request framing included. */
  messages(messages: readonly ChatMessage[]): number;
}

/**
 * Script-aware, deliberately conservative token estimate for one text.
 *
 * THE SHAPE OF THE RULE, and why it is script-aware: CJK is not
 * whitespace-separated, so a BPE tokenizer spends about one token per character,
 * while Latin prose averages several characters per token. One flat
 * characters-per-token divisor would therefore under-count Chinese by ~4x — the
 * dangerous direction — so the two families are counted separately:
 *
 * - every non-ASCII code point costs 1 token (docs/02 §5.1's own rule of thumb
 *   for CJK; a tokenizer with a thin CJK vocabulary can charge up to 3 via
 *   UTF-8 byte fallback, which is the residual risk and the reason a caller with
 *   a real counter should inject it),
 * - an ASCII run of `n` characters costs `ceil(n / 4)`.
 *
 * Iteration is by code point (`for...of`), so an astral character counts once
 * rather than twice for its surrogate pair.
 */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = (): void => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / ASCII_CHARS_PER_TOKEN);
      asciiRun = 0;
    }
  };
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiRun += 1;
    else {
      flushAscii();
      tokens += 1;
    }
  }
  flushAscii();
  return tokens;
}

/**
 * Build a measuring object.
 *
 * With no counter the script-aware approximation is used and the request framing
 * is added; with a counter, the counter answers for ONE message at a time and no
 * request framing is added on top (a real counter's per-message answer already
 * contains that framing, and adding it twice would charge the assembly for
 * something nobody measures).
 */
export function createEstimator(counter?: TokenCounter): TokenEstimator {
  const messageCache = new Map<string, number>();
  const textCache = new Map<string, number>();
  const source: MeasureSource = counter === undefined ? 'approximation' : 'injected';

  const text = (value: string): number => {
    const cached = textCache.get(value);
    if (cached !== undefined) return cached;
    const cost = estimateTextTokens(value);
    textCache.set(value, cost);
    return cost;
  };

  const message = (value: ChatMessage): number => {
    // Keyed by role as well as content: the framing a counter reports depends on
    // the role, so two messages that share text but not role are two questions.
    const key = `${value.role}\u0000${value.content}`;
    const cached = messageCache.get(key);
    if (cached !== undefined) return cached;
    const cost =
      counter === undefined ? text(value.content) + MESSAGE_OVERHEAD_TOKENS : counter([value]);
    messageCache.set(key, cost);
    return cost;
  };

  return {
    source,
    text,
    message,
    messages: (values) => {
      let total = 0;
      for (const value of values) total += message(value);
      return counter === undefined ? total + REQUEST_OVERHEAD_TOKENS : total;
    },
  };
}
