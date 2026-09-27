/**
 * Assembly order and conditions (M1-G4; docs/02-技术架构.md §5.1 装配顺序; the
 * acceptance is 「快照测试覆盖装配顺序」).
 *
 * HOW THE ORDER IS ASSERTED, twice on purpose: an inline snapshot (so a
 * reordering is a visible diff that no reviewer can miss) AND a literal
 * `role:content` string laid out in §5.1's sequence (so the test says WHAT the
 * order is, not merely that it changed). A snapshot alone would let a wrong order
 * be "correct" the moment somebody accepts the update.
 *
 * The fixture preset declares its blocks in an order that is deliberately NOT
 * the assembly order, including three positions, two `in_history` depths, one
 * disabled block and one conditional block that applies and one that does not.
 */

import type { PromptBlock, ToolDefinition } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../ports/llm';
import { compose } from './compose';
import {
  block,
  context,
  deepFreeze,
  expectFailure,
  expectOk,
  lines,
  preset,
  turns,
} from './test-kit';
import type { PromptContext } from './types';

/** Generous, so assembly order is never entangled with trimming here. */
const ROOMY = { contextWindow: 1000, reservedOutput: 0 } as const;

/** The condition half of a block spec, so the tests below stay short. */
type Conditions = PromptBlock['conditions'];

/** `role:content` lines for an already-narrowed message list. */
const text = (messages: readonly ChatMessage[]): string[] =>
  messages.map((message) => `${message.role}:${message.content}`);

const orderedPreset = preset([
  block({ id: 'post-late', content: 'POST-LATE', order: 30, position: 'post_history' }),
  block({ id: 'pre-b', content: 'PRE-B', order: 10 }),
  block({ id: 'in-d1', content: 'IN-D1', order: 5, position: 'in_history', depth: 1 }),
  block({ id: 'pre-a', content: 'PRE-A', order: 5 }),
  block({ id: 'off', content: 'DISABLED', order: 0, enabled: false }),
  block({ id: 'in-d0', content: 'IN-D0', order: 9, position: 'in_history', depth: 0 }),
  block({
    id: 'cond-on',
    content: 'COND-ON',
    order: 20,
    position: 'post_history',
    conditions: { keywords: ['MOON'] },
  }),
  block({ id: 'post-early', content: 'POST-EARLY', order: 10, position: 'post_history' }),
  block({ id: 'in-d0-b', content: 'IN-D0-B', order: 3, position: 'in_history', depth: 0 }),
  block({
    id: 'cond-off',
    content: 'COND-OFF',
    order: 21,
    position: 'post_history',
    conditions: { keywords: ['sun'] },
  }),
]);

const orderedContext: PromptContext = context({
  history: turns('h1', 'the moon rises', 'h3'),
  input: { role: 'user', content: 'USER-INPUT' },
  turnNumber: 3,
});

/** §5.1's sequence, spelled out: pre -> history with in_history -> post -> input. */
const EXPECTED_ORDER = [
  'system:PRE-A',
  'system:PRE-B',
  'user:h1',
  // `in-d1` has depth 1, i.e. one message back from the end: before `h3`.
  'assistant:the moon rises',
  'system:IN-D1',
  'user:h3',
  // depth 0 is immediately before the current user input; same depth, so `order`
  // decides: in-d0-b (3) before in-d0 (9).
  'system:IN-D0-B',
  'system:IN-D0',
  'system:POST-EARLY',
  // The keyword condition matched (`MOON` against `the moon rises`, case-insensitive).
  'system:COND-ON',
  // post_history is ordered by `order`: 10, 20, then 30.
  'system:POST-LATE',
  'user:USER-INPUT',
].join('|');

