/**
 * The draft row's own contract (M1-W1 / M1-C1, ADR-010).
 *
 * WHAT THIS FILE IS DEFENDING
 * The draft is what autosave persists, so it has to survive the two states a form actually passes
 * through: a payload that is COMPLETE and a payload that is HALF-TYPED (an empty name, a month
 * with no label). Neither may throw, neither may lose a value the user typed, and a row that is
 * not a draft at all must read as "no draft" so the editor falls back to the published version
 * (`readLocaleSetting`'s precedent).
 *
 * It also pins where a draft is NOT: nothing here is a `WorldVersion` / `CharacterVersion` row,
 * and the `baseVersion` it carries is the lineage anchor, which is why it is recorded at all.
 */
import type { CharacterVersion, JsonValue, WorldVersion } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { blankCharacterData } from './character';
import {
  characterDraftOf,
  characterDraftValue,
  readCharacterDraft,
  readWorldDraft,
  worldDraftOf,
  worldDraftValue,
} from './draft';
import { jsonObject, toJson } from './fields';
import { blankWorldData } from './world';

const AT = 1_790_000_000_000;

const baseWorldVersion: WorldVersion = {
  id: '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b01',
  worldId: '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b02',
  version: 2,
  createdAt: AT,
  updatedAt: AT,
  data: { ...blankWorldData('published'), premise: 'the published premise' },
  extensions: { 'x-mine.kept': true },
};

const baseCharacterVersion: CharacterVersion = {
  id: '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b03',
  characterId: '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a1b04',
  version: 5,
  createdAt: AT,
  updatedAt: AT,
  data: { ...blankCharacterData('published'), description: 'the published description' },
};

describe('the draft of a published version', () => {
  it('is the version itself, with an empty bag when the envelope had none', () => {
    expect(worldDraftOf(baseWorldVersion)).toEqual({
      baseVersion: 2,
      data: baseWorldVersion.data,
      extensions: { 'x-mine.kept': true },
    });
    expect(characterDraftOf(baseCharacterVersion)).toEqual({
      baseVersion: 5,
      data: baseCharacterVersion.data,
      extensions: {},
    });
  });
});

describe('the world draft row', () => {
  it('round-trips through the JSON a settings row holds', () => {
    const draft = {
      baseVersion: 2,
      data: { ...blankWorldData('草稿'), premise: '改过的设定' },
      extensions: { 'x-custom.weather': { label: '天气', value: '暴雪' } },
    };
    const value: JsonValue = worldDraftValue(draft);
    const read = readWorldDraft(toJson(value), baseWorldVersion);
    expect(read).toEqual(draft);
  });

  it('keeps a half-typed payload and completes only what it cannot read', () => {
    // The state autosave exists for: the name is empty and one member is the wrong type. The
    // empty values are the USER'S and must survive; the damaged one falls back to the base.
    const blank = jsonObject(toJson(blankWorldData(''))) ?? {};
    const stored = toJson({
      baseVersion: 2,
      data: { ...blank, name: '', startMinute: 'soon' },
      extensions: {},
    });
    const read = readWorldDraft(stored, baseWorldVersion);
    expect(read?.data.name).toBe('');
    expect(read?.data.startMinute).toBe(baseWorldVersion.data.startMinute);
    expect(read?.baseVersion).toBe(2);
  });

  it('reads a row that is not a draft as ABSENT, so the editor falls back', () => {
    expect(readWorldDraft(undefined, baseWorldVersion)).toBeUndefined();
    expect(readWorldDraft('nonsense', baseWorldVersion)).toBeUndefined();
    expect(readWorldDraft(7, baseWorldVersion)).toBeUndefined();
    expect(readWorldDraft([], baseWorldVersion)).toBeUndefined();
  });

  it('reads a row that IS a draft but carries no payload as the base payload', () => {
    expect(readWorldDraft({}, baseWorldVersion)).toEqual({
      baseVersion: baseWorldVersion.version,
      data: baseWorldVersion.data,
      extensions: {},
    });
  });

  it('falls back to the version it was read against when `baseVersion` is unusable', () => {
    for (const stored of [
      { baseVersion: 0 },
      { baseVersion: -2 },
      { baseVersion: 'x' },
      { baseVersion: 1.5 },
    ]) {
      expect(readWorldDraft(stored, baseWorldVersion)?.baseVersion).toBe(baseWorldVersion.version);
    }
  });

  it('drops an extension key the schema would refuse, and keeps the rest verbatim', () => {
    const read = readWorldDraft(
      { extensions: { 'x-ok.thing': 1, notNamespaced: 2, 'x-OK.bad': 3 } },
      baseWorldVersion,
    );
    expect(read?.extensions).toEqual({ 'x-ok.thing': 1 });
  });
});

describe('the character draft row', () => {
  it('round-trips through the JSON a settings row holds', () => {
    const draft = {
      baseVersion: 5,
      data: { ...blankCharacterData('草稿'), description: '改过的描述' },
      extensions: { 'x-custom.faction': { label: '阵营', value: '中立' } },
    };
    const value: JsonValue = characterDraftValue(draft);
    expect(readCharacterDraft(toJson(value), baseCharacterVersion)).toEqual(draft);
  });

  it('reads a half-typed card and keeps both foreign bags', () => {
    const read = readCharacterDraft(
      {
        baseVersion: 5,
        data: {
          name: '',
          stExtensions: { talkativeness: 0.5 },
          customFields: { 阵营: '中立' },
        },
        extensions: {},
      },
      baseCharacterVersion,
    );
    expect(read?.data.name).toBe('');
    // Everything the draft did not carry falls back to the published version.
    expect(read?.data.description).toBe(baseCharacterVersion.data.description);
    expect(read?.data.stExtensions).toEqual({ talkativeness: 0.5 });
    expect(read?.data.customFields).toEqual({ 阵营: '中立' });
  });
});
