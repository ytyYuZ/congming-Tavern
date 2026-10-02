/**
 * The DRAFT — what M1-W1 / M1-C1's autosave persists, and why that is not a version (ADR-010).
 *
 * THE CONTRACT QUESTION THIS FILE ANSWERS
 * A `WorldVersion` / `CharacterVersion` row is immutable: `versioning.ts` and `docs/02` §7 make
 * an edit a NEW version, so no autosave may ever write one in place. Autosave therefore writes a
 * DRAFT — a single mutable row that holds exactly what the editor is showing — and a new version
 * is committed by an EXPLICIT act (「发布新版本」, `state/content-store.ts`'s `publishWorld` /
 * `publishCharacter`). Leaving the editor does not commit anything: the draft is still there on
 * the next visit, and the published versions are exactly the ones that were published. That is
 * the whole design, and `cards/draft.test.ts` plus `state/content-store.test.ts` pin both halves
 * of it (a draft edit moves only the draft; a publish leaves the old version row byte-identical).
 *
 * WHERE A DRAFT LIVES, AND WHY THERE
 * In the `settings` collection, under `draft.world.<id>` / `draft.character.<id>` — the same
 * `(id, value)` shape as every other local preference (`docs/02` §7 已用的配置键, ADR-022). The
 * eighteen collections are frozen verbatim by ADR-022, a draft is not a domain entity, and the
 * port already addresses a settings row BY KEY, so this costs no schema change and no migration.
 * A draft row is disposable: `clearWorldDraft` / `clearCharacterDraft` delete it and the editor
 * falls back to the published version, which is what makes 「放弃草稿」 an act rather than a hope.
 *
 * WHY THE ROW RECORDS `baseVersion`
 * It is the version the draft was EDITED FROM, and it is the lineage anchor a publish records
 * (`cards/versions.ts`). Storing it means the anchor survives a reload, so a draft that was
 * started from v2 and published after another tab reached v4 still says truthfully where its
 * content came from instead of guessing "the head minus one".
 *
 * WHY `data` IS UNVALIDATED
 * A draft is a half-typed form: `name: ''` is a state autosave must keep, and `WorldDataSchema`
 * refuses it. So the reader completes the stored payload field by field against the version it
 * was based on (`completeWorldData` / `completeCharacterData`) instead of validating it — a
 * wholly unreadable row is treated as ABSENT (the editor falls back to the published version,
 * the `readLocaleSetting` precedent) and a damaged member falls back on its own.
 */
import {
  type CharacterData,
  type CharacterVersion,
  ExtensionKeySchema,
  type Extensions,
  type JsonValue,
  type VersionNumber,
  type WorldData,
  type WorldVersion,
} from '@smarttavern/schema';
import { completeCharacterData } from './character';
import { foldLegacyCustomFields } from './custom-fields';
import { asNumber, jsonObject, memberValue, toJson } from './fields';
import { completeWorldData } from './world';

/** A world as the editor holds it: the payload plus the version envelope's plugin bag. */
export interface WorldDraft {
  /** The version this draft was edited from; the lineage anchor a publish records. */
  readonly baseVersion: VersionNumber;
  readonly data: WorldData;
  readonly extensions: Extensions;
}

export interface CharacterDraft {
  readonly baseVersion: VersionNumber;
  readonly data: CharacterData;
  readonly extensions: Extensions;
}

/**
 * The draft a published version would show if no draft row exists — the editor's fallback.
 *
 * It also folds a legacy `x-custom.*` bag into the payload record on the way (`custom-fields.ts`),
 * so a card whose user fields are still in the envelope opens with them visible and the next
 * publish persists them in the right place.
 */
export function worldDraftOf(version: WorldVersion): WorldDraft {
  const folded = foldLegacyCustomFields(version.data.customFields, version.extensions);
  return {
    baseVersion: version.version,
    data: { ...version.data, customFields: folded.customFields ?? {} },
    extensions: folded.extensions,
  };
}

