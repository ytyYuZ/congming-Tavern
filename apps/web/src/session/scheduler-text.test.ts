/**
 * The turn scheduler's reason sentences, in the catalog's terms (M1-S5).
 *
 * WHY THIS TEST STAYS IN THE APP LAYER. The rule itself moved to `@smarttavern/core`
 * (`packages/core/src/engine/turn/scheduler.ts`), and it deliberately speaks in
 * STRUCTURED reasons: `docs/02` §5.6 and the dependency checker keep `packages/core`
 * locale-free, so only these small mappers connect a fact to a `MessageKey` and its
 * params. The pairs are asserted literally because a renamed key is a silent user-facing
 * break: `MessageKey` would catch the key, but not a missing number in `params`.
 */
import { exclusionReasonFact } from '@smarttavern/core';
import { describe, expect, it } from 'vitest';
import { exclusionReasonText, refusalReasonText, speakerReasonText } from './scheduler-text';

/* ─────────────────────── the reason sentences (text) ─────────────────────── */

describe('M1-S5: the reasons in the catalog terms', () => {
  it('maps every selection reason to a catalog sentence with its numbers', () => {
    expect(speakerReasonText({ kind: 'manual', position: 2 })).toEqual({
      key: 'play.schedulerReasonManual',
      params: { position: 2 },
    });
    expect(speakerReasonText({ kind: 'desire-ability', desire: 80, ability: 70 })).toEqual({
      key: 'play.schedulerReasonScore',
      params: { desire: 80, ability: 70 },
    });
  });

  it('names the user intervention in the catalog terms and in the stored fact (M1-S4)', () => {
    // WHY THE SENTENCES ARE THEIR OWN KEYS: a muted or absent member was not refused by a cap,
    // so reusing the limit sentences would describe a rule that never applied. The two facts are
    // distinct here for the same reason they are distinct in `ExclusionReason`.
    expect(exclusionReasonText({ kind: 'muted' })).toEqual({
      key: 'play.schedulerExcludedMuted',
      params: {},
    });
    expect(exclusionReasonText({ kind: 'absent' })).toEqual({
      key: 'play.schedulerExcludedAbsent',
      params: {},
    });
    // ...and the PERSISTED trace names the intervention too, in an ASCII fact with no prose: a
    // plan row re-read months later must still say the silence was the user's rather than a cap's.
    expect(exclusionReasonFact({ kind: 'muted' })).toBe('muted=true');
    expect(exclusionReasonFact({ kind: 'absent' })).toBe('absent=present(false)');
  });

  it('maps every exclusion reason, and counts the rounds a cooldown still has to wait', () => {
    expect(exclusionReasonText({ kind: 'capped', limit: 1, linesTaken: 1 })).toEqual({
      key: 'play.schedulerExcludedCapped',
      params: { lines: 1, limit: 1 },
    });
    expect(exclusionReasonText({ kind: 'speaker-cap', limit: 3 })).toEqual({
      key: 'play.schedulerExcludedSpeakerCap',
      params: { limit: 3 },
    });
    expect(exclusionReasonText({ kind: 'card-missing' })).toEqual({
      key: 'play.schedulerExcludedCardMissing',
      params: {},
    });
    // THE NAMED-ASSIGNMENT REASON (M1-S4 split the two mappings): `not-in-cast` is the one a
    // cast listing can never produce, so it lives on the refusal mapping - and the exclusions
    // above still resolve through it unchanged, which is the point of the split.
    expect(refusalReasonText({ kind: 'not-in-cast' })).toEqual({
      key: 'play.schedulerExcludedNotInCast',
      params: {},
    });
    expect(refusalReasonText({ kind: 'capped', limit: 1, linesTaken: 1 })).toEqual(
      exclusionReasonText({ kind: 'capped', limit: 1, linesTaken: 1 }),
    );
    // THE TWO NUMBERS OF A COOLDOWN SENTENCE ARE DIFFERENT FACTS: how long the cooldown is,
    // and how much of it is left. A character with `cooldown: 2` whose last line was TWO round
    // boundaries ago is free after ONE more, so the sentence must say 1 - and an
    // implementation that swapped the two would be caught by the `cooldown: 3` case below,
    // where the two numbers are equal.
    expect(exclusionReasonText({ kind: 'cooling', cooldown: 2, roundsSince: 2 })).toEqual({
      key: 'play.schedulerExcludedCooling',
      params: { remaining: 1, cooldown: 2 },
    });
    expect(exclusionReasonText({ kind: 'cooling', cooldown: 3, roundsSince: 1 }).params).toEqual({
      remaining: 3,
      cooldown: 3,
    });
    // The distance the sentence is derived from is measured in round BOUNDARIES, so one round
    // closer is one round less to wait - the same cooldown, a different answer.
    expect(exclusionReasonText({ kind: 'cooling', cooldown: 3, roundsSince: 2 }).params).toEqual({
      remaining: 2,
      cooldown: 3,
    });
  });
});
