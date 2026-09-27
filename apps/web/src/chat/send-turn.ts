/**
 * One conversational turn: persist the user message, stream the answer, persist
 * the answer, advance the transcript tip (M0-T8).
 *
 * THE PARTIAL-TEXT POLICY (chosen here, documented here)
 * A turn that ends WITHOUT a terminal failure — `done` with any finish reason, or
 * an abort — persists whatever text arrived, even a single delta, and advances
 * `headMessageId` to it. A turn that ends WITH a terminal `error` event persists
 * nothing: the draft is dropped and the head stays where it was.
 *
 * WHY THAT SPLIT. The two cases are not the same fact. An `error` event means the
 * provider refused or broke before answering (`auth`, `content_filter`, a 4xx):
 * keeping the fragment would put a half-sentence in the transcript and make the
 * next request quote it back as if the model had said it. An abort or a `length`
 * finish means the model DID answer and the user stopped it or ran out of budget —
 * throwing that away loses the only copy, and the user's next message ("继续") only
 * makes sense if the fragment is in the chain. So: `error` discards, everything
 * else keeps.
 *
 * The user's own message is persisted BEFORE the request goes out, and stays
 * persisted even when the request fails — it is what the user typed, and the
 * error banner is attached to the live turn's state, not to a row.
 *
 * WHERE THE KEY IS (HANDOFF §4.1 invariant 6)
 * It is read from `deps.config`, handed to `OpenAICompatibleProvider`'s
 * constructor and kept inside that closure. Nothing in this file logs, rethrows or
 * stores it, and the `meta` written onto a message carries the MODEL id only —
 * never a credential. A failure is reported as `code` + `message` + `retryable`
 * (the port's vocabulary), so the UI reads a stable code instead of parsing a
 * vendor sentence.
 */
import type { ChatMessage, StreamEvent } from '@smarttavern/core';
import { type FetchLike, LLM_ERROR_CODES, OpenAICompatibleProvider } from '@smarttavern/providers';
import type { Id, Message, Session } from '@smarttavern/schema';
import {
  appendMessage,
  getChain,
  getSession,
  recordSessionModel,
  setHeadMessageId,
} from '../db/repository';
import { buildMessages } from './prompt';

/** Everything one turn needs, injected — this module reaches for no singleton. */
export interface SendTurnDeps {
  /** The provider configuration the user saved. The key lives ONLY here. */
  config: { baseUrl: string; apiKey: string; model: string };
  /** Transport override; `mount.ts` passes the platform fetch (or the desktop's). */
  transport?: FetchLike;
  /**
   * Called with the text that has arrived so far, on every `text-delta`.
   *
   * This is what makes the answer render WHILE it streams: nothing is stored until the
   * turn ends (the partial-text policy below), so without this the view would sit on a
   * "thinking" marker for the whole generation and the text would appear at once — not
   * streaming at all. A callback rather than an event emitter keeps this module free of
   * any state layer (ADR-017).
   */
  onDelta?: (textSoFar: string) => void;
}

/**
 * What one turn produced.
 *
 * There is deliberately NO `session` field. The session is read at the START of the
 * turn, so a copy returned afterwards would carry a `headMessageId` and a
 * `refs.modelConfig.model` from BEFORE this turn's two writes (`setHeadMessageId`,
 * `recordSessionModel`) — a stale object that reads like a fresh one. `headMessageId`
 * below is the post-turn tip, and the chain itself is refreshed by the live query.
 */
export interface SendTurnResult {
  /** The stored user message (always written, even when the request failed). */
  userMessage: Message;
  /** The stored assistant message, or `undefined` when the partial-text policy dropped it. */
  assistantMessage: Message | undefined;
  /** `Session.headMessageId` after the turn. */
  headMessageId: Id | null;
  /** Terminal failure, when one was reported. `error` events never throw. */
  error: { code: string; message: string; retryable: boolean } | undefined;
  /** True when `signal` was aborted, whether or not text had arrived. */
  aborted: boolean;
}

/**
 * The request text for a turn.
 *
 * `includeUsage` is always on: the adapter's `capabilities.reportsUsage` is what
 * says whether the vendor answers, and asking costs nothing when it does not.
 * Sampling is left to the provider defaults — M0 has no sampling UI, and inventing
 * values here would make the transcript's parameters unreproducible.
 */
function turnRequest(model: string, messages: ChatMessage[]) {
  return { model, messages, includeUsage: true };
}

/**
 * Run one turn. Never throws for a provider-side failure: every failure is either
 * an `error` event turned into `result.error` or — only for a bug in this app — a
 * thrown error that the caller's `try` should surface.
 */
