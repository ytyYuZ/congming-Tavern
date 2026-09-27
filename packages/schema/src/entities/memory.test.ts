/**
 * Tests for the memory contract (docs/02 §4.1, §5.2 L3, §7; ADR-015).
 *
 * The cases that carry the design:
 * 1. `proposed` is a real, parseable status and is not upgraded on the way in —
 *    the AI's extraction must stay a proposal until the user confirms it;
 * 2. `scope` is open (plugins may own a scope) while `status` is closed;
 * 3. `atMinute` and `createdAt` are separate: what the memory is about versus
 *    when the row was written.
 */
import { describe, expect, it } from 'vitest';
import { MemoryEntrySchema } from './memory';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const MEMORY_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2001';
const TARGET_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2002';
const SOURCE_MESSAGE_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2003';
const NOW = 1_790_000_000_000;

const fullEntry = {
  id: MEMORY_ID,
  scope: 'character',
  targetId: TARGET_ID,
  text: '莉安答应在霜月十五日以前修好灯塔的透镜。',
  keywords: ['灯塔', '承诺', '透镜'],
  importance: 80,
  atMinute: 1_000_120,
  status: 'proposed',
  sourceMessageId: SOURCE_MESSAGE_ID,
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

describe('memory entry', () => {
  it('parses a fully populated entry', () => {
    expect(MemoryEntrySchema.safeParse(fullEntry).success).toBe(true);
  });

  it('parses a minimal entry (only the source message may be absent)', () => {
    const minimal: Record<string, unknown> = { ...fullEntry };
    delete minimal.sourceMessageId;
    expect(MemoryEntrySchema.safeParse(minimal).success).toBe(true);
    // Keywords may be empty: a fact with no retrieval key is still a memory.
    expect(MemoryEntrySchema.safeParse({ ...minimal, keywords: [] }).success).toBe(true);
    expectRequired(MemoryEntrySchema, fullEntry, [
      'id',
      'scope',
      'targetId',
      'text',
      'keywords',
      'importance',
      'atMinute',
      'status',
      'createdAt',
    ]);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, text: '' }).success).toBe(false);
  });

  it('keeps an extracted memory a PROPOSAL, not a confirmed fact (ADR-015)', () => {
    // No default and no coercion: what the extractor writes is what is stored.
    expect(MemoryEntrySchema.parse(fullEntry).status).toBe('proposed');
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, status: 'confirmed' }).success).toBe(true);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, status: 'rejected' }).success).toBe(true);
    // Anything outside the confirmation workflow is refused.
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, status: 'pending' }).success).toBe(false);
  });

  it('rejects out-of-range importance rather than clamping it', () => {
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, importance: 101 }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, importance: -1 }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, importance: 80.5 }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, importance: 0 }).success).toBe(true);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, importance: 100 }).success).toBe(true);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, atMinute: 1.5 }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, createdAt: -1 }).success).toBe(false);
  });

  it('opens scope to plugins while keeping the core four valid', () => {
    for (const scope of ['world', 'character', 'session', 'user']) {
      expect(`${scope}:${MemoryEntrySchema.safeParse({ ...fullEntry, scope }).success}`).toBe(
        `${scope}:true`,
      );
    }
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, scope: 'global' }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...fullEntry, scope: 'x-mythos.faction' }).success).toBe(
      true,
    );
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(MemoryEntrySchema, fullEntry);
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(MemoryEntrySchema.parse(fullEntry));
    expect(JSON.stringify(MemoryEntrySchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullEntry, extensions: { 'x-mythos.confidence': 0.62 } };
    const parsed = MemoryEntrySchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.confidence': 0.62 });
    expect(JSON.stringify(MemoryEntrySchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(
      MemoryEntrySchema.safeParse({ ...fullEntry, extensions: { confidence: 0.62 } }).success,
    ).toBe(false);
  });
});
