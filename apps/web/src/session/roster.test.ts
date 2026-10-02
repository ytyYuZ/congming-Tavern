/**
 * The create-session rules (M1-S1), as pure functions: no DOM and no database.
 *
 * WHAT THIS FILE HAS TO PROVE, IN THE MILESTONE'S OWN WORDS
 * 1. 「卡司自动生成」 — the cast is DERIVED from the ticked cards and the one designated player,
 *    so there is no second list a user has to keep in step. The cases below walk the rule
 *    (two cards, a solo session, a repeated tick) rather than one example of it.
 * 2. 「同一张卡可在不同会话担任不同身份」 — at the rule's level: the same TWO cards produce
 *    mirrored pins when the designation moves, and every pin is only an `{id, version}` pair,
 *    so nothing about a card's payload or its version is part of a session's identity.
 *    (`db/session-create.test.ts` proves the other half against the stored rows: the card's
 *    payload is byte-identical after being used in both roles.)
 * 3. The refusals: one sentence per missing choice, plus a clock that is not a minute.
 * 4. The preset boundary: exactly one choice, and the pin it produces is the built-in the
 *    composer assembles from — with no rule pack bound, because none exists.
 *
 * WHY THE PINS ARE CHECKED AGAINST THE SCHEMA AND NOT AGAINST LITERALS: `EntityPinSchema` is the
 * contract ADR-010 froze ("every reference a session holds must be pinned"), so a pin this
 * module invents is checked by the same validator the storage boundary uses. The whole
 * `SessionRefs` is parsed too (with a placeholder model config, which is not this module's
 * business): that is what makes "these pins are a legal session" a fact rather than a hope.
 */
/** @vitest-environment node */
import {
  EntityPinSchema,
  mintUuidV7,
  SessionRefsSchema,
  type WorldVersion,
} from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { blankWorldData } from '../cards/world';
import { BUILTIN_PRESET, BUILTIN_PRESET_ID } from '../chat/builtin-content';
import {
  BUILTIN_PRESET_CHOICE,
  type CardChoice,
  castOf,
  defaultClockOf,
  PRESET_CHOICES,
  presetPinOf,
  type SessionDraft,
  sessionIssues,
  sessionPinsOf,
} from './roster';

/* ──────────────────────────────── fixtures ───────────────────────────────── */

const LIAN: CardChoice = { id: 'card-lian', name: 'Lian', version: 3 };
const MIRA: CardChoice = { id: 'card-mira', name: 'Mira', version: 1 };

/** Two drafts over the SAME two cards, differing only in who the player is. */
function draft(overrides: Partial<SessionDraft> = {}): SessionDraft {
  return {
    world: { id: 'world-frostmoon', version: 2 },
    cards: [LIAN, MIRA],
    playerId: LIAN.id,
    initialClock: 480,
    ...overrides,
  };
}

/** One world version whose payload starts at `startMinute`. */
function worldVersion(startMinute: number): WorldVersion {
  return {
    id: mintUuidV7(),
    worldId: mintUuidV7(),
    version: 1,
    data: { ...blankWorldData('Frostmoon Isles'), startMinute },
    createdAt: 0,
    updatedAt: 0,
  };
}

/* ──────────────────────────────── the cast ───────────────────────────────── */

describe('the cast is derived, never typed twice', () => {
  it('is the ticked cards minus the player, in the order they were ticked', () => {
    expect(castOf([LIAN, MIRA], LIAN.id)).toEqual([MIRA]);
    expect(castOf([LIAN, MIRA], MIRA.id)).toEqual([LIAN]);
    // The player is not cast, and nothing else is cast either: the selection minus one card.
    const pins = sessionPinsOf(draft());
    expect(pins?.playerCharacter).toEqual({ id: LIAN.id, version: LIAN.version });
    expect(pins?.cast).toEqual([{ id: MIRA.id, version: MIRA.version }]);
  });

  it('leaves a solo session with an empty cast — the schema allows it', () => {
    const picksOnly = draft({ cards: [LIAN], playerId: LIAN.id });
    expect(sessionIssues(picksOnly)).toEqual([]);
    expect(sessionPinsOf(picksOnly)?.cast).toEqual([]);
  });

  it('drops a repeated tick, so a cast cannot list one card twice', () => {
    expect(castOf([MIRA, LIAN, MIRA], LIAN.id)).toEqual([MIRA]);
  });

  it('lets the SAME card be the player in one session and an NPC in another', () => {
    // The whole of ADR-010, at the rule's level: the designation moves, the cards do not.
    const asPlayer = sessionPinsOf(draft({ playerId: LIAN.id }));
    const asNpc = sessionPinsOf(draft({ playerId: MIRA.id }));
    expect(asPlayer?.playerCharacter.id).toBe(LIAN.id);
    expect(asPlayer?.cast.map((pin) => pin.id)).toEqual([MIRA.id]);
    expect(asNpc?.playerCharacter.id).toBe(MIRA.id);
    expect(asNpc?.cast.map((pin) => pin.id)).toEqual([LIAN.id]);

    // AND A PIN CARRIES NOTHING ELSE: two fields, so no payload, name or role can travel with
    // it — which is why the card's own row cannot be touched by either session.
    for (const pins of [asPlayer, asNpc]) {
      if (pins === undefined) throw new Error('a valid draft must produce pins');
      const everyPin = [pins.world, pins.playerCharacter, ...pins.cast];
      expect(everyPin.length).toBeGreaterThan(0);
      for (const pin of everyPin) {
        expect(Object.keys(pin).sort()).toEqual(['id', 'version']);
        expect(EntityPinSchema.safeParse(pin).success).toBe(true);
      }
    }
  });

  it('produces references the frozen SessionRefs contract accepts', () => {
    const pins = sessionPinsOf(draft());
    const parsed = SessionRefsSchema.safeParse({
      ...pins,
      modelConfig: {
        provider: 'openai-compatible',
        model: 'm',
        params: { temperature: 0.7, topP: 1 },
      },
    });
    expect(parsed.success).toBe(true);
  });
});