export async function sendTurn(
  deps: SendTurnDeps,
  params: { sessionId: Id; text: string; signal: AbortSignal },
): Promise<SendTurnResult> {
  const session = await getSession(params.sessionId);
  if (session === undefined) throw new Error(`sendTurn: no session ${params.sessionId}`);

  const chain = await getChain(params.sessionId);
  const userMessage = await appendMessage({
    sessionId: session.id,
    parentId: session.headMessageId,
    role: 'user',
    content: params.text,
  });
  await setHeadMessageId(session.id, userMessage.id);
  await recordSessionModel(session.id, {
    provider: PROVIDER_ID,
    model: deps.config.model,
  });

  const provider = new OpenAICompatibleProvider({
    baseUrl: deps.config.baseUrl,
    apiKey: deps.config.apiKey,
    model: deps.config.model,
    ...(deps.transport === undefined ? {} : { fetch: deps.transport }),
  });

  const draft: TurnDraft = {
    text: '',
    finishReason: undefined,
    usage: undefined,
    error: undefined,
    sawToolCall: false,
  };

  try {
    const request = turnRequest(deps.config.model, buildMessages(session, chain, params.text));
    for await (const event of provider.stream(request, params.signal)) {
      applyEvent(draft, event);
      // Report the arrival so the view can render it now; see `SendTurnDeps.onDelta`.
      if (event.type === 'text-delta') deps.onDelta?.(draft.text);
    }
  } catch (cause) {
    // The adapter turns provider failures into events, so reaching here means
    // either a bug in the adapter or a transport that threw something that is not
    // a `Response`. `describeThrown` keeps the key out of the message by reporting
    // the error's NAME, never its text.
    draft.error ??= {
      code: LLM_ERROR_CODES.network,
      message: describeThrown(cause),
      retryable: true,
    };
  }

  return finalize(deps, session, userMessage, draft, params.signal.aborted);
}

/** The provider id recorded on the session. `OpenAICompatibleProvider.id` is per-host. */
const PROVIDER_ID = 'openai-compatible';

/** Everything one stream has to remember between events. */
interface TurnDraft {
  text: string;
  finishReason: string | undefined;
  usage: { input: number; output: number } | undefined;
  error: { code: string; message: string; retryable: boolean } | undefined;
  /** A `tool-call` event arrived. M0 does not run tools; it records that one came. */
  sawToolCall: boolean;
}

/**
 * Fold one stream event into the draft.
 *
 * `reasoning-delta` is dropped on purpose: `ChatMessage.content` carries the
 * ANSWER, and a reasoning trace is not part of it. M1 renders reasoning in its own
 * panel from the same event vocabulary; storing it as content now would put the
 * model's scratchpad into the transcript and send it back on the next request.
 */
function applyEvent(draft: TurnDraft, event: StreamEvent): void {
  switch (event.type) {
    case 'text-delta':
      draft.text += event.text;
      return;
    case 'reasoning-delta':
      return;
    case 'usage':
      draft.usage = { input: event.input, output: event.output };
      return;
    case 'tool-call':
      draft.sawToolCall = true;
      return;
    case 'error':
      draft.error = { code: event.code, message: event.message, retryable: event.retryable };
      return;
    case 'done':
      draft.finishReason = event.finishReason;
      return;
  }
}

/**
 * Write the outcome. Split out of `sendTurn` so the policy above reads in one
 * place instead of being interleaved with the streaming loop.
 */
async function finalize(
  deps: SendTurnDeps,
  session: Session,
  userMessage: Message,
  draft: TurnDraft,
  aborted: boolean,
): Promise<SendTurnResult> {
  const failed = draft.error !== undefined;
  const keepPartial = !failed && draft.text !== '';

  if (!keepPartial) {
    return {
      userMessage,
      assistantMessage: undefined,
      headMessageId: userMessage.id,
      error: draft.error,
      aborted,
    };
  }

  const assistantMessage = await appendMessage({
    sessionId: session.id,
    parentId: userMessage.id,
    role: 'assistant',
    content: draft.text,
    // `model` is the id the user configured — a label, never a credential
    // (HANDOFF §4.1 invariant 6). `tokens` is present only when the vendor
    // actually reported usage.
    meta: {
      model: deps.config.model,
      ...(draft.usage === undefined ? {} : { tokens: draft.usage.output }),
    },
    extensions: {
      'x-finish-reason': draft.finishReason ?? (aborted ? 'aborted' : 'unknown'),
      ...(aborted ? { 'x-aborted': true } : {}),
      ...(draft.sawToolCall ? { 'x-saw-tool-call': true } : {}),
    },
  });
  await setHeadMessageId(session.id, assistantMessage.id);

  return {
    userMessage,
    assistantMessage,
    headMessageId: assistantMessage.id,
    error: draft.error,
    aborted,
  };
}

/**
 * A thrown value, as a sentence that cannot carry the key.
 *
 * It reports the error's NAME rather than its message on purpose: the platform
 * `fetch` can reject with a message that quotes the request it was given, and the
 * one field in that request that must never surface is the `authorization` header.
 * A name is enough for a developer and provably cannot be a credential.
 */
function describeThrown(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name} while streaming the response`;
  return 'an unknown failure while streaming the response';
}
