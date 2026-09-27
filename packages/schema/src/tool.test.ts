/**
 * Tests for the tool declaration contract (`docs/02` §5.3).
 *
 * The case that carries the design is `mutatesState` / `requiresApproval`: the AI
 * may *request* a call, but the local runtime has to know, from the declaration
 * alone, whether that call may touch state (HANDOFF §4.1 invariant 3).
 */
import { describe, expect, it } from 'vitest';
import { ToolDefinitionSchema, ToolParameterSchema } from './tool';

const definition = {
  name: 'roll_dice',
  summary: '掷骰，由本地引擎执行',
  parameters: [
    { name: 'expr', type: 'string', description: 'NdM 表达式', required: true },
    { name: 'reason', type: 'string', description: '为什么要掷', required: false },
  ],
  owner: 'core',
  mutatesState: false,
  requiresApproval: false,
};

describe('tool definition', () => {
  it('parses a core tool and a plugin-namespaced one', () => {
    expect(ToolDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(
      ToolDefinitionSchema.safeParse({
        ...definition,
        name: 'x-mythos/roll_sanity',
        owner: 'x-mythos',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed tool names instead of letting the model see them', () => {
    for (const name of ['', 'Roll_Dice', ' roll_dice', 'roll dice', 'a'.repeat(65)]) {
      expect(`${name}:${ToolDefinitionSchema.safeParse({ ...definition, name }).success}`).toBe(
        `${name}:false`,
      );
    }
  });

  it('requires every field the runtime needs to decide on a call', () => {
    for (const field of [
      'name',
      'summary',
      'parameters',
      'owner',
      'mutatesState',
      'requiresApproval',
    ]) {
      const broken: Record<string, unknown> = { ...definition };
      delete broken[field];
      expect(`${field}:${ToolDefinitionSchema.safeParse(broken).success}`).toBe(`${field}:false`);
    }
  });

  it('keeps mutating/approval flags strictly boolean', () => {
    expect(ToolDefinitionSchema.safeParse({ ...definition, mutatesState: 'yes' }).success).toBe(
      false,
    );
    expect(ToolDefinitionSchema.safeParse({ ...definition, requiresApproval: true }).success).toBe(
      true,
    );
  });

  it('validates parameters, including the closed type set', () => {
    expect(
      ToolParameterSchema.safeParse({
        name: 'expr',
        type: 'string',
        description: '',
        required: true,
      }).success,
    ).toBe(true);
    expect(
      ToolParameterSchema.safeParse({ name: 'expr', type: 'ndm', description: '', required: true })
        .success,
    ).toBe(false);
    expect(
      ToolParameterSchema.safeParse({
        name: 'Expr',
        type: 'string',
        description: '',
        required: true,
      }).success,
    ).toBe(false);
    expect(
      ToolParameterSchema.safeParse({
        name: 'unit',
        type: 'string',
        description: '时间单位',
        required: false,
        values: ['minute', 'hour', 'day'],
        default: 'minute',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-JSON default, because defaults travel through prompts', () => {
    expect(
      ToolParameterSchema.safeParse({
        name: 'expr',
        type: 'string',
        description: '',
        required: false,
        default: () => 1,
      }).success,
    ).toBe(false);
  });

  it('strips unknown fields and round-trips through JSON unchanged', () => {
    const parsed = ToolDefinitionSchema.parse({ ...definition, someFutureField: 1 });
    expect(parsed).not.toHaveProperty('someFutureField');
    const once = JSON.stringify(parsed);
    expect(JSON.stringify(ToolDefinitionSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips a plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...definition, extensions: { 'x-mythos.dc-hint': { dc: 15 } } };
    expect(ToolDefinitionSchema.parse(withExtension).extensions).toEqual({
      'x-mythos.dc-hint': { dc: 15 },
    });
    expect(ToolDefinitionSchema.safeParse({ ...definition, extensions: { dc: 15 } }).success).toBe(
      false,
    );
  });
});
