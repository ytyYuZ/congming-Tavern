/**
 * A new session's roster and its refusals — the pure half of M1-S1 (会话创建,
 * docs/06-开发任务拆解.md §2.5, docs/01 §5.4 开局步骤 1–6).
 *
 * THE CAST RULE, AND WHERE IT COMES FROM (the acceptance sentence 「卡司自动生成」)
 * docs/01 §5.4 numbers the opening steps: 2. 选择一张或多张角色卡 … 3. 指定其中一张为玩家角色 …
 * 4. 其余角色自动组成卡司. docs/01 §9's MVP criterion 5 states it as one sentence —
 * 「创建会话时可从所选卡中指定玩家角色，其余自动成为卡司，且无需重新建卡」 — docs/02 §4 gives the
 * shape (`SessionRefs.playerCharacter` 扮演开始时指定, `cast` 其余为卡司), and docs/02 §D9 /
 * ADR-010 give the reason (`packages/schema/src/entities/session.ts`'s header repeats it).
 *
 * So the rule implemented here is:
 *   THE USER TICKS THE CARDS THAT TAKE PART — one list, never two;
 *   EXACTLY ONE TICKED CARD IS `playerCharacter`;
 *   `cast` IS THE OTHER TICKED CARDS, in the order they appear in the library.
 * The cast is DERIVED from the tick list plus that one designation, so there is no second
 * roster to maintain and none to drift; a card that is not ticked is on neither side of the
 * stage. `playerCharacter` is therefore not a special third thing — it is a member of the same
 * selection, which is what lets the SAME card be the player in one session and an NPC in the
 * next with nothing on the card changing (ADR-010, and `session/roster.test.ts` asserts it).
 *
 * WHY NOTHING HERE WRITES TO A CARD
 * `playerCharacter` is a field of `Session.refs`, not of `CharacterData`
 * (`cards/character.ts` records the same rule from the editor's side). This module only ever
 * READS a card's id and version, and the version it pins comes from the head row the screen
 * read — so creating a session cannot move a card's payload or mint a version for it.
 *
 * WHAT 「选预设/规则包」 CAN OFFER TODAY, AND WHY THAT IS THE HONEST ANSWER
 * No `promptPresets` or `rulepacks` row can exist yet: the preset is still the module constant
 * `BUILTIN_PRESET` in `chat/builtin-content.ts` (docs/06 §8.5 决定 1), nothing writes either
 * collection, preset management is P1 in docs/01 §F1-7, and no rule pack ships at all. So
 * `PRESET_CHOICES` below has exactly ONE entry — the built-in — derived from that same constant,
 * so the pin a session records cannot name a preset the composer does not assemble from. There is
 * no rule-pack choice at all, and `sessionPinsOf` leaves `SessionRefs.rulePack` ABSENT rather than
 * inventing an id: the field is optional (`SessionRefsSchema`) and "no rule pack" is exactly what
 * its absence means. The screen says both facts out loud; this module is where they are true.
 *
 * WHAT IT DOES NOT OWN
 * The versions the pins carry come from rows the screen read (`WorldVersion`,
 * `Character.headVersion`), and the world version's own `startMinute` decides the clock's
 * default (`defaultClockOf`). No calendar arithmetic happens here: the minute is shown and
 * stored as a NUMBER, because mapping it to a date is `chat/clock.ts`'s job and that mapping
 * still uses the built-in calendar (M1-T1's boundary) — this module must not become a second
 * calendar by formatting a world's minute with the wrong month names.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { EntityPin, Id, VersionNumber, WorldVersion } from '@smarttavern/schema';
import { BUILTIN_PRESET, BUILTIN_PRESET_ID } from '../chat/builtin-content';
import { titleIssueOf } from './title';

/* ─────────────────────────────── the preset ──────────────────────────────── */

/**
 * One preset a session may be started on.
 *
 * `name` is the preset's OWN name, which is CONTENT and therefore never translated (ADR-030):
 * an English interface still shows the preset it will actually assemble from.
 */
export interface PresetChoice {
  readonly id: Id;
  readonly version: VersionNumber;
  readonly name: string;
}

/** The one preset that exists: the app's built-in (`chat/builtin-content.ts`). */
export const BUILTIN_PRESET_CHOICE: PresetChoice = {
  id: BUILTIN_PRESET_ID,
  version: BUILTIN_PRESET.version,
  name: BUILTIN_PRESET.name,
};

/**
 * Every preset a new session can pin — one, until M1-W2 turns presets into rows.
 *
 * It is an ARRAY rather than a single constant because the screen renders the choices it will
 * one day have; a future `loadPresets()` replaces this value and nothing else changes shape.
 */
export const PRESET_CHOICES: readonly PresetChoice[] = [BUILTIN_PRESET_CHOICE];

/** A preset's pin: the `{id, version}` pair `SessionRefs.promptPreset` stores. */
export function presetPinOf(choice: PresetChoice): EntityPin {
  return { id: choice.id, version: choice.version };
}

/* ────────────────────────── the tick list and the cast ───────────────────── */

/** One card the user ticked: its id, the roster's label for it, and the version to pin. */
export interface CardChoice {
  readonly id: Id;
  readonly name: string;
  readonly version: VersionNumber;
}

