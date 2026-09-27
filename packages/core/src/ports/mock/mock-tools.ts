/**
 * In-memory `ToolRuntime` double (docs/06 §8.4: "有 mock 实现用于测试").
 *
 * WHAT IT PROVES
 * The port's central rule is that a model may only REQUEST (HANDOFF §4.1
 * invariant 3), so this double is strict on purpose:
 * - `validate` never executes anything and never writes;
 * - `execute` REFUSES a call whose validation was not `valid` /
 *   `requires-approval`;
 * - `execute` REFUSES a mutating call that arrives without `approvedBy`;
 * - every attempt, including a refusal, lands in `audit()` — §5.3 requires all
 *   calls to be auditable.
 *
 * ARGUMENT VALIDATION IS STRUCTURAL, NOT JSON SCHEMA
 * It walks the tool's declared `parameters` (name / type / required / values).
 * That is the same information M0-T2's Zod → JSON Schema pipeline publishes, and
 * a double is the right place to keep the check small: the real runtime reuses
 * the pipeline, this one only has to be able to reject a missing or mistyped
 * argument so the runtime's refusals can be tested.
 */
import type { ToolDefinition, ToolName } from '@smarttavern/schema';
import type {
  ToolApprovalSource,
  ToolAuditRecord,
  ToolCallRequest,
  ToolCallResult,
  ToolChannelCapabilities,
  ToolDegradationPlan,
  ToolExecutionRequest,
  ToolHandler,
  ToolParameterIssue,
  ToolRuntime,
  ToolValidation,
} from '../tools';
import { isBuiltInToolChannel, needsApproval, planToolChannels } from '../tools';

/** A registered tool's local behaviour: the port's handler type, verbatim. */
export type MockToolHandler = ToolHandler;

/** A thrown value from a handler becomes a failed (and possibly retryable) result. */
export class MockToolError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'MockToolError';
    this.retryable = retryable;
  }
}

/** Fixed clock so the audit trail is deterministic (docs/02 §11). */
const FIXED_TIMESTAMP = 0;

export class MockToolRuntime implements ToolRuntime {
  private readonly tools = new Map<ToolName, ToolDefinition>();
  private readonly handlers = new Map<ToolName, MockToolHandler>();
  private readonly records: ToolAuditRecord[] = [];

  /** Calls handed to `execute`, in order, including the refused ones. */
  readonly executions: ToolCallRequest[] = [];

  register(tool: ToolDefinition, handler?: MockToolHandler): void {
    this.tools.set(tool.name, tool);
    if (handler !== undefined) this.handlers.set(tool.name, handler);
  }

  unregister(name: ToolName): boolean {
    this.handlers.delete(name);
    return this.tools.delete(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  planChannels(capabilities: ToolChannelCapabilities): ToolDegradationPlan | undefined {
    return planToolChannels(capabilities);
  }

  async validate(call: ToolCallRequest): Promise<ToolValidation> {
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return {
        status: 'unknown-tool',
        issues: [],
        manualApproval: false,
        mutatesState: false,
        detail: `no tool named ${call.name} is registered`,
      };
    }

    const issues = validateArguments(tool, call.args);
    const mutatesState = tool.mutatesState;
    const manualApproval = needsApproval(tool);

    if (issues.length > 0) {
      return {
        status: 'invalid',
        tool,
        issues,
        manualApproval,
        mutatesState,
        detail:
          `${call.name} was called with invalid arguments over the ` +
          `${call.source} channel: ${issues.map((issue) => issue.detail).join('; ')}`,
      };
    }

    // A plugin channel is legal, but it is not part of §5.3's ladder; a call that
    // arrives over a channel the ladder never negotiated is worth flagging.
    const channelNote = isBuiltInToolChannel(call.source)
      ? ''
      : ` (channel ${call.source} is a plugin channel, not a ladder level)`;

    if (manualApproval) {
      return {
        status: 'requires-approval',
        tool,
        issues: [],
        manualApproval,
        mutatesState,
        detail: `${call.name} changes state and needs local approval before it may run${channelNote}`,
      };
    }

    return {
      status: 'valid',
      tool,
      issues: [],
      manualApproval,
      mutatesState,
      detail: `${call.name} passed validation and may run locally${channelNote}`,
    };
  }

  async execute(request: ToolExecutionRequest): Promise<ToolCallResult> {
    const { call, validation, approvedBy } = request;
    this.executions.push(call);

    if (validation.status === 'unknown-tool' || validation.status === 'invalid') {
      return this.refuse(call, validation, 'rejected', 'the call did not pass validation');
    }
    if (validation.manualApproval && approvedBy === undefined) {
      return this.refuse(call, validation, 'rejected', 'approval is required but was not given');
    }

    const handler = this.handlers.get(call.name);
    if (handler === undefined) {
      return this.refuse(call, validation, 'error', `${call.name} has no local handler`, true);
    }

    try {
      const value = await handler(call.args, call);
      const result: ToolCallResult = {
        ok: true,
        value,
        detail: `${call.name} executed locally`,
      };
      this.append(call, validation, result, approvedBy);
      return result;
    } catch (error) {
      const retryable = error instanceof MockToolError ? error.retryable : false;
      const result: ToolCallResult = {
        ok: false,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error),
        retryable,
      };
      this.append(call, validation, result, approvedBy);
      return result;
    }
  }

