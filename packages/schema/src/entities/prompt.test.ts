/**
 * `PromptPreset` / `PromptBlock` — the contract M1-G4's PromptComposer consumes and
 * `data/promptPresets.json` carries (docs/02 §5.1 §7, docs/04 §2).
 *
 * WHAT THESE CASES ARE FOR: the entity is mostly closed enums (role / position /
 * priority) because the composer switches on them exhaustively, so the tests pin
 * exactly which members exist — a silently widened enum would let a preset through
 * that the composer has no branch for. The rest (empty `blocks`, stripped unknown
 * fields, the `x-` extension channel) pins the rules `common.ts` sets for every
 * entity, so this one cannot drift from them.
 */
import { describe, expect, it } from 'vitest';
import { PromptBlockSchema, PromptPresetSchema } from './prompt';

const ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b77';

/** The smallest block that is still a block: nothing optional is set. */
const minimalBlock = {
  id: 'block-1',
  name: 'System instruction',
  role: 'system',
  content: 'You are {{char}}.',
  enabled: true,
  position: 'pre_history',
  order: 0,
};

const minimalPreset = {
  id: ID,
  name: 'Default',
  version: 1,
  blocks: [minimalBlock],
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
};

describe('PromptBlock', () => {
  it('accepts the minimal block and defaults nothing silently', () => {
    const parsed = PromptBlockSchema.parse(minimalBlock);
    expect(parsed.depth).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
    expect(parsed.conditions).toBeUndefined();
  });

  it('accepts a block with every optional field set', () => {
    const full = {
      ...minimalBlock,
      position: 'in_history',
      depth: 4,
      order: -2,
      budget: { share: 0.25, priority: 'high' },
      conditions: { keywords: ['dusk'], minTurns: 3, timeOfDay: ['dusk', 'night'] },
      extensions: { 'x-plugin.tone': 'terse' },
    };
    expect(PromptBlockSchema.safeParse(full).success).toBe(true);
  });

  it('keeps role / position / priority CLOSED — the composer switches on them', () => {
    // A `tool` turn comes from the runtime, never from a template.
    expect(PromptBlockSchema.safeParse({ ...minimalBlock, role: 'tool' }).success).toBe(false);
    expect(PromptBlockSchema.safeParse({ ...minimalBlock, position: 'mid_history' }).success).toBe(
      false,
    );
    expect(
      PromptBlockSchema.safeParse({
        ...minimalBlock,
        budget: { priority: 'urgent' },
      }).success,
    ).toBe(false);
    // All four priorities are real members, in the order the trimming uses.
    for (const priority of ['required', 'high', 'normal', 'optional']) {
      expect(PromptBlockSchema.safeParse({ ...minimalBlock, budget: { priority } }).success).toBe(
        true,
      );
    }
  });

  it('bounds budget.share to a FRACTION: 0 is not a share and 1.5 is not either', () => {
    const at = (share: number) =>
      PromptBlockSchema.safeParse({
        ...minimalBlock,
        budget: { share, priority: 'normal' },
      }).success;
    expect(at(1)).toBe(true);
    expect(at(0.01)).toBe(true);
    expect(at(0)).toBe(false);
    expect(at(1.5)).toBe(false);
  });

  it('rejects nonsensical numbers instead of coercing them', () => {
    expect(PromptBlockSchema.safeParse({ ...minimalBlock, depth: -1 }).success).toBe(false);
    expect(PromptBlockSchema.safeParse({ ...minimalBlock, depth: 1.5 }).success).toBe(false);
    expect(
      PromptBlockSchema.safeParse({ ...minimalBlock, conditions: { minTurns: -1 } }).success,
    ).toBe(false);
  });

  it('carries macro text verbatim — content is not a closed vocabulary', () => {
    const parsed = PromptBlockSchema.parse({ ...minimalBlock, content: '{{roll::2d6}} {{time}}' });
    expect(parsed.content).toBe('{{roll::2d6}} {{time}}');
  });
});

describe('PromptPreset', () => {
  it('accepts the minimal preset', () => {
    expect(PromptPresetSchema.safeParse(minimalPreset).success).toBe(true);
  });

  it('allows an EMPTY blocks list — a preset being written is still a preset', () => {
    expect(PromptPresetSchema.safeParse({ ...minimalPreset, blocks: [] }).success).toBe(true);
  });

  it('requires a minted UUIDv7 id, because this project is the one minting it', () => {
    expect(PromptPresetSchema.safeParse({ ...minimalPreset, id: 'my-preset' }).success).toBe(false);
    // Version 4 is a UUID but not time-ordered (docs/04 §4).
    expect(
      PromptPresetSchema.safeParse({ ...minimalPreset, id: '0192f0a1-7c3d-4a4e-9b21-5c8f0d3a1b77' })
        .success,
    ).toBe(false);
  });

  it('requires a positive version — a preset starts at 1, never at 0', () => {
    expect(PromptPresetSchema.safeParse({ ...minimalPreset, version: 0 }).success).toBe(false);
    expect(PromptPresetSchema.safeParse({ ...minimalPreset, version: 2 }).success).toBe(true);
  });

  it('STRIPS an unknown field rather than rejecting the preset (common.ts rule 2)', () => {
    const parsed = PromptPresetSchema.parse({
      ...minimalPreset,
      futureField: 'from a v1.1 writer',
    });
    expect(Object.hasOwn(parsed, 'futureField')).toBe(false);
  });

  it('keeps extensions namespaced, so two plugins cannot fight over one slot', () => {
    expect(
      PromptPresetSchema.safeParse({
        ...minimalPreset,
        extensions: { 'x-plugin.a': 1 },
      }).success,
    ).toBe(true);
    expect(
      PromptPresetSchema.safeParse({ ...minimalPreset, extensions: { plain: 1 } }).success,
    ).toBe(false);
  });
});