/* ─────────────────────────── validation refusals ─────────────────────────── */

describe('the refusals a person can act on', () => {
  it('names each missing choice with its own sentence, in the order the form asks', () => {
    const cases: readonly [SessionDraft, string][] = [
      [draft({ world: undefined }), 'session.worldRequired'],
      [draft({ cards: [], playerId: undefined }), 'session.cardsRequired'],
      [draft({ playerId: undefined }), 'session.playerRequired'],
      [draft({ playerId: 'card-nobody' }), 'session.playerNotChosen'],
      [draft({ initialClock: Number.NaN }), 'session.clockInvalid'],
    ];
    for (const [value, key] of cases) {
      expect(sessionIssues(value), key).toEqual([key]);
    }
    // Everything at once is reported at once, not one at a time.
    expect(
      sessionIssues({ world: undefined, cards: [], playerId: undefined, initialClock: 1.5 }),
    ).toEqual(['session.worldRequired', 'session.cardsRequired', 'session.clockInvalid']);
  });

  it('refuses a clock that is not a whole minute', () => {
    expect(sessionIssues(draft({ initialClock: 1.5 }))).toEqual(['session.clockInvalid']);
    expect(sessionIssues(draft({ initialClock: Number.POSITIVE_INFINITY }))).toEqual([
      'session.clockInvalid',
    ]);
    // A NEGATIVE minute is legal: `EpochMinuteSchema` is any integer, and a world may well
    // start before its own era label.
    expect(sessionIssues(draft({ initialClock: -30 }))).toEqual([]);
  });

  it('answers no pins for a refused draft, so nothing can be built from one', () => {
    expect(sessionPinsOf(draft({ world: undefined }))).toBeUndefined();
    expect(sessionPinsOf(draft({ cards: [] }))).toBeUndefined();
    expect(sessionPinsOf(draft({ playerId: undefined }))).toBeUndefined();
    expect(sessionPinsOf(draft({ playerId: 'card-nobody' }))).toBeUndefined();
    expect(sessionPinsOf(draft({ initialClock: Number.NaN }))).toBeUndefined();
    expect(sessionPinsOf(draft())).toBeDefined();
  });
});

/* ──────────────────────── the preset, and the rule pack ──────────────────── */

describe('what 选预设/规则包 can offer today', () => {
  it('offers exactly the built-in preset, because no preset row can exist yet', () => {
    expect(PRESET_CHOICES).toEqual([BUILTIN_PRESET_CHOICE]);
    // The id the pin records and the id the composer assembles from are the same string: the
    // pin cannot name a preset nothing resolves.
    expect(BUILTIN_PRESET_CHOICE.id).toBe(BUILTIN_PRESET_ID);
    expect(BUILTIN_PRESET_CHOICE.id).toBe(BUILTIN_PRESET.id);
    expect(BUILTIN_PRESET_CHOICE.version).toBe(BUILTIN_PRESET.version);
    expect(BUILTIN_PRESET_CHOICE.name).toBe(BUILTIN_PRESET.name);
    expect(EntityPinSchema.safeParse(presetPinOf(BUILTIN_PRESET_CHOICE)).success).toBe(true);
  });

  it('binds no rule pack, because none exists to bind', () => {
    const pins = sessionPinsOf(draft());
    expect(pins).toBeDefined();
    if (pins === undefined) return;
    expect(Object.hasOwn(pins, 'rulePack')).toBe(false);
    expect(sessionPinsOf(draft())?.promptPreset).toEqual(presetPinOf(BUILTIN_PRESET_CHOICE));
  });
});

/* ─────────────────────────────── the clock ───────────────────────────────── */

describe('the initial clock', () => {
  it("defaults to the world version's own start minute", () => {
    expect(defaultClockOf(worldVersion(1234))).toBe(1234);
    // No version chosen yet: the calendar epoch, which is the only minute that needs no world.
    expect(defaultClockOf(undefined)).toBe(0);
  });
});
