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
import type { RefusalReason, SpeakerReason } from './scheduler';

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
 * Why this character cannot speak: the same sentences for a cast member the scheduler left
 * out (`CastExclusion`) and for one the USER named and the limits refused (`RefusalReason`),
 * because they are the same fact about the same character. `not-in-cast` is the one a
 * cast-listing never needs and a named assignment can produce.
 *
 * `{remaining}` is computed here rather than stored, because it is a property of the
 * sentence: a cooling character whose last line was `roundsSince` rounds ago is free again
 * once `roundsSince` exceeds `cooldown`, so the rounds left to wait are
 * `cooldown - roundsSince + 1`. Deriving it in the core would put UI arithmetic into the
 * rule; deriving it in the catalog is impossible, because a catalog value is data.
 */
export function exclusionReasonText(reason: RefusalReason): ReasonText {
  switch (reason.kind) {
    case 'card-missing':
      return { key: 'play.schedulerExcludedCardMissing', params: {} };
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
    case 'not-in-cast':
      return { key: 'play.schedulerExcludedNotInCast', params: {} };
  }
}
