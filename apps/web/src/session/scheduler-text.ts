/**
 * The scheduler's facts, in the catalog's terms (M1-S5).
 *
 * WHY THIS MAPPING IS A MODULE OF ITS OWN
 * `session/scheduler.ts` decides WHO speaks and WHY, and every "why" it produces is a
 * structured fact (`{ kind: 'cooling', cooldown: 2, roundsSince: 1 }`). A sentence is
 * INTERFACE COPY, so it belongs to the catalogs, and the translation from one to the other
 * is exactly this file: one exhaustive `switch` per reason, so a reason the core gains is a
 * `tsc` error here until somebody decides what it says. Keeping the mapping out of the core
 * is also what lets the rule stay locale-free and testable without a translator.
 *
 * WHY THE NUMBERS TRAVEL AS PARAMETERS AND NOT AS A PRE-BUILT SENTENCE
 * `t(key, params)` is the app's one interpolation path (`packages/i18n/src/translate.ts`),
 * so a sentence assembled here would be a second one - and it would put the grammar of
 * every language into TypeScript instead of into the catalog. The two locales genuinely
 * order these clauses differently, which is the same argument `play.clock` records.
 */
import type { MessageKey, TranslateParams } from '@smarttavern/i18n';
import type { ExclusionReason, RefusalReason, SpeakerReason } from './scheduler';

/** One catalog sentence plus the values its placeholders take. */
export interface ReasonText {
  readonly key: MessageKey;
  readonly params: TranslateParams;
}

/** Why this character was placed in the round. */
export function speakerReasonText(reason: SpeakerReason): ReasonText {
  switch (reason.kind) {
    case 'manual':
      return { key: 'play.schedulerReasonManual', params: { position: reason.position } };
    case 'desire-ability':
      return {
        key: 'play.schedulerReasonScore',
        params: { desire: reason.desire, ability: reason.ability },
      };
  }
}

/**
 * Why a cast member cannot take a turn. The vocabulary covers BOTH a member the scheduler left
 * out (`CastExclusion`) and one the USER named and the rule refused, because those are the same
 * fact about the same character; `not-in-cast` is the single reason only a named assignment can
 * produce, and it is mapped in `refusalReasonText` below.
 *
 * WHY THE TWO MAPPINGS ARE SPLIT (M1-S4): the scheduler gained reasons for the user's own
 * intervention, and a caller that renders a cast LISTING has only an `ExclusionReason` - it can
 * never hold `not-in-cast`. Keeping the listing's mapping total over its own vocabulary is what
 * lets that caller reach a sentence without inventing a `RefusalReason`, while both directions
 * stay exhaustive: a reason the core gains is a `tsc` error here until somebody decides what it
 * says.
 *
 * `{remaining}` is computed here rather than stored because it is a property of the SENTENCE (see
 * the file header): a cooling character is free once `roundsSince` exceeds `cooldown`, so the
 * rounds left to wait are `cooldown - roundsSince + 1` - arithmetic about a sentence, not about
 * the rule.
 */
export function exclusionReasonText(reason: ExclusionReason): ReasonText {
  switch (reason.kind) {
    case 'card-missing':
      return { key: 'play.schedulerExcludedCardMissing', params: {} };
    // The user's own intervention (M1-S4), whose sentence NAMES the fact rather than saying
    // "not eligible": the reason is the whole point of the row being visible.
    case 'absent':
      return { key: 'play.schedulerExcludedAbsent', params: {} };
    case 'muted':
      return { key: 'play.schedulerExcludedMuted', params: {} };
    case 'capped':
      return {
        key: 'play.schedulerExcludedCapped',
        params: { lines: reason.linesTaken, limit: reason.limit },
      };
    case 'cooling':
      return {
        key: 'play.schedulerExcludedCooling',
        params: {
          remaining: reason.cooldown - reason.roundsSince + 1,
          cooldown: reason.cooldown,
        },
      };
    case 'speaker-cap':
      return { key: 'play.schedulerExcludedSpeakerCap', params: { limit: reason.limit } };
  }
}

/**
 * Why a character the caller NAMED cannot take the turn: the exclusions above, or the one
 * reason only a named assignment can produce.
 */
export function refusalReasonText(reason: RefusalReason): ReasonText {
  return reason.kind === 'not-in-cast'
    ? { key: 'play.schedulerExcludedNotInCast', params: {} }
    : exclusionReasonText(reason);
}
