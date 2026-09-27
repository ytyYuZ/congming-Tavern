/**
 * `chat/message-tree.ts` — the pure questions the M1-S2 view asks about the message tree.
 *
 * WHY THESE ARE ASSERTED AS TABLE ROWS
 * Every case here is "given this run of siblings (or this chain) and this position, what
 * does the switcher say" — the same decision over a different shape of data. A table makes
 * the boundaries (first sibling, last sibling, a run of one, the chain's own head) readable
 * side by side, and each expectation is literal so a reader can hand-check it against the
 * fixture rather than against the implementation.
 *
 * WHAT IS **NOT** HERE
 * The rules that need a database — that a regenerate really writes a SIBLING, that a delete
 * of a node with replies is refused — are pinned where they can be observed end to end:
 * `app/routes/routes.test.tsx` (through the real controls) and `db/repository.test.ts` (the
 * row-level consequences). This file is only the arithmetic.
 */
import type { Message } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { promptMessageFor, siblingViewOf } from './message-tree';

/** One node, with only the fields these functions read. */
function node(
  id: string,
  parentId: string | null,
  role: Message['role'] = 'assistant',
  content = id,
): Message {
  return {
    id,
    sessionId: 's1',
    parentId,
    role,
    kind: 'dialogue',
    content,
    meta: {},
    createdAt: 0,
  };
}

describe('siblingViewOf', () => {
  /** `root` -> two answers, the second of which the head points at. */
  const root = node('root', null, 'user', '问题');
  const first = node('first', 'root', 'assistant', '第一个答案');
  const second = node('second', 'root', 'assistant', '第二个答案');
  const run = [first, second];

  it('reports the position and which sibling the chain runs through', () => {
    // Three rows of the same decision over one fixture: first, second, and "no choice".
    // The run under test is a COLUMN of the table (not a conditional in the loop body), so
    // "a run of one" is the same assertion as the other rows rather than a second path.
    const cases: readonly {
      readonly name: string;
      readonly run: readonly Message[];
      readonly messageId: string;
      readonly head: string | null;
      readonly expected: { index: number; active: string } | undefined;
    }[] = [
      {
        name: 'the first of two: the head is on the second',
        run,
        messageId: 'first',
        head: 'second',
        expected: { index: 0, active: 'second' },
      },
      {
        name: 'the second of two: the head is on the first',
        run,
        messageId: 'second',
        head: 'first',
        expected: { index: 1, active: 'first' },
      },
      {
        name: 'a run of one offers nothing to switch to',
        run: [first],
        messageId: 'first',
        head: 'first',
        expected: undefined,
      },
      {
        name: 'a message that is not in the run is not rendered as one of them',
        run,
        messageId: 'elsewhere',
        head: 'first',
        expected: undefined,
      },
    ];

    for (const testCase of cases) {
      const view = siblingViewOf(testCase.run, testCase.messageId, testCase.head);
      if (testCase.expected === undefined) {
        expect(view, testCase.name).toBeUndefined();
        continue;
      }
      expect(view?.index, testCase.name).toBe(testCase.expected.index);
      // The ACTIVE flag is what the view uses to say "you are here", so the whole list is
      // asserted: the marked member is exactly the sibling the head points at, and the head
      // is the active member's id in every row above.
      expect(
        view?.choices.map((choice) => `${choice.id}${choice.active ? '*' : ''}`),
        testCase.name,
      ).toEqual(testCase.run.map((s) => `${s.id}${s.id === testCase.head ? '*' : ''}`));
    }
  });

  it('marks a sibling active only when the head IS that sibling', () => {
    // `headMessageId` is the tip of the ACTIVE CHAIN (docs/02 §7), and a branch is chosen by
    // pointing it at one member of a run — so a head deeper in the tree marks NO sibling of
    // this run as active, which is what "the chain does not pass through here" means.
    const deep = siblingViewOf([root, first, second], 'first', 'some-later-descendant');
    expect(deep?.choices.every((choice) => !choice.active)).toBe(true);
    // ...while a null head (an empty transcript) is not the same as "unknown": nothing is
    // active either, and the view must not claim the first sibling is.
    const empty = siblingViewOf(run, 'first', null);
    expect(empty?.choices.map((choice) => choice.active)).toEqual([false, false]);
  });
});

describe('promptMessageFor', () => {
  const user = node('u1', null, 'user', '第一问');
  const answer = node('a1', 'u1', 'assistant', '第一答');
  const user2 = node('u2', 'a1', 'user', '第二问');
  const answer2 = node('a2', 'u2', 'assistant', '第二答');
  const chain = [user, answer, user2, answer2];

  it('finds the nearest earlier user turn, whatever sits between', () => {
    const cases: readonly { readonly messageId: string; readonly expected: string | undefined }[] =
      [
        { messageId: 'a2', expected: 'u2' },
        // An intermediate node of any role does not change the answer: "the question this
        // answer answers" is the nearest earlier turn the USER authored.
        { messageId: 'a1', expected: 'u1' },
        // A user message regenerated on its own has no earlier user turn to re-ask.
        { messageId: 'u1', expected: undefined },
        { messageId: 'missing', expected: undefined },
      ];
    for (const testCase of cases) {
      expect(promptMessageFor(chain, testCase.messageId)?.id, testCase.messageId).toBe(
        testCase.expected,
      );
    }
  });

  it('skips a later sibling that is not on this chain', () => {
    // The chain is ONE path, so the run's other answer is absent from it and cannot be
    // mistaken for the prompt: walking the chain (not the table) is what makes that true.
    const withSibling = [user, answer, node('a1-other', 'u1', 'assistant', '另一个答案')];
    expect(promptMessageFor(withSibling, 'a1-other')?.id).toBe('u1');
  });
});
