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

/** A failure the panel must show. `code` is the adapter's vocabulary (ADR-019). */
export interface CoCreateAskError {
  readonly code: string;
  /** The provider's own sentence, for a log. Never the only carrier of the code. */
  readonly message: string;
  readonly retryable: boolean;
  /** The HTTP status, when the failure came from a response. */
  readonly status?: number;
}

/** What one turn produced: the answer text, or the terminal failure. */
export type CoCreateAskResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: CoCreateAskError };

/**
 * The request for one turn.
 *
 * `responseSchema` is `proposal.ts`'s `PROPOSAL_RESPONSE_SCHEMA` — level ② of `docs/02` §5.3's
 * degradation ladder, the strongest constraint the port can express. It is a REQUEST and not a
 * requirement: a vendor that ignores `response_format` still answers, and `readProposal` is what makes
 * the answer usable. `includeUsage` is always on for `send-turn.ts`'s reason: the capability flag says
 * whether the vendor answers, and asking costs nothing when it does not.
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

  let text = '';
  let failure: CoCreateAskError | undefined;
  try {
    const request = {
      model: deps.config.model,
      messages: [
        { role: 'system' as const, content: deps.instruction },
        ...deps.history.map((message) => ({ ...message })),
      ],
      responseSchema: PROPOSAL_RESPONSE_SCHEMA,
      includeUsage: true,
    };
    for await (const event of provider.stream(request, params.signal)) {
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

  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, text };
}
