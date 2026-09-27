/**
 * The pure half of the message TREE (M1-S2): which siblings exist, which one the active
 * chain runs through, and the draft an edit starts from.
 *
 * WHY THIS IS A MODULE OF ITS OWN AND NOT CODE INSIDE THE VIEW
 * docs/02 §7 defines the tree and the acceptance for M1-S2 is about it ("消息树（parentId）
 * 正确；切换分支内容正确"), so the questions the view asks — "is there more than one answer
 * to this prompt", "which one am I on", "what text does the editor start with" — are
 * questions about the DATA, not about markup. Keeping them here makes them testable
 * without a DOM (see `message-tree.test.ts`) and makes the view a function of the answers,
 * which is the same split `chat/clock.ts` and `chat/vars.ts` follow.
 *
 * WHY A BRANCH SWITCH IS ONLY A POINTER MOVE
 * A branch IS a child of a node other than the one the chain currently runs through. The
 * chain is built by walking `parentId` up from `Session.headMessageId` (`db/repository.ts`'s
 * `getChain`), so choosing a different sibling needs no copy, no re-parenting and no write
 * to any message: the head moves to the sibling and the whole walk yields the other path.
 * That is what docs/02 §7 means by 回溯（移动 `headMessageId`）, and it is why nothing here
 * mutates a `Message`.
 *
 * WHY THE SIBLING LIST IS ACCEPTED AS DATA
 * The siblings of a message are the rows whose `parentId` equals its own — including one
 * that is not on the active chain, which is exactly the branch the user wants to reach and
 * which the chain therefore cannot show. The CALLER reads them (`state/chat-store.ts` owns
 * every database read); this module only decides what they mean, so it stays free of the
 * storage layer (ADR-017).
 */
import type { Id, Message } from '@smarttavern/schema';

/** One position in a run of siblings: its id, and whether the active chain runs through it. */
export interface SiblingChoice {
  readonly id: Id;
  readonly active: boolean;
}

/**
 * What the switcher needs about one message and the run of siblings it belongs to.
 *
 * `choices` is ONE ENTRY PER SIBLING (the node itself included) and `index` is the position
 * of `messageId` inside it. The neighbour to move to is deliberately NOT stored here: it is
 * `choices[index ± 1]` at the moment of the click (`app/routes/play.tsx`'s `SiblingSwitcher`),
 * because a stored id can outlive the head move that made it point at the wrong answer.
 */
export interface SiblingView {
  /** Every sibling, in the order the caller supplied them. */
  readonly choices: readonly SiblingChoice[];
  /** The position of the message being rendered inside `choices`. */
  readonly index: number;
}

/**
 * The switcher's view of `messageId` among `siblings`, or `undefined` when there is no
 * choice to make.
 *
 * WHAT `undefined` MEANS: the run has one member (or none, which is a caller bug — the
 * message being rendered is in its own run), so there is nothing to switch to and no count
 * worth printing. A view that rendered "1 / 1" and two dead arrows would be reporting a
 * branch that does not exist.
 *
 * `headMessageId` (and not the whole `Session`) is what decides the active member: the
 * chain is the walk from the head, so a sibling is active exactly when it IS the head or an
 * ancestor of it — and within ONE run of siblings at most one of them can be the one the
 * chain passes through. Comparing ids is therefore the whole test, with no second read.
 */
export function siblingViewOf(
  siblings: readonly Message[],
  messageId: Id,
  headMessageId: Id | null,
): SiblingView | undefined {
  if (siblings.length < 2) return undefined;
  const index = siblings.findIndex((sibling) => sibling.id === messageId);
  if (index < 0) return undefined;
  const choices: SiblingChoice[] = siblings.map((sibling) => ({
    id: sibling.id,
    active: sibling.id === headMessageId,
  }));
  return { choices, index };
}

/**
 * The user message a continuation or a regeneration answers, walking back from `messageId`.
 *
 * WHY THE ID AND NOT AN INDEX: a caller has a message (the head, or the sibling the user
 * pressed on), and the index of that message inside the chain is a fact the chain itself
 * should answer — an index passed in from the view is one more thing that can be stale.
 *
 * WHY THE NEAREST EARLIER `user` MESSAGE AND NOT `parentId`: regeneration is offered on an
 * ASSISTANT message whose parent is (in every turn `chat/send-turn.ts` writes) the user
 * message that prompted it, but the tree is data and a plugin or a future turn plan may
 * insert a node between the two. "The question this answer answers" is therefore the
 * nearest earlier turn the USER authored, which is what a regeneration must re-ask. A run
 * with no user message before `messageId` (a session whose first row is an assistant row)
 * answers `undefined`, and the caller refuses the gesture instead of inventing a prompt.
 */
export function promptMessageFor(chain: readonly Message[], messageId: Id): Message | undefined {
  const start = chain.findIndex((message) => message.id === messageId);
  if (start < 0) return undefined;
  for (let index = start - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate !== undefined && candidate.role === 'user') return candidate;
  }
  return undefined;
}
