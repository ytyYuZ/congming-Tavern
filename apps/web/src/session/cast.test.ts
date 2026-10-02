/**
 * `session/cast.ts` — the cast intervention contract (M1-S4; docs/06 section 2.4's
 * 「用户干预卡司」 row, docs/01 F4-5, docs/02 section 5.6).
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONE'S OWN TERMS
 * The row's clause that names these two acts is 「禁言」 / 「把角色移出当前场景」, and the
 * acceptance is 「干预后调度器行为符合预期」. The scheduler's half of that is asserted in
 * `session/scheduler.test.ts` (the muted and absent rows of the state table, and the refusal of a
 * named assignment); what is left for THIS file is the value the scheduler reads, and it is
 * checked the way `chat/vars.test.ts` checks a variable:
 * 1. every write is PURE - the input state and its record come out unchanged, because a
 *    checkpoint taken a moment ago holds that very object (ADR-010);
 * 2. the two facts are INDEPENDENT - muting somebody does not put them back on stage, and taking
 *    them off stage does not unmute them - and a presentation detail another milestone wrote is
 *    not discarded by either;
 * 3. absence means the DEFAULT, in both directions: a member with no entry reads as present and
 *    unmuted, and returning to the default is written as ABSENCE, so the stored bytes of an undo
 *    are the bytes that were there before the intervention;
 * 4. a no-op is refused (`undefined`) rather than written, so a double click is not a change.
 */
import { defaultSessionState, type SessionState, SessionStateSchema } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  type CastIntervention,
  checkpointCastOf,
  defaultIntervention,
  intervene,
  interventionOf,
  isSelectable,
  restoreIntervention,
} from './cast';

const MIRA = 'char-mira';
const LEO = 'char-leo';

/** A session state whose cast record is exactly this, with the epoch clock. */
function stateWith(cast: SessionState['cast']): SessionState {
  return { ...defaultSessionState(0), cast };
}

/** The two standings a case needs, so an expectation reads as the act it is about. */
const MUTED: CastIntervention = { present: true, muted: true };
const OFF_STAGE: CastIntervention = { present: false, muted: false };
const PRESENT: CastIntervention = { present: true, muted: false };

