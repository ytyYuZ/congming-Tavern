/**
 * The character card JSON mapping (`docs/06` §2.6 M1-I1, `docs/01` F9-1 / F9-2).
 *
 * THE ACCEPTANCE IS "NO KEY FIELD LOST", SO THE KEY FIELDS ARE NAMED HERE
 * `KEY_FIELDS` below is the explicit list the round trip is asserted against —
 * `name`, `description`, `personality`, `scenario`, `first_mes`, `mes_example`,
 * `creator_notes`, `system_prompt`, `post_history_instructions`,
 * `alternate_greetings`, `tags`, `creator`, `character_version` — plus
 * `character_book`, which our entity has no field for and which therefore arrives as
 * data. The loop reports `{ field, value }` rather than a bare boolean, so a failure
 * names the field that broke instead of pointing at a helper.
 *
 * AND THE OTHER HALF OF "NO LOSS": everything the card carried and we do not model is
 * asserted to come back on export, verbatim, in `extensions`.
 */
import { type CharacterData, CharacterDataSchema, type VoiceProfile } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  exportStCharacterCardJson,
  importStCharacterCardJson,
  ST_CARD_BAG_KEY,
  ST_SMARTTAVERN_BUCKET,
} from '../sillytavern/character-card';
import { memberOf } from '../sillytavern/json';
import { ST_CARD_V1, ST_CARD_V2, ST_CARD_V2_DATA, ST_CARD_V3 } from '../testing/st-fixtures';
import { cardOf, codesOf, findingsOf, recordOf } from '../testing/st-harness';

/**
 * Every field the round trip must preserve, named one by one. `character_book` is
 * asserted separately because it is not a `CharacterData` field: it travels in the
 * reserved bag and comes back as `data.character_book`.
 */
const KEY_FIELDS = [
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
] as const;

/** The `data` member of an ST document. */
function dataOf(document: unknown): Record<string, unknown> {
  return recordOf(
    memberOf(recordOf(document, 'the exported card'), 'data'),
    'the exported card data',
  );
}

