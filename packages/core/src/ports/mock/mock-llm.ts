/**
 * Scripted `LLMProvider` double (docs/06 §8.4: "有 mock 实现用于测试").
 *
 * THREE THINGS THIS DOUBLE MUST DO, all asserted by the tests next to it:
 * 1. answer with a scripted `StreamEvent` SEQUENCE, so a consumer can be tested
 *    against every variant of §6 including `error` and `done`;
 * 2. honour `AbortSignal` mid-stream — aborting stops the iteration instead of
 *    draining the rest of the script, which is what makes cancellation testable
 *    without a network;
 * 3. record every request, so a test can assert exactly what was sent (prompt,
 *    tools, sampling) rather than only what came back.
 *
 * It is a `LLMProvider` and nothing more: no vendor knowledge, no retry policy,
 * no error mapping (that is M0-T6's job).
 */
import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  ProviderCapabilities,
  StreamEvent,
} from '../llm';
import { isAborted } from './_support';

/** One turn's answer: either a fixed event list or a generator that can await. */
export type ScriptedTurn = readonly StreamEvent[] | AsyncIterable<StreamEvent>;

/** Provider capabilities of the double: everything on, so no test is blocked by a flag. */
export const MOCK_LLM_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  structuredOutput: true,
  vision: true,
  streaming: true,
  tokenCounting: true,
  reasoning: true,
};

export interface MockLLMOptions {
  id?: string;
  capabilities?: ProviderCapabilities;
  models?: readonly ModelInfo[];
  /** Answers in order. The last one is reused once the script is exhausted. */
  script?: readonly ScriptedTurn[];
  /** Token count `countTokens` reports (or a function of the request). */
  tokens?: number | ((req: ChatRequest) => Promise<number>);
}

export class MockLLMProvider implements LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** Every request passed to `stream`, in call order. */
  readonly requests: ChatRequest[] = [];

  private readonly models: ModelInfo[];
  private readonly script: ScriptedTurn[];
  private readonly tokens: number | ((req: ChatRequest) => Promise<number>);
  private turnIndex = 0;

  constructor(options: MockLLMOptions = {}) {
    this.id = options.id ?? 'mock-llm';
    this.capabilities = options.capabilities ?? MOCK_LLM_CAPABILITIES;
    this.models = [...(options.models ?? [{ id: 'mock-model', displayName: 'Mock Model' }])];
    this.script = [...(options.script ?? [defaultScript()])];
    this.tokens = options.tokens ?? 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [...this.models];
  }

  async countTokens(req: ChatRequest): Promise<number> {
    if (typeof this.tokens === 'function') return this.tokens(req);
    return this.tokens;
  }

  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const turn = this.script[Math.min(this.turnIndex, this.script.length - 1)];
    this.turnIndex += 1;
    if (turn === undefined) throw new Error('mock LLM has no scripted turn');
    return abortableIterable(turn, signal);
  }

  /* ─────────────────────────── test conveniences ────────────────────────── */

  /** The most recent request, or `undefined` when nothing was sent. */
  get lastRequest(): ChatRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  /** Requests whose first message content matches. */
  requestsMatching(text: string): ChatRequest[] {
    return this.requests.filter((req) =>
      req.messages.some((message) => message.content.includes(text)),
    );
  }

  /** Replace the remaining script, e.g. between assertions in one test. */
  setScript(turns: readonly ScriptedTurn[]): void {
    this.script.splice(0, this.script.length, ...turns);
    this.turnIndex = 0;
  }

  /** Forget recorded requests. */
  reset(): void {
    this.requests.length = 0;
    this.turnIndex = 0;
  }
}

/**
 * Wrap a turn so the abort signal is checked BEFORE every yield, and ENDS the
 * stream rather than throwing (see `isAborted` for why).
 *
 * Checking inside the loop, and not only on entry, is the point: a consumer that
 * aborts after the first chunk must not receive the second.
 */
async function* abortableIterable(
  turn: ScriptedTurn,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  if (isAborted(signal)) return;
  for await (const event of turn) {
    if (isAborted(signal)) return;
    yield event;
  }
}

/** Default answer: one text delta, a usage report and a normal finish. */
export function defaultScript(text = 'mock response', finishReason = 'stop'): ScriptedTurn {
  return [
    { type: 'text-delta', text },
    { type: 'usage', input: text.length, output: text.length },
    { type: 'done', finishReason },
  ];
}

/** Scripted answer that emits the six variants of §6 in one stream. */
export function allVariantsScript(): ScriptedTurn {
  return [
    { type: 'reasoning-delta', text: 'thinking' },
    { type: 'text-delta', text: 'answer' },
    { type: 'tool-call', id: 'call-1', name: 'roll_dice', args: { expr: '1d20' } },
    { type: 'usage', input: 10, output: 4 },
    { type: 'error', code: 'rate_limit', message: 'slow down', retryable: true },
    { type: 'done', finishReason: 'stop' },
  ];
}

/**
 * A generator turn that yields one event per microtask, for tests that need real
 * asynchrony between events (abort while a stream is still open). Deliberately
 * NOT `setTimeout`: timers are a platform global and `packages/core` must stay
 * platform-free (HANDOFF §4.1 invariant 1), while a microtask is pure ES.
 */
export function deferredScript(events: readonly StreamEvent[], idleRounds = 1): ScriptedTurn {
  return (async function* deferred() {
    for (const event of events) {
      for (let round = 0; round < idleRounds; round += 1) await Promise.resolve();
      yield event;
    }
  })();
}
