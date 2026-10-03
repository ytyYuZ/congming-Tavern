/**
 * One co-creation turn (M1-W2): the conversation about a card, sent through the app's ONE provider
 * path, and the answer back as text.
 *
 * WHY THIS GOES THROUGH `OpenAICompatibleProvider` AND NOT THROUGH `chat/send-turn.ts`
 * The instruction for M1-W2 is that a co-creation turn uses the EXISTING provider path and never a
 * second HTTP path. There are two spellings of that path in this app, and this module is the second
 * one on purpose:
 *   • `chat/send-turn.ts` composes a REQUEST from a `Session` — `composeTurn` over `Session.state`,
 *     the world clock, the variable macros — and then PERSISTS a message tree. A co-creation turn has
 *     no session and no transcript: it is a conversation about a CARD (docs/01 §5.2's left pane), and
 *     `sendTurn` would need a session row to exist before the user had decided to play anything.
 *   • `chat/providers.ts` already asks the same adapter a question outside a session (「测试连接」),
 *     so "the app talks to a provider without a transcript" is an established shape here.
 * What is NOT duplicated is the wire: this module constructs the same `OpenAICompatibleProvider` from
 * the same `ProviderSettings` and hands it the same `ChatRequest`, so a co-creation request is the
 * same HTTP request shape as a play turn — endpoint normalisation, auth header, SSE parsing, the error
 * vocabulary (`LLM_ERROR_CODES`) and the key redaction all come from the adapter and from nothing here.
 *
 * WHY THIS IS NOT STREAMED TO THE VIEW
 * A proposal is only meaningful once it is WHOLE: half of a JSON object is not a preview, and a
 * partially applied patch is exactly the harm `cards/draft.ts` exists to prevent. So the deltas are
 * accumulated here and the panel shows its own "thinking" state; `stream` is still the port method
 * (the only one that exists for a chat completion), which is also why `includeUsage` travels.
 *
 * WHY THE PARTIAL-TEXT POLICY IS THE SAME ONE `send-turn.ts` DOCUMENTS
 * `error` discards and everything else keeps: an `error` event means the provider refused before
 * answering, so its fragment must not become a "reply" the user reads; an abort or a `length` finish
 * means the model DID answer, so the text is returned with `ok: true` and the parser's own refusal
 * explains what is wrong with it. That split is deliberately the same rule in both modules.
 *
 * WHY THERE IS A SECOND ATTEMPT, AND WHY THERE IS ONLY ONE (A3)
 * `responseSchema` is level ② of `docs/02` §5.3's degradation ladder, and the level below it is the
 * SAME request with that one key left out: a provider which refuses the parameter still answers the
 * question, and `readProposal` reads prose as readily as it reads JSON (it already tolerates a code
 * fence around the object). So a failure whose own words NAME the parameter is retried exactly once
 * without it, and both arms of the result say which level produced the text (`degraded`) so the panel
 * can be honest about it. A failure that does not name the parameter is reported as itself: sending it
 * a second time would spend the author's quota on a request that already failed for a reason this
 * module cannot lift.
 */
import type { ChatMessage } from '@smarttavern/core';
import { type FetchLike, LLM_ERROR_CODES, OpenAICompatibleProvider } from '@smarttavern/providers';
import { PROPOSAL_RESPONSE_SCHEMA } from './proposal';

/** Everything one co-creation turn needs. The key lives only inside `config`. */
export interface CoCreateTurnDeps {
  /** The provider configuration the user saved. The key lives ONLY here. */
  readonly config: { baseUrl: string; apiKey: string; model: string };
  /** Transport override; `mount.ts` passes the platform fetch (or the desktop's). */
  readonly transport?: FetchLike;
  /** The system instruction for this turn (`coCreateInstructions`). */
  readonly instruction: string;
  /**
   * The conversation so far, oldest first, each already in its wire role.
   *
   * `assistant` entries are the model's own earlier answers — the JSON it produced, verbatim. Keeping
   * them means the next turn sees what it already proposed, which is what stops a model from
   * re-proposing an edit the user has already accepted or rejected.
   */
  readonly history: readonly ChatMessage[];
}

/**
 * A failure the panel must show. `code` is the adapter's vocabulary (ADR-019).
 *
 * `message` is NOT a leftover: the adapter composes it as `HTTP {status}: {label} ({the vendor's own
 * words})`, which is the only place the status and the vendor's sentence travel together, and A3 makes
 * the panel show it — a refused request must be reported as what the server said, never as a guess at
 * the model name. It is still the CODE that selects the sentence (ADR-019); this is the fact beside it.
 */
export interface CoCreateAskError {
  readonly code: string;
  /** The provider's own sentence. Never the only carrier of the code, and already key-redacted. */
  readonly message: string;
  readonly retryable: boolean;
  /** The HTTP status, when the failure came from a response. */
  readonly status?: number;
}

/**
 * What one turn produced: the answer text, or the terminal failure.
 *
 * `degraded` sits on BOTH arms because it is a fact about the REQUEST rather than about its outcome:
 * `true` means this is level ③ of `docs/02` §5.3's ladder, i.e. the attempt WITHOUT the response
 * schema. The panel states it either way — a degraded retry that ALSO failed is still a turn the
 * author has to know was sent twice.
 */
export type CoCreateAskResult =
  | { readonly ok: true; readonly text: string; readonly degraded: boolean }
  | { readonly ok: false; readonly error: CoCreateAskError; readonly degraded: boolean };