describe('SillyTavern character card JSON', () => {
  it('F9-1 a V2 card round-trips every key field and its character_book', () => {
    const first = importStCharacterCardJson(ST_CARD_V2);
    const card = cardOf(first);
    expect(first.ok).toBe(true);
    expect(first.specVersion).toBe(2);

    const again = exportStCharacterCardJson(card);
    expect(again.ok).toBe(true);
    const document = recordOf(again.value, 'the exported card');
    expect(memberOf(document, 'spec')).toBe('chara_card_v2');
    expect(memberOf(document, 'spec_version')).toBe('2.0');

    const exported = dataOf(again.value);
    for (const field of KEY_FIELDS) {
      expect({ field, value: exported[field] }).toEqual({
        field,
        value: ST_CARD_V2_DATA[field],
      });
    }
    expect({ field: 'character_book', value: memberOf(exported, 'character_book') }).toEqual({
      field: 'character_book',
      value: memberOf(ST_CARD_V2_DATA, 'character_book'),
    });

    // And the whole entity is stable through a SECOND import: export cannot have
    // dropped or rewritten anything the first import decided.
    const second = importStCharacterCardJson(again.value);
    expect(cardOf(second)).toEqual(card);
  });

  it('a V3 card keeps its V3-only members as data and writes them back', () => {
    const imported = importStCharacterCardJson(ST_CARD_V3);
    const card = cardOf(imported);
    expect(imported.specVersion).toBe(3);
    // Seven V3-only members (one finding each) plus the unknown member of MY bucket.
    expect(codesOf(imported).filter((code) => code === 'st-field-no-home')).toHaveLength(8);

    for (const field of ['nickname', 'source', 'group_only_greetings', 'assets']) {
      expect({
        field,
        reported: findingsOf(imported, 'st-field-no-home').some((finding) =>
          finding.detail.includes(field),
        ),
      }).toEqual({ field, reported: true });
    }

    const exported = exportStCharacterCardJson(card);
    expect(exported.specVersion).toBe(3);
    const data = dataOf(exported.value);
    for (const field of [
      'nickname',
      'creator_notes_multilingual',
      'source',
      'group_only_greetings',
      'creation_date',
      'modification_date',
      'assets',
    ]) {
      expect({ field, value: data[field] }).toEqual({
        field,
        value: recordOf(memberOf(ST_CARD_V3, 'data'), 'the V3 fixture data')[field],
      });
    }
    expect(cardOf(importStCharacterCardJson(exported.value))).toEqual(card);
  });

  it('a V1 card renames creatorcomment, defaults the V2 fields, and keeps its legacy members', () => {
    const imported = importStCharacterCardJson(ST_CARD_V1);
    const card = cardOf(imported);
    expect(imported.specVersion).toBe(1);
    expect(card.creator_notes).toBe('Legacy notes, from before the field was renamed.');
    expect(card.alternate_greetings).toEqual([]);
    expect(card.tags).toEqual([]);
    // ST has no equivalent for our own fields, so they are the neutral blank and the
    // import says so once.
    expect(codesOf(imported)).toContain('st-fields-defaulted');
    expect(card.voice.desire).toBe(50);

    // `avatar`, `talkativeness` and `fav` are V1 app fields with no home here.
    expect(codesOf(imported)).toContain('st-field-no-home');

    const exported = exportStCharacterCardJson(card);
    const document = recordOf(exported.value, 'the exported V1 card');
    expect(memberOf(document, 'spec')).toBeUndefined();
    expect(memberOf(document, 'creatorcomment')).toBe(card.creator_notes);
    for (const field of ['avatar', 'talkativeness', 'fav']) {
      expect({ field, value: document[field] }).toEqual({ field, value: ST_CARD_V1[field] });
    }
    expect(cardOf(importStCharacterCardJson(exported.value))).toEqual(card);
  });

  it('F9-2 the smarttavern bucket is split out and foreign extension keys survive verbatim', () => {
    const imported = importStCharacterCardJson(ST_CARD_V2);
    const card = cardOf(imported);
    const foreign = card.stExtensions ?? {};
    expect(memberOf(foreign, 'talkativeness')).toBe(0.6);
    expect(memberOf(foreign, 'depth_prompt')).toEqual({ depth: 4, prompt: 'Stay in character.' });
    // OUR bucket is not a foreign key: it becomes voice/visual/sampling.
    expect(foreign[ST_SMARTTAVERN_BUCKET]).toBeUndefined();
    expect(card.voice).toEqual({
      desire: 60,
      ability: 40,
      roles: ['lead'],
      maxLinesPerRound: 2,
      cooldown: 1,
    } satisfies VoiceProfile);
    expect(card.sampling?.temperature).toBe(0.9);
    // A member of the bucket that this build does not map is kept, and named.
    expect(
      findingsOf(imported, 'st-field-no-home').some(
        (finding) => finding.where === 'extensions.smarttavern.a-future-member',
      ),
    ).toBe(true);

    const exported = dataOf(exportStCharacterCardJson(card).value);
    const extensions = recordOf(memberOf(exported, 'extensions'), 'the exported extensions');
    expect(memberOf(extensions, 'talkativeness')).toBe(0.6);
    expect(memberOf(extensions, 'depth_prompt')).toEqual({
      depth: 4,
      prompt: 'Stay in character.',
    });
    expect(extensions[ST_SMARTTAVERN_BUCKET]).toEqual({
      'a-future-member': { why: 'a build that did not exist yet wrote this' },
      voice: card.voice,
      visual: card.visual,
      sampling: card.sampling,
    });
  });

  it('a field the mapper does not know survives as data and comes back on export', () => {
    const withExtra = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { ...ST_CARD_V2_DATA, future_field: { nested: [1, 2, 'three'] } },
    };
    const imported = importStCharacterCardJson(withExtra);
    expect(codesOf(imported)).toContain('st-field-no-home');
    expect(findingsOf(imported, 'st-field-no-home')[0]?.where).toBe('data.future_field');

    const exported = dataOf(exportStCharacterCardJson(cardOf(imported)).value);
    expect(memberOf(exported, 'future_field')).toEqual({ nested: [1, 2, 'three'] });
  });

  it('a present-but-unusable member is reported, and the documented default is used', () => {
    const messy = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        ...ST_CARD_V2_DATA,
        personality: 42,
        tags: 'solo',
        alternate_greetings: [{}, 'kept'],
        system_prompt: { not: 'text' },
      },
    };
    const imported = importStCharacterCardJson(messy);
    const card = cardOf(imported);
    expect(codesOf(imported)).toContain('st-field-coerced');
    expect(codesOf(imported)).toContain('st-field-invalid');
    expect(card.personality).toBe('42');
    expect(card.tags).toEqual(['solo']);
    expect(card.alternate_greetings).toEqual(['kept']);
    expect(card.system_prompt).toBe('');
  });

  it('an unknown spec version is a finding, not a throw, and produces no card', () => {
    const imported = importStCharacterCardJson({
      spec: 'chara_card_v9',
      spec_version: '9.0',
      data: ST_CARD_V2_DATA,
    });
    expect(imported.card).toBeUndefined();
    expect(imported.ok).toBe(false);
    expect(codesOf(imported)).toEqual(['st-unknown-spec-version']);

    // A major that disagrees with its own spec is refused the same way.
    const contradictory = importStCharacterCardJson({
      spec: 'chara_card_v2',
      spec_version: '3.0',
      data: ST_CARD_V2_DATA,
    });
    expect(codesOf(contradictory)).toContain('st-unknown-spec-version');
  });

  it('a newer MINOR of a spec we know is read leniently, with a warning', () => {
    const imported = importStCharacterCardJson({
      spec: 'chara_card_v2',
      spec_version: '2.1',
      data: ST_CARD_V2_DATA,
    });
    expect(imported.ok).toBe(true);
    expect(cardOf(imported).name).toBe('Bram the Lamplighter');
    const warning = findingsOf(imported, 'st-spec-version-newer');
    expect(warning).toHaveLength(1);
    expect(warning[0]?.severity).toBe('warning');
  });

  it('a card with no usable name is refused, and a data object with no spec is read as V2', () => {
    const nameless = importStCharacterCardJson({ ...ST_CARD_V1, name: '   ' });
    expect(nameless.card).toBeUndefined();
    expect(codesOf(nameless)).toContain('st-missing-name');

    const unspecced = importStCharacterCardJson({ data: ST_CARD_V2_DATA });
    expect(unspecced.ok).toBe(true);
    expect(unspecced.specVersion).toBe(2);
    // The note about the missing spec, plus the fixture's unmapped bucket member.
    expect(codesOf(unspecced)).toEqual(['st-spec-missing', 'st-field-no-home']);
  });

  it('a collision with the reserved bag key is refused rather than overwritten', () => {
    const imported = importStCharacterCardJson({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { ...ST_CARD_V2_DATA, extensions: { [ST_CARD_BAG_KEY]: 'somebody else' } },
    });
    expect(imported.card).toBeUndefined();
    expect(imported.ok).toBe(false);
    expect(codesOf(imported)).toEqual(['st-reserved-key-collision']);
  });

  it('exporting a payload that is not a valid CharacterData is refused with findings', () => {
    const card = cardOf(importStCharacterCardJson(ST_CARD_V2));
    const broken: CharacterData = { ...card, name: '' };
    expect(CharacterDataSchema.safeParse(broken).success).toBe(false);
    const exported = exportStCharacterCardJson(broken);
    expect(exported.value).toBeUndefined();
    expect(exported.ok).toBe(false);
    expect(codesOf(exported)).toContain('st-card-shape');
  });
});
