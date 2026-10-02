/**
 * The character payload as the editor treats it (M1-C1).
 *
 * WHAT THIS FILE IS DEFENDING
 * 1. 「字段完整」 against the CONTRACT: the form's declared paths cover every leaf of
 *    `CharacterDataSchema` or delegate it explicitly, and the blank card a new character starts
 *    from is one the schema accepts.
 * 2. THE ADR-010 ABSENCE: no player/cast field, no `kind`, no `role` — identity is a property of
 *    the SESSION, and a card that grew one would fight the session that owns it. The only
 *    speaking-role vocabulary a card has is `voice.roles`, which says how a card speaks, never
 *    who is playing whom.
 * 3. The two foreign bags (`stExtensions`, `customFields`) survive hydration VERBATIM: they are
 *    I1's round trip and other people's data, and nothing here may decide they can be dropped.
 * 4. `completeCharacterData` is total: a damaged draft falls back field by field and never throws.
 */
import { type CharacterData, CharacterDataSchema, UUID_V7_PATTERN } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  blankCharacterData,
  blankExpression,
  blankOutfit,
  blankReference,
  CHARACTER_DELEGATED_PATHS,
  CHARACTER_ENVELOPE_PATHS,
  CHARACTER_FORM_PATHS,
  characterIssues,
  completeCharacterData,
  isReasoningEffort,
  isReferenceRole,
  isSeedPolicy,
  REASONING_EFFORT_LABELS,
  REFERENCE_ROLE_LABELS,
  SEED_POLICY_LABELS,
} from './character';
import { appendItem, jsonObject, removeItem, toJson, withItem } from './fields';
import { leafPaths } from './schema-leaves.test-helpers';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

/** A card with EVERY member present, including the optionals and both foreign bags. */
const fullCard: CharacterData = {
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
  voice: { desire: 60, ability: 80, roles: ['守夜人'], maxLinesPerRound: 2, cooldown: 1 },
  visual: {
    appearance: { hair: '银白', eyes: '灰', build: '修长', skin: '苍白', marks: ['左臂旧伤'] },
    outfits: [{ id: 'outfit-default', name: '守夜斗篷', prompt: 'dark wool cloak' }],
    expressions: [{ id: 'happy', label: '微笑', prompt: 'faint smile' }],
    style: { preset: 'anime', positive: 'soft light', negative: 'blurry', aspect: '832x1216' },
    params: {
      provider: 'a1111',
      model: 'sd-xl',
      sampler: 'euler',
      steps: 28,
      cfg: 5.5,
      seedPolicy: 'fixed',
      seed: 42,
    },
    references: [{ assetId: '0192f0a1-1111-7000-8000-00000000000a', role: 'face' }],
  },
  sampling: {
    temperature: 0.9,
    topP: 0.95,
    topK: 40,
    maxTokens: 512,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
    repetitionPenalty: 1.1,
    stop: ['\n\n'],
    seed: 7,
    reasoningEffort: 'high',
  },
  stExtensions: { talkativeness: 0.5, depth_prompt: { depth: 4, prompt: 'stay in character' } },
  customFields: { 阵营: '中立' },
};

/* ────────────────────────── field completeness ───────────────────────────── */

describe('the form inventory', () => {
  it('covers every leaf of CharacterDataSchema, or delegates it on purpose', () => {
    const declared = new Set([
      ...CHARACTER_FORM_PATHS,
      ...CHARACTER_DELEGATED_PATHS,
      ...CHARACTER_ENVELOPE_PATHS,
    ]);
    const missing = leafPaths(CharacterDataSchema).filter((path) => !declared.has(path));
    expect(missing).toEqual([]);
  });

  it('names nothing the payload does not have (a typo is not a rendered field)', () => {
    const leaves = new Set(leafPaths(CharacterDataSchema));
    const unknown = [...CHARACTER_FORM_PATHS, ...CHARACTER_DELEGATED_PATHS].filter(
      (path) => !leaves.has(path),
    );
    expect(unknown).toEqual([]);
  });

  it('delegates the two foreign bags, and says which', () => {
    // `stExtensions` holds other people's ST keys; `customFields` is superseded for new data by
    // the envelope's `extensions`. Both are preserved by hydration, neither is rendered.
    expect(CHARACTER_DELEGATED_PATHS).toEqual(['stExtensions', 'customFields']);
    expect(CHARACTER_ENVELOPE_PATHS).toEqual(['extensions']);
  });
});

