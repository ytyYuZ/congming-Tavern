/**
 * Tests for the worldbook contract (docs/02 §4.1, §5.1, §5.2 L4, §7; ADR-012,
 * ADR-015).
 *
 * The cases that carry the design:
 * 1. `position` is the PromptComposer's CLOSED slot vocabulary — a slot the
 *    composer cannot place would otherwise validate and then vanish silently;
 * 2. the three time conditions (ADR-012) are each optional and independent, so a
 *    keyword-only entry stays legal;
 * 3. `probability` is the SillyTavern 0-100 convention, not a 0-1 fraction.
 */
import { describe, expect, it } from 'vitest';
import { WorldbookConditionsSchema, WorldbookEntrySchema } from './worldbook';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const ENTRY_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2301';
const WORLD_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2302';

const fullEntry = {
  id: ENTRY_ID,
  worldId: WORLD_ID,
  keywords: ['灯塔', '守夜人'],
  content: '灯塔是群岛唯一的光源，守夜人轮流看护它。',
  priority: 10,
  position: 'in_history',
  depth: 4,
  probability: 100,
  conditions: { timeOfDay: 'night', afterMinute: 5_000, withinDays: 30 },
  enabled: true,
  comment: '常驻设定，改前先问作者。',
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

describe('worldbook conditions', () => {
  it('parses all three conditions, any one of them, and none at all', () => {
    expect(WorldbookConditionsSchema.safeParse(fullEntry.conditions).success).toBe(true);
    expect(WorldbookConditionsSchema.safeParse({}).success).toBe(true);
    for (const key of ['timeOfDay', 'afterMinute', 'withinDays']) {
      const single = { [key]: fullEntry.conditions[key as keyof typeof fullEntry.conditions] };
      expect(`${key}:${WorldbookConditionsSchema.safeParse(single).success}`).toBe(`${key}:true`);
    }
  });

  it('rejects out-of-range time conditions instead of clamping them', () => {
    expect(WorldbookConditionsSchema.safeParse({ timeOfDay: '' }).success).toBe(false);
    expect(WorldbookConditionsSchema.safeParse({ afterMinute: 1.5 }).success).toBe(false);
    expect(WorldbookConditionsSchema.safeParse({ withinDays: 0 }).success).toBe(false);
    expect(WorldbookConditionsSchema.safeParse({ withinDays: -1 }).success).toBe(false);
    expect(WorldbookConditionsSchema.safeParse({ afterMinute: -1440 }).success).toBe(true);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(WorldbookConditionsSchema, fullEntry.conditions);
    const once = JSON.stringify(WorldbookConditionsSchema.parse(fullEntry.conditions));
    expect(JSON.stringify(WorldbookConditionsSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('worldbook entry', () => {
  it('parses a fully populated entry', () => {
    expect(WorldbookEntrySchema.safeParse(fullEntry).success).toBe(true);
  });

  it('parses a minimal entry (comment is the only optional field, conditions may be empty)', () => {
    const minimal: Record<string, unknown> = { ...fullEntry, conditions: {} };
    delete minimal.comment;
    expect(WorldbookEntrySchema.safeParse(minimal).success).toBe(true);
    // A keyword-less, unconditioned entry is a disabled-or-constant entry; the
    // schema does not decide that, `enabled` does.
    expect(WorldbookEntrySchema.safeParse({ ...minimal, keywords: [] }).success).toBe(true);
    expectRequired(WorldbookEntrySchema, fullEntry, [
      'id',
      'worldId',
      'keywords',
      'content',
      'priority',
      'position',
      'depth',
      'probability',
      'conditions',
      'enabled',
    ]);
  });

  it('keeps the injection slot closed to the composer vocabulary', () => {
    for (const position of ['pre_history', 'in_history', 'post_history']) {
      expect(
        `${position}:${WorldbookEntrySchema.safeParse({ ...fullEntry, position }).success}`,
      ).toBe(`${position}:true`);
    }
    // A plugin slot the composer cannot place must fail loudly, not vanish.
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, position: 'mid_history' }).success).toBe(
      false,
    );
    expect(
      WorldbookEntrySchema.safeParse({ ...fullEntry, position: 'x-mythos.slot' }).success,
    ).toBe(false);
  });

  it('bounds probability to the SillyTavern 0-100 convention', () => {
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, probability: 101 }).success).toBe(false);
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, probability: -1 }).success).toBe(false);
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, probability: 0 }).success).toBe(true);
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, probability: 33.5 }).success).toBe(false);
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, depth: -1 }).success).toBe(false);
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, depth: 0 }).success).toBe(true);
    expect(WorldbookEntrySchema.safeParse({ ...fullEntry, enabled: 'yes' }).success).toBe(false);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(WorldbookEntrySchema, fullEntry);
  });

  it('is JSON round-trip stable, conditions included', () => {
    const once = JSON.stringify(WorldbookEntrySchema.parse(fullEntry));
    expect(JSON.stringify(WorldbookEntrySchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullEntry, extensions: { 'x-mythos.scan': { regex: true } } };
    const parsed = WorldbookEntrySchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.scan': { regex: true } });
    expect(JSON.stringify(WorldbookEntrySchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(
      WorldbookEntrySchema.safeParse({ ...fullEntry, extensions: { regex: true } }).success,
    ).toBe(false);
  });
});
