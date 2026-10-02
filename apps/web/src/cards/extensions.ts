/**
 * 自定义字段 — the user-authored extra fields of a world or character card (M1-W1 / M1-C1).
 *
 * WHERE THEY LIVE, AND WHY IT IS `extensions` AND NOWHERE ELSE
 * `common.ts` rule 1 makes an entity's `extensions` bag the ONLY sanctioned channel for data
 * a plugin (or this app) adds outside the domain fields, and it puts that bag on the VERSION
 * ENVELOPE (`versioning.ts`'s `versionedEntity`) so plugin data can never collide with a
 * domain field. So a custom field is an entry of `WorldVersion.extensions` /
 * `CharacterVersion.extensions` — never an ad-hoc record hung on the version row.
 *
 * WHY A LABEL CANNOT BE THE KEY, AND WHAT IS WRITTEN INSTEAD
 * `EXTENSION_KEY_PATTERN` accepts `x-<namespace>` plus dot-separated `[a-z0-9-]` segments, so
 * the label the user types (`HP 上限`, `魔法体系`, `isPlayer`) is NOT a legal key. This module
 * therefore MINTS one: the label is slugged into `x-custom.<slug>` and the label itself is
 * kept in the VALUE (`{label, value}`), so a field renamed in a later session is a delete plus
 * an add (the identity is the key — the same rule `play.tsx`'s `VariableRow` states for a
 * variable name) and nothing about the user's wording is lost or silently re-slugged.
 *
 * A non-ASCII character becomes `-u<code point in hex>`, which keeps the derivation a pure,
 * collision-resistant function of the label for Chinese labels as well as Latin ones. A label
 * with no letter or digit at all (`"??"`) has no key and is REFUSED by the editor rather than
 * given an invented one.
 *
 * WHAT IS DELIBERATELY NOT HERE: nothing reads or writes `data.customFields`. That payload
 * field is part of the frozen `WorldData` / `CharacterData` contract and is CARRIED THROUGH
 * hydration untouched (an imported world may have one), but this app's own custom fields use
 * the one channel above. See the finding recorded in `cards/draft.ts`.
 */
import { ExtensionKeySchema, type Extensions, type JsonValue } from '@smarttavern/schema';
import { asOptionalString, jsonObject } from './fields';

/** The namespace every custom field of this editor lives under. */
export const CUSTOM_FIELD_PREFIX = 'x-custom.';

/** One custom field, as the editor renders it. `key` is what is stored; `label` is shown. */
export interface CustomField {
  /** The `extensions` key (`x-custom.<slug>`), i.e. the field's identity. */
  readonly key: string;
  /** The label the user typed, kept in the stored value. */
  readonly label: string;
  /** The field's text. Empty is a legal value. */
  readonly value: string;
}

/** ASCII letters and digits survive as themselves; everything else is encoded. */
const ASCII_ALNUM = /[a-z0-9]/;

/**
 * A label must contain at least one LETTER OR DIGIT, in any script.
 *
 * WHY THE CHECK IS UNICODE-WIDE AND NOT ASCII: the label is the author's own wording, and for
 * this project that usually means Chinese — `魔法体系` is a perfectly good field name whose slug
 * is a string of code points. A label of pure punctuation (`??`) or pure whitespace names
 * nothing, and an invented key for it would collide with the next such label.
 */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The `[a-z0-9-]` half of an extension key derived from `label`.
 *
 * Pure and total: runs of separators collapse and leading/trailing `-` are trimmed, so two
 * spellings of the same name (`Foo  Bar`, `foo--bar`) are ONE key rather than two fields nobody
 * can tell apart. A label that is all separators answers `''`, which `customFieldKey` refuses.
 */
export function slugOf(label: string): string {
  let slug = '';
  for (const character of label.trim().toLowerCase()) {
    if (ASCII_ALNUM.test(character)) slug += character;
    else if (character === '-' || character === '_' || character === ' ') slug += '-';
    // `codePointAt(0)` is defined for a character produced by iteration; the `?? 0` keeps the
    // function total for a lone surrogate, which `for…of` can hand over.
    else slug += `-u${(character.codePointAt(0) ?? 0).toString(16)}`;
  }
  return slug.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The `extensions` key a label is stored under, or `undefined` when the label cannot have one.
 *
 * The minted key is validated against the schema's own pattern before it is returned: a key this
 * app writes must be a key `ExtensionsSchema` accepts, and checking that here is what makes the
 * writer's output a reader's input by construction rather than by luck.
 */
export function customFieldKey(label: string): string | undefined {
  const trimmed = label.trim();
  if (!HAS_LETTER_OR_DIGIT.test(trimmed)) return undefined;
  const slug = slugOf(trimmed);
  if (slug === '') return undefined;
  const key = `${CUSTOM_FIELD_PREFIX}${slug}`;
  return ExtensionKeySchema.safeParse(key).success ? key : undefined;
}

/**
 * Every custom field in an `extensions` bag, in insertion order.
 *
 * TOLERANT ON THE WAY IN (the `completeState` precedent): a value written by somebody else
 * under this namespace — a plain string, an object without both members — renders as a field
 * with a best-effort label instead of being dropped or throwing. Keys outside `x-custom.` are
 * other people's data and are simply not this function's business (the editor leaves them in
 * the bag when it writes a field back).
 */
export function customFieldsOf(extensions: Extensions | undefined): readonly CustomField[] {
  if (extensions === undefined) return [];
  const fields: CustomField[] = [];
  for (const [key, value] of Object.entries(extensions)) {
    if (!key.startsWith(CUSTOM_FIELD_PREFIX)) continue;
    const label = key.slice(CUSTOM_FIELD_PREFIX.length);
    if (typeof value === 'string') {
      fields.push({ key, label, value });
      continue;
    }
    const stored = jsonObject(value);
    if (stored === undefined) continue;
    fields.push({
      key,
      label: asOptionalString(stored, 'label') ?? label,
      value: asOptionalString(stored, 'value') ?? '',
    });
  }
  return fields;
}

/**
 * Add one custom field, or answer `undefined` when the label cannot name one.
 *
 * A label whose key already exists is REFUSED rather than merged: two fields with one key
 * cannot both exist, and the honest way to rename is to delete and add — which is also what
 * keeps the derivation a pure function of the label instead of a counter that would make the
 * stored key depend on the order fields were created in.
 */
export function withCustomField(
  extensions: Extensions | undefined,
  label: string,
  value: string,
): Extensions | undefined {
  const key = customFieldKey(label);
  if (key === undefined) return undefined;
  const current = extensions ?? {};
  if (Object.hasOwn(current, key)) return undefined;
  return Object.assign({ ...current }, { [key]: { label: label.trim(), value } });
}

/** Rewrite one field's value, keeping the label stored beside it. */
export function withCustomFieldValue(
  extensions: Extensions | undefined,
  key: string,
  label: string,
  value: string,
): Extensions {
  const current = extensions ?? {};
  const stored: JsonValue = { label, value };
  return Object.assign({ ...current }, { [key]: stored });
}

/**
 * Remove one custom field. Every OTHER key of the bag is kept, including the ones this
 * module does not own: the bag belongs to the entity, not to the editor.
 */
export function withoutCustomField(extensions: Extensions | undefined, key: string): Extensions {
  const next: Extensions = {};
  for (const [existing, value] of Object.entries(extensions ?? {})) {
    if (existing !== key) next[existing] = value;
  }
  return next;
}
