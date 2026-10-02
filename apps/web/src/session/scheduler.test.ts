/**
 * The turn scheduler's rule (M1-S5), as a pure function: no DOM, no database, no React.
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONE'S OWN TERMS
 * The docs/06 row for M1-S5 gives two acceptance clauses - "the caps are enforced as hard
 * limits" and "the TurnPlan is stored" - and the task's own list adds three more properties:
 * a table of states with literal expectations, determinism, and a named no-candidate outcome.
 * Every one of them is a case below, and the two acceptance clauses are named in the test
 * titles so a reader can map the row to its evidence without guessing.
 *
 * WHY THE LIMITS ARE TESTED IN PAIRS (a blocked case AND its control)
 * "maxLinesPerRound excludes a candidate" is only meaningful next to a state where that same
 * candidate IS chosen: without the control, a test passes for an implementation that ignores
 * every candidate, and without the blocked case it passes for one that ignores the limits.
 * Both halves are asserted against the SAME fixture, so the difference between them is exactly
 * the line the rule draws.
 *
 * WHY A TABLE OF STATES AND NOT ONE EXAMPLE
 * The interesting positions of this rule are combinations: who has spoken this round, who
 * spoke in an earlier one, who has no card at all, and how many distinct speakers the round
 * already has. A table makes those positions comparable at a glance and makes a missed
 * combination visible as a missing row rather than as a missing test.
 */
/** @vitest-environment node */
import { type Id, TurnPlanSchema, type VoiceProfile } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  type CastMember,
  MAX_SPEAKERS_PER_ROUND,
  planDraftOf,
  planTurn,
  type SchedulerInput,
  type SpokenLine,
} from './scheduler';
import { exclusionReasonText, speakerReasonText } from './scheduler-text';

/* ──────────────────────────────── fixtures ───────────────────────────────── */

/** A voice profile with the neutral middle of every range, plus what a case changes. */
function voice(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return { desire: 50, ability: 50, roles: [], maxLinesPerRound: 2, cooldown: 0, ...overrides };
}

/** One cast member whose NAME is its id, so an expectation reads as an id. */
function member(id: string, overrides: Partial<VoiceProfile> = {}): CastMember {
  return { id, name: id, voice: voice(overrides) };
}

/** A pin whose card version cannot be read: no name, no profile (see `castMemberOf`). */
function unreadable(id: string): CastMember {
  return { id, name: undefined, voice: undefined };
}

/** One line the cast has already spoken. */
function line(speakerId: Id): SpokenLine {
  return { role: 'assistant', speakerId };
}

/** One message the PLAYER sent: each one starts a round. */
const PLAYER: SpokenLine = { role: 'user', speakerId: undefined };

/** The ids a schedule put in the round, in order. */
function entryIds(schedule: { entries: readonly { characterId: Id }[] }): Id[] {
  return schedule.entries.map((entry) => entry.characterId);
}

/** The (id, reason kind) pairs a schedule left out, in order. */
function exclusions(schedule: {
  excluded: readonly { characterId: Id; reason: { kind: string } }[];
}): (readonly [Id, string])[] {
  return schedule.excluded.map((entry) => [entry.characterId, entry.reason.kind] as const);
}

/* ───────────────────────── a table of round states ───────────────────────── */

/** One row of the state table: the input, and the whole answer it must produce. */
interface StateRow {
  readonly name: string;
  readonly cast: readonly CastMember[];
  readonly history: readonly SpokenLine[];
  /** The round order, as ids. */
  readonly order: readonly Id[];
  /** Who was left out and the KIND of reason, in the order the rule reports them. */
  readonly excluded: readonly (readonly [Id, string])[];
  /** The next speaker's id, or `undefined` when nobody can speak. */
  readonly next: Id | undefined;
}

