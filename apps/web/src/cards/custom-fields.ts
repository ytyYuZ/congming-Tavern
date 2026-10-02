/**
 * 自定义字段 — the user's own key/value fields on a world or character card (M1-W1 / M1-C1).
 *
 * WHERE THEY LIVE: THE PAYLOAD'S OWN RECORD
 * `WorldData.customFields` (required, `Record<string, string>`) and `CharacterData.customFields`
 * (optional, the same shape), both listed in `docs/02` §4 beside the fields they belong to. That
 * makes them DOMAIN data, so `common.ts` rule 1 — "third-party data goes in the entity's
 * `extensions` bag" — does not apply to them. The distinction is not cosmetic: `extensions` is the
 * PLUGIN namespace, and a user field parked under `x-custom.*` is indistinguishable from plugin
 * state to anything that iterates the bag, which means a plugin could read or rewrite the author's
 * own notes. One channel per owner: the payload's record for the user, `extensions` for plugins.
 *
 * WHY THE KEY IS THE LABEL, VERBATIM
 * A record keyed by the author's own wording needs no slug: `HP 上限` and `魔法体系` are ordinary
 * keys here. Two rules are all this module adds on top of "a string map": a BLANK label names
 * nothing and is refused, and a DUPLICATE label would silently overwrite the field it collides
 * with, so it is refused too. The consequence is stated rather than hidden — renaming a field is a
 * delete plus an add, because the key IS the field's identity (the same rule `play.tsx`'s
 * `VariableRow` follows for a variable name).
 *
 * LEGACY: `x-custom.*` IN THE VERSION ENVELOPE'S `extensions` (a read-time fold)
 * One earlier iteration of this editor wrote user fields into the envelope's plugin bag as
 * `x-custom.<slug>` → `{label, value}` (or a bare string). `foldLegacyCustomFields` moves those
 * entries into the payload record when a card is OPENED and takes them out of the bag, so the next
 * publish does not carry them forever. It is a repair at the READ boundary with no `migrations`
 * row, which is the same shape `db/repository.ts`'s `completeState` uses: the mapping is derivable
 * from the stored value, and the next write persists it naturally. Everything that is NOT
 * `x-custom.*` is left byte-for-byte where it was — that is a plugin's data, not this editor's.
 */
import type { Extensions } from '@smarttavern/schema';
import { asOptionalString, jsonObject } from './fields';

/** One custom field, as the panel renders it: the key the user typed, and its text. */
export interface CustomField {
  /** The label the user typed. It IS the record key (`docs/02` §4's `customFields`). */
  readonly label: string;
  /** The field's text. Empty is a legal value. */
  readonly value: string;
}

/** The namespace the legacy iteration used. Read-only now: nothing writes it any more. */
export const LEGACY_CUSTOM_FIELD_PREFIX = 'x-custom.';

/** A record's entries, in insertion order, as renderable fields. */
export function customFieldsOf(
  fields: Readonly<Record<string, string>> | undefined,
): readonly CustomField[] {
  return Object.entries(fields ?? {}).map(([label, value]) => ({ label, value }));
}

/**
 * Add one field, or answer `undefined` when the label cannot name one.
 *
 * The label is TRIMMED and the trimmed form is the key, so `'hp '` and `'hp'` are one field rather
 * than two nobody can tell apart. The value is stored as given, including `''` — an empty value is
 * a field the user has not filled in yet, not a reason to refuse the row.
 */
export function withCustomField(
  fields: Readonly<Record<string, string>> | undefined,
  label: string,
  value: string,
): Record<string, string> | undefined {
  const key = label.trim();
  if (key === '') return undefined;
  const current = fields ?? {};
  if (Object.hasOwn(current, key)) return undefined;
  return Object.assign({ ...current }, { [key]: value });
}

/** Rewrite one field's text. The label is the row's identity and does not move. */
export function withCustomFieldValue(
  fields: Readonly<Record<string, string>> | undefined,
  label: string,
  value: string,
): Record<string, string> {
  return Object.assign({ ...(fields ?? {}) }, { [label]: value });
}

/** Remove one field, keeping every other key. */
export function withoutCustomField(
  fields: Readonly<Record<string, string>> | undefined,
  label: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [existing, value] of Object.entries(fields ?? {})) {
    if (existing !== label) next[existing] = value;
  }
  return next;
}

/**
 * The payload record plus whatever a legacy `x-custom.*` bag still holds.
 *
 * `customFields` is `undefined` when the payload had no record AND the bag held nothing to move —
 * an absent optional member stays absent (the same rule `cards/character.ts` follows for
 * `sampling`), while an EMPTY record that was there stays a record.
 *
 * Two decisions inside, both deliberate:
 * - the PAYLOAD WINS: a legacy entry whose label already exists in the record is dropped, because
 *   the record is the channel the user edits now and silently overwriting it would undo an edit;
 * - a legacy value this module cannot read (a number, an array) is LEFT IN THE BAG rather than
 *   turned into a field: it is not something the user typed into a text box, and guessing would
 *   invent content.
 */
export function foldLegacyCustomFields(
  fields: Readonly<Record<string, string>> | undefined,
  extensions: Extensions | undefined,
): { readonly customFields: Record<string, string> | undefined; readonly extensions: Extensions } {
  const collected: Record<string, string> = { ...(fields ?? {}) };
  const remaining: Extensions = {};
  for (const [key, value] of Object.entries(extensions ?? {})) {
    if (!key.startsWith(LEGACY_CUSTOM_FIELD_PREFIX)) {
      remaining[key] = value;
      continue;
    }
    const stored = jsonObject(value);
    const fallbackLabel = key.slice(LEGACY_CUSTOM_FIELD_PREFIX.length);
    const label =
      stored === undefined ? fallbackLabel : (asOptionalString(stored, 'label') ?? fallbackLabel);
    const text =
      stored === undefined
        ? typeof value === 'string'
          ? value
          : undefined
        : (asOptionalString(stored, 'value') ?? '');
    if (text === undefined) {
      // Readable as a plugin's value but not as one of the user's fields: keep it where it is.
      remaining[key] = value;
      continue;
    }
    if (!Object.hasOwn(collected, label)) collected[label] = text;
  }
  const empty = Object.keys(collected).length === 0;
  return {
    customFields: empty && fields === undefined ? undefined : collected,
    extensions: remaining,
  };
}
