/**
 * One conversational turn: persist the user message, compose the request through the
 * prompt engine, stream the answer, persist the answer, advance the transcript tip
 * (M0-T8; M1 integration routes assembly through M1-G4's `compose`).
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
 * WHERE THE PROMPT COMES FROM (M1)
 * `chat/prompt.ts` used to hand-assemble the wire messages because neither engine
 * existed; it is deleted. The request is now `compose(preset, context, budget)`:
 * the built-in preset and calendar (`chat/builtin-content.ts`), the context and the
 * app-side `{slot}` fill (`chat/clock.ts`). The composer's `ok: false` branch is NOT
 * thrown — an over-budget assembly is a fact the user can act on (docs/02 §5.1
 * requires the numbers), so it is returned as `error` and `chat-store.ts` puts it in
 * the banner. Nothing is sent and no assistant row is written.
 *
 * WHERE THE KEY IS (HANDOFF §4.1 invariant 6)
 * It is read from `deps.config`, handed to `OpenAICompatibleProvider`'s
 * constructor and kept inside that closure. Nothing in this file logs, rethrows or
 * stores it, and the `meta` written onto a message carries the MODEL id only —
 * never a credential. A failure is reported as `code` + `message` + `retryable`
 * (the port's vocabulary), so the UI reads a stable code instead of parsing a
 * vendor sentence.
 *
 * WHY THE COMPOSER'S VARIABLE LOG IS APPLIED HERE AND NOT INSIDE THE COMPOSER (M1-S6,
 * ADR-031)
 * `{{setvar}}` and `{{addvar}}` are the one part of a prompt that changes the world, and
 * `compose` is a PURE function: it cannot write anything, so it RETURNS the changes it
 * performed (`ComposeSuccess.variableChanges`) instead of mutating a state it does not
 * own. This module is the layer that owns persistence, so the log crosses that boundary
 * here: `chat/vars.ts`'s `applyVariableChanges` computes `old state + change -> new state`
 * and the row is written with one `writeSessionState`. That split is exactly what ADR-031
 * buys — the writer never mutates in place, so a state already snapshotted into a
 * checkpoint cannot move under it, and the AI channel (`update_state`, deferred to M2+)
 * can later produce the same value and have it declined. Two consequences are recorded
 * rather than hidden: the log is applied ONCE PER COMPOSITION (the moment the user's
 * message enters the transcript), not once per answer, so a `setvar` in the user's own
 * text applies even when the provider then refuses the turn — the directive is a local
 * effect of the text, like the persisted user message; and a manual retry of that text
 * applies it again, which is idempotent for `setvar` (assign) and would double-count an
 * `addvar`. Making that idempotent needs an identity a macro text does not carry, and
 * that belongs to the deferred proposal flow, not here.
 */
import type { ChatMessage, PromptBudget, StreamEvent, VariableChange } from '@smarttavern/core';
import { type FetchLike, LLM_ERROR_CODES, OpenAICompatibleProvider } from '@smarttavern/providers';
import type { Calendar, Id, Message, PromptPreset, Session } from '@smarttavern/schema';
import {
  appendMessage,
  getChain,
  getSession,
  recordSessionModel,
  setHeadMessageId,
  writeSessionState,
} from '../db/repository';
import { PROMPT_BUDGET_CODE } from '../i18n/error-keys';
import { BUILTIN_BUDGET, BUILTIN_CALENDAR, BUILTIN_PRESET } from './builtin-content';
import { clockOf, composeTurn, promptContext, promptSlots } from './clock';
import { applyVariableChanges } from './vars';

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
  /**
   * Preset override. Absent in the app — the built-in preset is used — and present in
   * a test that has to drive a preset the app would never ship (a block that cannot
   * fit its own `budget.share`, an empty preset). It is the smallest seam that makes
   * the composer's trimming and its failure branch REACHABLE from a turn, which is
   * what "the app really uses the engine" has to mean.
   */
  preset?: PromptPreset;
  /** Budget override, for the same reason as `preset`. */
  budget?: PromptBudget;
  /**
   * The `Calendar` of the session's PINNED world version (M1-T1 follow-up): the time block's
   * date, hour and segment are rendered from it, so the model is told the moment in the
   * WORLD's own units — its month names, its `minutesPerHour`, its `hoursPerDay` — rather than
   * in the built-in face's.
   *
   * WHY IT IS OPTIONAL WITH A BUILT-IN DEFAULT, UNLIKE THE SESSION: `state/chat-store.ts`
   * always supplies the calendar it read for the open session (see `pinnedCalendar`), and a
   * caller that has no world to read — a test whose session pins content that does not exist —
   * gets the same value such a session resolves to, which is exactly
   * `chat/clock.ts`'s `calendarOf` fallback. So the default cannot disagree with the read path:
   * it is the bottom of it.
   */
  calendar?: Calendar;
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
  /**
   * The stored user message, or `undefined` when this turn wrote none (M1-S2: a
   * regeneration and a continuation re-ask a question that is already in the chain, so
   * there is no new user row to hand back). An ordinary composer turn always writes one,
   * even when the request then fails.
   */
  userMessage: Message | undefined;
  /** The stored assistant message, or `undefined` when the partial-text policy dropped it. */
  assistantMessage: Message | undefined;
  /** `Session.headMessageId` after the turn. */
  headMessageId: Id | null;
  /** Terminal failure, when one was reported. `error` events never throw. */
  error: SendTurnError | undefined;
  /** True when `signal` was aborted, whether or not text had arrived. */
  aborted: boolean;
}

