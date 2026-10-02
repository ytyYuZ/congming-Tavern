/**
 * 自定义字段 — the payload's own `customFields` record (M1-W1 / M1-C1).
 *
 * WHAT THIS FILE IS DEFENDING
 * 1. THE CHANNEL: user fields live in `data.customFields`, and the rules around them are two — a
 *    blank label names nothing and a duplicate would overwrite the field it collides with. Neither
 *    is a slug problem: `HP 上限` and `魔法体系` are ordinary record keys, and the test says so,
 *    because the whole point of the record is that the author's wording IS the key.
 * 2. THE LEGACY FOLD is a read-time repair with three properties that matter: a `x-custom.*` entry
 *    moves into the record, a NON-legacy `x-` key does not move at all (that is a plugin's data),
 *    and the record WINS when both name the same field — otherwise re-opening a card could undo an
 *    edit the user just made.
 * 3. An absent optional record stays absent: `CharacterData.customFields` is optional, and a card
 *    that never had one must not gain `{}` from a read.
 */
import type { Extensions } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import {
  customFieldsOf,
  foldLegacyCustomFields,
  LEGACY_CUSTOM_FIELD_PREFIX,
  withCustomField,
  withCustomFieldValue,
  withoutCustomField,
} from './custom-fields';
import { jsonObject, toJson } from './fields';

describe('the payload record', () => {
  it('reads the entries as fields, in insertion order', () => {
    expect(customFieldsOf({ 天气: '暴雪', hp: '120' })).toEqual([
      { label: '天气', value: '暴雪' },
      { label: 'hp', value: '120' },
    ]);
    expect(customFieldsOf({})).toEqual([]);
    expect(customFieldsOf(undefined)).toEqual([]);
  });

  it('adds a field under the label VERBATIM — no slug, whatever the author typed', () => {
    let fields = withCustomField(undefined, 'HP 上限', '120');
    expect(fields).toEqual({ 'HP 上限': '120' });
    fields = withCustomField(fields, '魔法体系', '潮汐');
    expect(fields).toEqual({ 'HP 上限': '120', 魔法体系: '潮汐' });
    // The record is plain JSON, which is what the draft row stores it as.
    expect(jsonObject(toJson(fields))).toEqual(fields);
  });

  it('trims the label into the key, so one field cannot have two spellings', () => {
    const fields = withCustomField(undefined, '  hp  ', '10');
    expect(fields).toEqual({ hp: '10' });
    expect(withCustomField(fields, 'hp', '20')).toBeUndefined();
  });

  it('refuses a blank label and a duplicate, before anything is written', () => {
    expect(withCustomField(undefined, '', '10')).toBeUndefined();
    expect(withCustomField(undefined, '   ', '10')).toBeUndefined();
    const once = withCustomField(undefined, 'mana', '10');
    expect(withCustomField(once, 'mana', '20')).toBeUndefined();
  });

  it('lets a field be empty: a value not typed yet is not a refusal', () => {
    expect(withCustomField(undefined, '待填', '')).toEqual({ 待填: '' });
  });

  it('edits and removes one field without moving the others', () => {
    const fields = { a: '1', b: '2' };
    expect(withCustomFieldValue(fields, 'b', '20')).toEqual({ a: '1', b: '20' });
    expect(withoutCustomField(fields, 'a')).toEqual({ b: '2' });
    // The input record is what a row may already hold: nothing here mutates it.
    expect(fields).toEqual({ a: '1', b: '2' });
  });
});

describe('the legacy x-custom.* fold', () => {
  const legacy: Extensions = {
    'x-custom.hp-u4e0a-u9650': { label: 'HP 上限', value: '120' },
    'x-custom.mana': { label: 'mana', value: '10' },
    'x-mythos.sanity': 9,
  };

  it('moves the legacy entries into the record, under the label they stored', () => {
    const folded = foldLegacyCustomFields(undefined, legacy);
    expect(folded.customFields).toEqual({ 'HP 上限': '120', mana: '10' });
    // ...and takes them OUT of the bag, so the next publish does not carry them forever.
    expect(folded.extensions).toEqual({ 'x-mythos.sanity': 9 });
  });

  it('leaves every non-legacy key exactly where it was', () => {
    const folded = foldLegacyCustomFields(undefined, { 'x-mythos.sanity': 9, 'x-other.a': 'b' });
    expect(folded.customFields).toBeUndefined();
    expect(folded.extensions).toEqual({ 'x-mythos.sanity': 9, 'x-other.a': 'b' });
  });

  it('reads the old bare-string spelling too, using the slug as the label', () => {
    const folded = foldLegacyCustomFields(undefined, { 'x-custom.plain': 'raw' });
    expect(folded.customFields).toEqual({ plain: 'raw' });
    expect(folded.extensions).toEqual({});
  });

  it('lets the RECORD win, so a legacy entry cannot undo an edit', () => {
    const folded = foldLegacyCustomFields({ mana: '999' }, legacy);
    expect(folded.customFields).toEqual({ mana: '999', 'HP 上限': '120' });
  });

  it('keeps a legacy value it cannot read as a field in the bag rather than guessing', () => {
    // A number under the namespace is not something a text box produced, so it stays where it is.
    const folded = foldLegacyCustomFields(undefined, { 'x-custom.number': 3 });
    expect(folded.customFields).toBeUndefined();
    expect(folded.extensions).toEqual({ 'x-custom.number': 3 });
  });

  it('keeps an absent optional record absent, and a present empty one present', () => {
    expect(foldLegacyCustomFields(undefined, undefined).customFields).toBeUndefined();
    expect(foldLegacyCustomFields(undefined, {}).customFields).toBeUndefined();
    expect(foldLegacyCustomFields({}, undefined).customFields).toEqual({});
  });

  it('exposes the prefix it reads, so a reader can see the namespace is single', () => {
    expect(LEGACY_CUSTOM_FIELD_PREFIX).toBe('x-custom.');
    for (const key of Object.keys(legacy)) {
      expect(key.startsWith(LEGACY_CUSTOM_FIELD_PREFIX)).toBe(key.includes('custom'));
    }
  });
});
