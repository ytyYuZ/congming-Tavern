/**
 * Who speaks next: the pure selection core of M1-S5 (docs/06, section 2.4). The row's
 * product is "the user assigns the order by hand + a per-round speaker cap + a per-round
 * line cap", and its acceptance is "the caps are enforced as hard limits; the TurnPlan is
 * stored" - both halves live here or in the plan this module produces.
 *
 * WHY THIS IS A MODULE AND NOT A COMPONENT
 * The decision is a function of DATA: the session's cast, the recent transcript, and the
 * limits each pinned card carries. React has nothing to do with it and the DOM has nothing
 * to do with it, so it lives here, beside `session/roster.ts` (M1-S1's cast rule), which is
 * the same kind of session-domain pure rule and whose output this module consumes:
 * `Session.refs.cast` is the roster, and it already excludes the player.
 *
 * WHY NOT `packages/rules`
 * docs/02 section 5.6 puts the `TurnScheduler` in the engine layer, i.e. `packages/core`,
 * which this task may not touch. `packages/rules` is defined by its own manifest and header
 * as "dice, check resolution and retrieval, plus the built-in openly-licensed rule pack
 * data" - a turn scheduler is a session engine, not rules content, so hosting it there
 * would be a category error the next reader would have to undo. Two smaller reasons point
 * the same way: the dependency checker forbids `packages/rules` from importing
 * `packages/i18n` (even as a type), while this module's output has to be rendered in the
 * catalog's terms (`session/scheduler-text.ts`); and the app layer already owns the
 * session-domain pure rules (M1-S1, M1-S6, M1-T1).
 *
 * THE SELECTION RULE (M1-S5's "user" mode; docs/01 F4-6, docs/02 section 5.6)
 * 1. The user's manual assignment wins: an id they named comes first, in the order they
 *    named it. That is the milestone's product, and docs/02 says what the scheduler owes
 *    that mode: it validates the choice against the constraints and turns it into a plan.
 * 2. Everyone else is ranked by `voice.desire + voice.ability` - the two numbers M1-C3
 *    evaluates and the only numbers M1-S5 reads. This is NOT M2-S1's scored formula: no
 *    weights, no roles, no addressed / keyword / recency terms, no jitter. It exists so
 *    that "ask for the next turn" has an answer before a human has assigned anything.
 * 3. Ties break by the order the cast pins recorded, which is library order (M1-S1).
 *
 * THE HARD LIMITS (docs/02 section 5.6: local, and the model cannot break them)
 * - `VoiceProfile.maxLinesPerRound`: turns a character may take IN ONE ROUND. A character
 *   that has already taken that many lines this round is excluded ("capped").
 * - `VoiceProfile.cooldown`: rounds a character sits out AFTER a round they spoke in. The
 *   measure is the number of round boundaries between their last line and now, so a line in
 *   the CURRENT round is never what cools them down: within a round `maxLinesPerRound`
 *   governs, and across rounds `cooldown` does. That split is what makes `cooldown: 0` mean
 *   "no cooldown" (the identity) rather than "cannot speak twice in a row", and it is why
 *   the two limits are tested independently.
 * - `MAX_SPEAKERS_PER_ROUND` (`maxSpeakersPerRound` here): how many DISTINCT characters may
 *   speak in one round (docs/02 section 5.6's default of 3). A character who has not spoken
 *   this round is not selectable once the round is full.
 * All three are constraints, not hints: a candidate that violates one is not selectable, it
 * is reported in `excluded` with the reason, and the caller is told why.
 *
 * WHAT A ROUND IS, AND WHY IT NEEDS NO NEW STATE
 * A round is one thing the player did and the cast's answers to it: the round boundary is a
 * `user` message, so the round index is the number of user messages in the chain and "lines
 * taken this round" is read from the assistant messages after the last one. Every number
 * below is therefore a function of the transcript alone - there is no round counter to
 * store, to keep in step, or to lose on a reload.
 *
 * DETERMINISM (stated here, pinned by `scheduler.test.ts`)
 * The same input yields the same schedule, always, and the same input twice yields two
 * deep-equal values. There is NO randomness in this module at all: the docs/02 formula's
 * `jitter(seed)` belongs to M2-S1, and ties break by cast order rather than by a draw - so
 * nothing here needs an injected random source, and a test can assert an exact speaker
 * instead of a distribution.
 *
 * WHERE THE TWO LIMITS THAT ARE NOT HERE WENT (stated rather than silently dropped)
 * - The weighted scoring, and the session-level configuration its weights need, are M2-S1's:
 *   `packages/schema`'s `Session` carries `schedulerMode` but no weights and no caps, which
 *   is why `maxSpeakersPerRound` is an argument with a documented default rather than a
 *   stored setting.
 *
 * WHAT M1-S4 ADDED: THE USER'S OWN INTERVENTION, AS TWO MORE REASONS
 * docs/02 section 5.6's last two hard constraints - 「被 `muted` 的角色跳过；`present: false` 的
 * 角色不参与」 - are the user's edit of the cast rather than a property of a card, so they arrive
 * here as DATA (`SchedulerInput.cast`, the live `Session.state.cast` of ADR-032) rather than as
 * a flag on `CastMember`. That is the distinction the module's first version recorded and left
 * open: `Session.refs.cast` is the PINNED ROSTER (who is in the session) and `Checkpoint.castState`
 * is a SNAPSHOT (who was on stage at a save point), while the value the scheduler must read is
 * neither - it is "now", and it moves when the user mutes somebody.
 *
 * WHY THE INTERVENTION IS CHECKED BEFORE THE LIMITS, AND WHY IT HAS ITS OWN REASONS
 * A muted or absent member is not competing for the round at all, while a capped or cooling one
 * is a candidate the LIMITS refused; reporting "line limit reached" for somebody the user
 * explicitly silenced would name a rule that had nothing to do with the decision, and the
 * milestone's acceptance is that the scheduler's behaviour reflects the INTERVENTION. So the two
 * facts are named (`muted`, `absent`), they come first in the exclusion order, the scheduler's
 * own reason vocabulary is where they live, and `session/scheduler-text.ts` renders them in the
 * catalog's terms like every other reason. `absent` wins over `muted` when both are true: being
 * off stage is the more fundamental answer to "can they speak", and `present: false` is what
 * docs/02 section 5.6 makes the stronger constraint (「不参与」 rather than 「跳过」).
 */
