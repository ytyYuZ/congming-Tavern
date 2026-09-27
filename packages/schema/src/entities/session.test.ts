/**
 * Tests for the session contract (docs/02 §4, §7; ADR-010, ADR-011, ADR-012).
 *
 * The load-bearing cases:
 * 1. identity is a property of the session (ADR-010) — the same card must be
 *    able to be `playerCharacter` in one session and `cast` in another, and
 *    `playerCharacter` must be a pinned reference rather than a flag;
 * 2. every reference is pinned to a version, so an old save cannot silently
 *    re-render after the world is edited;
 * 3. `SessionState` is the whole save payload (docs/04 §6) AND the live state on the
 *    session row itself (`Session.state`, ADR-032), so it is checked for the clock,
 *    inner clock, vars, sheets and deadlines independently — and the row's `state`
 *    is checked to be REQUIRED and distinct from `initialClock`.
 */
import { describe, expect, it } from 'vitest';
import { UUID_V7_PATTERN } from '../common';
import {
  DeadlineSchema,
  EntityPinSchema,
  SessionRefsSchema,
  SessionSchema,
  SessionStateSchema,
} from './session';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const SESSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1c01';
const WORLD_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1c02';
const PLAYER_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1c03';
const NPC_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1c04';
const MESSAGE_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1c05';
const NOW = 1_790_000_000_000;

const fullDeadline = {
  id: 'ritual',
  label: '仪式开始',
  dueMinute: 1_002_000,
  kind: 'countdown',
  targetId: NPC_ID,
  status: 'active',
};

/**
 * The live state a session row carries (ADR-032). Defined BEFORE `fullSession`
 * because the session fixture embeds it, and re-used by the `SessionState` cases
 * below so the two cannot describe different states.
 */
const fullState = {
  scene: { title: '雪夜旅店', location: '银松镇·旅店', time: 1_000_120 },
  clock: 1_000_120,
  innerClock: { kind: 'round', current: 2, total: 10, secondsPerRound: 6, note: '酒馆混战' },
  vars: { 天气: '暴雪', 威胁: 3, 已发现灯塔: true },
  sheets: { [NPC_ID]: { hp: 12, conditions: ['疲惫'] } },
  deadlines: [fullDeadline],
};

const fullRefs = {
  world: { id: WORLD_ID, version: 3 },
  playerCharacter: { id: PLAYER_ID, version: 1 },
  cast: [{ id: NPC_ID, version: 2 }],
  promptPreset: { id: 'tavern-default', version: 1 },
  rulePack: { id: 'dnd5e-srd', version: 1 },
  modelConfig: {
    provider: 'openai',
    model: 'gpt-x',
    params: { temperature: 0.8, topP: 0.95 },
  },
};

const fullSession = {
  id: SESSION_ID,
  title: '银松镇的第一个冬天',
  refs: fullRefs,
  // The origin, deliberately EARLIER than the live clock in `fullState`: a fixture
  // where the two are equal would not catch a reader that used the wrong one.
  initialClock: 1_000_000,
  state: fullState,
  schedulerMode: 'rules',
  headMessageId: MESSAGE_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

/* ──────────────────────────────── helpers ────────────────────────────────── */

type Parseable = { safeParse: (value: unknown) => { success: boolean } };

/** Required-field driver: deleting any listed field must make the parse fail. */
function expectRequired(schema: Parseable, fixture: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const broken: Record<string, unknown> = { ...fixture };
    delete broken[field];
    expect(`${field}:${schema.safeParse(broken).success}`).toBe(`${field}:false`);
  }
}

/** Unknown fields (and `extensions` on a schema that has none) are stripped. */
function expectStrips(schema: Parseable, fixture: Record<string, unknown>, keys: string[]) {
  const payload = { ...fixture, someFutureField: 1 };
  const parsed = schema.safeParse(payload);
  expect(parsed.success).toBe(true);
  const data = (parsed as { data?: Record<string, unknown> }).data ?? {};
  for (const key of [...keys, 'someFutureField']) {
    expect(data).not.toHaveProperty(key);
  }
}

/**
 * Copy of `source` with `keys` removed.
 *
 * Both spellings of a bare key are unusable here: `minimal.rulePack` trips
 * `noPropertyAccessFromIndexSignature`, and `minimal['rulePack']` trips Biome's
 * `useLiteralKeys`. Only a parameterised key satisfies both.
 */