  audit(): readonly ToolAuditRecord[] {
    return [...this.records];
  }

  /* ─────────────────────────── test conveniences ────────────────────────── */

  /** Audit rows for one call id. */
  recordsFor(callId: string): ToolAuditRecord[] {
    return this.records.filter((record) => record.callId === callId);
  }

  clear(): void {
    this.records.length = 0;
    this.executions.length = 0;
  }

  private refuse(
    call: ToolCallRequest,
    validation: ToolValidation,
    reason: 'rejected' | 'error',
    detail: string,
    retryable = false,
  ): ToolCallResult {
    const result: ToolCallResult =
      reason === 'rejected'
        ? { ok: false, reason: 'rejected', detail, issues: validation.issues }
        : { ok: false, reason: 'error', detail, retryable };
    this.append(call, validation, result, undefined);
    return result;
  }

  private append(
    call: ToolCallRequest,
    validation: ToolValidation,
    result: ToolCallResult,
    approvedBy: ToolApprovalSource | undefined,
  ): void {
    this.records.push({
      callId: call.id,
      name: call.name,
      source: call.source,
      args: call.args,
      validationStatus: validation.status,
      ok: result.ok,
      detail: result.detail,
      ...(approvedBy === undefined ? {} : { approvedBy }),
      ...(call.atMinute === undefined ? {} : { atMinute: call.atMinute }),
      timestamp: FIXED_TIMESTAMP,
    });
  }
}

/* ──────────────────────────── 测试用工具声明 ───────────────────────────── */

/**
 * A tool DECLARATION with two parameters (one required string, one optional
 * integer), so every branch of `validateArguments` has something to exercise.
 * Overrides let a test state the one difference it cares about.
 */
export function mockTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'roll_dice',
    summary: 'Roll dice with the local engine',
    parameters: [
      { name: 'expr', type: 'string', description: 'dice expression, e.g. 2d6+1', required: true },
      { name: 'target', type: 'string', description: 'who rolls', required: true },
      { name: 'reason', type: 'string', description: 'why', required: false },
      { name: 'modifier', type: 'integer', description: 'flat bonus', required: false },
    ],
    owner: 'core',
    mutatesState: false,
    requiresApproval: false,
    ...overrides,
  };
}

/* ────────────────────────── 参数校验（结构化） ─────────────────────────── */

/** Shape check of `args` against a tool's declared parameters. */
export function validateArguments(tool: ToolDefinition, args: unknown): ToolParameterIssue[] {
  const issues: ToolParameterIssue[] = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return [
      {
        code: 'type',
        detail: `${tool.name} expects an object of arguments, received ${describe(args)}`,
      },
    ];
  }
  const record = args as Record<string, unknown>;

  for (const parameter of tool.parameters) {
    const value = record[parameter.name];
    if (value === undefined) {
      if (parameter.required) {
        issues.push({
          parameter: parameter.name,
          code: 'missing',
          detail: `required parameter ${parameter.name} is missing`,
        });
      }
      continue;
    }
    if (!matchesType(parameter.type, value)) {
      issues.push({
        parameter: parameter.name,
        code: 'type',
        detail: `parameter ${parameter.name} must be ${parameter.type}, received ${describe(value)}`,
      });
      continue;
    }
    if (parameter.values !== undefined && !parameter.values.some((one) => one === value)) {
      issues.push({
        parameter: parameter.name,
        code: 'enum',
        detail: `parameter ${parameter.name} must be one of ${parameter.values.join(', ')}`,
      });
    }
  }

  for (const key of Object.keys(record)) {
    if (tool.parameters.some((parameter) => parameter.name === key)) continue;
    issues.push({
      parameter: key,
      code: 'unknown',
      detail: `${tool.name} has no parameter named ${key}`,
    });
  }

  return issues;
}

function matchesType(type: ToolDefinition['parameters'][number]['type'], value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