import type {
  CastState,
  Id,
  Message,
  SchedulerMode,
  TurnPlanEntry,
  TurnPlanExclusion,
  VoiceProfile,
} from '@smarttavern/schema';

/* ---------------------------------- input ---------------------------------- */

/**
 * The most characters that may take a turn in one round (docs/02 section 5.6: default 3).
 *
 * It is a DEFAULT and not a stored setting because no field carries it: `Session` has
 * `schedulerMode` and nothing else about scheduling, and `SessionState` has no scheduler
 * section. A caller may pass `maxSpeakersPerRound`; M2-S1 is where a configurable value
 * gets a persisted home.
 */
export const MAX_SPEAKERS_PER_ROUND = 3;

/**
 * One member of the cast, as the scheduler needs it: an identity, a label, and the voice
 * profile of the PINNED card version.
 *
 * WHY `voice` AND `name` ARE BOTH OPTIONAL: a session pins `{id, version}` pairs, and the
 * row they name can be gone (a card deleted, a version never imported). That is not the
 * scheduler's failure to invent a profile for - a default desire or ability would be a
 * silent guess about a card nobody can read - so such a member is passed with both fields
 * `undefined` and comes back in `excluded` as `card-missing`.
 *
 * WHY THE USER'S INTERVENTION IS NOT A THIRD FIELD HERE: mute and presence are live state
 * that moves while the session is played (M1-S4), not a property of a member of the roster,
 * so they travel in `SchedulerInput.castState` beside the cast rather than being copied onto
 * each member by every caller - one value, read once, the way `Session.state.cast` stores it.
 */
export interface CastMember {
  readonly id: Id;
  readonly name: string | undefined;
  readonly voice: VoiceProfile | undefined;
}

