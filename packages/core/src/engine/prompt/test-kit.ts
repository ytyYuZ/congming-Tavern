/**
 * Shared fixtures for the prompt-composer tests (M1-G4).
 *
 * WHY A KIT AND NOT A COPY PER FILE. The acceptance is "a snapshot of assembly
 * order and of over-budget trimming", and those two snapshots describe the SAME
 * preset built the same way. A per-file copy would let the trim table pass
 * against a preset the order test never saw.
 *
 * NOT A `.test.ts` FILE ON PURPOSE, matching `engine/time/test-kit.ts`: it holds
 * no suite, and an empty suite is a failure rather than a pass.
 *
 * The clock here is a plain `ClockDisplay` LITERAL, not a `display()` call: the
 * composer consumes a display the caller already produced (docs/02 §5.1), and a
 * literal makes each rendered field visible in one place. `macros.test.ts`
 * checks the literal against the time engine's own public `renderParts()`.
 */
import type { PromptBlock, PromptPreset } from '@smarttavern/schema';
import type { ChatMessage } from '../../ports/llm';
import type { ClockDisplay } from '../time';
import type { TokenCounter } from './estimate';
import type { MacroContext } from './macros';
import type { ComposeFailure, ComposeResult, ComposeSuccess, PromptContext } from './types';

/** A block whose only job is to exist, with every field a test does not set. */
export function block(
  spec: { id: string; content: string; order: number } & Partial<PromptBlock>,
): PromptBlock {
  const { id, content, order, ...rest } = spec;
  return {
    id,
    name: id,
    role: 'system',
    content,
    enabled: true,
    position: 'pre_history',
    order,
    ...rest,
  };
}

/** The empty-building fixtures need a preset id that satisfies `UuidV7Schema`. */
export const PRESET_ID = '01890000-0000-7000-8000-000000000001';

export function preset(blocks: readonly PromptBlock[]): PromptPreset {
  return {
    id: PRESET_ID,
    name: 'Fixture preset',
    version: 1,
    blocks: [...blocks],
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Alternating history turns: even index is the user, odd is the character. The
 * alternation is what makes the order in a snapshot readable — a run of
 * `system` messages before, inside and after the history is the thing under
 * test, and it must not be mistaken for the history itself.
 */
export function turns(...contents: readonly string[]): ChatMessage[] {
  return contents.map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
  }));
}

/** A clock display: Era 3, Alpha 4, 02:30, inside the `dawn` segment. */
export const clock: ClockDisplay = {
  minute: 150,
  epochLabel: 'Era',
  year: 3,
  monthIndex: 0,
  monthName: 'Alpha',
  day: 4,
  dayOfYear: 4,
  hour: 2,
  minuteOfHour: 30,
  minutesPerHour: 60,
  hoursPerDay: 12,
  segments: [{ id: 'dawn', name: 'Dawn' }],
};

/** Everything the macros need, so each macro test overrides only its own field. */
export function macroContext(overrides: Partial<MacroContext> = {}): MacroContext {
  return {
    characterName: 'Aria',
    userName: 'Yuki',
    worldName: 'Elaria',
    sceneLocation: 'The tavern',
    turnNumber: 4,
    variables: { hp: 10, Aria_hp: 12 },
    clock,
    ...overrides,
  };
}

/** A context with no history and a one-word input, unless a test says otherwise. */
export function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    characterName: 'Aria',
    userName: 'Yuki',
    worldName: 'Elaria',
    sceneLocation: 'The tavern',
    turnNumber: 4,
    variables: { hp: 10 },
    clock,
    history: [],
    input: { role: 'user', content: 'go' },
    ...overrides,
  };
}

/**
 * A counter that charges a flat 10 tokens per message, which is what makes the
 * trim tables hand-checkable: one message is 10, so "fits 3 of 4 blocks" is a
 * budget of 30. It is additive on purpose — the injected-counter path must not
 * need the estimate to be additive, and `budget.test.ts` covers the additive
 * case with an explicit expected total.
 */
export const flatCounter: TokenCounter = (messages) => messages.length * 10;

/** The key a test asserts on: `role:content`, so a stray role is a visible diff. */
export function lines(result: ComposeResult): string[] {
  return messagesOf(result).map((message) => `${message.role}:${message.content}`);
}

function messagesOf(result: ComposeResult): readonly ChatMessage[] {
  return result.ok ? result.messages : result.overBudget;
}

/** Narrow a result in a test: fails loudly when the assembly did not fit. */
export function expectOk(result: ComposeResult): ComposeSuccess {
  if (!result.ok) {
    throw new Error(`expected a fitting assembly, got: ${result.error.message}`);
  }
  return result;
}

/** Narrow a result in a test: fails loudly when the assembly unexpectedly fit. */
export function expectFailure(result: ComposeResult): ComposeFailure {
  if (result.ok) throw new Error('expected a budget failure, got a fitting assembly');
  return result;
}

/** Freeze a fixture deeply, so a write the composer should not make throws. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
