/**
 * 自定义字段 ↔ the version envelope's `extensions` bag (M1-W1 / M1-C1).
 *
 * WHAT THIS FILE IS DEFENDING
 * 1. The KEY DERIVATION is total and legal: whatever a user types, the minted key must satisfy
 *    `ExtensionsSchema`'s pattern — including a Chinese label, which cannot be a key at all
 *    (`common.ts` rule 1, and the reason this module exists).
 * 2. The LABEL survives: it is stored beside the value, so the editor can show what the author
 *    wrote rather than a slug it invented.
 * 3. A foreign key in the same bag is another owner's data — read past, and preserved when this
 *    editor writes.
 */
import { ExtensionKeySchema, ExtensionsSchema } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_PREFIX,
  customFieldKey,
  customFieldsOf,
  slugOf,
  withCustomField,
  withCustomFieldValue,
  withoutCustomField,
} from './extensions';
import { jsonObject, toJson } from './fields';

describe('slugOf', () => {
  it('keeps ASCII letters and digits, and folds the separators', () => {
    expect(slugOf('Foo Bar')).toBe('foo-bar');
    expect(slugOf('  hp  ')).toBe('hp');
    expect(slugOf('hp_max')).toBe('hp-max');
    expect(slugOf('a--b')).toBe('a-b');
  });

  it('encodes a character it cannot keep, so two labels cannot collide by accident', () => {
    expect(slugOf('HP 上限')).toBe('hp-u4e0a-u9650');
    expect(slugOf('魔法体系')).toBe('u9b54-u6cd5-u4f53-u7cfb');
    expect(slugOf('魔法体系')).not.toBe(slugOf('魔法體'));
  });

  it('answers an empty slug only for a label that is all separators', () => {
    expect(slugOf('---')).toBe('');
    expect(slugOf('   ')).toBe('');
    // Punctuation is ENCODED rather than dropped — the slug stays a pure function of the label —
    // and refusing a label that cannot NAME a field is `customFieldKey`'s job (see below).
    expect(slugOf('??')).toBe('u3f-u3f');
  });
});

describe('customFieldKey', () => {
  it('mints a key the schema itself accepts', () => {
    for (const label of ['Foo Bar', 'HP 上限', '魔法体系', '1', 'x-y']) {
      const key = customFieldKey(label);
      expect(key, label).toBeDefined();
      expect(ExtensionKeySchema.safeParse(key).success, `${label} -> ${String(key)}`).toBe(true);
      expect(key?.startsWith(CUSTOM_FIELD_PREFIX), label).toBe(true);
    }
  });

  it('refuses a label that cannot name a field', () => {
    expect(customFieldKey('??')).toBeUndefined();
    expect(customFieldKey('   ')).toBeUndefined();
  });
});

describe('the custom-field bag', () => {
  it('adds a field with its label stored beside its value', () => {
    const extensions = withCustomField(undefined, 'HP 上限', '120');
    expect(extensions).toEqual({ 'x-custom.hp-u4e0a-u9650': { label: 'HP 上限', value: '120' } });
    expect(ExtensionsSchema.safeParse(extensions).success).toBe(true);
    expect(customFieldsOf(extensions)).toEqual([
      { key: 'x-custom.hp-u4e0a-u9650', label: 'HP 上限', value: '120' },
    ]);
  });

  it('refuses a duplicate label and a label with no letters or digits', () => {
    const once = withCustomField(undefined, 'mana', '10');
    expect(withCustomField(once, 'mana', '20')).toBeUndefined();
    expect(withCustomField(once, 'MANA', '20')).toBeUndefined();
    expect(withCustomField(once, '??', '20')).toBeUndefined();
  });

  it('keeps another owner’s keys when it adds, edits and removes', () => {
    const foreign = { 'x-mythos.sanity': 9 };
    const added = withCustomField(foreign, 'mana', '10');
    expect(added?.['x-mythos.sanity']).toBe(9);
    const edited = withCustomFieldValue(added, 'x-custom.mana', 'mana', '20');
    expect(edited['x-mythos.sanity']).toBe(9);
    expect(customFieldsOf(edited)).toEqual([{ key: 'x-custom.mana', label: 'mana', value: '20' }]);
    const removed = withoutCustomField(edited, 'x-custom.mana');
    expect(removed).toEqual(foreign);
  });

  it('reads a foreign-shaped entry instead of dropping it or throwing', () => {
    // A plain string, an object without both members, and a number: three shapes another writer
    // could legitimately have left under this namespace.
    const extensions = {
      'x-custom.plain': 'raw',
      'x-custom.partial': { label: 'Named' },
      'x-custom.number': 3,
      'x-other.thing': 'not ours',
    };
    expect(customFieldsOf(extensions)).toEqual([
      { key: 'x-custom.plain', label: 'plain', value: 'raw' },
      { key: 'x-custom.partial', label: 'Named', value: '' },
    ]);
    expect(customFieldsOf(undefined)).toEqual([]);
  });

  it('survives the JSON boundary the draft row stores it through', () => {
    const extensions = withCustomField(undefined, '魔法体系', '潮汐');
    const stored = jsonObject(toJson(extensions));
    expect(customFieldsOf(stored)).toEqual([
      { key: 'x-custom.u9b54-u6cd5-u4f53-u7cfb', label: '魔法体系', value: '潮汐' },
    ]);
  });
});