/** What one stored message contributes to the schedule: the role, and who spoke. */
export interface SpokenLine {
  readonly role: Message['role'];
  readonly speakerId: Id | undefined;
}

/** The projection of one `Message` onto the only two fields the rule reads. */
export function spokenLineOf(message: Message): SpokenLine {
  return { role: message.role, speakerId: message.speakerId };
}

export interface SchedulerInput {
  /** The session's cast pins, resolved to their voice profiles. */
  readonly cast: readonly CastMember[];
  /** The ACTIVE chain, oldest first (`db/repository.ts`'s `getChain`). */
  readonly history: readonly SpokenLine[];
  /**
   * The LIVE cast state (M1-S4, ADR-032): `Session.state.cast`, keyed by character id. A
   * member with no entry is present and not muted, which is what an empty record and a
   * session created before the field existed both mean - so an absent field is not a
   * missing answer.
   */
  readonly castState?: Readonly<Record<Id, CastState>>;
  /**
   * The user's manual assignment for this round, most preferred first. An id that is not in
   * the cast is refused (`RefusalReason` `not-in-cast`) rather than ignored, so a stale
   * screen cannot hand the turn to somebody the session does not contain.
   */
  readonly assignedOrder?: readonly Id[];
  /** Defaults to `MAX_SPEAKERS_PER_ROUND`. */
  readonly maxSpeakersPerRound?: number;
}

/* --------------------------------- reasons --------------------------------- */

/**
 * Why a character was placed in the round. A structured fact, never prose: the catalogs own
 * the sentences (`session/scheduler-text.ts`) and the stored plan owns a locale-free trace
 * (`speakerReasonFact`), so a language switch cannot leave a stored sentence behind.
 */
export type SpeakerReason =
  | { readonly kind: 'manual'; readonly position: number }
  | { readonly kind: 'desire-ability'; readonly desire: number; readonly ability: number };

/**
 * Why a cast member cannot take a turn in this round.
 *
 * `muted` and `absent` are the user's OWN intervention (M1-S4) and come first in the order
 * `admit` reports them in: they are facts about who is in the scene at all, while `capped`,
 * `cooling` and `speaker-cap` are facts about the round's limits. `absent` is checked before
 * `muted` because being off stage (docs/02 section 5.6: 「不参与」) is the more fundamental
 * reason of the two.
 */
export type ExclusionReason =
  | { readonly kind: 'card-missing' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'muted' }
  | { readonly kind: 'capped'; readonly limit: number; readonly linesTaken: number }
  | { readonly kind: 'cooling'; readonly cooldown: number; readonly roundsSince: number }
  | { readonly kind: 'speaker-cap'; readonly limit: number };

/** Why a character the caller NAMED cannot take the turn. */
export type RefusalReason = ExclusionReason | { readonly kind: 'not-in-cast' };

/** One cast member the scheduler left out, with the reason the panel renders. */
export interface CastExclusion {
  readonly characterId: Id;
  readonly name: string | undefined;
  readonly reason: ExclusionReason;
}

/** One character's slot in the round, in the order the round will run. */
export interface PlannedSpeaker {
  readonly characterId: Id;
  readonly name: string | undefined;
  /** Position in the round: 0-based, ascending, and distinct. */
  readonly order: number;
  /** The ceiling from the card's `maxLinesPerRound`, stored as the plan's `linesBudget`. */
  readonly linesBudget: number;
  /** Lines already taken this round, so the gap between budget and use is visible. */
  readonly linesTaken: number;
  readonly desire: number;
  readonly ability: number;
  /** `desire + ability`; the plan row's `score` (the weighted formula is M2-S1). */
  readonly score: number;
  readonly reason: SpeakerReason;
}

/** Why NOBODY can take a turn. Named, so a caller never receives `undefined`. */
export type NoSpeakerReason =
  /** The session has no cast at all (a solo scene, or every pin was removed). */
  | { readonly kind: 'empty-cast' }
  /** There are cast members and every one of them is blocked; see `excluded` for each. */
  | { readonly kind: 'nobody-eligible' };

