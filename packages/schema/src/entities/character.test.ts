/**
 * Tests for the character card — the contract with the highest cost of being
 * wrong (docs/02 §13 item 4).
 *
 * Three things are being defended here:
 * 1. the SillyTavern field names are frozen verbatim, because renaming one
 *    silently breaks every imported card;
 * 2. there is no player/cast field on a card (ADR-010) — identity belongs to the
 *    session, and a test would catch it creeping back in;
 * 3. foreign SillyTavern `extensions` survive import -> export (docs/04 §10)
 *    even though their keys are not `x-` namespaced.
 */
import { describe, expect, it } from 'vitest';
import { CharacterDataSchema, CharacterVersionSchema } from './character';

/**
 * Copy of `source` with `keys` removed.
 *
 * Both spellings of a bare key are unusable here: `broken.characterId` trips
 * `noPropertyAccessFromIndexSignature`, and `broken['characterId']` trips
 * Biome's `useLiteralKeys`. Only a parameterised key satisfies both.
 */
function withoutKeys(source: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

const CHARACTER_ID = '0192f0a1-1111-7000-8000-000000000001';
const VERSION_ID = '0192f0a1-1111-7000-8000-000000000002';
const NOW = 1_790_000_000_000;

/** A complete card: every optional field present, so stripping is detectable. */
const fullCard = {
  name: '银松镇的莉安',
  description: '守夜人，左手有旧伤。',
  personality: '多疑但守诺',
  scenario: '霜月十二日，银松镇的旅店。',
  first_mes: '"你也是来看雪的？"',
  mes_example: '<START>\n{{user}}: 你叫什么？\n{{char}}: 莉安。',
  creator_notes: '适合慢热单场景。',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: ['"别站在门口。"'],
  tags: ['奇幻', 'zh-CN'],
  creator: '某位创作者',
  character_version: '1.0',
  voice: {
    desire: 60,
    ability: 80,
    roles: ['守夜人'],
    maxLinesPerRound: 2,
    cooldown: 1,
  },
  visual: {
    appearance: { hair: '银白', eyes: '灰', build: '修长', skin: '苍白', marks: ['左臂旧伤'] },
    outfits: [{ id: 'outfit-default', name: '守夜斗篷', prompt: 'dark wool cloak' }],
    expressions: [{ id: 'happy', label: '微笑', prompt: 'faint smile' }],
    style: { preset: 'anime', positive: 'soft light', negative: 'blurry', aspect: '832x1216' },
    params: { seedPolicy: 'fixed', seed: 42, steps: 28, cfg: 5.5 },
    references: [{ assetId: '0192f0a1-1111-7000-8000-00000000000a', role: 'face' }],
  },
  sampling: { temperature: 0.9 },
  stExtensions: { talkativeness: 0.5, depth_prompt: { depth: 4, prompt: 'stay in character' } },
  customFields: { 阵营: '中立' },
};

describe('character data', () => {
  it('parses a complete card', () => {
    const result = CharacterDataSchema.safeParse(fullCard);
    expect(result.success).toBe(true);
  });

  it('parses a minimal card (only name is truly required)', () => {
    // Every SillyTavern field is required to exist but may legitimately be
    // empty — an imported card often is. `name` is the only field that cannot.
    const minimalCard = {
      name: '莉安',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      voice: { desire: 50, ability: 50, roles: [], maxLinesPerRound: 1, cooldown: 0 },
      visual: {
        appearance: { hair: '', eyes: '', build: '', skin: '', marks: [] },
        outfits: [],
        expressions: [],
        style: { preset: '', positive: '', negative: '', aspect: '' },
        params: { seedPolicy: 'fixed' },
      },
    };
    expect(CharacterDataSchema.safeParse(minimalCard).success).toBe(true);
    expect(CharacterDataSchema.safeParse({ ...minimalCard, name: '' }).success).toBe(false);
  });

  it('rejects a card missing any required SillyTavern field', () => {
    const required = [
      'name',
      'description',
      'personality',
      'scenario',
      'first_mes',
      'mes_example',
      'creator_notes',
      'system_prompt',
      'post_history_instructions',
      'alternate_greetings',
      'tags',
      'creator',
      'character_version',
      'voice',
      'visual',
    ];
    for (const field of required) {
      const broken: Record<string, unknown> = { ...fullCard };
      delete broken[field];
      expect(`${field}:${CharacterDataSchema.safeParse(broken).success}`).toBe(`${field}:false`);
    }
  });

  it('enforces the speaking-profile bounds (hard constraints the AI cannot exceed)', () => {
    const voice = (patch: Record<string, number>) => ({
      ...fullCard,
      voice: { ...fullCard.voice, ...patch },
    });
    expect(CharacterDataSchema.safeParse(voice({ desire: 101 })).success).toBe(false);
    expect(CharacterDataSchema.safeParse(voice({ desire: 100 })).success).toBe(true);
    expect(CharacterDataSchema.safeParse(voice({ maxLinesPerRound: 6 })).success).toBe(false);
    expect(CharacterDataSchema.safeParse(voice({ maxLinesPerRound: 5 })).success).toBe(true);
    expect(CharacterDataSchema.safeParse(voice({ cooldown: 4 })).success).toBe(false);
  });

  it('rejects an unknown seed policy rather than guessing', () => {
    const broken = {
      ...fullCard,
      visual: { ...fullCard.visual, params: { seedPolicy: 'asdf' } },
    };
    expect(CharacterDataSchema.safeParse(broken).success).toBe(false);
  });

  it('has no player/cast field, because identity is a property of the session', () => {
    const keys = Object.keys(CharacterDataSchema.shape);
    for (const forbidden of ['isPlayer', 'kind', 'role', 'persona', 'player']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('preserves foreign SillyTavern extensions verbatim (import -> export round-trip)', () => {
    const parsed = CharacterDataSchema.parse(fullCard);
    expect(parsed.stExtensions).toEqual(fullCard.stExtensions);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    const parsed = CharacterDataSchema.parse({ ...fullCard, someFutureField: 1 });
    expect(parsed).not.toHaveProperty('someFutureField');
  });

  it('is JSON round-trip stable', () => {
    const once = JSON.stringify(CharacterDataSchema.parse(fullCard));
    const twice = JSON.stringify(CharacterDataSchema.parse(JSON.parse(once)));
    expect(twice).toBe(once);
  });

  it('carries plugin data on the version envelope, not inside the payload', () => {
    // The plugin channel is `CharacterVersion.extensions`. A stray `extensions`
    // key inside the card payload must be stripped like any other unknown field,
    // so a plugin can never smuggle data past the envelope.
    const parsed = CharacterDataSchema.parse({ ...fullCard, extensions: { sanity: 9 } });
    expect(parsed).not.toHaveProperty('extensions');
  });
});

describe('character version envelope', () => {
  const version = {
    id: VERSION_ID,
    characterId: CHARACTER_ID,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    data: fullCard,
  };

  it('parses a first version without a lineage', () => {
    expect(CharacterVersionSchema.safeParse(version).success).toBe(true);
  });

  it('requires a UUIDv7 id and a positive version number', () => {
    expect(CharacterVersionSchema.safeParse({ ...version, id: 'not-a-uuid' }).success).toBe(false);
    expect(CharacterVersionSchema.safeParse({ ...version, version: 0 }).success).toBe(false);
  });

  it('requires the characterId back-pointer used by the storage collection', () => {
    const broken = withoutKeys(version, 'characterId');
    expect(CharacterVersionSchema.safeParse(broken).success).toBe(false);
  });

  it('records lineage for an iteration and round-trips it', () => {
    const second = {
      ...version,
      id: '0192f0a1-1111-7000-8000-000000000003',
      version: 2,
      lineage: { parentId: VERSION_ID, parentVersion: 1, reason: '补充差分图', at: NOW + 1000 },
    };
    const parsed = CharacterVersionSchema.parse(second);
    expect(parsed.lineage?.parentVersion).toBe(1);
    expect(JSON.stringify(CharacterVersionSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
  });

  it('round-trips a plugin extension attached to the version', () => {
    const withPlugin = { ...version, extensions: { 'x-mythos.sanity': { current: 9 } } };
    const parsed = CharacterVersionSchema.parse(withPlugin);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(withPlugin);
  });

  it('rejects an un-namespaced key in the extensions bag', () => {
    const broken = { ...version, extensions: { sanity: 9 } };
    expect(CharacterVersionSchema.safeParse(broken).success).toBe(false);
  });
});