const STATES: readonly StateRow[] = [
  {
    name: 'a fresh round ranks by desire + ability',
    cast: [member('a', { desire: 50, ability: 50 }), member('b', { desire: 80, ability: 30 })],
    history: [],
    order: ['b', 'a'],
    excluded: [],
    next: 'b',
  },
  {
    name: 'a tie breaks by cast order (the order the pins recorded)',
    cast: [member('a', { desire: 60, ability: 40 }), member('b', { desire: 40, ability: 60 })],
    history: [],
    order: ['a', 'b'],
    excluded: [],
    next: 'a',
  },
  {
    name: 'the current round is counted from the last player message',
    cast: [member('a', { maxLinesPerRound: 3 }), member('b', { desire: 70 })],
    // A spoke in an EARLIER round, B in this one: only B's line counts for this round, and
    // only A's carries a cooldown distance.
    history: [PLAYER, line('a'), PLAYER, line('b')],
    order: ['b', 'a'],
    excluded: [],
    next: 'b',
  },
  {
    name: 'a character may take its second turn when its line budget allows it',
    cast: [member('a', { maxLinesPerRound: 2 }), member('b', { desire: 10 })],
    history: [PLAYER, line('a')],
    order: ['a', 'b'],
    excluded: [],
    next: 'a',
  },
  {
    name: 'maxLinesPerRound blocks the turn its budget cannot pay for',
    cast: [member('a', { maxLinesPerRound: 1 }), member('b', { desire: 10 })],
    history: [PLAYER, line('a')],
    order: ['b'],
    excluded: [['a', 'capped']],
    next: 'b',
  },
  {
    name: 'cooldown blocks a character who spoke in the previous round',
    cast: [member('a', { cooldown: 1 }), member('b', { desire: 10 })],
    history: [PLAYER, line('a'), PLAYER],
    order: ['b'],
    excluded: [['a', 'cooling']],
    next: 'b',
  },
  {
    name: 'cooldown 0 means no cooldown at all (the previous round is free)',
    cast: [member('a', { cooldown: 0 }), member('b', { desire: 10 })],
    history: [PLAYER, line('a'), PLAYER],
    order: ['a', 'b'],
    excluded: [],
    next: 'a',
  },
  {
    name: 'a cooldown of 2 is still spent after one full round',
    cast: [member('a', { cooldown: 2 }), member('b', { desire: 10 })],
    history: [PLAYER, line('a'), PLAYER, PLAYER],
    order: ['b'],
    excluded: [['a', 'cooling']],
    next: 'b',
  },
  {
    name: 'the speaker cap admits the best three and names the fourth',
    cast: [
      member('a', { desire: 90 }),
      member('b', { desire: 80 }),
      member('c', { desire: 70 }),
      member('d', { desire: 60 }),
    ],
    history: [PLAYER],
    order: ['a', 'b', 'c'],
    excluded: [['d', 'speaker-cap']],
    next: 'a',
  },
  {
    name: 'a character who already spoke does not consume a further speaker slot',
    cast: [
      member('a', { desire: 90, maxLinesPerRound: 2 }),
      member('b', { desire: 80 }),
      member('c', { desire: 70 }),
      member('d', { desire: 60 }),
    ],
    // Three distinct speakers are already in this round, and A, B and C each still have a line
    // left: the cap is about PEOPLE, so they continue while D never gets in.
    history: [PLAYER, line('a'), line('b'), line('c')],
    order: ['a', 'b', 'c'],
    excluded: [['d', 'speaker-cap']],
    next: 'a',
  },
  {
    name: 'a pin whose card cannot be read is reported, never guessed at',
    cast: [member('a', { desire: 90 }), unreadable('ghost')],
    history: [],
    order: ['a'],
    excluded: [['ghost', 'card-missing']],
    next: 'a',
  },
  {
    name: 'everyone capped or cooling is a named outcome, not an empty answer',
    cast: [
      member('a', { desire: 90, maxLinesPerRound: 1, cooldown: 1 }),
      member('b', { desire: 80, maxLinesPerRound: 1, cooldown: 1 }),
    ],
    history: [PLAYER, line('a'), PLAYER, line('b')],
    order: [],
    excluded: [
      ['a', 'cooling'],
      ['b', 'capped'],
    ],
    next: undefined,
  },
  {
    name: 'an empty cast is its own outcome (a solo scene is not a failure)',
    cast: [],
    history: [PLAYER],
    order: [],
    excluded: [],
    next: undefined,
  },
];