/** The answer to "who speaks now". Three named outcomes, and no fourth. */
export type SpeakerChoice =
  | { readonly kind: 'speaker'; readonly speaker: PlannedSpeaker }
  | { readonly kind: 'none'; readonly reason: NoSpeakerReason }
  | {
      readonly kind: 'refused';
      readonly characterId: Id;
      readonly name: string | undefined;
      readonly reason: RefusalReason;
    };

/** One round's decision: the order, the silences, and the person to ask next. */
export interface TurnSchedule {
  /** Round index from the transcript: the number of user messages in the chain. */
  readonly round: number;
  readonly entries: readonly PlannedSpeaker[];
  readonly excluded: readonly CastExclusion[];
  readonly next: SpeakerChoice;
  /** True when the stored order is not the one the score alone would have produced. */
  readonly overriddenByUser: boolean;
  readonly maxSpeakersPerRound: number;
}

/* -------------------------------- the rule --------------------------------- */

/** The lines each cast member has taken in the CURRENT round. */
function linesThisRound(history: readonly SpokenLine[], castIds: ReadonlySet<Id>): Map<Id, number> {
  const counts = new Map<Id, number>();
  for (let index = roundStartIndex(history); index < history.length; index += 1) {
    const line = history[index];
    if (line === undefined || line.role !== 'assistant') continue;
    const speaker = line.speakerId;
    if (speaker === undefined || !castIds.has(speaker)) continue;
    counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
  }
  return counts;
}

/** The index of the first line of the current round: just after the last user message. */
function roundStartIndex(history: readonly SpokenLine[]): number {
  let start = 0;
  for (let index = 0; index < history.length; index += 1) {
    if (history[index]?.role === 'user') start = index + 1;
  }
  return start;
}

/**
 * How many round boundaries have passed since `characterId` last spoke, or `undefined` when
 * they never have. `0` means their last line is in the current round.
 */
function roundsSinceLastLine(history: readonly SpokenLine[], characterId: Id): number | undefined {
  let last = -1;
  for (let index = 0; index < history.length; index += 1) {
    const line = history[index];
    if (line !== undefined && line.role === 'assistant' && line.speakerId === characterId) {
      last = index;
    }
  }
  if (last < 0) return undefined;
  let rounds = 0;
  for (let index = last + 1; index < history.length; index += 1) {
    if (history[index]?.role === 'user') rounds += 1;
  }
  return rounds;
}

/** The round index: one boundary per message the player sent. */
function countRounds(history: readonly SpokenLine[]): number {
  let round = 0;
  for (const line of history) {
    if (line.role === 'user') round += 1;
  }
  return round;
}

/** Everything the eligibility questions are asked against, derived once per call. */
interface RoundState {
  readonly round: number;
  readonly lines: Map<Id, number>;
  readonly spokenThisRound: ReadonlySet<Id>;
  readonly roundsSince: ReadonlyMap<Id, number | undefined>;
}

function roundStateOf(input: SchedulerInput): RoundState {
  const castIds = new Set(input.cast.map((member) => member.id));
  const lines = linesThisRound(input.history, castIds);
  const roundsSince = new Map<Id, number | undefined>();
  for (const member of input.cast) {
    roundsSince.set(member.id, roundsSinceLastLine(input.history, member.id));
  }
  return {
    round: countRounds(input.history),
    lines,
    spokenThisRound: new Set(lines.keys()),
    roundsSince,
  };
}

/**
 * Why a character with a readable voice profile cannot speak now, or `undefined` when they
 * can.
 *
 * WHY THE TWO LIMITS ARE ASKED IN THIS ORDER: a spent line budget is a fact about THIS round
 * and a cooldown is a fact about earlier ones, so when both apply the more local one is the
 * more useful sentence. They are independent constraints - each one alone can exclude a
 * candidate the other would have allowed - which is what `scheduler.test.ts` pins.
 */
