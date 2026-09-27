/**
 * Tool runtime double: the invariant that the AI may REQUEST but only the local
 * runtime WRITES, expressed as refusals (docs/02 §5.3, HANDOFF §4.1 invariant 3).
 */
import { describe, expect, it } from 'vitest';
import { MockToolError, MockToolRuntime, mockTool } from './index';

const CALL = { id: 'call-1', name: 'roll_dice', source: 'native' } as const;
const ARGS = { expr: '1d20', target: 'c1' };

function toolWithHandler(runtime: MockToolRuntime, mutatesState = false): void {
  runtime.register(mockTool({ mutatesState, requiresApproval: false }), async (args) => ({
    total: 7,
    expr: (args as { expr: string }).expr,
  }));
}

describe('MockToolRuntime.validate', () => {
  it('accepts a well-formed call for a stateless tool', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);

    const validation = await runtime.validate({ ...CALL, args: ARGS });

    expect(validation.status).toBe('valid');
    expect(validation.issues).toEqual([]);
    expect(validation.mutatesState).toBe(false);
    expect(validation.manualApproval).toBe(false);
  });

  it('never executes or records anything: validation is a read-only step', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);
    await runtime.validate({ ...CALL, args: ARGS });
    await runtime.validate({ ...CALL, args: ARGS });
    expect(runtime.executions).toEqual([]);
    expect(runtime.audit()).toEqual([]);
  });

  it('rejects a missing required parameter', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);

    const validation = await runtime.validate({ ...CALL, args: { expr: '1d20' } });

    expect(validation.status).toBe('invalid');
    expect(validation.issues).toEqual([
      { parameter: 'target', code: 'missing', detail: 'required parameter target is missing' },
    ]);
  });

  it('rejects a wrongly typed or unknown parameter', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);

    const validation = await runtime.validate({
      ...CALL,
      args: { expr: '1d20', target: 'c1', modifier: 'big', ac: 15 },
    });

    expect(validation.status).toBe('invalid');
    expect(validation.issues.map((issue) => issue.code)).toEqual(['type', 'unknown']);
    expect(validation.detail).toContain('native');
  });

  it('rejects a value outside a declared enumeration', async () => {
    const runtime = new MockToolRuntime();
    runtime.register(
      mockTool({
        parameters: [
          {
            name: 'unit',
            type: 'string',
            description: 'time unit',
            required: true,
            values: ['minute', 'hour'],
          },
        ],
      }),
    );

    const validation = await runtime.validate({ ...CALL, args: { unit: 'fortnight' } });

    expect(validation.issues[0]?.code).toBe('enum');
  });

  it('says so when the tool is not registered at all', async () => {
    const validation = await new MockToolRuntime().validate({ ...CALL, args: ARGS });

    expect(validation.status).toBe('unknown-tool');
    expect(validation.detail).toContain('roll_dice');
  });

  it('marks a state-changing tool as needing approval', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime, true);

    const validation = await runtime.validate({ ...CALL, args: ARGS });

    expect(validation.status).toBe('requires-approval');
    expect(validation.mutatesState).toBe(true);
    expect(validation.manualApproval).toBe(true);
  });

  it('notes when a call arrived over a plugin channel, not a ladder level', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);

    const validation = await runtime.validate({
      ...CALL,
      source: 'x-mythos.function-call',
      args: ARGS,
    });

    expect(validation.status).toBe('valid');
    expect(validation.detail).toContain('x-mythos.function-call');
  });
});

describe('MockToolRuntime.execute', () => {
  it('executes a valid call locally and returns the value for the model', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);

    const validation = await runtime.validate({ ...CALL, args: ARGS });
    const result = await runtime.execute({ call: { ...CALL, args: ARGS }, validation });

    expect(result).toEqual({
      ok: true,
      value: { total: 7, expr: '1d20' },
      detail: 'roll_dice executed locally',
    });
  });

  it('refuses to execute a mutating call that was never approved', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime, true);
    const call = { ...CALL, args: ARGS };

    const validation = await runtime.validate(call);
    expect(validation.status).toBe('requires-approval');

    const refused = await runtime.execute({ call, validation });
    expect(refused).toEqual({
      ok: false,
      reason: 'rejected',
      detail: 'approval is required but was not given',
      issues: [],
    });

    const approved = await runtime.execute({ call, validation, approvedBy: 'user' });
    expect(approved.ok).toBe(true);
  });

  it('refuses to execute a call that failed validation', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime);
    const call = { ...CALL, args: {} };

    const validation = await runtime.validate(call);
    const result = await runtime.execute({ call, validation });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rejected');
      expect(result.issues.map((issue) => issue.parameter)).toEqual(['expr', 'target']);
    }
  });

  it('refuses to execute a declared but unimplemented tool', async () => {
    const runtime = new MockToolRuntime();
    runtime.register(mockTool());

    const call = { ...CALL, args: ARGS };
    const validation = await runtime.validate(call);
    const result = await runtime.execute({ call, validation });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'error') expect(result.retryable).toBe(true);
  });

  it('turns a handler failure into a result, and honours retryability', async () => {
    const runtime = new MockToolRuntime();
    runtime.register(mockTool(), () => {
      throw new MockToolError('dice syntax is invalid', true);
    });

    const call = { ...CALL, args: ARGS };
    const validation = await runtime.validate(call);
    const result = await runtime.execute({ call, validation });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'error') {
      expect(result.retryable).toBe(true);
      expect(result.detail).toBe('dice syntax is invalid');
    }
  });

  it('records every attempt, including the refusals (§5.3 audit trail)', async () => {
    const runtime = new MockToolRuntime();
    toolWithHandler(runtime, true);
    const call = { ...CALL, args: ARGS, atMinute: 90 };

    const validation = await runtime.validate(call);
    await runtime.execute({ call, validation });
    await runtime.execute({ call, validation, approvedBy: 'user' });

    const records = runtime.recordsFor(call.id);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      callId: 'call-1',
      name: 'roll_dice',
      source: 'native',
      validationStatus: 'requires-approval',
      ok: false,
      atMinute: 90,
      timestamp: 0,
    });
    expect(records[0]?.approvedBy).toBeUndefined();
    expect(records[1]?.approvedBy).toBe('user');
    expect(records[1]?.ok).toBe(true);
    expect(runtime.audit()).toHaveLength(2);
  });
});

describe('MockToolRuntime catalog', () => {
  it('registers, lists, gets and unregisters by tool name', () => {
    const runtime = new MockToolRuntime();
    runtime.register(mockTool());

    expect(runtime.list().map((tool) => tool.name)).toEqual(['roll_dice']);
    expect(runtime.get('roll_dice')?.owner).toBe('core');
    expect(runtime.unregister('roll_dice')).toBe(true);
    expect(runtime.unregister('roll_dice')).toBe(false);
    expect(runtime.list()).toEqual([]);
  });

  it('plans the ladder from the model capabilities it is handed', () => {
    const runtime = new MockToolRuntime();
    expect(
      runtime.planChannels({
        nativeFunctionCalling: true,
        structuredOutput: true,
        textProtocol: true,
      })?.order,
    ).toEqual(['native', 'json', 'text-protocol']);
  });
});