describe('M1-S5: the round state table', () => {
  for (const row of STATES) {
    it(row.name, () => {
      const schedule = planTurn({ cast: row.cast, history: row.history });

      expect(entryIds(schedule)).toEqual([...row.order]);
      expect(exclusions(schedule)).toEqual(row.excluded.map((entry) => [entry[0], entry[1]]));
      if (row.next === undefined) {
        // THE NO-CANDIDATE OUTCOME IS NAMED: a caller receives a reason, never `undefined`
        // and never a crash - and the two reasons are distinguishable, because an empty cast
        // and a fully blocked one are fixed by different things.
        expect(schedule.next.kind).toBe('none');
        expect(schedule.next.kind === 'none' ? schedule.next.reason.kind : 'speaker').toBe(
          row.cast.length === 0 ? 'empty-cast' : 'nobody-eligible',
        );
      } else {
        expect(schedule.next.kind).toBe('speaker');
        expect(schedule.next.kind === 'speaker' ? schedule.next.speaker.characterId : '').toBe(
          row.next,
        );
      }
    });
  }
});

/* ────────────────────────────── determinism ──────────────────────────────── */

describe('M1-S5: determinism', () => {
  const input: SchedulerInput = {
    cast: [
      member('a', { desire: 70, ability: 20, maxLinesPerRound: 2, cooldown: 1 }),
      member('b', { desire: 70, ability: 20, maxLinesPerRound: 3, cooldown: 0 }),
      unreadable('ghost'),
      member('c', { desire: 10, ability: 10 }),
    ],
    history: [PLAYER, line('c'), PLAYER],
  };

  it('produces the SAME speaker and the same plan from the same input, twice', () => {
    const first = planTurn(input);
    const second = planTurn(input);

    // Deep equality, not just the speaker: the order, the exclusions and the reasons are all
    // part of the answer a plan row stores, so a rule that varied any of them would store a
    // different decision for the same state.
    expect(second).toEqual(first);
    // `a` and `b` score the same, so cast order decides and the answer does not depend on
    // object identity or on a draw.
    expect(first.next).toEqual({ kind: 'speaker', speaker: first.entries[0] });
    expect(entryIds(first)).toEqual(['a', 'b', 'c']);
    expect(first.next.kind === 'speaker' ? first.next.speaker.characterId : '').toBe('a');
  });

  it('is a pure function of its input: a fresh, structurally equal input agrees', () => {
    const rebuilt: SchedulerInput = {
      cast: input.cast.map((entry) => ({ ...entry })),
      history: input.history.map((entry) => ({ ...entry })),
    };
    expect(planTurn(rebuilt)).toEqual(planTurn(input));
  });
});

/* ─────────────────────── the acceptance clauses, by name ─────────────────── */