function blockedBy(
  voice: VoiceProfile,
  linesTaken: number,
  roundsSince: number | undefined,
): ExclusionReason | undefined {
  if (linesTaken >= voice.maxLinesPerRound) {
    return { kind: 'capped', limit: voice.maxLinesPerRound, linesTaken };
  }
  // `roundsSince >= 1` is "their last line is in an EARLIER round", which is the only
  // position a cooldown speaks about: a line in this round is governed by the line budget
  // above, or a character with `maxLinesPerRound: 2` could never take its second turn.
  if (roundsSince !== undefined && roundsSince >= 1 && roundsSince <= voice.cooldown) {
    return { kind: 'cooling', cooldown: voice.cooldown, roundsSince };
  }
  return undefined;
}

/** `desire + ability`; `-1` for a member whose card cannot be read (never admitted). */
function scoreOf(member: CastMember): number {
  return member.voice === undefined ? -1 : member.voice.desire + member.voice.ability;
}

/** The 0-based position of `id` in `order`, or `undefined` when it is not there. */
function positionIn(order: readonly Id[], id: Id): number | undefined {
  const index = order.indexOf(id);
  return index < 0 ? undefined : index;
}

/** One cast member with the rank inputs resolved: the user's position, then the score. */
interface RankedMember {
  readonly member: CastMember;
  /** Its position in `Session.refs.cast`, which is the last tie-break (library order). */
  readonly castIndex: number;
  /** 0-based position in the user's assignment, or `undefined` when they did not name it. */
  readonly assignedPosition: number | undefined;
}

/**
 * The cast in the order the round will try them.
 *
 * WHY THE ASSIGNMENT IS A SORT KEY AND NOT A SEPARATE BRANCH: "the user assigned an order"
 * and "nobody assigned anything" are the same ranking with an empty key on one side, so the
 * limits are checked in ONE place against ONE list. A second code path for the manual case
 * is exactly where a cap would stop being enforced.
 */
function rank(cast: readonly CastMember[], assignedOrder: readonly Id[]): RankedMember[] {
  const ranked = cast.map((member, castIndex) => ({
    member,
    castIndex,
    assignedPosition: positionIn(assignedOrder, member.id),
  }));
  ranked.sort((left, right) => {
    const leftPosition = left.assignedPosition ?? Number.POSITIVE_INFINITY;
    const rightPosition = right.assignedPosition ?? Number.POSITIVE_INFINITY;
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    const byScore = scoreOf(right.member) - scoreOf(left.member);
    if (byScore !== 0) return byScore;
    return left.castIndex - right.castIndex;
  });
  return ranked;
}

/**
 * Why the USER's own intervention keeps this member out of the round, or `undefined` when it
 * does not (M1-S4).
 *
 * WHY `absent` IS ASKED FIRST: an off-stage character is not in the scene, so muting is not the
 * reason they cannot speak - reporting "muted" for somebody who was also taken off stage would
 * describe half the decision, and the reason is what the user reads in the panel to remember
 * what they did. An entry that is missing entirely is the DEFAULT (`present: true`,
 * `muted: false`), which is what a session created before the field existed means.
 */
function blockedByIntervention(
  castState: Readonly<Record<Id, CastState>> | undefined,
  characterId: Id,
): ExclusionReason | undefined {
  const entry = castState?.[characterId];
  if (entry === undefined) return undefined;
  if (!entry.present) return { kind: 'absent' };
  return entry.muted === true ? { kind: 'muted' } : undefined;
}

/**
 * Walk the ranking once and split it into the round's order and the silences.
 *
 * The speaker cap is counted AS THE RANKING IS WALKED: a member who already spoke this round
 * does not consume a new slot (they are continuing), while a member who did not can only be
 * admitted while `spoken + admittedNew` is under the cap. Members skipped for that reason
 * are excluded with `speaker-cap`, so the panel can say who was left out and why instead of
 * leaving a silent gap in the cast list.
 *
 * THE INTERVENTION IS CHECKED FIRST, BEFORE THE CARD AND BEFORE THE LIMITS (M1-S4): a muted or
 * absent member is not a candidate at all, so they must not consume a speaker slot, must not be
 * reported as capped, and must not be admitted even when the user NAMED them - which is what
 * makes `nextOf` answer `refused` with the intervention's own reason.
 */