describe('compose — assembly order', () => {
  const result = expectOk(compose(orderedPreset, orderedContext, ROOMY));

  it("produces §5.1's order: pre_history, history, in_history, post_history, input", () => {
    expect(lines(result).join('|')).toBe(EXPECTED_ORDER);
  });

  it('matches the snapshot of the whole assembly', () => {
    expect(result.messages).toMatchInlineSnapshot(`
      [
        {
          "content": "PRE-A",
          "role": "system",
        },
        {
          "content": "PRE-B",
          "role": "system",
        },
        {
          "content": "h1",
          "role": "user",
        },
        {
          "content": "the moon rises",
          "role": "assistant",
        },
        {
          "content": "IN-D1",
          "role": "system",
        },
        {
          "content": "h3",
          "role": "user",
        },
        {
          "content": "IN-D0-B",
          "role": "system",
        },
        {
          "content": "IN-D0",
          "role": "system",
        },
        {
          "content": "POST-EARLY",
          "role": "system",
        },
        {
          "content": "COND-ON",
          "role": "system",
        },
        {
          "content": "POST-LATE",
          "role": "system",
        },
        {
          "content": "USER-INPUT",
          "role": "user",
        },
      ]
    `);
  });

  it('skips a disabled block rather than emitting it empty', () => {
    expect(lines(result).some((line) => line.includes('DISABLED'))).toBe(false);
    expect(result.messages.every((message) => message.content.length > 0)).toBe(true);
  });

  it('includes a conditional block only when its condition holds', () => {
    expect(lines(result).some((line) => line.includes('COND-ON'))).toBe(true);
    expect(lines(result).some((line) => line.includes('COND-OFF'))).toBe(false);
  });

  it('invents nothing: no unresolved macro in a plain preset', () => {
    expect(result.unresolvedMacros).toEqual([]);
    expect(result.variableChanges).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe('compose — `in_history` depth', () => {
  it('counts back from the end, clamps a deep block to the start, and keeps depths stable', () => {
    const deep = preset([
      block({ id: 'd9', content: 'D9', order: 0, position: 'in_history', depth: 9 }),
      block({ id: 'd2', content: 'D2', order: 0, position: 'in_history', depth: 2 }),
      block({ id: 'd1', content: 'D1', order: 0, position: 'in_history', depth: 1 }),
      block({ id: 'd0', content: 'D0', order: 0, position: 'in_history', depth: 0 }),
    ]);
    const result = expectOk(
      compose(
        deep,
        context({ history: turns('a', 'b', 'c', 'd'), input: { role: 'user', content: 'U' } }),
        ROOMY,
      ),
    );
    expect(lines(result)).toEqual([
      'system:D9',
      'user:a',
      'assistant:b',
      'system:D2',
      'user:c',
      'system:D1',
      'assistant:d',
      'system:D0',
      'user:U',
    ]);
  });

  it('treats a missing depth as 0, immediately before the user input', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'nodepth', content: 'NODEPTH', order: 0, position: 'in_history' }),
          block({ id: 'post', content: 'POST', order: 1, position: 'post_history' }),
        ]),
        context({ history: turns('a'), input: { role: 'user', content: 'U' } }),
        ROOMY,
      ),
    );
    expect(lines(result)).toEqual(['user:a', 'system:NODEPTH', 'system:POST', 'user:U']);
  });
});

describe('compose — conditions', () => {
  /**
   * The `role:content` lines a one-block preset produces with these conditions.
   * Every case below goes through the same path, so a `run` that forgot to pass
   * the conditions would be visible in the shape of the expectation.
   */
  const run = (conditions: Conditions, ctx: PromptContext): string[] =>
    text(
      expectOk(
        compose(preset([block({ id: 'c', content: 'C', order: 0, conditions })]), ctx, ROOMY),
      ).messages,
    );

  it('honours minTurns from below and above', () => {
    expect(run({ minTurns: 3 }, context({ turnNumber: 2 }))).toEqual(['user:go']);
    expect(run({ minTurns: 3 }, context({ turnNumber: 3 }))).toEqual(['system:C', 'user:go']);
  });

  it('honours timeOfDay against the clock segments, matching ids exactly', () => {
    // The fixture clock is inside the `dawn` segment.
    expect(run({ timeOfDay: ['dawn'] }, context())).toEqual(['system:C', 'user:go']);
    // Segment ids are ids from the world's calendar, not prose: no case folding.
    expect(run({ timeOfDay: ['Dawn'] }, context())).toEqual(['user:go']);
    expect(run({ timeOfDay: ['dusk'] }, context())).toEqual(['user:go']);
  });

  it('treats an ABSENT time input as UNMET, so no world content is invented', () => {
    // No clock and no stated ids: the context cannot say what time it is, and
    // guessing "met" would inject a dawn-only block at an unknown hour.
    const bare = context({ clock: undefined, segmentIds: undefined });
    expect(run({ timeOfDay: ['dawn'] }, bare)).toEqual(['user:go']);
    // Stated ids are enough on their own.
    expect(
      run({ timeOfDay: ['dusk'] }, context({ clock: undefined, segmentIds: ['dusk'] })),
    ).toEqual(['system:C', 'user:go']);
  });

  it('matches keywords case-insensitively over the conversation, not over other blocks', () => {
    const history = turns('the Dragon sleeps', 'quiet');
    expect(run({ keywords: ['dragon'] }, context({ history }))).toEqual([
      'system:C',
      'user:the Dragon sleeps',
      'assistant:quiet',
      'user:go',
    ]);
    expect(run({ keywords: ['wyrm'] }, context({ history }))).toEqual([
      'user:the Dragon sleeps',
      'assistant:quiet',
      'user:go',
    ]);
    // A block's own content is not part of the conversation: it cannot trigger itself.
    expect(run({ keywords: ['C'] }, context({ history: [] }))).toEqual(['user:go']);
  });

  it('reads an empty condition list as "no condition"', () => {
    expect(run({ keywords: [], timeOfDay: [] }, context())).toEqual(['system:C', 'user:go']);
  });

  it('ands every condition it is given', () => {
    const conditions = { minTurns: 5, keywords: ['go'] };
    expect(run(conditions, context({ turnNumber: 4 }))).toEqual(['user:go']);
    expect(run(conditions, context({ turnNumber: 5 }))).toEqual(['system:C', 'user:go']);
  });
});

