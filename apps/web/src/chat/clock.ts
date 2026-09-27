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
 * WHY THE CLOCK IS `session.state.clock` (ADR-032)
 * docs/02 §5.7 puts the LIVE time in `SessionState.clock`, and ADR-032 gave
 * `SessionState` a persistence slot: `Session.state`, required, completed at the
 * read boundary for rows written before the field existed. So the clock the app
 * shows and prompts with is the session's own live state — the value a turn
 * advances and a checkpoint snapshots — and NOT `Session.initialClock`, which is
 * still here and still means something narrower: the world's `startMinute`, the
 * origin this session began at and the minute every derived default state starts
 * from (`defaultSessionState`). It never moves, so it must not be deleted, and it
 * must not be shown as "now" either.
 *
 * Reading it in ONE place (`clockOf`) is what made that swap a change here rather
 * than at every call site.
 *
 * WHERE THIS MODULE SITS. It is the seam between three layers that must not import
 * each other: `@smarttavern/core` (the engine, which computes), the app's built-in
 * content (the data, which the app owns until M1-W1/I2), and `packages/i18n` (the
 * glue words, passed in as `t` so this module never reaches for the locale store).
 */
import {
  advance,
  type ChatMessage,
  type ClockDisplay,
  calendarView,
  // Imported under a local name on purpose: the bare identifier `display` collides
  // with the DOM's global `display` accessor in a browser, and a bundler that resolved
  // the free name to that global would silently call the wrong thing at runtime.
  display as clockDisplay,
  compose,
  hourOfDayAt,
  type PromptBudget,
  type PromptContext,
  renderParts,
  resolveSegments,
} from '@smarttavern/core';
import type { Translator } from '@smarttavern/i18n';
import type { Message, PromptPreset, Session, SessionState } from '@smarttavern/schema';
import { BUILTIN_CALENDAR, type BuiltinSlot } from './builtin-content';

