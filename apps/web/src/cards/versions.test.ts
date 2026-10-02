/**
 * Committing a draft as a NEW version (ADR-010) — the pure half of the card editors' save.
 *
 * WHAT THIS FILE IS DEFENDING, IN THE MILESTONE'S OWN WORDS
 * 「编辑产生新版本，旧版本不被改动」. So the assertions are:
 * 1. a commit is a NEW ROW (a fresh id, `version = head + 1`) — never the row that was published;
 * 2. the inputs are NOT mutated, which is why they are frozen here: a planner that edited the row
 *    it was given would throw in strict mode instead of quietly rewriting somebody's save;
 * 3. the head is an INDEX over the payload (`name`, `tags`), so a library row cannot advertise a
 *    name the version it points at does not have;
 * 4. the version number is monotonic over the HEAD while the lineage parent is the version the
 *    draft was EDITED FROM — two different facts, which differ exactly when another tab published
 *    in between.
 */
import {
  type Character,
  CharacterVersionSchema,
  type UuidV7,
  type World,
  WorldSchema,
  WorldVersionSchema,
} from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { blankCharacterData } from './character';
import { planCharacterVersion, planWorldVersion } from './versions';
import { blankWorldData } from './world';

const WORLD_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b01' as UuidV7;
const OTHER_WORLD_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b02' as UuidV7;
const PAST_VERSION_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b03' as UuidV7;
const MINTED_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b04' as UuidV7;
const CHARACTER_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b05' as UuidV7;
const AT = 1_790_000_000_000;

const head: World = Object.freeze({
  id: WORLD_ID,
  name: '霜月群岛',
  headVersion: 3,
  tags: ['奇幻'],
  createdAt: AT - 1_000,
  updatedAt: AT - 1_000,
});

const base = Object.freeze({ id: PAST_VERSION_ID, version: 3 });

const frozenData = Object.freeze({
  ...blankWorldData('霜月群岛'),
  genre: ['奇幻', '生存'],
});

describe('planWorldVersion', () => {
  it('plans a NEW row one version above the head, and records where it came from', () => {
    const plan = planWorldVersion({
      head,
      base: { anchor: base, reason: '由世界卡编辑器发布' },
      data: frozenData,
      extensions: { 'x-custom.weather': { label: '天气', value: '暴雪' } },
      id: MINTED_ID,
      at: AT,
    });

    expect(plan.version.id).toBe(MINTED_ID);
    expect(plan.version.id).not.toBe(PAST_VERSION_ID);
    expect(plan.version.worldId).toBe(WORLD_ID);
    expect(plan.version.version).toBe(4);
    expect(plan.version.createdAt).toBe(AT);
    expect(plan.version.updatedAt).toBe(AT);
    expect(plan.version.data).toBe(frozenData);
    expect(plan.version.extensions).toEqual({
      'x-custom.weather': { label: '天气', value: '暴雪' },
    });
    // The lineage sentence is the caller's, in the language active at the save.
    expect(plan.version.lineage).toEqual({
      parentId: PAST_VERSION_ID,
      parentVersion: 3,
      reason: '由世界卡编辑器发布',
      at: AT,
    });
    // The head points at the new version and carries the payload's own name and genre.
    expect(plan.world).toEqual({
      ...head,
      name: frozenData.name,
      tags: ['奇幻', '生存'],
      headVersion: 4,
      updatedAt: AT,
    });
    // Both rows are what the schema expects, which is the publish gate's last backstop.
    expect(WorldVersionSchema.safeParse(plan.version).success).toBe(true);
    expect(WorldSchema.safeParse(plan.world).success).toBe(true);
  });

  it('never mutates the row it was given (the ADR-010 failure this planner exists to prevent)', () => {
    const plan = planWorldVersion({
      head,
      base: { anchor: base, reason: 'reason' },
      data: frozenData,
      extensions: undefined,
      id: MINTED_ID,
      at: AT,
    });
    // Frozen inputs: an in-place write would have thrown above. What is left to check is that the
    // OLD row is still exactly what it was, and that the new row is a different object.
    expect(head.headVersion).toBe(3);
    expect(head.updatedAt).toBe(AT - 1_000);
    expect(plan.world).not.toBe(head);
    expect(plan.world.tags).not.toBe(head.tags);
    expect(plan.version.id).not.toBe(PAST_VERSION_ID);
    expect(plan.version).not.toHaveProperty('extensions');
  });

  it('plans version 1 with no lineage when the card is being created', () => {
    const fresh: World = Object.freeze({ ...head, headVersion: 0 });
    const plan = planWorldVersion({
      head: fresh,
      base: undefined,
      data: frozenData,
      extensions: undefined,
      id: MINTED_ID,
      at: AT,
    });
    expect(plan.version.version).toBe(1);
    expect(plan.world.headVersion).toBe(1);
    // Absent, not empty: a first version has no parent (`LineageSchema` is optional).
    expect(plan.version).not.toHaveProperty('lineage');
  });

  it('keeps the version number monotonic over the head even when the draft is older', () => {
    // The race: this draft was edited from v1 while another writer reached v5.
    const moved: World = Object.freeze({ ...head, headVersion: 5 });
    const older = Object.freeze({ id: OTHER_WORLD_ID, version: 1 });
    const plan = planWorldVersion({
      head: moved,
      base: { anchor: older, reason: 'reason' },
      data: frozenData,
      extensions: undefined,
      id: MINTED_ID,
      at: AT,
    });
    expect(plan.version.version).toBe(6);
    // ...and the lineage still names the base the content came from, not "the head minus one".
    expect(plan.version.lineage?.parentVersion).toBe(1);
    expect(plan.version.lineage?.parentId).toBe(OTHER_WORLD_ID);
  });
});