/**
 * A failure the caller must show.
 *
 * `detail` is the ONE extra field, and only a local (non-provider) failure uses it:
 * the composer's budget numbers (`PromptBudgetError` carries the shortfall, the
 * limit and the levers) are the whole value of that error, and the catalog sentence
 * has a `{detail}` placeholder to receive them (ADR-019 keeps the code and the prose
 * apart; this keeps the code and the NUMBERS apart). An adapter failure leaves it
 * absent — its sentence is the provider's own, for logs, and the banner renders the
 * catalog sentence for the code.
 */
export interface SendTurnError {
  code: string;
  message: string;
  retryable: boolean;
  detail?: string;
}

/**
 * The request text for a turn.
 *
 * `includeUsage` is always on: the adapter's `capabilities.reportsUsage` is what
 * says whether the vendor answers, and asking costs nothing when it does not.
 * Sampling is left to the provider defaults — M0 has no sampling UI, and inventing
 * values here would make the transcript's parameters unreproducible.
 */
function turnRequest(model: string, messages: readonly ChatMessage[]) {
  return { model, messages: [...messages], includeUsage: true };
}

/**
 * The outcome of composing one turn's request — either the messages to send or the
 * user-facing refusal. A named union rather than an inline object so `sendTurn`'s
 * early return is checked by the compiler.
 *
 * `changes` is on BOTH branches on purpose: the composer records a `{{setvar}}` whichever
 * way the assembly ends, and `sendTurn` applies the log on every path (see the header).
 */
type Composed =
  | {
      readonly ok: true;
      readonly messages: readonly ChatMessage[];
      readonly changes: readonly VariableChange[];
    }
  | {
      readonly ok: false;
      readonly error: SendTurnError;
      readonly changes: readonly VariableChange[];
    };

/**
 * Build this turn's request through the prompt engine.
 *
 * WHY THE BUDGET COMES FROM `builtin-content.ts` UNLESS OVERRIDDEN: `ModelInfo`
 * (`contextWindow`, `maxOutputTokens`) is the real source, and nothing in this app
 * has one yet (`state/settings-store.ts` stores a model NAME), so the built-in
 * budget is the documented default until a model picker exists.
 */
function composeRequest(
  deps: SendTurnDeps,
  session: Session,
  chain: readonly Message[],
  text: string,
): Composed {
  const result = composeTurn(
    deps.preset ?? BUILTIN_PRESET,
    promptContext(session, chain, text, clockOf(deps.calendar ?? BUILTIN_CALENDAR, session)),
    deps.budget ?? BUILTIN_BUDGET,
    promptSlots(session),
  );
  if (result.ok) return { ok: true, messages: result.messages, changes: result.variableChanges };
  return { ok: false, error: budgetFailure(result.error), changes: result.variableChanges };
}

/**
 * The composer's explicit over-budget failure, as a `SendTurnResult.error`.
 *
 * WHY IT IS TRANSLATED AT ALL: docs/02 §5.1 requires 明确报错并给出建议, and the
 * suggestion is the actionable half. `error.message` is built here (not from a
 * vendor) and goes to the log; the SCREEN renders `error.promptBudget`, whose
 * `{detail}` is `error.detail`. The label is deliberately not a sentence about the
 * prompt content: the numbers and the levers ARE the message.
 */
