/**
 * Budget & trimming (M1-G4; docs/02-技术架构.md §5.1「按块优先级从低到高裁剪
 * (optional → normal → high；required 永不裁剪，超限则明确报错并给出建议)」; the
 * acceptance is 「快照测试覆盖…超预算裁剪」).
 *
 * WHY THE COUNTER IS INJECTED HERE, and what it buys: `flatCounter` charges a flat
 * 10 tokens per message, so "this preset is 40 tokens and the limit is 20" is
 * arithmetic a reviewer can do in their head and every expectation below is a
 * literal. The approximation path has its own file and is asserted here only as a
 * reported `measuredBy`.
 *
 * Each row of the trim table states the SURVIVORS and the DROPPED set in the order
 * trimming removed them — the order is part of the contract, because it is the
 * priority rule made visible.
 */

import type { PromptBlock } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { applyBudget } from './budget';
import { compose } from './compose';
import {
  block,
  context,
  expectFailure,
  expectOk,
  flatCounter,
  lines,
  preset,
  turns,
} from './test-kit';

/**
 * One block per priority, declared in the REVERSE of the trim order so a test
 * cannot pass by accident of declaration order. All four land in `pre_history`
 * with ascending `order`, so the assembly is `R H N O` = 4 messages = 40 tokens.
 */
const oneOfEach = preset([
  block({ id: 'required', content: 'R', order: 0, budget: { priority: 'required' } }),
  block({ id: 'high', content: 'H', order: 10, budget: { priority: 'high' } }),
  block({ id: 'normal', content: 'N', order: 20, budget: { priority: 'normal' } }),
  block({ id: 'optional', content: 'O', order: 30, budget: { priority: 'optional' } }),
]);

