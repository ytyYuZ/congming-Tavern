/**
 * Tests for the turn-plan contract (docs/02 §4.1, §5.6, §7; ADR-011).
 *
 * The cases that carry the design:
 * 1. the plan is a LOCAL product — a plan with reasons and an exclusion list is
 *    representable, and ordering/`linesBudget` cannot be negative or zero;
 * 2. `mode` is the same closed schema as `Session.schedulerMode`, so the two can
 *    never drift apart;
 * 3. `excluded[]` is required, because "why is nobody talking" must stay
 *    answerable.
 */
import { describe, expect, it } from 'vitest';
import { SchedulerModeSchema } from './session';
import { TurnPlanEntrySchema, TurnPlanExclusionSchema, TurnPlanSchema } from './turn';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const PLAN_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2201';
const SESSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2202';
const CHAR_A = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2203';
const CHAR_B = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2204';
const CHAR_C = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2205';
const NOW = 1_790_000_000_000;

const fullEntry = {
  characterId: CHAR_A,
  order: 0,
  linesBudget: 2,
  score: 71.5,
  reasons: ['发言欲望 60', '冷却已过'],
};

const fullPlan = {
  id: PLAN_ID,
  sessionId: SESSION_ID,
  round: 4,
  mode: 'rules',
  entries: [fullEntry, { characterId: CHAR_B, order: 1, linesBudget: 1, score: 44, reasons: [] }],
  excluded: [{ characterId: CHAR_C, reason: '本场景未在场' }],
  overriddenByUser: true,
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

/** Unknown fields (and `extensions` on a schema that has none) are stripped. */
function expectStrips(schema: Parseable, fixture: Record<string, unknown>, dropped: string[] = []) {
  const parsed = schema.safeParse({ ...fixture, someFutureField: 1 });
  expect(parsed.success).toBe(true);
  const data = (parsed as { data?: Record<string, unknown> }).data ?? {};
  for (const key of [...dropped, 'someFutureField']) {
    expect(data).not.toHaveProperty(key);
  }
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('turn plan entry', () => {
  it('parses a fully populated entry', () => {
    expect(TurnPlanEntrySchema.safeParse(fullEntry).success).toBe(true);
    expectRequired(TurnPlanEntrySchema, fullEntry, [
      'characterId',
      'order',
      'linesBudget',
      'score',
      'reasons',
    ]);
  });

  it('refuses a budget or an order that could not be honoured', () => {
    expect(TurnPlanEntrySchema.safeParse({ ...fullEntry, linesBudget: 0 }).success).toBe(false);
    expect(TurnPlanEntrySchema.safeParse({ ...fullEntry, linesBudget: 1.5 }).success).toBe(false);
    expect(TurnPlanEntrySchema.safeParse({ ...fullEntry, order: -1 }).success).toBe(false);
    // A negative score is legal: a card can score below zero and still be listed.
    expect(TurnPlanEntrySchema.safeParse({ ...fullEntry, score: -12 }).success).toBe(true);
    expect(TurnPlanEntrySchema.safeParse({ ...fullEntry, reasons: ['a', 'b'] }).success).toBe(true);
  });

  it('has no plugin channel of its own: the plan row owns it', () => {
    expect(Object.keys(TurnPlanEntrySchema.shape)).not.toContain('extensions');
    expectStrips(TurnPlanEntrySchema, { ...fullEntry, extensions: { 'x-a': 1 } }, ['extensions']);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(TurnPlanEntrySchema, fullEntry);
    const once = JSON.stringify(TurnPlanEntrySchema.parse(fullEntry));
    expect(JSON.stringify(TurnPlanEntrySchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('turn plan exclusion', () => {
  it('requires a human-readable reason, which is the whole point of the list', () => {
    const full = { characterId: CHAR_C, reason: '冷却中（1 轮）' };
    expect(TurnPlanExclusionSchema.safeParse(full).success).toBe(true);
    expectRequired(TurnPlanExclusionSchema, full, ['characterId', 'reason']);
    expect(TurnPlanExclusionSchema.safeParse({ ...full, reason: '' }).success).toBe(false);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    const full = { characterId: CHAR_C, reason: '冷却中' };
    expectStrips(TurnPlanExclusionSchema, full);
    const once = JSON.stringify(TurnPlanExclusionSchema.parse(full));
    expect(JSON.stringify(TurnPlanExclusionSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('turn plan', () => {
  it('parses a fully populated plan', () => {
    expect(TurnPlanSchema.safeParse(fullPlan).success).toBe(true);
  });

  it('parses a minimal plan (a solo round with nobody excluded)', () => {
    const minimal = { ...fullPlan, entries: [], excluded: [], overriddenByUser: false };
    expect(TurnPlanSchema.safeParse(minimal).success).toBe(true);
    expectRequired(TurnPlanSchema, fullPlan, [
      'id',
      'sessionId',
      'round',
      'mode',
      'entries',
      'excluded',
      'overriddenByUser',
      'createdAt',
    ]);
  });

  it('shares the closed scheduler-mode vocabulary with the session', () => {
    for (const mode of ['user', 'rules', 'ai']) {
      expect(`session:${mode}:${SchedulerModeSchema.safeParse(mode).success}`).toBe(
        `session:${mode}:true`,
      );
      expect(`plan:${mode}:${TurnPlanSchema.safeParse({ ...fullPlan, mode }).success}`).toBe(
        `plan:${mode}:true`,
      );
    }
    expect(TurnPlanSchema.safeParse({ ...fullPlan, mode: 'random' }).success).toBe(false);
    // The AI may propose an order, but the plan still uses one of the three modes.
    expect(TurnPlanSchema.safeParse({ ...fullPlan, mode: 'x-mythos.ai' }).success).toBe(false);
  });

  it('rejects an out-of-range round or timestamp', () => {
    expect(TurnPlanSchema.safeParse({ ...fullPlan, round: -1 }).success).toBe(false);
    expect(TurnPlanSchema.safeParse({ ...fullPlan, round: 0 }).success).toBe(true);
    expect(TurnPlanSchema.safeParse({ ...fullPlan, overriddenByUser: 'yes' }).success).toBe(false);
    expect(TurnPlanSchema.safeParse({ ...fullPlan, createdAt: -1 }).success).toBe(false);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(TurnPlanSchema, fullPlan);
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(TurnPlanSchema.parse(fullPlan));
    expect(JSON.stringify(TurnPlanSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullPlan, extensions: { 'x-mythos.scheduler-trace': { ms: 3 } } };
    const parsed = TurnPlanSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.scheduler-trace': { ms: 3 } });
    expect(JSON.stringify(TurnPlanSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(TurnPlanSchema.safeParse({ ...fullPlan, extensions: { ms: 3 } }).success).toBe(false);
  });
});
