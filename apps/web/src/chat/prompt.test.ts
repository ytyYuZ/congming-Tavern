/**
 * `buildMessages` — the built-in default assembly (M0-T8, docs/06 §8.5 决定 1).
 *
 * WHY THIS IS A PURE-FUNCTION TEST WITH LITERAL MESSAGES
 * `PromptPreset` is M1, so this assembly IS the M0 preset. Pinning its exact shape as
 * literals is what lets M1 diff the real preset engine against it instead of
 * rediscovering what M0 sent. The chain is built as plain `Message` values rather than
 * through the database because the function is pure — a database round trip would only
 * test the fixture.
 */
import type { Message, Session } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { buildMessages } from './prompt';

function session(overrides: Partial<Session['refs']> = {}): Session {
  return {
    id: 'session-1',
    title: '测试会话',
    refs: {
      world: { id: 'world-a', version: 2 },
      playerCharacter: { id: 'pc-a', version: 1 },
      cast: [],
      promptPreset: { id: 'builtin-default', version: 1 },
      modelConfig: {
        provider: 'openai-compatible',
        model: 'm',
        params: { temperature: 1, topP: 1 },
      },
      ...overrides,
    },
    initialClock: 0,
    schedulerMode: 'user',
    headMessageId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

let messageCounter = 0;

function message(overrides: Partial<Message> = {}): Message {
  messageCounter += 1;
  return {
    id: `message-${messageCounter}`,
    sessionId: 'session-1',
    parentId: null,
    role: 'user',
    kind: 'dialogue',
    content: '内容',
    meta: {},
    createdAt: messageCounter,
    ...overrides,
  };
}

describe('buildMessages', () => {
  it('assembles system + chain + the new user turn, in that order', () => {
    const chain = [
      message({ role: 'user', content: '第一问' }),
      message({ role: 'assistant', content: '第一答' }),
    ];

    const messages = buildMessages(session(), chain, '第二问');

    expect(messages.map((entry) => entry.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1]?.content).toBe('第一问');
    expect(messages[2]?.content).toBe('第一答');
    expect(messages[3]?.content).toBe('第二问');
  });

  it('names the world and the player character in the system turn', () => {
    const [system] = buildMessages(session(), [], '你好');
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('world-a');
    expect(system?.content).toContain('v2');
    expect(system?.content).toContain('pc-a');
  });

  it('drops stored system and tool turns and empty assistant turns', () => {
    const chain = [
      // A leftover system turn from a preset would otherwise be a SECOND instruction
      // set, and a tool turn without its call is rejected by every vendor.
      message({ role: 'system', content: '旧的系统提示' }),
      message({ role: 'user', content: '问题' }),
      message({ role: 'assistant', content: '' }),
      message({ role: 'tool', content: '{"ok":true}' }),
      message({ role: 'assistant', content: '真正的回答' }),
    ];

    const messages = buildMessages(session(), chain, '追加');

    expect(messages.map((entry) => entry.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages.map((entry) => entry.content)).toEqual([
      messages[0]?.content,
      '问题',
      '真正的回答',
      '追加',
    ]);
  });

  it('carries a speaker id through, because presentation survives the wire check', () => {
    const chain = [message({ role: 'assistant', content: 'NPC 说话', speakerId: 'npc-7' })];
    const messages = buildMessages(session(), chain, '继续');
    expect(messages[1]?.speakerId).toBe('npc-7');
    expect(messages[3]?.speakerId).toBeUndefined();
  });

  it('is pure: the same input gives the same output and the chain is not mutated', () => {
    const chain = [message({ role: 'user', content: '不变' })];
    const before = JSON.stringify(chain);
    const first = buildMessages(session(), chain, 'x');
    const second = buildMessages(session(), chain, 'x');
    expect(JSON.stringify(chain)).toBe(before);
    expect(first).toEqual(second);
  });
});