describe('compose — macros', () => {
  it('expands block content and the user input from the same context', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'a', content: '{{char}} greets {{user}} in {{scene.location}}', order: 0 }),
        ]),
        context({ input: { role: 'user', content: 'and {{char}} answers' } }),
        ROOMY,
      ),
    );
    expect(lines(result)).toEqual([
      'system:Aria greets Yuki in The tavern',
      'user:and Aria answers',
    ]);
  });

  it('reports each unresolved macro once, wherever it appeared', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'a', content: '{{roll::2d6}}', order: 0 }),
          block({ id: 'b', content: '{{roll::2d6}} {{frobnicate}}', order: 1 }),
        ]),
        context({ input: { role: 'user', content: '{{frobnicate}}' } }),
        ROOMY,
      ),
    );
    expect(result.unresolvedMacros).toEqual(['{{roll::2d6}}', '{{frobnicate}}']);
  });

  it('never expands macros inside the stored history', () => {
    const result = expectOk(
      compose(
        preset([block({ id: 'a', content: 'A', order: 0 })]),
        context({ history: turns('{{char}} spoke here'), input: { role: 'user', content: '' } }),
        ROOMY,
      ),
    );
    expect(lines(result)).toEqual(['system:A', 'user:{{char}} spoke here']);
    expect(result.unresolvedMacros).toEqual([]);
  });

  it('returns setvar as a change while leaving the context untouched', () => {
    const frozen = deepFreeze(context({ variables: { hp: 10 } }));
    const result = expectOk(
      compose(
        preset([block({ id: 'a', content: '{{setvar::hp::7}}hp is {{getvar::hp}}', order: 0 })]),
        frozen,
        ROOMY,
      ),
    );
    expect(lines(result)).toEqual(['system:hp is 10', 'user:go']);
    expect(result.variableChanges).toEqual([{ name: 'hp', value: '7' }]);
    expect(frozen.variables).toEqual({ hp: 10 });
  });

  it('omits an enabled block and an input whose content expands to nothing', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'empty', content: '', order: 0 }),
          block({ id: 'directive', content: '{{setvar::k::v}}', order: 1 }),
        ]),
        context({ input: { role: 'user', content: '' } }),
        ROOMY,
      ),
    );
    expect(result.messages).toEqual([]);
    expect(result.variableChanges).toEqual([{ name: 'k', value: 'v' }]);
  });
});

describe('compose — result plumbing', () => {
  it('echoes the tool signatures without serialising them into a message', () => {
    const tools: readonly ToolDefinition[] = [
      {
        name: 'roll_dice',
        summary: 'Roll dice',
        parameters: [],
        owner: 'core',
        mutatesState: false,
        requiresApproval: false,
      },
    ];
    const result = expectOk(
      compose(
        preset([block({ id: 'a', content: 'A', order: 0 })]),
        context({ tools, input: { role: 'user', content: '' } }),
        ROOMY,
      ),
    );
    expect(result.tools).toBe(tools);
    expect(lines(result)).toEqual(['system:A']);
  });

  it('reports per-block usage for the debug panel, kept and dropped alike', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'keep', content: 'K', order: 0, budget: { priority: 'required' } }),
          block({ id: 'drop', content: 'D', order: 1, budget: { priority: 'optional' } }),
        ]),
        context({ input: { role: 'user', content: '' } }),
        // Two one-character blocks: 5 + 5 messages plus 3 tokens of request
        // framing is 13, so a limit of 10 must drop the optional one and keep the
        // required one even though 5 + 3 = 8 is what survives.
        { contextWindow: 10, reservedOutput: 0 },
      ),
    );
    expect(result.blocks.map((entry) => [entry.name, entry.priority, entry.kept])).toEqual([
      ['keep', 'required', true],
      ['drop', 'optional', false],
    ]);
    expect(result.budget.measuredBy).toBe('approximation');
  });

  it('has no `messages` field on failure, so an over-budget prompt cannot be sent', () => {
    const result = expectFailure(
      compose(
        preset([block({ id: 'a', content: 'A', order: 0, budget: { priority: 'required' } })]),
        context({ input: { role: 'user', content: '' } }),
        { contextWindow: 4, reservedOutput: 0 },
      ),
    );
    expect(Object.hasOwn(result, 'messages')).toBe(false);
    expect(lines(result)).toEqual(['system:A']);
    expect(result.error.code).toBe('budget-exceeded');
    expect(result.error.shortfall).toBeGreaterThan(0);
  });
});
