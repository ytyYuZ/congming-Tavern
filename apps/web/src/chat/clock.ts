/**
 * The world clock, as the app uses it: the `TimeEngine`'s structured `ClockDisplay`,
 * the visible sentence built from it, the app-side preset slot fill, and the
 * `PromptContext` for one turn (M1-T1 / M1-T3 integration; docs/02 §5.1, §5.7; ADR-030).
 *
 * WHY THE SENTENCE IS COMPOSED HERE AND NOT IN THE ENGINE
 * `TimeEngine.display()` deliberately returns parts, not docs/02 §5.7's finished
 * "第三纪 1287 年 霜月 12 日 · 黄昏": the engine serves an export, a log line and a
 * CLI as well as this UI, and it owns no locale (`engine/time/clock.ts` records the
 * decision). So the SENTENCE is the app's job — it is the only layer that knows
 * `packages/i18n` exists — and the wording it wraps around the parts comes from the
 * catalogs, while the month and segment names stay the world's own authored data.
 *
 * WHY THE CLOCK IS `session.initialClock`
 * docs/02 §5.7 puts the LIVE time in `SessionState.clock`, and `SessionState` is an
 * M1-T4/M1-M1 concern: this app has no `sessionStates` row yet (`db/repository.ts`
 * writes sessions and messages only). `Session.initialClock` is the one clock a
 * session actually carries — "the world's `startMinute`, copied here so the session
 * owns its origin" — so it is what the clock shows and what enters the prompt until
 * a checkpoint row exists. Reading it in ONE place (`clockOf`) is what makes the
 * swap to `SessionState.clock` a change here instead of at every call site.
 *
 * WHERE THIS MODULE SITS. It is the seam between three layers that must not import
 * each other: `@smarttavern/core` (the engine, which computes), the app's built-in
 * content (the data, which the app owns until M1-W1/I2), and `packages/i18n` (the
 * glue words, passed in as `t` so this module never reaches for the locale store).
 */
import {
  type ChatMessage,
  type ClockDisplay,
  // Imported under a local name on purpose: the bare identifier `display` collides
  // with the DOM's global `display` accessor in a browser, and a bundler that resolved
  // the free name to that global would silently call the wrong thing at runtime.
  display as clockDisplay,
  compose,
  type PromptBudget,
  type PromptContext,
  renderParts,
} from '@smarttavern/core';
import type { Translator } from '@smarttavern/i18n';
import type { Message, PromptPreset, Session } from '@smarttavern/schema';
import { BUILTIN_CALENDAR, type BuiltinSlot } from './builtin-content';

/** The clock reading of a session, as structured parts. See the header for `initialClock`. */
export function clockOf(session: Session): ClockDisplay {
  return clockDisplay(BUILTIN_CALENDAR, session.initialClock);
}

/**
 * The VISIBLE clock sentence, with the surrounding words from the catalog.
 *
 * `renderParts` supplies the data half (`纪元 1 一月 1 06:30`) and the segment name
 * comes from the calendar's own `segments`; only the connecting prose and its
 * punctuation are translated. So a language switch moves the glue and leaves the
 * world's month and day-part names exactly as authored — which is ADR-030's line
 * between UI copy and content.
 *
 * WHY THE SEGMENT IS OPTIONAL: `Calendar.segments` may be empty (a world that does
 * not name its day-parts), and `display().segments` is then `[]`. Dropping the
 * placeholder is the only honest rendering; inventing a name would put a segment in
 * the UI that `segmentOf` cannot report.
 */
export function worldClockText(reading: ClockDisplay, t: Translator['t']): string {
  const date = renderParts(reading);
  const segment = reading.segments[0]?.name;
  if (segment === undefined) return t('play.clockNoSegment', { date });
  return t('play.clock', { date, segment });
}

/* ──────────────────────── the preset's app-side slot fill ─────────────────── */

/**
 * One `{slot}` token. SINGLE braces, and that is the whole point: the composer's
 * macro syntax is `{{name}}`, so this pass cannot claim, consume or shadow a macro.
 * The lookbehind is what keeps the two apart — it refuses a `{` that is itself
 * preceded by `{`, so the `{date}` inside `{{date}}` is not a slot.
 */