function admit(
  ranked: readonly RankedMember[],
  state: RoundState,
  maxSpeakersPerRound: number,
  castState: Readonly<Record<Id, CastState>> | undefined,
): { entries: PlannedSpeaker[]; excluded: CastExclusion[] } {
  const entries: PlannedSpeaker[] = [];
  const excluded: CastExclusion[] = [];
  let newSpeakers = 0;
  for (const { member, assignedPosition } of ranked) {
    const intervention = blockedByIntervention(castState, member.id);
    if (intervention !== undefined) {
      excluded.push({ characterId: member.id, name: member.name, reason: intervention });
      continue;
    }
    const voice = member.voice;
    if (voice === undefined) {
      excluded.push({
        characterId: member.id,
        name: member.name,
        reason: { kind: 'card-missing' },
      });
      continue;
    }
    const linesTaken = state.lines.get(member.id) ?? 0;
    const reason = blockedBy(voice, linesTaken, state.roundsSince.get(member.id));
    if (reason !== undefined) {
      excluded.push({ characterId: member.id, name: member.name, reason });
      continue;
    }
    const isNewSpeaker = !state.spokenThisRound.has(member.id);
    if (isNewSpeaker && state.spokenThisRound.size + newSpeakers >= maxSpeakersPerRound) {
      excluded.push({
        characterId: member.id,
        name: member.name,
        reason: { kind: 'speaker-cap', limit: maxSpeakersPerRound },
      });
      continue;
    }
    if (isNewSpeaker) newSpeakers += 1;
    entries.push({
      characterId: member.id,
      name: member.name,
      order: entries.length,
      linesBudget: voice.maxLinesPerRound,
      linesTaken,
      desire: voice.desire,
      ability: voice.ability,
      score: voice.desire + voice.ability,
      reason:
        assignedPosition === undefined
          ? { kind: 'desire-ability', desire: voice.desire, ability: voice.ability }
          : { kind: 'manual', position: assignedPosition + 1 },
    });
  }
  return { entries, excluded };
}