/** The clock reading of a session, as structured parts. See the header for `initialClock`. */
export function clockOf(session: Session): ClockDisplay {
  return clockDisplay(BUILTIN_CALENDAR, session.state.clock);
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

/* ───────────────────────────── advancing the clock ────────────────────────── */

/**
 * Move a session state's clock by `delta` minutes — M1-T2's engine half.
 *
 * THE ARITHMETIC IS THE ENGINE'S, NOT THIS MODULE'S
 * `advance()` (`packages/core/src/engine/time/clock.ts`) owns the calendar walk and
 * returns a `TimeStep`; this function only decides WHICH VALUE becomes the session's
 * new `clock`. Re-deriving the minute here (`state.clock + delta * 60`) would work for
 * the built-in 60-minute hour and quietly break for a world whose `minutesPerHour` is
 * not 60 — a data edit, not a code change, which is exactly the kind of bug the engine
 * exists to prevent. It returns a NEW state and moves no input, like every other
 * engine operation (docs/02 §5.7's "time went back but the state did not" must be
 * inexpressible).
 *
 * WHY ONLY `clock` MOVES: `session.state.clock` is what `clockOf` reads and what the
 * prompt's time block is built from (ADR-032), so it is the one field a manual advance
 * has to write. `scene.time` is the SCENE's own timestamp — a transcription of when
 * the current scene opened — and a later scene tracker (M3) is what keeps it; guessing
 * at it here would be a second, unchecked clock.
 *
 * WHY NEGATIVE DELTAS ARE ALLOWED: "set the clock back" is a documented user
 * operation and a checkpoint rollback has to be expressible (docs/02 §5.7), so a
 * custom amount below zero is a request, not an error. `advance` already defines what
 * "crossed" means in that direction.
 *
 * WHAT IS DELIBERATELY NOT HERE (docs/02 §5.7's advance policy)
 * `timeRhythm` (the implicit every-N-turns advance) and `advance_time`'s
 * auto / ask / deny choice belong to the APPROVAL UI, not to this function: a pure
 * function cannot ask a human, and the rule that "more than one day forces ask" is a
 * decision about who may call `advance`, not about what `advance` computes. The manual
 * controls on the play screen are the one caller today, and their whole policy is
 * "the user pressed the button".
 */
export function advanceState(state: SessionState, delta: number): SessionState {
  const step = advance({ delta, calendar: BUILTIN_CALENDAR, fromMinute: state.clock });
  return { ...state, clock: step.toMinute };
}

/**
 * The minutes one 「+时段」 press moves: to the START of the day segment after the one
 * the clock is in.
 *
 * WHY THE NEXT BOUNDARY AND NOT A FIXED `stepMinutes`: the built-in calendar's four
 * segments happen to be six hours each, so `+360` would look right and be wrong for
 * every other set of windows — segments are world content and their widths are not
 * uniform (docs/02 §5.7's `timeRhythm.stepMinutes` is a separate, optional number the
 * world declares). Going to the next boundary makes the control mean "the next
 * stretch of the day" for any calendar, which is what the label promises.
 *
 * The search is a scan over the resolved windows for the first `fromHour` strictly
 * after the current hour, plus the first one after a full day; it uses the engine's
 * own `resolveSegments` + `hourOfDayAt`, so an overnight window (`夜` declared 22 → 4)
 * is flattened by the engine rather than re-interpreted here.
 *
 * A calendar with NO segments has no boundaries to aim at, so the answer falls back to
 * one hour. That is the one number this module states rather than derives, and it is
 * deliberately the same quantity the 「+1 小时」 button moves: with nothing named about
 * the day, "the next part of the day" has no meaning and an hour is the honest step.
 */
export function segmentStep(state: SessionState): number {
  const view = calendarView(BUILTIN_CALENDAR);
  const segments = resolveSegments(BUILTIN_CALENDAR.segments, view.hoursPerDay);
  if (segments.length === 0) return view.minutesPerHour;

  const { hour, minute } = hourOfDayAt(view, state.clock);
  // The next declared boundary strictly after this hour. A segment may legitimately be
  // ABSENT here (a calendar whose windows do not cover every hour), so the scan is over
  // the resolved windows rather than "the segment after the current one" — the latter
  // would have nothing to answer with on an uncovered minute like 03:00 of a calendar
  // that only names 06:00-12:00.
  const after = segments
    .filter((segment) => segment.fromHour > hour)
    .reduce<number | undefined>(
      (earliest, segment) =>
        earliest === undefined || segment.fromHour < earliest ? segment.fromHour : earliest,
      undefined,
    );
  // No boundary later today, so the step crosses midnight into the first one: the hours
  // are measured on a circular day, which is also why a `fromHour` of 0 works here.
  const firstBoundary = segments.reduce(
    (lowest, segment) => Math.min(lowest, segment.fromHour),
    view.hoursPerDay,
  );
  const nextHour = after ?? firstBoundary + view.hoursPerDay;
  // Whole hours to the boundary, then back out the minutes already past the hour, so
  // the step lands exactly ON the boundary rather than an hour's worth of minutes on.
  return (nextHour - hour) * view.minutesPerHour - minute;
}

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
 *
 * `variables` IS `session.state.vars` (M1-S6, ADR-031): the session's live variable
 * table is what a `{{getvar::hp}}` reads, and it is passed in here rather than looked
 * up again so the value the prompt substitutes is the value the status bar shows. An
 * undefined variable still stays VERBATIM in the text and is reported through
 * `unresolvedMacros` — never silently empty. The composer also records every
 * `{{setvar}}` / `{{addvar}}` it performs into `variableChanges`, which is a LOG and
 * not a write: `compose` is pure, and `chat/send-turn.ts` (the layer that owns
 * persistence) applies it to the state afterwards.
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
    variables: session.state.vars,
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
 * `fillSlots`). It is applied to the BLOCK CONTENTS rather than to the composed
 * messages, because filling the composed text would mean editing text the macro
 * expander had already produced.
 *
 * WHAT MAKES THAT SAFE IS THE VALUES, NOT THE ORDER: the fill lands BEFORE the macro
 * pass, so a slot value that contained `{{...}}` WOULD be scanned and expanded like any
 * other text — `engine/prompt/macros.ts` states exactly that as a deliberate rule, since
 * the expander is a stateless text function and cannot tell a macro from a value that
 * looks like one. Today's slots are ids and version numbers copied from the session's
 * pins (`promptSlots`), so none of them can contain a brace. A future slot fed from FREE
 * TEXT must escape or refuse `{{` before it is put in a slot; the ordering above is not
 * what makes it data.
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
