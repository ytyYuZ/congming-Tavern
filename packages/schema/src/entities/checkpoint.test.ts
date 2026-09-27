/**
 * Tests for the checkpoint contract (docs/02 §4, §5.7, §7; docs/04 §6).
 *
 * The one invariant worth defending here is the reason checkpoints exist at all:
 * a save carries the FULL clock snapshot, so loading it never replays messages.
 * That is asserted three ways — the clock is inside `state`, the inner clock and
 * deadlines survive the round-trip with it, and the row has no message list to
 * fall back on.
 */
import { describe, expect, it } from 'vitest';
import { CastStateSchema, CheckpointSchema } from './checkpoint';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const CHECKPOINT_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1e01';
const SESSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1e02';
const MESSAGE_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1e03';
const SPEAKER_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1e04';
const NOW = 1_790_000_000_000;

const fullState = {
  scene: { title: '雪夜旅店', location: '银松镇·旅店', time: 1_000_120 },
  clock: 1_000_120,
  innerClock: { kind: 'turn', current: 3, total: 12, secondsPerRound: 6, note: '酒馆混战' },
  vars: { 天气: '暴雪', 威胁: 3, 已发现灯塔: true },
  sheets: { [SPEAKER_ID]: { hp: 12, conditions: ['疲惫'] } },
  deadlines: [
    {
      id: 'ritual',
      label: '仪式开始',
      dueMinute: 1_002_000,
      kind: 'countdown',
      targetId: SPEAKER_ID,
      status: 'active',
    },
  ],
};