describe('M1-S5 acceptance: the limits are enforced as hard limits', () => {
  it('[上限被硬性强制执行] maxLinesPerRound excludes the character desire and ability would have chosen', () => {
    // A is the strongest speaker by a wide margin, so desire + ability alone would pick it.
    // Its own card caps it at one line per round and it has taken that line: the limit wins,
    // and `excluded` says which limit it was.
    const cast = [
      member('a', { desire: 95, ability: 95, maxLinesPerRound: 1 }),
      member('b', { desire: 5, ability: 5 }),
    ];
    const blocked = planTurn({ cast, history: [PLAYER, line('a')] });
    expect(blocked.next.kind === 'speaker' ? blocked.next.speaker.characterId : '').toBe('b');
    expect(blocked.excluded).toEqual([
      { characterId: 'a', name: 'a', reason: { kind: 'capped', limit: 1, linesTaken: 1 } },
    ]);

    // THE CONTROL: one line fewer in the transcript and the SAME fixture picks A. Without
    // this half, the assertion above would also pass for a rule that ignored A entirely.
    const control = planTurn({ cast, history: [PLAYER] });
    expect(control.next.kind === 'speaker' ? control.next.speaker.characterId : '').toBe('a');
    expect(control.excluded).toEqual([]);
  });

  it('[上限被硬性强制执行] cooldown excludes the character desire and ability would have chosen', () => {
    const cast = [
      member('a', { desire: 95, ability: 95, cooldown: 1, maxLinesPerRound: 5 }),
      member('b', { desire: 5, ability: 5 }),
    ];
    // A spoke in the ROUND BEFORE THIS ONE (one player message separates them), which is
    // exactly the distance a cooldown of 1 forbids.
    const blocked = planTurn({ cast, history: [PLAYER, line('a'), PLAYER] });
    expect(blocked.next.kind === 'speaker' ? blocked.next.speaker.characterId : '').toBe('b');
    expect(blocked.excluded).toEqual([
      { characterId: 'a', name: 'a', reason: { kind: 'cooling', cooldown: 1, roundsSince: 1 } },
    ]);

    // THE CONTROL, twice over: the same card with `cooldown: 0` is selectable at that exact
    // distance, and the same card with `cooldown: 1` is selectable when it spoke in THIS
    // round instead. The two halves are what separate "cooldown" from "has spoken before".
    const noCooldown = planTurn({
      cast: [
        member('a', { desire: 95, ability: 95, cooldown: 0 }),
        member('b', { desire: 5, ability: 5 }),
      ],
      history: [PLAYER, line('a'), PLAYER],
    });
    expect(noCooldown.next.kind === 'speaker' ? noCooldown.next.speaker.characterId : '').toBe('a');

    const sameRound = planTurn({ cast, history: [PLAYER, line('a')] });
    expect(sameRound.next.kind === 'speaker' ? sameRound.next.speaker.characterId : '').toBe('a');
  });

  it('[上限被硬性强制执行] the per-round speaker cap is the third limit, and it is independent', () => {
    const cast = [
      member('a', { desire: 90 }),
      member('b', { desire: 80 }),
      member('c', { desire: 70 }),
      member('d', { desire: 60 }),
    ];
    const schedule = planTurn({ cast, history: [PLAYER] });
    expect(entryIds(schedule)).toHaveLength(MAX_SPEAKERS_PER_ROUND);
    expect(schedule.excluded).toEqual([
      { characterId: 'd', name: 'd', reason: { kind: 'speaker-cap', limit: 3 } },
    ]);
    // A caller may state the cap; nothing in the schema carries it yet (see the module
    // header), so the argument is the whole interface for it.
    const two = planTurn({ cast, history: [PLAYER], maxSpeakersPerRound: 2 });
    expect(entryIds(two)).toEqual(['a', 'b']);
  });

  it('refuses a named assignment the limits block, instead of silently choosing somebody else', () => {
    const cast = [
      member('a', { desire: 90, maxLinesPerRound: 1 }),
      member('b', { desire: 80 }),
      member('c', { desire: 70 }),
    ];
    // The user hands this turn to A, who has used its single line of the round. The answer is
    // a refusal carrying the same reason the excluded list carries - not B, and not a crash.
    const refused = planTurn({ cast, history: [PLAYER, line('a')], assignedOrder: ['a'] });
    expect(refused.next).toEqual({
      kind: 'refused',
      characterId: 'a',
      name: 'a',
      reason: { kind: 'capped', limit: 1, linesTaken: 1 },
    });
    // Nothing was decided in their favour, so the round order is the score's own.
    expect(entryIds(refused)).toEqual(['b', 'c']);

    // A named character the session does not contain is refused too: a stale screen must not
    // be able to hand the turn to a card that is not on stage.
    const stranger = planTurn({ cast, history: [], assignedOrder: ['nobody'] });
    expect(stranger.next).toEqual({
      kind: 'refused',
      characterId: 'nobody',
      name: undefined,
      reason: { kind: 'not-in-cast' },
    });
  });

  it('honours a valid named assignment, and records that it overrode the plan', () => {
    const cast = [
      member('a', { desire: 90 }),
      member('b', { desire: 80 }),
      member('c', { desire: 70 }),
    ];
    // C is last by score, so putting it first is an override - and the reason on the entry
    // says so, in the core's own terms rather than in prose.
    const assigned = planTurn({ cast, history: [], assignedOrder: ['c'] });
    expect(entryIds(assigned)).toEqual(['c', 'a', 'b']);
    expect(assigned.overriddenByUser).toBe(true);
    expect(assigned.next.kind === 'speaker' ? assigned.next.speaker.reason : undefined).toEqual({
      kind: 'manual',
      position: 1,
    });
    expect(assigned.next.kind === 'speaker' ? assigned.next.speaker.linesBudget : 0).toBe(2);

    // Assigning the character the score would have chosen anyway is NOT an override: the row
    // would otherwise claim the user changed a plan they agreed with.
    const agreed = planTurn({ cast, history: [], assignedOrder: ['a'] });
    expect(entryIds(agreed)).toEqual(['a', 'b', 'c']);
    expect(agreed.overriddenByUser).toBe(false);
  });
});

