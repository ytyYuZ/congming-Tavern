/**
 * Tests for the agenda contract (docs/02 §4, §5.7, §7).
 *
 * The cases that carry the design:
 * 1. `source` is open (a plugin or importer may have scheduled the entry) while
 *    `status` is the closed state machine `TimeEngine.fireDue()` drives;
 * 2. time is an epoch minute, and a repeat period is a positive delta — a zero
 *    period would fire the same entry forever;
 * 3. the §4/§7 disagreement over `sessionId` was resolved by putting §7's index
 *    key on the row (see the module docstring), and a test pins that it is required.
 */
import { describe, expect, it } from 'vitest';
import { AgendaEntrySchema } from './agenda';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const ENTRY_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1f01';
const SESSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1f00';
const ACTOR_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1f02';
const OTHER_ACTOR_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1f03';
const RESULT_MESSAGE_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1f04';

const fullEntry = {
  id: ENTRY_ID,
  sessionId: SESSION_ID,
  title: '灯塔熄灭',
  description: '守夜人换班时灯塔灭了十分钟。',
  atMinute: 1_000_800,
  repeatEveryMinutes: 1440,
  actors: [ACTOR_ID, OTHER_ACTOR_ID],
  secret: true,
  status: 'pending',
  source: 'rulepack',
  resultingMessageId: RESULT_MESSAGE_ID,
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

/**
 * Copy of `source` with `keys` removed.
 *
 * Both spellings of a bare key are unusable here: `minimal.repeatEveryMinutes`
 * trips `noPropertyAccessFromIndexSignature`, and `minimal['repeatEveryMinutes']`
 * trips Biome's `useLiteralKeys`. Only a parameterised key satisfies both.
 */
function withoutKeys(source: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('agenda entry', () => {
  it('parses a fully populated entry', () => {
    expect(AgendaEntrySchema.safeParse(fullEntry).success).toBe(true);
  });

  it('parses a minimal entry (repeat and result are the only optional fields)', () => {
    const minimal = withoutKeys(fullEntry, 'repeatEveryMinutes', 'resultingMessageId');
    expect(AgendaEntrySchema.safeParse(minimal).success).toBe(true);
    // An entry with no actors is legal: "the fog rolls in" involves nobody.
    expect(AgendaEntrySchema.safeParse({ ...minimal, actors: [] }).success).toBe(true);
    expectRequired(AgendaEntrySchema, fullEntry, [
      'id',
      'sessionId',
      'title',
      'description',
      'atMinute',
      'actors',
      'secret',
      'status',
      'source',
    ]);
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, title: '' }).success).toBe(false);
  });

  it('rejects an unknown status (closed machine) and an unknown source (open enum)', () => {
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, status: 'done' }).success).toBe(false);
    for (const status of ['pending', 'fired', 'skipped', 'rescheduled']) {
      expect(`${status}:${AgendaEntrySchema.safeParse({ ...fullEntry, status }).success}`).toBe(
        `${status}:true`,
      );
    }
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, source: 'system' }).success).toBe(false);
    expect(
      AgendaEntrySchema.safeParse({ ...fullEntry, source: 'x-mythos.rumor-table' }).success,
    ).toBe(true);
  });

  it('rejects out-of-range time and repeat values instead of clamping them', () => {
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, repeatEveryMinutes: 0 }).success).toBe(
      false,
    );
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, repeatEveryMinutes: 1.5 }).success).toBe(
      false,
    );
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, atMinute: 1.5 }).success).toBe(false);
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, secret: 'yes' }).success).toBe(false);
    // An epoch minute is any integer, including a pre-epoch one.
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, atMinute: -60 }).success).toBe(true);
  });

  it('carries the session key docs/02 §7 indexes the collection by', () => {
    // §7 indexes `agenda` by (sessionId, atMinute, status). The field lives on the
    // row so the storage layer never needs a parallel key — Message, Checkpoint and
    // TurnPlan do the same. A foreign (non-UUID) session id is legal: docs/04 §7
    // validates the payload BEFORE it remaps ids.
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, sessionId: 'sess-frost-01' }).success).toBe(
      true,
    );
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, sessionId: '' }).success).toBe(false);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(AgendaEntrySchema, fullEntry);
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(AgendaEntrySchema.parse(fullEntry));
    expect(JSON.stringify(AgendaEntrySchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullEntry, extensions: { 'x-mythos.hidden-dc': { dc: 15 } } };
    const parsed = AgendaEntrySchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.hidden-dc': { dc: 15 } });
    expect(JSON.stringify(AgendaEntrySchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(AgendaEntrySchema.safeParse({ ...fullEntry, extensions: { dc: 15 } }).success).toBe(
      false,
    );
  });
});