/**
 * One attempt's outcome: the accumulated text, and the terminal failure when there was one.
 *
 * `failure` is absent for a `length` finish or an abort, exactly as `send-turn.ts` reports them: the
 * model answered, and whether the answer is usable is `readProposal`'s question, not this module's.
 */
interface AskAttempt {
  readonly text: string;
  readonly failure?: CoCreateAskError;
}

/**
 * The two names a provider uses when it refuses level ② — the structured-output step of `docs/02`
 * §5.3. Detection is by NAME, which is what that section's 降级策略 ladder is stated over.
 *
 * WHY NOT `code === 'invalid_request'`: the adapter classifies EVERY 4xx it cannot place as
 * `invalid_request` (`packages/providers/src/llm/openai-compatible.ts`'s `classifyFailure`), and an
 * unreadable body (`invalid_response`) can name the parameter just as well — so the code cannot tell
 * "this endpoint has no structured output" from "this request was wrong in some other way", which is
 * exactly the confusion A3 is about. The parameter's own name can: it is the vendor's words, which the
 * adapter folds into the message it emits (`failureEvent`'s `(…)` suffix).
 */
const REFUSED_SCHEMA_NAMES = ['response_format', 'json_schema'] as const;

/** True when a failure's own words name the structured-output parameter (`docs/02` §5.3 level ②). */
function namesResponseSchema(message: string): boolean {
  const haystack = message.toLowerCase();
  return REFUSED_SCHEMA_NAMES.some((name) => haystack.includes(name));
}

/**
 * One request, streamed to the end.
 *
 * WHY `withSchema` IS A PARAMETER AND NOT TWO FUNCTIONS: the ladder's two levels differ by exactly one
 * key of the request body, and everything else — the instruction, the history, the accumulation rule,
 * the partial-text policy — has to be identical, or the retry would be a different question.
 */
async function streamAnswer(
  provider: OpenAICompatibleProvider,
  deps: CoCreateTurnDeps,
  signal: AbortSignal,
  withSchema: boolean,
): Promise<AskAttempt> {
  let text = '';
  let failure: CoCreateAskError | undefined;
  try {
    const request = {
      model: deps.config.model,
      messages: [
        { role: 'system' as const, content: deps.instruction },
        ...deps.history.map((message) => ({ ...message })),
      ],
      ...(withSchema ? { responseSchema: PROPOSAL_RESPONSE_SCHEMA } : {}),
      includeUsage: true,
    };
    for await (const event of provider.stream(request, signal)) {
      switch (event.type) {
        case 'text-delta':
          text += event.text;
          break;
        case 'error':
          failure = {
            code: event.code,
            message: event.message,
            retryable: event.retryable,
            ...(event.status === undefined ? {} : { status: event.status }),
          };
          break;
        default:
          // `reasoning-delta`, `tool-call`, `usage` and `done` are not this module's business: the
          // reply is `content` (`send-turn.ts` documents why a reasoning trace is dropped), a
          // co-creation turn runs no tools, and the tip of a card is not token-metered.
          break;
      }
    }
  } catch (cause) {
    // The adapter turns provider failures into events, so reaching here means either a bug in the
    // adapter or a transport that threw something that is not a `Response`. The error's own NAME is
    // reported and never its message: a rejection message can quote the request, and the request
    // carries the key (`send-turn.ts`'s `describeThrown`).
    failure ??= {
      code: LLM_ERROR_CODES.network,
      message:
        cause instanceof Error ? `${cause.name} while streaming the response` : 'unknown failure',
      retryable: true,
    };
  }
  return { text, ...(failure === undefined ? {} : { failure }) };
}

/**
 * The request for one turn, and the ladder below it.
 *
 * `responseSchema` is `proposal.ts`'s `PROPOSAL_RESPONSE_SCHEMA` — level ② of `docs/02` §5.3's
 * degradation ladder, the strongest constraint the port can express. It is a REQUEST and not a
 * requirement: a vendor that ignores `response_format` still answers, and `readProposal` is what makes
 * the answer usable. `includeUsage` is always on for `send-turn.ts`'s reason: the capability flag says
 * whether the vendor answers, and asking costs nothing when it does not.
 *
 * A vendor that does not merely IGNORE the parameter but refuses it gets level ③ — the same request
 * without it — and nothing beyond that, because a third attempt would be the second one again.
 */
export async function askCoCreate(
  deps: CoCreateTurnDeps,
  params: { readonly signal: AbortSignal },
): Promise<CoCreateAskResult> {
  const provider = new OpenAICompatibleProvider({
    baseUrl: deps.config.baseUrl,
    apiKey: deps.config.apiKey,
    model: deps.config.model,
    ...(deps.transport === undefined ? {} : { fetch: deps.transport }),
  });

  const first = await streamAnswer(provider, deps, params.signal, true);
  if (first.failure === undefined) return { ok: true, text: first.text, degraded: false };

  // The refusal named the parameter, so level ③ is the honest next step: the same question, asked
  // without the constraint this endpoint cannot accept. Nothing else is retried.
  if (!namesResponseSchema(first.failure.message)) {
    return { ok: false, error: first.failure, degraded: false };
  }

  const retry = await streamAnswer(provider, deps, params.signal, false);
  // The RETRY's failure is the one reported: it is what actually ended the turn, and `degraded`
  // beside it says the schema had already been given up on (`judge` in `state/co-create-store.ts`
  // shows both facts together).
  if (retry.failure !== undefined) return { ok: false, error: retry.failure, degraded: true };
  return { ok: true, text: retry.text, degraded: true };
}