describe('M1-S5 acceptance: the TurnPlan is stored', () => {
  it('[TurnPlan 落库] the draft is a schema-valid TurnPlan row with an explainable entry and exclusion', () => {
    const schedule = planTurn({
      cast: [
        member('a', { desire: 80, ability: 70, maxLinesPerRound: 1 }),
        member('b', { desire: 20 }),
      ],
      history: [PLAYER, line('a')],
    });
    const draft = planDraftOf('session-1', 'user', schedule);

    // The row the repository mints an id and a timestamp for. Parsing it with the FROZEN
    // schema is what makes "the plan is stored" a fact about the contract rather than about
    // this module's own idea of the shape (the repository parses it again on the way in).
    const parsed = TurnPlanSchema.safeParse({ ...draft, id: 'plan-1', createdAt: 1 });
    expect(parsed.success).toBe(true);
    expect(draft.mode).toBe('user');
    expect(draft.round).toBe(1);
    expect(draft.entries).toEqual([
      {
        characterId: 'b',
        order: 0,
        linesBudget: 2,
        score: 70,
        reasons: ['rank=desire+ability', 'desire=20', 'ability=50'],
      },
    ]);
    // THE SILENCE IS EXPLAINED: this is the field docs/02 §7 and `turn.ts` both call the
    // reason a user can read, and it names the limit and the numbers behind it.
    expect(draft.excluded).toEqual([
      { characterId: 'a', reason: 'capped=maxLinesPerRound(1),lines=1' },
    ]);
    expect(draft.overriddenByUser).toBe(false);
  });

  it('stores facts, not sentences: every reason string is locale-free ASCII', () => {
    // A translated sentence inside a PERSISTED row would freeze the language it was written
    // in. The screen renders prose from the same structure (`scheduler-text.ts`), so the
    // stored strings must never carry copy - and a catalog key would tie the database to a
    // key a later edit may remove.
    const schedule = planTurn({
      cast: [
        member('a', { cooldown: 2 }),
        member('b', { maxLinesPerRound: 1 }),
        unreadable('ghost'),
        member('c', { desire: 10 }),
        member('d', { desire: 5 }),
      ],
      history: [PLAYER, line('b'), PLAYER],
      assignedOrder: ['a'],
    });
    const draft = planDraftOf('session-1', 'user', schedule);
    const facts = [
      ...draft.entries.flatMap((entry) => entry.reasons),
      ...draft.excluded.map((entry) => entry.reason),
    ];
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

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
    expect(exclusionReasonText({ kind: 'not-in-cast' })).toEqual({
      key: 'play.schedulerExcludedNotInCast',
      params: {},
    });
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