function withoutKeys(source: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('session refs', () => {
  it('parses a fully populated refs block', () => {
    expect(SessionRefsSchema.safeParse(fullRefs).success).toBe(true);
  });

  it('parses a minimal refs block (rulePack is the only optional slot)', () => {
    const minimal = withoutKeys(fullRefs, 'rulePack');
    expect(SessionRefsSchema.safeParse(minimal).success).toBe(true);
    expectRequired(SessionRefsSchema, fullRefs, [
      'world',
      'playerCharacter',
      'cast',
      'promptPreset',
      'modelConfig',
    ]);
    expectRequired(SessionRefsSchema, fullRefs.modelConfig, ['provider', 'model', 'params']);
    expectRequired(SessionRefsSchema, fullRefs.world, ['id', 'version']);
  });

  it('requires temperature and topP in the model config, like every sampling site', () => {
    const params = (patch: Record<string, unknown>) => ({
      ...fullSession,
      refs: { ...fullRefs, modelConfig: { ...fullRefs.modelConfig, params: patch } },
    });
    expect(SessionSchema.safeParse(params({ temperature: 3, topP: 0.9 })).success).toBe(false);
    expect(SessionSchema.safeParse(params({ temperature: 0.7, topP: 0.9 })).success).toBe(true);
    expect(SessionSchema.safeParse(params({ topP: 0.9 })).success).toBe(false);
  });

  it('pins every reference to a version, so a save cannot drift', () => {
    // A pin without its `version` must fail: replace the whole `world` slot with
    // an unpinned one. Building the object this way also keeps `fullRefs` intact.
    const unpinned = { ...withoutKeys(fullRefs, 'world'), world: { id: WORLD_ID } };
    expect(SessionRefsSchema.safeParse(unpinned).success).toBe(false);
    expect(
      SessionRefsSchema.safeParse({ ...fullRefs, world: { id: WORLD_ID, version: 0 } }).success,
    ).toBe(false);
    expect(EntityPinSchema.safeParse({ id: WORLD_ID, version: 1 }).success).toBe(true);
  });

  it('makes identity a session property: one card is player here, cast there', () => {
    const asPlayer = SessionRefsSchema.parse(fullRefs);
    const asCast = SessionRefsSchema.parse({
      ...fullRefs,
      playerCharacter: { id: NPC_ID, version: 9 },
      cast: [{ id: PLAYER_ID, version: 1 }],
    });
    // The same card id appears on both sides of different sessions, with no
    // flag anywhere on the card itself (ADR-010).
    expect(asPlayer.playerCharacter.id).toBe(PLAYER_ID);
    expect(asCast.cast.map((pin) => pin.id)).toContain(PLAYER_ID);
    for (const forbidden of ['isPlayer', 'playerFlag', 'kind', 'role']) {
      expect(Object.keys(SessionRefsSchema.shape)).not.toContain(forbidden);
    }
    // A session without a player character is not a session.
    const broken = withoutKeys(fullRefs, 'playerCharacter');
    expect(SessionRefsSchema.safeParse(broken).success).toBe(false);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(SessionRefsSchema, fullRefs, []);
    const once = JSON.stringify(SessionRefsSchema.parse(fullRefs));
    expect(JSON.stringify(SessionRefsSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('session', () => {
  it('parses a fully populated session', () => {
    expect(SessionSchema.safeParse(fullSession).success).toBe(true);
  });

  it('parses a minimal session (every field but rulePack/extensions is required)', () => {
    const minimal = { ...fullSession, headMessageId: null };
    expect(SessionSchema.safeParse(minimal).success).toBe(true);
    expectRequired(SessionSchema, fullSession, [
      'id',
      'title',
      'refs',
      'initialClock',
      'state',
      'schedulerMode',
      'headMessageId',
      'createdAt',
      'updatedAt',
    ]);
    expect(SessionSchema.safeParse({ ...fullSession, title: '' }).success).toBe(false);
  });

  it('requires a well-formed live state and keeps it distinct from initialClock (ADR-032)', () => {
    // The live state is REQUIRED: a session without a clock, a scene or variables
    // cannot be played, and the read boundary (not the schema) is what completes a
    // row written before the field existed.
    expect(SessionSchema.safeParse({ ...fullSession, state: undefined }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...fullSession, state: {} }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...fullSession, state: { clock: 1 } }).success).toBe(false);

    const parsed = SessionSchema.parse(fullSession);
    expect(parsed.state).toEqual(fullState);
    // Two clocks, two meanings: the origin never moves, the live clock does.
    expect(parsed.initialClock).not.toBe(parsed.state.clock);
  });

  it('rejects an unknown scheduler mode rather than guessing', () => {
    expect(SessionSchema.safeParse({ ...fullSession, schedulerMode: 'random' }).success).toBe(
      false,
    );
    expect(SessionSchema.safeParse({ ...fullSession, schedulerMode: 'ai' }).success).toBe(true);
    expect(SessionSchema.safeParse({ ...fullSession, schedulerMode: 'user' }).success).toBe(true);
    expect(SessionSchema.safeParse({ ...fullSession, headMessageId: undefined }).success).toBe(
      false,
    );
    expect(SessionSchema.safeParse({ ...fullSession, createdAt: -1 }).success).toBe(false);
  });

  it('accepts a foreign slug id, because ids are validated before remapping', () => {
    // docs/04 §7 validates schemas (step 3) before it remaps colliding ids
    // (step 8), so a well-formed foreign id must not be a hard failure here.
    expect(SessionSchema.safeParse({ ...fullSession, id: 'sess-frost-01' }).success).toBe(true);
    for (const id of [SESSION_ID, WORLD_ID, PLAYER_ID, NPC_ID, MESSAGE_ID]) {
      expect(`${id}:${UUID_V7_PATTERN.test(id)}`).toBe(`${id}:true`);
    }
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(SessionSchema, fullSession, []);
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(SessionSchema.parse(fullSession));
    expect(JSON.stringify(SessionSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullSession, extensions: { 'x-mythos.curse': { level: 2 } } };
    const parsed = SessionSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.curse': { level: 2 } });
    expect(JSON.stringify(SessionSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(SessionSchema.safeParse({ ...fullSession, extensions: { curse: 2 } }).success).toBe(
      false,
    );
  });
});

describe('deadline', () => {
  it('parses a fully populated deadline and a minimal one', () => {
    expect(DeadlineSchema.safeParse(fullDeadline).success).toBe(true);
    const minimal = withoutKeys(fullDeadline, 'targetId');
    expect(DeadlineSchema.safeParse(minimal).success).toBe(true);
    expectRequired(DeadlineSchema, fullDeadline, ['id', 'label', 'dueMinute', 'kind', 'status']);
  });

  it('rejects unknown kinds and statuses rather than guessing', () => {
    expect(DeadlineSchema.safeParse({ ...fullDeadline, kind: 'timer' }).success).toBe(false);
    expect(DeadlineSchema.safeParse({ ...fullDeadline, status: 'done' }).success).toBe(false);
    expect(DeadlineSchema.safeParse({ ...fullDeadline, status: 'expired' }).success).toBe(true);
    expect(DeadlineSchema.safeParse({ ...fullDeadline, status: 'cleared' }).success).toBe(true);
    expect(DeadlineSchema.safeParse({ ...fullDeadline, label: '' }).success).toBe(false);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(DeadlineSchema, fullDeadline, []);
    const once = JSON.stringify(DeadlineSchema.parse(fullDeadline));
    expect(JSON.stringify(DeadlineSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('session state (the save payload)', () => {
  it('parses a fully populated state and a minimal one', () => {
    expect(SessionStateSchema.safeParse(fullState).success).toBe(true);
    const minimal = {
      scene: { title: '', location: '', time: 0 },
      clock: 0,
      vars: {},
      sheets: {},
      deadlines: [],
    };
    expect(SessionStateSchema.safeParse(minimal).success).toBe(true);
    expectRequired(SessionStateSchema, fullState, [
      'scene',
      'clock',
      'vars',
      'sheets',
      'deadlines',
    ]);
    expectRequired(SessionStateSchema, fullState.scene, ['title', 'location', 'time']);
  });

  it('keeps the narrative clock and the inner clock independent (docs/02 §5.7)', () => {
    const parsed = SessionStateSchema.parse(fullState);
    expect(parsed.clock).toBe(1_000_120);
    expect(parsed.innerClock?.kind).toBe('round');
    expect(SessionStateSchema.safeParse({ ...fullState, innerClock: undefined }).success).toBe(
      true,
    );
    const broken = { ...fullState, innerClock: { ...fullState.innerClock, kind: 'phase' } };
    expect(SessionStateSchema.safeParse(broken).success).toBe(false);
    const noSeconds = { ...fullState, innerClock: { kind: 'turn', current: 1, note: '' } };
    expect(SessionStateSchema.safeParse(noSeconds).success).toBe(false);
  });

  it('accepts primitives in vars and arbitrary JSON in sheets, and nothing else', () => {
    expect(
      SessionStateSchema.safeParse({ ...fullState, vars: { n: 1, s: 'a', b: false } }).success,
    ).toBe(true);
    expect(SessionStateSchema.safeParse({ ...fullState, vars: { o: { nested: 1 } } }).success).toBe(
      false,
    );
    expect(SessionStateSchema.safeParse({ ...fullState, vars: { n: null } }).success).toBe(false);
    expect(
      SessionStateSchema.safeParse({ ...fullState, sheets: { [NPC_ID]: { any: [1, 'a', null] } } })
        .success,
    ).toBe(true);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    // No plugin channel here: a session's `extensions` live on the Session row,
    // and a state snapshot is a value type (see Checkpoint for the owned copy).
    expectStrips(SessionStateSchema, { ...fullState, extensions: { 'x-a': 1 } }, ['extensions']);
    const once = JSON.stringify(SessionStateSchema.parse(fullState));
    expect(JSON.stringify(SessionStateSchema.parse(JSON.parse(once)))).toBe(once);
  });
});
