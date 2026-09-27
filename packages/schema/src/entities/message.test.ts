/**
 * Tests for the message contract (docs/02 §4, §7).
 *
 * The cases that carry the design:
 * 1. `role` stays CLOSED (wire protocol) while `kind` is OPEN — a plugin kind
 *    must validate, and an invented role must not (`common.ts` rule 3);
 * 2. `ToolCall.name` is a free string and `source` is open, because tools and
 *    transports are plugin extension points (plugins.ts §3);
 * 3. the tree edge (`parentId`) is `null` at the root, never missing.
 */
import { describe, expect, it } from 'vitest';
import { MessageMetaSchema, MessageSchema, ToolCallSchema } from './message';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const MESSAGE_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1d01';
const SESSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1d02';
const PARENT_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1d03';
const SPEAKER_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1d04';
const NOW = 1_790_000_000_000;

const fullToolCall = {
  id: 'call-1',
  name: 'roll_dice',
  args: { expr: '1d20+3', reason: '撬锁' },
  result: { total: 17, rolls: [14] },
  status: 'ok',
  source: 'native',
};

const fullMessage = {
  id: MESSAGE_ID,
  sessionId: SESSION_ID,
  parentId: PARENT_ID,
  role: 'assistant',
  speakerId: SPEAKER_ID,
  kind: 'dialogue',
  content: '"门没锁，但里面有人。"',
  emotion: 'wary',
  toolCalls: [fullToolCall],
  meta: {
    tokens: 128,
    model: 'gpt-x',
    promptSnapshotId: 'snap-7',
    emittedAtMinute: 1_000_120,
    turnPlanId: 'plan-3',
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

/**
 * Copy of `source` with `keys` removed.
 *
 * Both spellings of a bare key are unusable here: `minimal.result` trips
 * `noPropertyAccessFromIndexSignature`, and `minimal['result']` trips Biome's
 * `useLiteralKeys`. Only a parameterised key satisfies both.
 */
function withoutKeys(source: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('tool call', () => {
  it('parses a fully populated call and a minimal one (args is required, result is not)', () => {
    expect(ToolCallSchema.safeParse(fullToolCall).success).toBe(true);
    const minimal = withoutKeys(fullToolCall, 'result');
    expect(ToolCallSchema.safeParse(minimal).success).toBe(true);
    expectRequired(ToolCallSchema, fullToolCall, ['id', 'name', 'args', 'status', 'source']);
    // `args` accepts any JSON payload: each tool owns its own argument schema.
    expect(ToolCallSchema.safeParse({ ...fullToolCall, args: [1, 'two', null] }).success).toBe(
      true,
    );
    expect(ToolCallSchema.safeParse({ ...fullToolCall, name: '' }).success).toBe(false);
  });

  it('keeps the tool name a free string and the source open, but the status closed', () => {
    // A plugin-provided tool is registered by name (plugins.ts §3).
    const pluginTool = {
      ...fullToolCall,
      name: 'x-mythos.roll_sanity',
      source: 'x-mythos.function-call',
    };
    expect(ToolCallSchema.safeParse(pluginTool).success).toBe(true);
    expect(ToolCallSchema.safeParse({ ...fullToolCall, source: 'text-protocol' }).success).toBe(
      true,
    );
    expect(ToolCallSchema.safeParse({ ...fullToolCall, source: 'telepathy' }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ ...fullToolCall, status: 'maybe' }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ ...fullToolCall, status: 'rejected' }).success).toBe(true);
    expect(ToolCallSchema.safeParse({ ...fullToolCall, status: 'error' }).success).toBe(true);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(ToolCallSchema, fullToolCall);
    const once = JSON.stringify(ToolCallSchema.parse(fullToolCall));
    expect(JSON.stringify(ToolCallSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('message meta', () => {
  it('parses the full record and an empty one (every field is optional)', () => {
    expect(MessageMetaSchema.safeParse(fullMessage.meta).success).toBe(true);
    expect(MessageMetaSchema.safeParse({}).success).toBe(true);
    expect(MessageMetaSchema.safeParse({ tokens: -1 }).success).toBe(false);
    expect(MessageMetaSchema.safeParse({ tokens: 1.5 }).success).toBe(false);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(MessageMetaSchema, fullMessage.meta);
    const once = JSON.stringify(MessageMetaSchema.parse({}));
    expect(JSON.stringify(MessageMetaSchema.parse(JSON.parse(once)))).toBe(once);
  });
});

describe('message', () => {
  it('parses a fully populated message', () => {
    expect(MessageSchema.safeParse(fullMessage).success).toBe(true);
  });

  it('parses a minimal message (only the optional presentation fields may be absent)', () => {
    const minimal = withoutKeys(
      { ...fullMessage, parentId: null, meta: {} },
      'speakerId',
      'emotion',
      'toolCalls',
    );
    expect(MessageSchema.safeParse(minimal).success).toBe(true);
    expectRequired(MessageSchema, fullMessage, [
      'id',
      'sessionId',
      'parentId',
      'role',
      'kind',
      'content',
      'meta',
      'createdAt',
    ]);
  });

  it('keeps the protocol role closed but lets a plugin contribute a kind', () => {
    expect(MessageSchema.safeParse({ ...fullMessage, role: 'narrator' }).success).toBe(false);
    for (const role of ['system', 'user', 'assistant', 'tool']) {
      expect(`${role}:${MessageSchema.safeParse({ ...fullMessage, role }).success}`).toBe(
        `${role}:true`,
      );
    }
    expect(MessageSchema.safeParse({ ...fullMessage, kind: 'monologue' }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...fullMessage, kind: 'x-mythos.monologue' }).success).toBe(
      true,
    );
    for (const kind of ['narration', 'dialogue', 'action', 'ooc']) {
      expect(`${kind}:${MessageSchema.safeParse({ ...fullMessage, kind }).success}`).toBe(
        `${kind}:true`,
      );
    }
  });

  it('models the tree: a root message has parentId null, not a missing edge', () => {
    const root = { ...fullMessage, parentId: null };
    expect(MessageSchema.parse(root).parentId).toBeNull();
    const broken = withoutKeys(fullMessage, 'parentId');
    expect(MessageSchema.safeParse(broken).success).toBe(false);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(MessageSchema, fullMessage);
  });

  it('is JSON round-trip stable, tool calls included', () => {
    const once = JSON.stringify(MessageSchema.parse(fullMessage));
    expect(JSON.stringify(MessageSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullMessage, extensions: { 'x-mythos.voice': { pitch: -2 } } };
    const parsed = MessageSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.voice': { pitch: -2 } });
    expect(JSON.stringify(MessageSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(MessageSchema.safeParse({ ...fullMessage, extensions: { pitch: -2 } }).success).toBe(
      false,
    );
  });
});