describe('planCharacterVersion', () => {
  const character: Character = Object.freeze({
    id: CHARACTER_ID,
    name: '莉安',
    headVersion: 1,
    tags: [],
    avatarAssetId: '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b0a',
    createdAt: AT,
    updatedAt: AT,
  });

  it('derives the head from the card’s own name and tags, and keeps the avatar', () => {
    const data = Object.freeze({ ...blankCharacterData('莉安'), tags: ['奇幻', 'zh-CN'] });
    const plan = planCharacterVersion({
      head: character,
      base: { anchor: Object.freeze({ id: PAST_VERSION_ID, version: 1 }), reason: 'reason' },
      data,
      extensions: { 'x-custom.faction': { label: '阵营', value: '中立' } },
      id: MINTED_ID,
      at: AT + 1,
    });
    expect(plan.version.characterId).toBe(CHARACTER_ID);
    expect(plan.version.version).toBe(2);
    expect(plan.character.tags).toEqual(['奇幻', 'zh-CN']);
    expect(plan.character.avatarAssetId).toBe(character.avatarAssetId);
    expect(plan.character.headVersion).toBe(2);
    expect(CharacterVersionSchema.safeParse(plan.version).success).toBe(true);
    expect(plan.character.name).toBe(data.name);
  });

  it('leaves the head’s own extensions bag alone, because the envelope owns the channel', () => {
    const withPlugin: Character = Object.freeze({
      ...character,
      extensions: { 'x-plugin.note': 'kept' },
    });
    const plan = planCharacterVersion({
      head: withPlugin,
      base: undefined,
      data: Object.freeze(blankCharacterData('莉安')),
      extensions: { 'x-custom.a': { label: 'a', value: 'b' } },
      id: MINTED_ID,
      at: AT,
    });
    // One plugin slot per artefact: the version's. The head's existing bag is preserved as it
    // was and never becomes the place custom fields are written.
    expect(plan.character.extensions).toEqual({ 'x-plugin.note': 'kept' });
    expect(plan.version.extensions).toEqual({ 'x-custom.a': { label: 'a', value: 'b' } });
  });
});
