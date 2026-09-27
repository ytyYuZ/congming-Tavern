/**
 * The degradation ladder and the "AI may request, the runtime writes" boundary
 * (`docs/02` §5.3, HANDOFF §4.1 invariant 3).
 */

import type { ToolName } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { mockTool } from './mock/mock-tools';
import {
  isBuiltInToolChannel,
  needsApproval,
  planToolChannels,
  requiredParameters,
  TOOL_CHANNEL_ORDER,
  type ToolChannel,
  toolChannelRank,
} from './tools';

describe('degradation ladder (docs/02 §5.3)', () => {
  it('orders the three levels native → structured output → text protocol', () => {
    expect(TOOL_CHANNEL_ORDER).toEqual(['native', 'json', 'text-protocol']);
    // Reused from `Message.toolCalls[].source`, not re-declared: same three
    // spellings, in ladder order.
    expect<readonly ToolChannel[]>(TOOL_CHANNEL_ORDER).toEqual(['native', 'json', 'text-protocol']);
  });

  it('ranks a channel by how precisely it carries a call', () => {
    expect(toolChannelRank('native')).toBe(0);
    expect(toolChannelRank('json')).toBe(1);
    expect(toolChannelRank('text-protocol')).toBe(2);
    expect(isBuiltInToolChannel('native')).toBe(true);
    expect(isBuiltInToolChannel('text-protocol')).toBe(true);
  });

  it('does not rank a plugin channel, but still accepts it', () => {
    const plugin: ToolChannel = 'x-mythos.function-call';
    expect(toolChannelRank(plugin)).toBe(-1);
    expect(isBuiltInToolChannel(plugin)).toBe(false);
  });

  it('plans down to the text protocol for a plain-text model', () => {
    const plan = planToolChannels({
      nativeFunctionCalling: false,
      structuredOutput: false,
      textProtocol: true,
    });
    expect(plan).toEqual({
      order: ['text-protocol'],
      primary: 'text-protocol',
      allowRetry: true,
      // §5.3 forbids silent failure: the plan has to name what happens at the end.
      giveUp: 'report-to-user',
    });
  });

  it('prefers native function calling when the model offers it', () => {
    const plan = planToolChannels({
      nativeFunctionCalling: true,
      structuredOutput: true,
      textProtocol: true,
    });
    expect(plan?.primary).toBe('native');
    expect(plan?.order).toEqual(['native', 'json', 'text-protocol']);
  });

  it('falls back to structured output when native calling is missing', () => {
    const plan = planToolChannels({
      nativeFunctionCalling: false,
      structuredOutput: true,
      textProtocol: true,
    });
    expect(plan?.primary).toBe('json');
    expect(plan?.order).toEqual(['json', 'text-protocol']);
  });
});

describe('tool declaration helpers', () => {
  it('reports the required parameters in declaration order', () => {
    const tool = mockTool();
    expect(requiredParameters(tool).map((parameter) => parameter.name)).toEqual(['expr', 'target']);
  });

  it('treats a mutating tool as needing approval even without the flag', () => {
    expect(needsApproval(mockTool({ mutatesState: true, requiresApproval: false }))).toBe(true);
    expect(needsApproval(mockTool({ mutatesState: false, requiresApproval: true }))).toBe(true);
    expect(needsApproval(mockTool({ mutatesState: false, requiresApproval: false }))).toBe(false);
  });

  it("uses the schema's tool-name vocabulary rather than a parallel one", () => {
    const name: ToolName = 'x-mythos/roll_sanity';
    expect(mockTool({ name }).name).toBe(name);
  });
});