/**
 * The form's value: only what the user chose. `cast` is deliberately NOT a field — the whole
 * point of the milestone's first acceptance half is that the cast is derived, so a draft that
 * could carry one would be a second list nobody asked the user to keep up to date.
 */
export interface SessionDraft {
  /** The chosen world VERSION's pin, or `undefined` while no world is chosen. */
  readonly world: EntityPin | undefined;
  /** The ticked cards. The screen builds this from the two libraries, in library order. */
  readonly cards: readonly CardChoice[];
  /** The id of the ticked card the user plays, or `undefined` while none is designated. */
  readonly playerId: Id | undefined;
  /** Minutes since the calendar epoch. `NaN` (an unparsable field) is refused below. */
  readonly initialClock: number;
  /**
   * The name the user typed for this session, if any (M1-T1).
   *
   * OPTIONAL ON PURPOSE: naming a session is optional, so a draft without it is still complete and
   * the store writes the default title (`state/chat-store.ts`). That is what lets 示例开局
   * (`packs/example-session.ts`) and every programmatic caller keep creating sessions unchanged —
   * a required field here would be a second decision those callers would have to invent.
   */
  readonly title?: string;
}

/**
 * The clock a draft starts at: the world version's OWN start minute, `0` when no version is
 * chosen yet. `WorldDataSchema.startMinute` is the world's decision (docs/01 §5.4 step 6:
 * 「设定初始时钟（默认取世界卡的起始时刻）」), so this is a copy, not a default of ours.
 */
export function defaultClockOf(version: WorldVersion | undefined): number {
  return version?.data.startMinute ?? 0;
}

/**
 * THE CAST: the ticked cards with the player's removed, in the order they were ticked.
 *
 * A repeated id cannot come from the screen (the ticks are a set of ids) but CAN come from a
 * programmatic caller, so the first occurrence wins and later ones are dropped — a cast that
 * listed one card twice would be a roster bug the schema happily stores.
 */
export function castOf(
  cards: readonly CardChoice[],
  playerId: Id | undefined,
): readonly CardChoice[] {
  const cast: CardChoice[] = [];
  const seen = new Set<Id>();
  for (const card of cards) {
    if (card.id === playerId || seen.has(card.id)) continue;
    seen.add(card.id);
    cast.push(card);
  }
  return cast;
}

/* ───────────────────────────── validation (校验) ─────────────────────────── */

/**
 * Everything that stands between this draft and a session, as catalog keys the screen renders
 * as whole sentences — one per missing CHOICE, in the order the form asks for them, plus the name
 * when it is one the row could not store.
 *
 * WHY ONE ISSUE PER CAUSE AND NOT A LIST OF FIELD ERRORS: each of these is a decision the user
 * has not made yet (which world, which cards, which of them is theirs), so the sentence is the
 * question's other half rather than a diagnostic about malformed data. The name limit joins the
 * clock's refusal (`session.clockInvalid`) on the other side of that line: there is no such thing
 * as a MISSING name — a blank field asks for the default title — but a name longer than
 * `SessionSchema` accepts has to be said out loud before anything is written, rather than
 * silently cut or thrown at the write boundary (`session/title.ts` holds that rule).
 */
export function sessionIssues(draft: SessionDraft): readonly MessageKey[] {
  const issues: MessageKey[] = [];
  const titleIssue = titleIssueOf(draft.title);
  if (titleIssue !== undefined) issues.push(titleIssue);
  if (draft.world === undefined) issues.push('session.worldRequired');
  if (draft.cards.length === 0) issues.push('session.cardsRequired');
  else if (draft.playerId === undefined) issues.push('session.playerRequired');
  else if (!draft.cards.some((card) => card.id === draft.playerId)) {
    issues.push('session.playerNotChosen');
  }
  // `EpochMinuteSchema` is `z.number().int()`, so a fraction, a `NaN` (an unparsable input) or
  // an infinity would be refused by the schema anyway; saying it here names the FIELD.
  if (!Number.isSafeInteger(draft.initialClock)) issues.push('session.clockInvalid');
  return issues;
}

/* ──────────────────────────────── the pins ───────────────────────────────── */

/**
 * The versioned references a session is built from — `SessionRefs` minus the model config,
 * which is the repository's business (`db/repository.ts`: the first turn records what the user
 * configured, and a session created before BYO-Key exists still has to be playable).
 */
export interface SessionPins {
  readonly world: EntityPin;
  readonly playerCharacter: EntityPin;
  readonly cast: readonly EntityPin[];
  readonly promptPreset: EntityPin;
}

/**
 * The pins this draft names, or `undefined` when it names none — i.e. when `sessionIssues`
 * refuses it. The two are one rule with two answers, so a caller cannot build pins from a
 * form the screen would have refused, and the store's own gate (`state/chat-store.ts`) has
 * nothing to re-decide.
 */
export function sessionPinsOf(draft: SessionDraft): SessionPins | undefined {
  const { world, playerId } = draft;
  if (sessionIssues(draft).length > 0) return undefined;
  if (world === undefined || playerId === undefined) return undefined;
  const player = draft.cards.find((card) => card.id === playerId);
  if (player === undefined) return undefined;
  return {
    world,
    playerCharacter: { id: player.id, version: player.version },
    cast: castOf(draft.cards, playerId).map((card) => ({ id: card.id, version: card.version })),
    promptPreset: presetPinOf(BUILTIN_PRESET_CHOICE),
  };
}