/* ──────────────────────── the identity rule (ADR-010) ────────────────────── */

describe('the card carries no identity', () => {
  it('renders no player/cast field, in any spelling', () => {
    // The editor's own inventory is checked, because THAT is what the form can offer: a card
    // whose editor grew 「玩家角色」 would be able to mark a card, and the same card then could
    // not play the antagonist in the next session.
    const forbidden = ['isPlayer', 'kind', 'role', 'persona', 'cast'];
    for (const path of CHARACTER_FORM_PATHS) {
      const leaf = path.split('.').at(-1) ?? path;
      expect(forbidden, `${path} is an identity field`).not.toContain(leaf);
    }
    // ...and the schema itself is still free of them, which is the rule the editor inherits.
    expect(Object.keys(CharacterDataSchema.shape)).not.toContain('isPlayer');
    expect(Object.keys(CharacterDataSchema.shape)).not.toContain('kind');
  });

  it('keeps `voice.roles` as the only role vocabulary, and it is about speech', () => {
    const rolePaths = CHARACTER_FORM_PATHS.filter((path) => path.includes('role'));
    expect(rolePaths).toEqual(['voice.roles']);
  });
});

/* ─────────────────────────── the blank payload ───────────────────────────── */

describe('blankCharacterData', () => {
  it('starts a new card from a payload the schema accepts', () => {
    const data = blankCharacterData('新角色');
    expect(CharacterDataSchema.safeParse(data).success).toBe(true);
    expect(characterIssues(data)).toEqual([]);
    // The three optional members are ABSENT rather than empty: "not set" is a fact the session
    // configuration reads differently from "set to empty".
    expect(data).not.toHaveProperty('sampling');
    expect(data).not.toHaveProperty('stExtensions');
    expect(data).not.toHaveProperty('customFields');
  });

  it('mints a v7 id for every row that needs one', () => {
    for (const row of [blankOutfit(), blankExpression()]) {
      expect(UUID_V7_PATTERN.test(row.id), row.id).toBe(true);
    }
    // A reference has no asset to point at yet, so its id starts empty and the validation panel
    // refuses it — the honest blank for a field whose pipeline does not exist (docs/06 §10.5).
    expect(blankReference()).toEqual({ assetId: '', role: 'face' });
  });

  it('adds, edits and removes an outfit without touching the original payload', () => {
    const base = blankCharacterData('w');
    const outfit = blankOutfit();
    const added = {
      ...base,
      visual: { ...base.visual, outfits: appendItem(base.visual.outfits, outfit) },
    };
    expect(added.visual.outfits).toHaveLength(1);
    const edited = {
      ...added,
      visual: {
        ...added.visual,
        outfits: withItem(added.visual.outfits, 0, { ...outfit, name: '斗篷' }),
      },
    };
    expect(edited.visual.outfits[0]?.name).toBe('斗篷');
    const emptied = {
      ...edited,
      visual: { ...edited.visual, outfits: removeItem(edited.visual.outfits, 0) },
    };
    expect(emptied.visual.outfits).toEqual([]);
    expect(base.visual.outfits).toEqual([]);
  });
});

/* ─────────────────────────── the enum tables ─────────────────────────────── */

describe('the enumeration tables', () => {
  it('covers the schema’s own unions, so an option can never be missing a sentence', () => {
    expect(Object.keys(SEED_POLICY_LABELS).sort()).toEqual(['fixed', 'increment', 'random']);
    expect(Object.keys(REFERENCE_ROLE_LABELS).sort()).toEqual(['face', 'outfit', 'style']);
    expect(Object.keys(REASONING_EFFORT_LABELS).sort()).toEqual([
      'high',
      'low',
      'medium',
      'minimal',
    ]);
  });

  it('narrows a select’s string to the union it came from', () => {
    expect(isSeedPolicy('fixed')).toBe(true);
    expect(isSeedPolicy('FIXED')).toBe(false);
    expect(isReferenceRole('style')).toBe(true);
    expect(isReferenceRole('')).toBe(false);
    expect(isReasoningEffort('high')).toBe(true);
    expect(isReasoningEffort('highest')).toBe(false);
  });
});