function budgetFailure(error: {
  readonly code: 'budget-exceeded' | 'empty-budget';
  readonly shortfall: number;
  readonly limit: number;
  readonly suggestion: string;
}): SendTurnError {
  const detail = `prompt ${error.code}: short by ${error.shortfall} tokens of ${error.limit}`;
  return {
    code: PROMPT_BUDGET_CODE,
    message: `${detail}. ${error.suggestion}`,
    retryable: false,
    detail,
  };
}

/**
 * What this turn must write before the request goes out.
 *
 * WHY `'none'` IS SPELLED OUT RATHER THAN AN ABSENT `append`
 * A regeneration and a continuation ask a question that is ALREADY in the chain, so the
 * turn must write no user message at all — and an optional field cannot say that: an
 * absent field is also what a caller that forgot to pass one looks like, and the fallback
 * it invites ("then ask `params.text` as the user turn") is exactly the bug that makes a
 * regeneration append a SECOND copy of the question instead of a sibling answer. So the
 * three cases are nameable at the call site:
 * - omitted            — an ordinary turn: write `params.text` as a user row under the head.
 * - `{mode: 'none'}`   — a CONTINUATION: write nothing, the head is the chain to continue.
 * - `{mode: 'assistant'}` — a REGENERATION: write the answer only, under the head the store
 *   has already moved to the answer's own parent, which is what makes it a sibling (docs/02
 *   §7's 同父多子).
 */
export type TurnAppend = { readonly mode: 'none' } | { readonly mode: 'assistant' };

/**
 * Run one turn. Never throws for a provider-side failure: every failure is either
 * an `error` event turned into `result.error` or — only for a bug in this app — a
 * thrown error that the caller's `try` should surface.
 *
 * WHO OWNS `Session.headMessageId` AT ENTRY IS THE CALLER'S DECISION (M1-S2)
 * `params.append` names the position this turn attaches to, and the caller has already put
 * the head there (or is relying on it being where the last turn left it). An OMITTED
 * `append` is the ordinary composer turn and writes the user row itself.
 */
export async function sendTurn(
  deps: SendTurnDeps,
  params: {
    sessionId: Id;
    text: string;
    signal: AbortSignal;
    append?: TurnAppend;
    /**
     * Who the LOCAL schedule said should speak (M1-S5). It is written onto the ASSISTANT row
     * as `speakerId`, and that field is the whole reason a later round can tell who has
     * already spoken: the scheduler reads the transcript to count each character's lines, so a
     * turn that spoke for a card without recording which card makes every cap unenforceable.
     *
     * WHY IT IS OPTIONAL AND NOT A REQUIRED PART OF EVERY TURN: an ordinary composer turn
     * (`send`) has no local plan - the player speaks, not a card - so the field's absence is
     * the honest value for it, and a message with no `speakerId` is one docs/02 §7 already
     * documents ("absent for narration/system output").
     */
    speakerId?: Id;
    /** The stored plan this turn came from (M1-S5), recorded as `Message.meta.turnPlanId`. */
    turnPlanId?: Id;
  },
): Promise<SendTurnResult> {
  const session = await getSession(params.sessionId);
  if (session === undefined) throw new Error(`sendTurn: no session ${params.sessionId}`);

  // Read BEFORE the new message is appended: the engine's `history` is the
  // conversation so far, and the composer appends `input` itself.
  const chain = await getChain(params.sessionId);
  const composed = composeRequest(deps, session, chain, params.text);

  // The user turn written before the request. `'none'` and `'assistant'` must NOT invent a
  // user row, because a question that is already in the chain would then be asked twice —
  // see `TurnAppend`.
  const asked =
    params.append === undefined
      ? await appendMessage({
          sessionId: session.id,
          parentId: session.headMessageId,
          role: 'user',
          content: params.text,
        })
      : undefined;
  if (asked !== undefined) await setHeadMessageId(session.id, asked.id);
  await recordSessionModel(session.id, {
    provider: PROVIDER_ID,
    model: deps.config.model,
  });

  // THE COMPOSER'S VARIABLE LOG, APPLIED ONCE (M1-S6, ADR-031; see the header)
  // `applyVariableChanges` is pure and answers the SAME state object for an empty log, so
  // a turn that wrote no variable does not touch the session row a second time — and the
  // built-in preset contains no write directive at all, which is the common case.
  const nextState = applyVariableChanges(session.state, composed.changes);
  if (nextState !== session.state) await writeSessionState(session.id, nextState);

  if (!composed.ok) {
    // Nothing was sent, so there is no draft and no assistant row. A user message this turn
    // wrote stays persisted — it is what they typed, and the banner is attached to the live
    // turn, not to a row. When this turn wrote NO user row (a regeneration or a continuation
    // whose composition failed), the tip is still whatever the caller left it at, which is
    // the position that was asked about.
    return {
      userMessage: asked,
      assistantMessage: undefined,
      headMessageId: asked?.id ?? (await getSession(session.id))?.headMessageId ?? null,
      error: composed.error,
      aborted: false,
    };
  }

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
    const request = turnRequest(deps.config.model, composed.messages);
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

  return recordOutcome(deps, session.id, asked, draft, params.signal.aborted, {
    ...(params.speakerId === undefined ? {} : { speakerId: params.speakerId }),
    ...(params.turnPlanId === undefined ? {} : { turnPlanId: params.turnPlanId }),
  });
}