/** One fixture block by id, so no test has to index the array unchecked. */
function blockById(id: string): PromptBlock {
  const found = oneOfEach.blocks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no fixture block named ${id}`);
  return found;
}

/** No history and no input, so the only tokens are the blocks under test. */
const bare = context({ history: [], input: { role: 'user', content: '' }, turnNumber: 1 });

const composed = (contextWindow: number, reservedOutput: number) =>
  expectOk(compose(oneOfEach, bare, { contextWindow, reservedOutput, counter: flatCounter }));

describe('compose — over-budget trimming', () => {
  const table = [
    {
      name: 'fits every block',
      contextWindow: 100,
      reservedOutput: 20,
      limit: 80,
      survivors: 'R,H,N,O',
      dropped: '',
    },
    // 40 tokens against 30: the optional block goes and 30 fits exactly.
    {
      name: 'drops optional first',
      contextWindow: 35,
      reservedOutput: 5,
      limit: 30,
      survivors: 'R,H,N',
      dropped: 'optional',
    },
    // Still 30 against 20: normal goes next, and 20 fits exactly.
    {
      name: 'drops normal next',
      contextWindow: 25,
      reservedOutput: 5,
      limit: 20,
      survivors: 'R,H',
      dropped: 'optional,normal',
    },
    // 20 against 10: high goes too, leaving only the required block.
    {
      name: 'never drops required',
      contextWindow: 15,
      reservedOutput: 5,
      limit: 10,
      survivors: 'R',
      dropped: 'optional,normal,high',
    },
  ];

  it.each(table)(
    '$name (limit $limit of 40 tokens)',
    ({ contextWindow, reservedOutput, limit, survivors, dropped }) => {
      const result = composed(contextWindow, reservedOutput);
      expect(lines(result).join('|')).toBe(
        survivors
          .split(',')
          .map((content) => `system:${content}`)
          .join('|'),
      );
      // `DroppedBlock.name` is the block NAME, which the fixture kit defaults to
      // the id: the trim journal is about blocks, not about their text.
      expect(result.dropped.map((entry) => entry.name).join(',')).toBe(dropped);
      expect(result.budget.limit).toBe(limit);
      expect(result.budget.used).toBe(survivors.split(',').length * 10);
      expect(result.budget.freed).toBe(dropped === '' ? 0 : dropped.split(',').length * 10);
      expect(result.budget.measuredBy).toBe('injected');
      // `required` is never in the dropped set, whatever the budget says.
      expect(result.dropped.some((entry) => entry.priority === 'required')).toBe(false);
    },
  );

  it('matches the snapshot of the trim journal, priority included', () => {
    expect(composed(25, 5).dropped).toMatchInlineSnapshot(`
      [
        {
          "id": "optional",
          "name": "optional",
          "order": 30,
          "priority": "optional",
          "reason": "over-budget",
          "tokens": 10,
        },
        {
          "id": "normal",
          "name": "normal",
          "order": 20,
          "priority": "normal",
          "reason": "over-budget",
          "tokens": 10,
        },
      ]
    `);
  });

  it('matches the snapshot of the surviving assembly', () => {
    expect(composed(25, 5).messages).toMatchInlineSnapshot(`
      [
        {
          "content": "R",
          "role": "system",
        },
        {
          "content": "H",
          "role": "system",
        },
      ]
    `);
  });
});

describe('compose — the explicit failure §5.1 asks for', () => {
  const result = expectFailure(
    compose(oneOfEach, bare, { contextWindow: 15, reservedOutput: 10, counter: flatCounter }),
  );

  it('keeps the required block and reports the shortfall by name', () => {
    expect(lines(result)).toEqual(['system:R']);
    expect(result.dropped.map((entry) => entry.name)).toEqual(['optional', 'normal', 'high']);
    expect(result.error.code).toBe('budget-exceeded');
    expect(result.error.limit).toBe(5);
    expect(result.error.undroppableTokens).toBe(10);
    expect(result.error.shortfall).toBe(5);
    expect(result.error.message).toContain('short by 5');
    expect(result.error.suggestion).toContain('shorten the conversation history');
  });

  it('distinguishes an unusable budget from a merely over-long prompt', () => {
    const empty = expectFailure(
      compose(oneOfEach, bare, { contextWindow: 10, reservedOutput: 10, counter: flatCounter }),
    );
    expect(empty.error.code).toBe('empty-budget');
    expect(empty.error.limit).toBe(0);
    expect(empty.error.message).toContain('no room');
    expect(empty.error.suggestion).toContain('reservedOutput');
  });

  it('cannot trim the history, and says so in the suggestion', () => {
    const long = context({
      history: turns('x'.repeat(200)),
      input: { role: 'user', content: '' },
    });
    const failed = expectFailure(
      compose(
        preset([block({ id: 'r', content: 'R', order: 0, budget: { priority: 'required' } })]),
        long,
        { contextWindow: 30, reservedOutput: 0 },
      ),
    );
    // 200 ASCII characters is ceil(200 / 4) + 4 = 54 tokens, plus 5 for the
    // block and 3 of request framing: 62 against a limit of 30.
    expect(failed.error.undroppableTokens).toBe(62);
    expect(failed.error.shortfall).toBe(32);
    expect(failed.error.message).toContain('short by 32');
    expect(failed.error.suggestion).toContain('shorten the conversation history by 32 tokens');
  });
});

describe('compose — the trim tie-break', () => {
  it('drops the highest `order` first inside one priority class', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'required', content: 'R', order: 0, budget: { priority: 'required' } }),
          block({ id: 'early', content: 'E', order: 10 }),
          block({ id: 'late', content: 'L', order: 20 }),
        ]),
        bare,
        { contextWindow: 20, reservedOutput: 0, counter: flatCounter },
      ),
    );
    // 30 tokens against 20: exactly one of the two `normal` blocks must go, and
    // the one the preset ranks LATER (order 20) is the less important one.
    expect(result.dropped.map((entry) => [entry.name, entry.order, entry.reason])).toEqual([
      ['late', 20, 'over-budget'],
    ]);
    expect(lines(result)).toEqual(['system:R', 'system:E']);
  });

  it('falls back to declaration order when two blocks share an `order`', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'first', content: 'F', order: 10 }),
          block({ id: 'second', content: 'S', order: 10 }),
        ]),
        bare,
        { contextWindow: 10, reservedOutput: 0, counter: flatCounter },
      ),
    );
    // Same priority, same order: the preset states no ranking, so the later
    // declaration is the one that goes. Deterministic, not meaningful.
    expect(result.dropped.map((entry) => entry.name)).toEqual(['second']);
  });

  it('puts priority above position: an optional block leaves before a high one', () => {
    const result = expectOk(
      compose(
        preset([
          block({
            id: 'optional-pre',
            content: 'OP',
            order: 0,
            position: 'pre_history',
            budget: { priority: 'optional' },
          }),
          block({
            id: 'high-post',
            content: 'HP',
            order: 99,
            position: 'post_history',
            budget: { priority: 'high' },
          }),
        ]),
        bare,
        { contextWindow: 10, reservedOutput: 0, counter: flatCounter },
      ),
    );
    // `optional-pre` has the LOWEST order of the two, so an order-only rule would
    // have kept it; priority decides, and it goes first.
    expect(result.dropped.map((entry) => entry.name)).toEqual(['optional-pre']);
    expect(lines(result)).toEqual(['system:HP']);
  });

  it('treats a block with no `budget` as trimmable `normal`', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'required', content: 'R', order: 0, budget: { priority: 'required' } }),
          block({ id: 'unstated', content: 'U', order: 1 }),
        ]),
        bare,
        { contextWindow: 10, reservedOutput: 0, counter: flatCounter },
      ),
    );
    expect(result.dropped.map((entry) => [entry.name, entry.priority])).toEqual([
      ['unstated', 'normal'],
    ]);
  });
});

describe('compose — `budget.share` ceilings', () => {
  it('drops a droppable block over its ceiling, with `over-share` as the reason', () => {
    const result = expectOk(
      compose(
        preset([
          block({
            id: 'huge',
            content: 'H',
            order: 0,
            budget: { priority: 'normal', share: 0.05 },
          }),
          block({ id: 'small', content: 'S', order: 1 }),
        ]),
        bare,
        { contextWindow: 100, reservedOutput: 0, counter: flatCounter },
      ),
    );
    // The ceiling is floor(0.05 * 100) = 5 tokens and the block costs 10, so it
    // goes even though the assembly as a whole (20 of 100) fits comfortably.
    expect(result.dropped.map((entry) => [entry.name, entry.reason, entry.tokens])).toEqual([
      ['huge', 'over-share', 10],
    ]);
    expect(lines(result)).toEqual(['system:S']);
  });

  it('keeps a `required` block over its ceiling and warns, because priority wins', () => {
    const result = expectOk(
      compose(
        preset([
          block({
            id: 'req',
            content: 'R',
            order: 0,
            budget: { priority: 'required', share: 0.05 },
          }),
        ]),
        bare,
        { contextWindow: 100, reservedOutput: 0, counter: flatCounter },
      ),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('required block "req"');
    expect(result.warnings[0]).toContain('never trimmed');
    expect(lines(result)).toEqual(['system:R']);
    expect(result.dropped).toEqual([]);
  });

  it('leaves a block that fits its ceiling alone', () => {
    const result = expectOk(
      compose(
        preset([
          block({ id: 'half', content: 'H', order: 0, budget: { priority: 'normal', share: 0.5 } }),
        ]),
        bare,
        { contextWindow: 20, reservedOutput: 0, counter: flatCounter },
      ),
    );
    // ceiling = floor(0.5 * 20) = 10, cost = 10: at the ceiling is not over it.
    expect(result.dropped).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('applyBudget — the raw step', () => {
  it('reports the survival set AND the error, so a debug panel can render it', () => {
    const outcome = applyBudget(
      [
        { message: { role: 'user', content: 'R' }, block: blockById('required'), blockIndex: 0 },
        { message: { role: 'user', content: 'O' }, block: blockById('optional'), blockIndex: 3 },
      ],
      { contextWindow: 5, reservedOutput: 0, counter: flatCounter },
    );
    // 20 tokens against 5: the optional block is dropped and it STILL does not
    // fit, which is the one case the raw step answers with both halves.
    expect(outcome.kept.map((item) => item.message.content)).toEqual(['R']);
    expect(outcome.dropped.map((entry) => entry.reason)).toEqual(['over-budget']);
    expect(outcome.report.used).toBe(10);
    expect(outcome.error?.code).toBe('budget-exceeded');
    expect(outcome.error?.shortfall).toBe(5);
  });

  it('leaves an item with no block alone: history is not a trim candidate', () => {
    const outcome = applyBudget([{ message: { role: 'user', content: 'history turn' } }], {
      contextWindow: 1,
      reservedOutput: 0,
      counter: flatCounter,
    });
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.report.used).toBe(10);
    expect(outcome.error?.undroppableTokens).toBe(10);
  });
});