/* ────────────────────────────── validation ───────────────────────────────── */

describe('characterIssues', () => {
  it('accepts a complete card', () => {
    expect(characterIssues(fullCard)).toEqual([]);
  });

  it('names the field a range violation belongs to', () => {
    const data: CharacterData = { ...fullCard, voice: { ...fullCard.voice, desire: 200 } };
    const issues = characterIssues(data);
    expect(issues).toHaveLength(1);
    // The dotted path is the FACT; the sentence is the schema's (ADR-019's split).
    expect(issues[0]?.path).toBe('voice.desire');
    expect(issues[0]?.message).not.toBe('');
  });

  it('refuses an empty name, the one content constraint a card has', () => {
    expect(characterIssues({ ...fullCard, name: '' }).map((issue) => issue.path)).toEqual(['name']);
  });
});

/* ─────────────────────── the tolerant draft reader ───────────────────────── */

describe('completeCharacterData', () => {
  it('is total over a card that survived the JSON round trip', () => {
    const stored = toJson(fullCard);
    expect(completeCharacterData(blankCharacterData('base'), stored)).toEqual(fullCard);
  });

  it('falls back to the base when the stored payload is not an object at all', () => {
    const base = blankCharacterData('base');
    expect(completeCharacterData(base, undefined)).toBe(base);
    expect(completeCharacterData(base, 'nonsense')).toBe(base);
    expect(completeCharacterData(base, 3)).toBe(base);
  });

  it('takes a cleared field as an edit and falls back only for the wrong type', () => {
    const base: CharacterData = { ...blankCharacterData('base'), description: 'published' };
    const completed = completeCharacterData(base, {
      description: '',
      tags: ['a', 2],
      voice: { desire: 'high', ability: 10 },
      visual: { appearance: { hair: 5 }, style: 'not an object' },
    });
    expect(completed.description).toBe('');
    expect(completed.tags).toEqual(['a']);
    expect(completed.voice.desire).toBe(base.voice.desire);
    expect(completed.voice.ability).toBe(10);
    expect(completed.visual.appearance.hair).toBe(base.visual.appearance.hair);
    expect(completed.visual.style).toEqual(base.visual.style);
  });

  it('keeps both foreign bags verbatim, including a key this app cannot read', () => {
    const stored = toJson(fullCard);
    const completed = completeCharacterData(blankCharacterData('base'), stored);
    expect(completed.stExtensions).toEqual(fullCard.stExtensions);
    expect(completed.customFields).toEqual(fullCard.customFields);
    // A card that arrived without them must not GAIN empty ones.
    const bare = completeCharacterData(blankCharacterData('base'), {});
    expect(bare).not.toHaveProperty('stExtensions');
    expect(bare).not.toHaveProperty('customFields');
  });

  it('completes an optional sampling group member by member', () => {
    const base = blankCharacterData('base');
    const completed = completeCharacterData(base, {
      sampling: { temperature: 0.5, topP: 'warm', reasoningEffort: 'nonsense' },
    });
    expect(completed.sampling).toEqual({ temperature: 0.5 });
    // The whole group absent keeps the base's own group (here: none).
    expect(completeCharacterData(base, { name: 'x' })).not.toHaveProperty('sampling');
  });

  it('keeps a stored reference whose role is unreadable, defaulting to a face reference', () => {
    const completed = completeCharacterData(blankCharacterData('base'), {
      visual: { references: [{ assetId: 'a1', role: 'something-else' }, { assetId: 'a2' }, 7] },
    });
    expect(completed.visual.references).toEqual([
      { assetId: 'a1', role: 'face' },
      { assetId: 'a2', role: 'face' },
    ]);
  });

  it('reads a stored value that is not an object at all as absent', () => {
    expect(jsonObject(3)).toBeUndefined();
    const completed = completeCharacterData(blankCharacterData('base'), { stExtensions: 3 });
    expect(completed).not.toHaveProperty('stExtensions');
  });
});