/** The provider id recorded on the session. `OpenAICompatibleProvider.id` is per-host. */
const PROVIDER_ID = 'openai-compatible';

/** Everything one stream has to remember between events. */
interface TurnDraft {
  text: string;
  finishReason: string | undefined;
  usage: { input: number; output: number } | undefined;
  error: SendTurnError | undefined;
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
 *
 * `sessionId` rather than the whole `Session`: the read at the start of the turn is
 * stale by now (two writes have happened), so passing only the id removes the
 * temptation to read anything else off it.
 *
 * `asked` is the user message THIS turn wrote, or `undefined` when the mode was `'none'` or
 * `'assistant'` (a regeneration or a continuation — see `sendTurn`). The answer hangs off
 * the head in that case, which is the parent the answer being regenerated already shares —
 * that is the whole mechanism by which a regeneration produces a SIBLING rather than a child.
 */
async function recordOutcome(
  deps: SendTurnDeps,
  sessionId: Id,
  asked: Message | undefined,
  draft: TurnDraft,
  aborted: boolean,
  /**
   * The local schedule's answer, when this turn came from one (M1-S5): which card spoke and
   * which plan decided it. Empty for every other caller, so the two fields stay absent on a
   * row that no schedule produced.
   */
  speaking: { readonly speakerId?: Id; readonly turnPlanId?: Id },
): Promise<SendTurnResult> {
  const failed = draft.error !== undefined;
  const keepPartial = !failed && draft.text !== '';

  /**
   * The tip when nothing was appended. When this turn DID ask, the tip is the row it wrote;
   * when it did not, the answer hangs under the session's current head — read on demand,
   * because the caller may have moved it (a regeneration does, before calling) and a copy
   * taken at the start of the turn would be the pre-move value.
   */
  const tip = async (): Promise<Id | null> =>
    asked?.id ?? (await getSession(sessionId))?.headMessageId ?? null;

  if (!keepPartial) {
    return {
      userMessage: asked,
      assistantMessage: undefined,
      headMessageId: await tip(),
      error: draft.error,
      aborted,
    };
  }

  const assistantMessage = await appendMessage({
    sessionId,
    parentId: await tip(),
    role: 'assistant',
    content: draft.text,
    // WHO SPOKE, when a local schedule said so (M1-S5). The field is what makes the NEXT
    // round's caps enforceable, because the scheduler counts each character's lines by
    // reading this column (`session/scheduler.ts`).
    ...(speaking.speakerId === undefined ? {} : { speakerId: speaking.speakerId }),
    // `model` is the id the user configured — a label, never a credential
    // (HANDOFF §4.1 invariant 6). `tokens` is present only when the vendor
    // actually reported usage.
    meta: {
      model: deps.config.model,
      ...(draft.usage === undefined ? {} : { tokens: draft.usage.output }),
      // The plan that decided this turn, so "why did this character speak" is answerable
      // from the transcript itself (docs/02 §4's `MessageMeta.turnPlanId`).
      ...(speaking.turnPlanId === undefined ? {} : { turnPlanId: speaking.turnPlanId }),
    },
    extensions: {
      'x-finish-reason': draft.finishReason ?? (aborted ? 'aborted' : 'unknown'),
      ...(aborted ? { 'x-aborted': true } : {}),
      ...(draft.sawToolCall ? { 'x-saw-tool-call': true } : {}),
    },
  });
  await setHeadMessageId(sessionId, assistantMessage.id);

  return {
    userMessage: asked,
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
