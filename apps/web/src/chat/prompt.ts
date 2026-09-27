/**
 * Prompt assembly for one turn — the "built-in default" of M0-T8.
 *
 * WHY THERE IS NO PromptPreset HERE (docs/06 §8.5 决定 1)
 * `PromptPreset` / `PromptBlock` are M1, but `Session.refs.promptPreset` is a
 * required pin on the frozen session schema. §8.5 records the consequence
 * explicitly: M0-T8 "走内置默认装配" — the pin is a placeholder and THIS function
 * is the whole preset. It is deliberately pure: no storage, no provider, no
 * randomness, so a test can pin the assembled shape and M1 can diff against it
 * when the real preset engine lands.
 *
 * WHAT THE ASSEMBLY IS, AND WHY IT IS THREE PARTS
 * 1. ONE system turn naming the world and the player. The ids come from the
 *    placeholder pins (M1 will resolve them to names), because a session schema
 *    that cannot build a prompt is the failure docs/02 §4 was written to prevent.
 * 2. The ACTIVE CHAIN as alternating turns. The chain arrives already walked from
 *    `Session.headMessageId` (`db/repository.ts`), so a discarded branch is not
 *    in it — reassembling the tree here would re-introduce the bug the walk
 *    exists to prevent.
 * 3. The new user turn.
 *
 * WHY SOME MESSAGES ARE DROPPED
 * - `system` and `tool` turns in the chain belong to the tool protocol (§5.3) and
 *   to M1's preset engine. Re-emitting a stored `system` turn here would put a
 *   second, stale instruction set in front of the model; a `tool` turn without the
 *   call it answers is rejected by every vendor.
 * - An EMPTY assistant turn is dropped: it is what a turn that failed before its
 *   first delta leaves behind, and a `content: ''` assistant message is a request
 *   some vendors reject outright.
 */
import type { ChatMessage } from '@smarttavern/core';
import type { Message, Session } from '@smarttavern/schema';

/** The instruction that tells the model what it is playing (M0 default preset). */
function systemInstruction(session: Session): string {
  const { world, playerCharacter } = session.refs;
  return [
    '你是一个交互式小说与 TRPG 的主持人（GM）。',
    `世界：${world.id}（v${world.version}）。`,
    `玩家扮演的角色：${playerCharacter.id}（v${playerCharacter.version}）。`,
    '请用第二人称推进剧情，只输出角色与旁白的内容，不要复述本说明。',
  ].join('\n');
}

/**
 * Assemble the wire messages for one turn.
 *
 * The returned array is what the provider receives: `ChatMessage` (the port's
 * type) and not `Message` (the stored entity) — a request message is only what
 * goes on the wire, and conflating the two is what ADR-016 forbids.
 */
export function buildMessages(
  session: Session,
  chain: readonly Message[],
  input: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemInstruction(session) }];

  for (const message of chain) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.content === '') continue;
    messages.push(
      message.speakerId === undefined
        ? { role: message.role, content: message.content }
        : { role: message.role, content: message.content, speakerId: message.speakerId },
    );
  }

  messages.push({ role: 'user', content: input });
  return messages;
}
