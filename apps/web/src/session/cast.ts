/**
 * The user's intervention in the cast, as a PURE function of `old state + edit -> new
 * state` (M1-S4; docs/06 section 2.4's row 「用户干预卡司」, docs/01 F4-5).
 *
 * WHAT THE ROW ASKS FOR, AND WHERE EACH ACT LIVES
 * The row's product list is 「编辑 AI 发言、代写并交还、禁言、强制下轮发言」 and its acceptance is
 * 「干预后调度器行为符合预期」. Two of those four already have a home and are deliberately NOT
 * rebuilt here:
 * - 编辑 AI 发言 and 代写并交还 are `state/chat-store.ts`'s `editMessage`: an edit writes a NEW
 *   SIBLING of the message with the same `speakerId` and moves the head to it (docs/02 §7's
 *   「同父多子」), so "the user wrote this line for a card, and the AI carries on from it" is
 *   already expressible - the row the model reads next is the person's text under the card's
 *   own id.
 * - 强制下轮发言 is the manual assignment M1-S5 already built (`speakNextTurn(characterId)`,
 *   recorded in `TurnPlan.overriddenByUser` and in the entry's `assigned-order=` reason). A
 *   second mechanism for it would be a second place where "who speaks next" is decided, and
 *   `Session.schedulerMode` (`'user'` is what a session is created with) is the mode that act
 *   belongs to; the AI-proposal mode that would need a stored order is M2-S1's.
 * So THIS module owns the two acts that had no home: 禁言 (mute) and 把角色移出当前场景 (take a
 * character off stage), plus the inverse of both, and it owns them as data.
 *
 * WHY A PURE MODULE AND NOT CODE INSIDE THE STORE OR THE PANEL
 * The fact being edited is LIVE session state (`Session.state.cast`, ADR-032), which is
 * snapshotted WHOLE into a checkpoint and written WHOLE to the row. An in-place edit would
 * move a value a checkpoint already holds (ADR-010) and would make "restore the cast to what
 * it was" inexpressible, which is exactly the act the milestone requires. So every function
 * here answers a NEW state and leaves its input untouched - the same rule as `chat/vars.ts`,
 * and for the same reason. Keeping it out of the panel also keeps the panel a renderer: it
 * decides where the controls are, never what an intervention means.
 *
 * WHY THE INTERVENTION IS AN EDIT AND NOT A TOGGLE
 * `intervene` takes the state the user WANTS to reach (`present` / `muted` as explicit
 * booleans), not "flip it". A toggle computed from a value the screen read a moment ago is the
 * lost-update bug in miniature - a second tab, a rollback or a re-read between paint and click
 * makes the flip land on the wrong side - while "make this member absent" is a request that
 * means the same thing whenever it arrives. The panel's two-step confirm reads the current
 * value and asks for the intended one, which is the same split `setVariable` uses.
 *
 * WHY UNDO IS A STATE VALUE AND NOT A HISTORY
 * `intervene` answers the standing it replaced (`previous`), so the caller can hold ONE value and
 * put it back (`restoreIntervention`). There is no stack and no edit log: the milestone asks that
 * a person be able to undo/restore their own edit, and a one-step undo whose value came from
 * the row is exactly that - a history would be a second source of truth for the cast, which is
 * the bug ADR-032 exists to remove. A save point is the way to go back further, and it works
 * because this value lives inside `Session.state` (see the header below).
 *
 * WHY AN ABSENT ENTRY IS SPELLED OUT RATHER THAN DELETED
 * An id with no entry in `Session.state.cast` means "present and not muted" (the schema records
 * this), which is what a session created before the field existed meant. So a member returned
 * to the default could be DELETED from the record - and this module does that, because the
 * stored bytes are then the smaller and more honest value, and a restore that put back the
 * record it replaced reproduces the exact bytes that were there. The entry is kept when it
 * still carries something the default does not (`emotion`, `outfit`, or the other flag), so an
 * unmute cannot silently discard a presentation detail another milestone wrote.
 */
import type { CastState, Id, SessionState } from '@smarttavern/schema';

/* ─────────────────────────────── the vocabulary ───────────────────────────── */

/**
 * The two things a person can decide about a cast member, and nothing else.
 *
 * `present: false` is 「把角色移出当前场景」: the character is off stage, so the scheduler does
 * not select them and a later turn does not speak for them. `muted: true` is 禁言: they are
 * still on stage - other characters can address them, and the transcript still shows them -
 * but they are deliberately not prompted. docs/02 §5.6 gives both as hard constraints of the
 * scheduler, which is why they are the two fields and not presentation details.
 */
export interface CastIntervention {
  readonly present: boolean;
  readonly muted: boolean;
}

/** What the scheduler and the screen read as a member's standing RIGHT NOW. */
export function defaultIntervention(): CastIntervention {
  return { present: true, muted: false };
}

/**
 * The standing of one member of the live state, with the defaults applied.
 *
 * ONE PLACE DECIDES WHAT ABSENCE MEANS. `Session.state.cast` may have no entry for a member
 * (the schema makes the field optional and treats a missing id as the default), and every
 * caller - the scheduler, the panel, the write below - must agree about that, or a member could
 * be "absent" to one of them and "present" to another. `noUncheckedIndexedAccess` makes the
 * lookup answer `undefined`, so the reader is forced through here rather than trusting `?`.
 */