/** Whether two round orders name the same characters in the same sequence. */
function sameOrder(left: readonly Id[], right: readonly Id[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/** The round order as plain ids, for the "did the user change it" comparison. */
function orderOf(entries: readonly PlannedSpeaker[]): readonly Id[] {
  return entries.map((entry) => entry.characterId);
}

/**
 * The one character to ask right now.
 *
 * A NAMED ASSIGNMENT IS VALIDATED, NOT TRUSTED (docs/02 section 5.6's `user` mode: the
 * scheduler "only validates the constraints and produces the plan"). An assigned id that
 * the limits block is therefore reported as `refused` with the same reason the excluded
 * list carries, rather than being silently swapped for somebody else - a scheduler that
 * quietly speaks for a different character is the black box this milestone exists to
 * prevent.
 */
function nextOf(
  input: SchedulerInput,
  chosen: { entries: PlannedSpeaker[]; excluded: CastExclusion[] },
): SpeakerChoice {
  const assigned = input.assignedOrder?.[0];
  if (assigned !== undefined && !input.cast.some((member) => member.id === assigned)) {
    return {
      kind: 'refused',
      characterId: assigned,
      name: undefined,
      reason: { kind: 'not-in-cast' },
    };
  }
  if (assigned !== undefined) {
    const blocked = chosen.excluded.find((entry) => entry.characterId === assigned);
    if (blocked !== undefined) {
      return { kind: 'refused', characterId: assigned, name: blocked.name, reason: blocked.reason };
    }
  }
  const first = chosen.entries[0];
  if (first !== undefined) return { kind: 'speaker', speaker: first };
  return {
    kind: 'none',
    reason: input.cast.length === 0 ? { kind: 'empty-cast' } : { kind: 'nobody-eligible' },
  };
}

/**
 * Decide the round: who speaks, in what order, who cannot, and who to ask next.
 *
 * Pure, total and deterministic: no I/O, no clock, no randomness, and no input can make it
 * throw. The "nobody can speak" answer is a named outcome (`SpeakerChoice`), never
 * `undefined`, because a caller that receives nothing cannot say WHICH fact stopped the
 * round - and this milestone's acceptance is that the limits are enforced AND explained.
 */
export function planTurn(input: SchedulerInput): TurnSchedule {
  const maxSpeakersPerRound = input.maxSpeakersPerRound ?? MAX_SPEAKERS_PER_ROUND;
  const state = roundStateOf(input);
  const assignedOrder = input.assignedOrder ?? [];

  const chosen = admit(
    rank(input.cast, assignedOrder),
    state,
    maxSpeakersPerRound,
    input.castState,
  );
  // The same walk WITHOUT the assignment: the difference between the two orders is the only
  // honest answer to "did the user override the plan", and running it here keeps that
  // question out of the UI (which must not re-implement admission to answer it).
  const byScore = admit(rank(input.cast, []), state, maxSpeakersPerRound, input.castState);

  return {
    round: state.round,
    entries: chosen.entries,
    excluded: chosen.excluded,
    next: nextOf(input, chosen),
    overriddenByUser:
      assignedOrder.length > 0 && !sameOrder(orderOf(chosen.entries), orderOf(byScore.entries)),
    maxSpeakersPerRound,
  };
}

/* ----------------------------- the stored plan ----------------------------- */

/**
 * A `TurnPlan` without the id and the timestamp, which the repository mints (`appendMessage`
 * and `createCheckpoint` own theirs for the same reason: one minter, one place).
 */
export interface TurnPlanDraft {
  readonly sessionId: Id;
  readonly round: number;
  readonly mode: SchedulerMode;
  readonly entries: readonly TurnPlanEntry[];
  readonly excluded: readonly TurnPlanExclusion[];
  readonly overriddenByUser: boolean;
}

/**
 * The locale-free trace of a selection, as stored in `TurnPlanEntry.reasons`.
 *
 * WHY THE PLAN STORES A FACT STRING AND NOT A SENTENCE: a `TurnPlan` row is PERSISTED DATA,
 * so a translated sentence inside it would freeze the language it was written in, and a
 * catalog key would make the database depend on a key a later edit may remove. The screen
 * renders prose from the SAME structure through `session/scheduler-text.ts`, where the
 * language belongs; nothing reads these strings back, and docs/02 section 5.6's "explain
 * every score" is satisfied by the pair: the fact in the row, the sentence on screen.
 */
export function speakerReasonFact(reason: SpeakerReason): string {
  switch (reason.kind) {
    case 'manual':
      return `assigned-order=${reason.position}`;
    case 'desire-ability':
      return 'rank=desire+ability';
  }
}

/** The same for a silence: docs/02 section 5.6's `excluded` list, readable by a human. */
export function exclusionReasonFact(reason: ExclusionReason): string {
  switch (reason.kind) {
    case 'card-missing':
      return 'card-missing';
    // The intervention (M1-S4): the row says what the USER did, so re-reading a plan explains
    // a silence the person caused rather than blaming a limit that never applied.
    case 'absent':
      return 'absent=present(false)';
    case 'muted':
      return 'muted=true';
    case 'capped':
      return `capped=maxLinesPerRound(${reason.limit}),lines=${reason.linesTaken}`;
    case 'cooling':
      return `cooling=cooldown(${reason.cooldown}),roundsSince=${reason.roundsSince}`;
    case 'speaker-cap':
      return `speaker-cap=maxSpeakersPerRound(${reason.limit})`;
  }
}

/** The `TurnPlan` a schedule becomes. `mode` is the session's own (`Session.schedulerMode`). */
export function planDraftOf(
  sessionId: Id,
  mode: SchedulerMode,
  schedule: TurnSchedule,
): TurnPlanDraft {
  return {
    sessionId,
    round: schedule.round,
    mode,
    entries: schedule.entries.map((entry) => ({
      characterId: entry.characterId,
      order: entry.order,
      linesBudget: entry.linesBudget,
      score: entry.score,
      reasons: [
        speakerReasonFact(entry.reason),
        `desire=${entry.desire}`,
        `ability=${entry.ability}`,
      ],
    })),
    excluded: schedule.excluded.map((entry) => ({
      characterId: entry.characterId,
      reason: exclusionReasonFact(entry.reason),
    })),
    overriddenByUser: schedule.overriddenByUser,
  };
}