export function characterDraftOf(version: CharacterVersion): CharacterDraft {
  const folded = foldLegacyCustomFields(version.data.customFields, version.extensions);
  return {
    baseVersion: version.version,
    data: {
      ...version.data,
      ...(folded.customFields === undefined ? {} : { customFields: folded.customFields }),
    },
    extensions: folded.extensions,
  };
}

/**
 * The `extensions` bag of a stored draft, keeping only keys the schema would accept.
 *
 * A key that is not `x-` namespaced cannot be written back (the payload's own `extensions` is
 * the version envelope's, and `ExtensionsSchema` would refuse the whole row), so a damaged entry
 * is DROPPED here rather than carried into a draft that could never be published. Everything
 * else — including the foreign keys a plugin owns, and the legacy `x-custom.*` entries the fold
 * still has to look at — is kept verbatim, because the bag belongs to the entity, not to us.
 */
function extensionsOf(member: JsonValue | undefined): Extensions {
  const extensions: Extensions = {};
  for (const [key, value] of Object.entries(jsonObject(member) ?? {})) {
    if (ExtensionKeySchema.safeParse(key).success) extensions[key] = value;
  }
  return extensions;
}

/** The stored form of a draft: JSON by construction, so the row is a `JsonValue`. */
export function worldDraftValue(draft: WorldDraft): JsonValue {
  return {
    baseVersion: draft.baseVersion,
    data: toJson(draft.data),
    extensions: toJson(draft.extensions),
  };
}

export function characterDraftValue(draft: CharacterDraft): JsonValue {
  return {
    baseVersion: draft.baseVersion,
    data: toJson(draft.data),
    extensions: toJson(draft.extensions),
  };
}

/** A stored `baseVersion`, or the base it was read against when the member is unusable. */
function baseVersionOf(
  source: { [key: string]: JsonValue },
  fallback: VersionNumber,
): VersionNumber {
  const stored = asNumber(source, 'baseVersion', fallback);
  return Number.isInteger(stored) && stored > 0 ? stored : fallback;
}

/**
 * Read a stored world draft, or `undefined` when the row holds nothing usable.
 *
 * `base` is the version the draft is completed against — the latest published one, which is the
 * only version an editor opens with. `undefined` means "there is no draft", i.e. the editor shows
 * the published payload, which is also what an unreadable row degrades to.
 *
 * The legacy fold runs AFTER completion, and the order is the rule: the draft's own
 * `data.customFields` wins over anything the old bag still holds, so re-opening a half-edited card
 * cannot have a stale slug overwrite the field the user just typed.
 */
export function readWorldDraft(
  value: JsonValue | undefined,
  base: WorldVersion,
): WorldDraft | undefined {
  const stored = jsonObject(value);
  if (stored === undefined) return undefined;
  const data = completeWorldData(base.data, memberValue(stored, 'data'));
  const folded = foldLegacyCustomFields(
    data.customFields,
    extensionsOf(memberValue(stored, 'extensions')),
  );
  return {
    baseVersion: baseVersionOf(stored, base.version),
    data: { ...data, customFields: folded.customFields ?? {} },
    extensions: folded.extensions,
  };
}

export function readCharacterDraft(
  value: JsonValue | undefined,
  base: CharacterVersion,
): CharacterDraft | undefined {
  const stored = jsonObject(value);
  if (stored === undefined) return undefined;
  const data = completeCharacterData(base.data, memberValue(stored, 'data'));
  const folded = foldLegacyCustomFields(
    data.customFields,
    extensionsOf(memberValue(stored, 'extensions')),
  );
  return {
    baseVersion: baseVersionOf(stored, base.version),
    data: {
      ...data,
      ...(folded.customFields === undefined ? {} : { customFields: folded.customFields }),
    },
    extensions: folded.extensions,
  };
}