export function interventionOf(cast: SessionState['cast'], characterId: Id): CastIntervention {
  const entry = cast?.[characterId];
  if (entry === undefined) return defaultIntervention();
  return { present: entry.present, muted: entry.muted === true };
}

/**
 * Whether the scheduler may consider this member at all - `false` for an absent or a muted
 * character, which is the fact `session/scheduler.ts` reports as `absent` / `muted`.
 *
 * It exists so the rule and the panel ask the same question in the same terms: the panel
 * renders "can speak" / "cannot speak and why" from the intervention, and the scheduler's
 * verdict is what decides. The REASON is deliberately not returned here - naming it is the
 * scheduler's job (`ExclusionReason`), because that is the vocabulary the stored plan and the
 * catalog sentences are built on.
 */
export function isSelectable(intervention: CastIntervention): boolean {
  return intervention.present && !intervention.muted;
}

/* ───────────────────────────── the pure transition ────────────────────────── */

/** What one intervention did: the new state, and the one it replaced. */
export interface InterventionResult {
  /** The state to persist. A NEW object; the input is untouched. */
  readonly state: SessionState;
  /** The value that was there before - this is what makes undo one assignment. */
  readonly previous: CastIntervention;
}

/**
 * Apply one cast member's intervention and answer the new state plus what it replaced.
 *
 * WHY IT ANSWERS `undefined` FOR A NO-OP: asking for the value that is already there is not an
 * intervention, and writing the row anyway would make a mis-aimed double click look like a
 * change (and would give the panel a "previous" value that is not one). The caller reports
 * "nothing to do" rather than a save.
 *
 * WHY THE OTHER FLAG IS READ FROM THE STORED ENTRY AND NOT FROM THE CALLER: the two facts are
 * independent - muting somebody must not put them back on stage, and taking them off stage must
 * not unmute them - so the transition writes one field and PRESERVES the other, along with any
 * presentation detail (`emotion`, `outfit`) that another milestone may have recorded.
 */
export function intervene(
  state: SessionState,
  characterId: Id,
  next: CastIntervention,
): InterventionResult | undefined {
  const cast = state.cast ?? {};
  const previous = interventionOf(state.cast, characterId);
  if (previous.present === next.present && previous.muted === next.muted) return undefined;
  const entry = cast[characterId];
  // The default is spelled by ABSENCE: an entry that carries nothing but the defaults is
  // removed, so the stored record stays the set of members something was actually decided
  // about, and `interventionOf` reads the same value back. Only the PRESENTATION fields are
  // asked about - `muted` belongs to the intervention being written, and `present` is always
  // there, so neither is a reason to keep an entry alive.
  const carriesNothingElse =
    entry === undefined || (entry.emotion === undefined && entry.outfit === undefined);
  const updated: Record<Id, CastState> = { ...cast };
  if (next.present && !next.muted && carriesNothingElse) {
    delete updated[characterId];
  } else {
    updated[characterId] = {
      ...(entry ?? {}),
      present: next.present,
      muted: next.muted,
    };
  }
  return { state: { ...state, cast: updated }, previous };
}

/**
 * Put a member's standing back - the undo an intervention's `previous` value is for.
 *
 * WHY THIS IS THE SAME TRANSITION AND NOT A SECOND ONE
 * `intervene` already is "make this member's standing be this value", and an undo is exactly
 * that with the value the user had a moment ago - so this function is a NAME for the intent
 * rather than a second implementation, and an entry that carries only the defaults is spelled by
 * absence on the way back exactly as it was before (which is what makes the restore reproduce
 * the bytes that were there). A separate "un-mute" path would be a second place where the
 * meaning of an entry is decided, and the two would drift the first time one of them changed.
 *
 * Answers `undefined` when the standing is already that value, so an undo of an undo writes
 * nothing rather than re-writing the row it just read.
 */
export function restoreIntervention(
  state: SessionState,
  characterId: Id,
  previous: CastIntervention,
): SessionState | undefined {
  return intervene(state, characterId, previous)?.state;
}

/**
 * The live cast record a CHECKPOINT should carry, or `{}` when the state has none.
 *
 * WHY THIS EXISTS AS A FUNCTION RATHER THAN AS `state.cast ?? {}` AT THE CALL SITE: the save
 * point's `castState` and the session's live `cast` are the same fact at two moments, so the
 * snapshot must be taken by reading the live value - never by re-deriving it from the roster,
 * which would make a save point claim a cast the user had intervened in. It is a COPY, for the
 * reason `db/repository.ts`'s `copyState` gives: a snapshot that aliased the live record would
 * follow every later mute and stop being "then".
 */
export function checkpointCastOf(state: SessionState): Record<Id, CastState> {
  const copy: Record<Id, CastState> = {};
  for (const [id, entry] of Object.entries(state.cast ?? {})) copy[id] = { ...entry };
  return copy;
}