const PROMPT_SLOT = /(?<!\{)\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * Substitute the app-owned `{slot}` tokens of a block's content.
 *
 * WHY THE APP HAS A FILL PASS AT ALL. A `PromptBlock` is data: the composer can
 * expand `{{macros}}` from the context, but it cannot read `session.refs.world.id`,
 * because that is the app's own shape and `packages/core` must not know it. So the
 * app fills the slots before `compose()` runs, and the two passes stay disjoint:
 * slots are single-braced and are gone before the macro pass sees the text.
 *
 * AN UNFILLED SLOT STAYS VISIBLE, exactly as an unresolved macro does — the same
 * rule for the same reason (`engine/prompt/macros.ts`): silently substituting ''
 * would delete a sentence fragment and no one would notice. This is also why the
 * caller's slot bag is typed rather than a `Record<string, string>`: a typo is a
 * compile error, not a token in the prompt.
 */
export function fillSlots(
  content: string,
  slots: Readonly<Partial<Record<BuiltinSlot, string>>>,
): string {
  return content.replace(PROMPT_SLOT, (token: string, name: string): string => {
    const value = slots[name as BuiltinSlot];
    return value === undefined ? token : value;
  });
}

/* ──────────────────────────── the message chain ───────────────────────────── */

/**
 * The messages of the ACTIVE CHAIN as wire messages, oldest first.
 *
 * Three drop rules, all inherited from the M0 assembly they replace — the reasons
 * did not change when the assembly moved into the composer:
 * - `system` / `tool` turns in the chain belong to the tool protocol and to the
 *   preset. Re-emitting a stored `system` turn puts a SECOND, stale instruction set
 *   in front of the model, and a `tool` turn without the call it answers is
 *   rejected by every vendor.
 * - An EMPTY turn is dropped. An empty assistant turn is what a turn that failed
 *   before its first delta leaves behind, and `content: ''` is a request some
 *   vendors reject outright.
 *
 * `speakerId` survives because it is not something a provider reads: it is
 * presentation state the UI re-renders, which is why the port's type carries it.
 */
export function toWireMessages(chain: readonly Message[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const message of chain) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.content === '') continue;
    messages.push(
      message.speakerId === undefined
        ? { role: message.role, content: message.content }
        : { role: message.role, content: message.content, speakerId: message.speakerId },
    );
  }
  return messages;
}

/* ──────────────────────────────── the context ─────────────────────────────── */

/**
 * One turn's `PromptContext`, built from the session, its active chain, the current
 * input and the world clock.
 *
 * `history` EXCLUDES the current input: the composer appends it itself (and expands
 * its macros), so passing it in the chain would send the user's turn twice. The
 * chain is walked from `Session.headMessageId` by the repository, so a discarded
 * branch is already absent — reassembling the tree here would re-introduce the bug
 * that walk exists to prevent.
 *
 * `turnNumber` is 1-based and counts the USER turns already stored: the turn about
 * to be sent is this one, which is what `conditions.minTurns` and `{{round}}` mean
 * by "the turn number".
 *
 * WHY THE PIN IDS STAND IN FOR NAMES: `{{world.name}}` has an expander, but a
 * session holds no world NAME — no `WorldVersion` row exists yet (docs/06 §8.5
 * 决定 1). A macro that cannot be resolved must stay unresolved (a deliberate rule
 * in `engine/prompt/macros.ts`), and leaving `{{char}}` raw in a system prompt is
 * worse than the id, so the id is supplied as the name until M1-W1 resolves it.
 * `variables` is empty because M1-S6 owns session variables: `{{getvar::x}}` then
 * stays unresolved and appears in `unresolvedMacros` instead of substituting ''.
 */
export function promptContext(
  session: Session,
  chain: readonly Message[],
  input: string,
  clock: ClockDisplay,
): PromptContext {
  const history = toWireMessages(chain);
  return {
    characterName: session.refs.playerCharacter.id,
    userName: session.refs.playerCharacter.id,
    worldName: session.refs.world.id,
    turnNumber: history.filter((message) => message.role === 'user').length + 1,
    history,
    input: { role: 'user', content: input },
    clock,
    variables: {},
  };
}

/**
 * The values the built-in preset's `{slot}` tokens expect, read from the session's
 * own pins. See `composeTurn` for where they are applied.
 *
 * WHY VERSION NUMBERS ARE HERE AND NOT IN THE CONTEXT: they are text in a block, so
 * they are part of the slot fill; the `MacroContext` has no version field, and
 * inventing one would be a preset-engine change rather than an app one.
 */
export function promptSlots(session: Session): Record<BuiltinSlot, string> {
  const { world, playerCharacter } = session.refs;
  return {
    worldId: world.id,
    worldVersion: String(world.version),
    userId: playerCharacter.id,
    userVersion: String(playerCharacter.version),
  };
}

/**
 * Compose one turn's messages through the real `PromptComposer`.
 *
 * The return type is `compose`'s own discriminated result rather than a local
 * `{ ok: boolean }`: `ComposeFailure` has no `messages` field at all, so an
 * over-budget assembly cannot be forwarded by forgetting one `if` (that split is
 * recorded in `engine/prompt/types.ts` as its whole reason).
 *
 * The slot fill happens HERE and not in `compose`, because the preset's `{slot}`
 * tokens are the app's own notation over the app's own session shape (see
 * `fillSlots`). Filling the block contents — rather than the composed messages —
 * keeps the argument text that macros expand to untouched: a slot value that
 * happened to contain `{{...}}` is filled in first, so it is data, never a macro.
 */
export function composeTurn(
  preset: PromptPreset,
  context: PromptContext,
  budget: PromptBudget,
  slots: Readonly<Partial<Record<BuiltinSlot, string>>>,
): ReturnType<typeof compose> {
  const filled: PromptPreset = {
    ...preset,
    blocks: preset.blocks.map((block) => ({ ...block, content: fillSlots(block.content, slots) })),
  };
  return compose(filled, context, budget);
}