describe('session/cast — the pure transition (M1-S4)', () => {
  it('reads an absent entry as present and unmuted, which is what the schema means by it', () => {
    // The default, in both spellings the live state can have: a record that mentions nobody, and
    // a record that is ABSENT (a session row written before the field existed - the read
    // boundary completes it with `{}`, which is the same thing).
    expect(interventionOf({}, MIRA)).toEqual(PRESENT);
    expect(interventionOf(undefined, MIRA)).toEqual(PRESENT);
    expect(interventionOf({ [MIRA]: { present: true } }, MIRA)).toEqual(PRESENT);
    expect(defaultIntervention()).toEqual(PRESENT);
    // ...and only a real entry says otherwise.
    expect(interventionOf({ [MIRA]: MUTED }, MIRA)).toEqual(MUTED);
    expect(interventionOf({ [MIRA]: OFF_STAGE }, MIRA)).toEqual(OFF_STAGE);
    expect(isSelectable(interventionOf({}, MIRA))).toBe(true);
    expect(isSelectable(interventionOf({ [MIRA]: MUTED }, MIRA))).toBe(false);
    expect(isSelectable(interventionOf({ [MIRA]: OFF_STAGE }, MIRA))).toBe(false);
  });

  it('writes through a new object: neither the old state nor its record moves', () => {
    const before = stateWith({ [LEO]: { present: true, emotion: 'wary' } });
    const result = intervene(before, MIRA, MUTED);
    if (result === undefined) throw new Error('the mute was refused');

    expect(result.state.cast).toEqual({
      [LEO]: { present: true, emotion: 'wary' },
      [MIRA]: { present: true, muted: true },
    });
    // The input is the value a checkpoint taken a moment ago holds. An in-place implementation
    // would have moved the save point with it, which is the bug ADR-010 exists to prevent.
    expect(before.cast).toEqual({ [LEO]: { present: true, emotion: 'wary' } });
    expect(result.state).not.toBe(before);
    expect(result.state.cast).not.toBe(before.cast);
    // Nothing but the cast changes: an intervention is not a clock, a scene or a variable edit.
    expect(result.state.clock).toBe(before.clock);
    expect(result.state.vars).toBe(before.vars);
    // The value it replaced is the WHOLE point of the answer: a save point's undo needs it.
    expect(result.previous).toEqual(PRESENT);
  });

  it('keeps the other fact and the presentation details when it writes one of them', () => {
    // Muting somebody who is off stage must not put them back on stage...
    const mutedWhileAway = intervene(stateWith({ [MIRA]: OFF_STAGE }), MIRA, {
      present: false,
      muted: true,
    });
    expect(mutedWhileAway?.state.cast?.[MIRA]).toEqual({ present: false, muted: true });
    // ...and an entry that carries an outfit survives both acts (the field is another
    // milestone's, so a silence must not silently discard it).
    const away = intervene(stateWith({ [MIRA]: { present: true, outfit: 'cloak' } }), MIRA, {
      present: false,
      muted: false,
    });
    expect(away?.state.cast?.[MIRA]).toEqual({ present: false, muted: false, outfit: 'cloak' });
    const back = intervene(stateWith({ [MIRA]: { present: false, outfit: 'cloak' } }), MIRA, {
      present: true,
      muted: false,
    });
    expect(back?.state.cast?.[MIRA]).toEqual({ present: true, muted: false, outfit: 'cloak' });
  });

  it('spells the default by ABSENCE, so an undo writes back the bytes that were there', () => {
    const before = stateWith({});
    const muted = intervene(before, MIRA, MUTED);
    if (muted === undefined) throw new Error('the mute was refused');
    expect(muted.state.cast).toEqual({ [MIRA]: { present: true, muted: true } });

    // The undo is the same transition with the value the mute replaced: the member returns to
    // the default, and the default is the ABSENT entry - not `{present: true, muted: false}`.
    expect(restoreIntervention(muted.state, MIRA, muted.previous)).toEqual(before);
    // ...which is what makes "restored" a row-level fact rather than a semantic one: the stored
    // value is `{}` again.
    expect(restoreIntervention(muted.state, MIRA, muted.previous)?.cast).toEqual({});
    // A round trip through the schema keeps that spelling, so a reader cannot see two states for
    // one cast: what is stored is what a session with no intervention has.
    expect(SessionStateSchema.parse(muted.state).cast).toEqual({
      [MIRA]: { present: true, muted: true },
    });
  });

  it('refuses a no-op instead of writing the row again', () => {
    expect(intervene(stateWith({}), MIRA, PRESENT)).toBeUndefined();
    expect(intervene(stateWith({ [MIRA]: MUTED }), MIRA, MUTED)).toBeUndefined();
    expect(restoreIntervention(stateWith({}), MIRA, PRESENT)).toBeUndefined();
    // An intervention that asks for a value the state already has must not answer a `previous`
    // either: there was nothing to replace, so the panel must not offer to undo it.
    expect(intervene(stateWith({ [MIRA]: { present: false } }), MIRA, OFF_STAGE)).toBeUndefined();
  });

  it('leaves the other members alone', () => {
    const before = stateWith({ [LEO]: MUTED });
    const result = intervene(before, MIRA, OFF_STAGE);
    expect(result?.state.cast).toEqual({ [LEO]: MUTED, [MIRA]: OFF_STAGE });
    expect(result?.previous).toEqual(PRESENT);
  });

  it('takes a checkpoint snapshot as a COPY, so a later mute cannot move it (M1-M1)', () => {
    const live = stateWith({ [MIRA]: MUTED });
    const snapshot = checkpointCastOf(live);
    expect(snapshot).toEqual({ [MIRA]: MUTED });
    expect(snapshot).not.toBe(live.cast);
    expect(snapshot[MIRA]).not.toBe(live.cast?.[MIRA]);
    // A checkpoint that aliased the record would follow every later intervention and stop being
    // "then" - the same rule `db/repository.ts`'s `copyState` applies to the whole state.
    expect(checkpointCastOf(stateWith(undefined))).toEqual({});
  });
});