const fullCheckpoint = {
  id: CHECKPOINT_ID,
  sessionId: SESSION_ID,
  label: '酒馆混战前',
  messageId: MESSAGE_ID,
  auto: true,
  state: fullState,
  agendaStatus: [{ id: 'rumor-1', status: 'fired' }],
  summary: '一行人在雪夜旅店撞见守夜人。',
  castState: {
    [SPEAKER_ID]: { present: true, emotion: 'wary', outfit: 'cloak', muted: false },
    'npc-2': { present: false },
  },
  createdAt: NOW,
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

/** Unknown fields are stripped, never rejected (HANDOFF §4.1 invariant 5). */
function expectStrips(schema: Parseable, fixture: Record<string, unknown>) {
  const parsed = schema.safeParse({ ...fixture, someFutureField: 1 });
  expect(parsed.success).toBe(true);
  expect((parsed as { data?: Record<string, unknown> }).data ?? {}).not.toHaveProperty(
    'someFutureField',
  );
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('cast state', () => {
  it('parses a full record and a presence-only record', () => {
    expect(CastStateSchema.safeParse(fullCheckpoint.castState[SPEAKER_ID]).success).toBe(true);
    expect(CastStateSchema.safeParse({ present: false }).success).toBe(true);
    expectRequired(CastStateSchema, fullCheckpoint.castState[SPEAKER_ID], ['present']);
    expect(CastStateSchema.safeParse({ emotion: 'wary' }).success).toBe(false);
    expect(CastStateSchema.safeParse({ present: 'yes' }).success).toBe(false);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(CastStateSchema, fullCheckpoint.castState[SPEAKER_ID]);
    const once = JSON.stringify(CastStateSchema.parse(fullCheckpoint.castState[SPEAKER_ID]));
    expect(JSON.stringify(CastStateSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('checkpoint', () => {
  it('parses a fully populated checkpoint', () => {
    expect(CheckpointSchema.safeParse(fullCheckpoint).success).toBe(true);
  });

  it('parses a minimal checkpoint (every field but extensions is required)', () => {
    const minimal = {
      id: CHECKPOINT_ID,
      sessionId: SESSION_ID,
      label: '自动存档',
      messageId: MESSAGE_ID,
      auto: false,
      state: {
        scene: { title: '', location: '', time: 0 },
        clock: 0,
        vars: {},
        sheets: {},
        deadlines: [],
      },
      agendaStatus: [],
      summary: '',
      castState: {},
      createdAt: 0,
    };
    expect(CheckpointSchema.safeParse(minimal).success).toBe(true);
    expectRequired(CheckpointSchema, fullCheckpoint, [
      'id',
      'sessionId',
      'label',
      // Required AND nullable: deleting it is still a parse failure (this driver), while
      // `messageId: null` is a value — see the minute-zero case below.
      'messageId',
      'auto',
      'state',
      'agendaStatus',
      'summary',
      'castState',
      'createdAt',
    ]);
    expect(CheckpointSchema.safeParse({ ...fullCheckpoint, label: '' }).success).toBe(false);
  });

  it('accepts a null messageId — the save point taken before the first message', () => {
    // A session starts with no messages (`Session.headMessageId` is `IdSchema.nullable()`
    // for the same reason), so a checkpoint has to be able to say "at the start of an
    // empty transcript". `null` is that one spelling.
    expect(CheckpointSchema.safeParse({ ...fullCheckpoint, messageId: null }).success).toBe(true);
    expect(CheckpointSchema.parse({ ...fullCheckpoint, messageId: null }).messageId).toBeNull();
    // `''` is NOT a second spelling: `IdSchema` refuses it, so a reader never has to treat
    // an empty id as a third case.
    expect(CheckpointSchema.safeParse({ ...fullCheckpoint, messageId: '' }).success).toBe(false);
    // And `null` survives the JSON round trip a stored row performs.
    const once = JSON.stringify(CheckpointSchema.parse({ ...fullCheckpoint, messageId: null }));
    expect(JSON.stringify(CheckpointSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('carries the full clock snapshot, so loading a save never replays messages', () => {
    const parsed = CheckpointSchema.parse(fullCheckpoint);
    expect(parsed.state.clock).toBe(1_000_120);
    expect(parsed.state.innerClock?.current).toBe(3);
    expect(parsed.state.deadlines).toHaveLength(1);
    expect(parsed.state.scene.title).toBe('雪夜旅店');
    // Nothing in the row is a message list: the state IS the restore path.
    expect(Object.keys(CheckpointSchema.shape)).not.toContain('messages');
    expect(Object.keys(CheckpointSchema.shape)).not.toContain('messageIds');
    // Dropping any part of the clock makes the snapshot incomplete.
    for (const field of ['clock', 'scene', 'deadlines', 'vars', 'sheets']) {
      const broken: Record<string, unknown> = { ...fullState };
      delete broken[field];
      expect(
        `${field}:${CheckpointSchema.safeParse({ ...fullCheckpoint, state: broken }).success}`,
      ).toBe(`${field}:false`);
    }
  });

  it('rejects an unknown agenda status and an unknown inner-clock kind', () => {
    expect(
      CheckpointSchema.safeParse({
        ...fullCheckpoint,
        agendaStatus: [{ id: 'rumor-1', status: 'done' }],
      }).success,
    ).toBe(false);
    expect(
      CheckpointSchema.safeParse({
        ...fullCheckpoint,
        state: { ...fullState, innerClock: { ...fullState.innerClock, kind: 'phase' } },
      }).success,
    ).toBe(false);
    expect(CheckpointSchema.safeParse({ ...fullCheckpoint, createdAt: -1 }).success).toBe(false);
    expect(CheckpointSchema.safeParse({ ...fullCheckpoint, auto: 'yes' }).success).toBe(false);
  });

  it('reuses the agenda status vocabulary instead of redeclaring it', () => {
    for (const status of ['pending', 'fired', 'skipped', 'rescheduled']) {
      const candidate = { ...fullCheckpoint, agendaStatus: [{ id: 'x', status }] };
      expect(`${status}:${CheckpointSchema.safeParse(candidate).success}`).toBe(`${status}:true`);
    }
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(CheckpointSchema, fullCheckpoint);
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(CheckpointSchema.parse(fullCheckpoint));
    expect(JSON.stringify(CheckpointSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullCheckpoint, extensions: { 'x-mythos.save-tag': 'boss' } };
    const parsed = CheckpointSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.save-tag': 'boss' });
    expect(JSON.stringify(CheckpointSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(
      CheckpointSchema.safeParse({ ...fullCheckpoint, extensions: { saveTag: 'boss' } }).success,
    ).toBe(false);
  });
});
