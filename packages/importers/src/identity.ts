/**
 * The identity policy of an import — `docs/04` §7's ID conflict table, §12 items
 * 9, 10 and 12.
 *
 * THE THREE ANSWERS, AND WHAT EACH ONE COSTS
 *
 *   create  the package entity is unknown here → write it under its OWN id.
 *   reuse   the same content is already here → write NOTHING and point at the
 *           existing row. This is what makes a second import of the same package
 *           create zero rows (item 9).
 *   remap   the package id (or, for a named entity, the name) is taken by
 *           DIFFERENT content → mint a new id, record where it came from, and
 *           leave the local row untouched (item 10, §7's "不静默覆盖"). The new
 *           row records the package id in `extensions` so the report can explain
 *           it and a re-import can find it again (see the provenance rule below).
 *
 * WHERE THE PROVENANCE GOES, AND WHY `extensions` IS THE RIGHT CHANNEL
 * `packages/schema/src/common.ts` rule 1: `extensions` is the ONLY sanctioned
 * place for data the core schema does not define, and every key must start
 * `x-<namespace>`. `originId` / `importedFrom` are exactly that — provenance this
 * importer adds, not a domain field — so they go there and nowhere else. The
 * spelling is `x-smarttavern.origin-id`, NOT `x-smarttavern.originId`: the key
 * pattern in `common.ts` allows `[a-z0-9-]` per dot-separated segment, so the
 * camelCase spelling §7 uses in prose cannot be a key at all. `smarttavern` is the
 * core's own namespace; a plugin must use its own.
 *
 * WHY THE REUSE CHECK ALSO LOOKS AT `originId`
 * Once a row has been remapped its id no longer equals the package's id. A second
 * import of the same package would then see "id free, but the name is taken by
 * different content" and remap AGAIN — one duplicate per import, which is exactly
 * what item 9 forbids. So an incoming entity also matches a local row that records
 * this package id as its origin. That is the whole reason the provenance is stored
 * and not merely reported.
 *
 * THE DECISION IS PURE AND TABLE-TESTABLE: the caller hands in the package entity
 * and a flat list of "local rows" (one entry per comparable local content — a
 * versioned entity contributes one per version), and gets one of the three answers
 * with a stable reason token.
 */
import type { Extensions } from '@smarttavern/schema';
import { deepEqual } from './deep-equal';

/* ──────────────────────────── provenance channel ─────────────────────────── */

/**
 * The two extension keys an import writes. `origin-id` holds the id the entity had
 * INSIDE THE PACKAGE (the owner id for a versioned entity: `worldId` /
 * `characterId`); `imported-from` the package's own manifest id.
 */
export const IMPORT_EXTENSION_KEYS = {
  originId: 'x-smarttavern.origin-id',
  importedFrom: 'x-smarttavern.imported-from',
} as const;

/** Read the recorded origin id, if this row carries one. */
export function originIdOf(row: { readonly extensions?: Extensions }): string | undefined {
  const value = row.extensions?.[IMPORT_EXTENSION_KEYS.originId];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The row with the importer's own extension keys removed — the value that may be
 * compared against an incoming package entity.
 *
 * WHY STRIPPING IS MANDATORY: after a remap the stored row carries two keys the
 * package entity does not have, so comparing raw rows would call every remapped
 * row "different content" forever and each import would mint another duplicate. An
 * `extensions` object emptied by the strip is REMOVED rather than left as `{}`, so
 * a row that never had extensions compares equal to one that only ever had
 * provenance.
 *
 * The input is never mutated: the result is a structural copy.
 */
export function stripImportExtensions<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item));
  if (value === null || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === 'extensions') {
      const cleaned = stripExtensions(record[key]);
      if (cleaned !== undefined) out[key] = cleaned;
      continue;
    }
    out[key] = strip(record[key]);
  }
  return out;
}

/** Extensions without the importer's keys, or `undefined` when nothing is left. */
function stripExtensions(value: unknown): unknown | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return strip(value);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === IMPORT_EXTENSION_KEYS.originId || key === IMPORT_EXTENSION_KEYS.importedFrom) {
      continue;
    }
    out[key] = strip(record[key]);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The provenance to write onto a remapped row, keeping any foreign extensions. */
export function provenanceExtensions(
  existing: Extensions | undefined,
  originId: string,
  packageId: string,
): Extensions {
  return {
    ...existing,
    [IMPORT_EXTENSION_KEYS.originId]: originId,
    [IMPORT_EXTENSION_KEYS.importedFrom]: packageId,
  };
}

/* ───────────────────────────── the decision ──────────────────────────────── */

/** What the importer will do with one package entity. */
export type IdentityAction = 'create' | 'reuse' | 'remap';

/**
 * Why. Stable tokens rather than sentences: the report is data, and the sentence a
 * user reads is the CLI's / the UI's business (`formatImportReport`).
 */
export type IdentityReason =
  | 'not-present'
  | 'identical-content'
  | 'from-earlier-import'
  | 'id-collision-content-differs'
  | 'same-name-different-content';

export interface IdentityCandidate {
  /** The entity's id inside the package. */
  readonly packageId: string;
  /**
   * The name a person would use to identify it, when the entity has one. Absent
   * for entities whose name is not an identity (`messages`, `checkpoints`, …):
   * two sessions may share a title and still be two different playthroughs, so
   * treating a title as a name would remap them for no reason.
   */
  readonly name?: string;
  /** `{version, data}` for a versioned entity; the row itself otherwise. */
  readonly content: unknown;
}

/** One comparable piece of local content, flattened. */
export interface LocalIdentityRow {
  /** The LOCAL id a reuse would point at (the owner id for a versioned entity). */
  readonly id: string;
  /** An origin id recorded by an earlier import, when there is one. */
  readonly originId?: string;
  readonly name?: string;
  readonly content: unknown;
}

/** Discriminated so a `remap` cannot be read as if it already had an id. */
export type IdentityDecision =
  | { readonly action: 'create'; readonly id: string; readonly reason: 'not-present' }
  | {
      readonly action: 'reuse';
      readonly id: string;
      readonly reason: 'identical-content' | 'from-earlier-import';
    }
  | {
      readonly action: 'remap';
      readonly originId: string;
      readonly reason: 'id-collision-content-differs' | 'same-name-different-content';
    };

/**
 * Resolve one entity against the local rows, in this order:
 *
 *   1. identical content at the same id            → reuse   (item 9)
 *   2. identical content recorded for this origin  → reuse   (item 9, after a remap)
 *   3. identical content under the same name       → reuse   (item 9, renamed id)
 *   4. that id is taken by DIFFERENT content       → remap   (§7)
 *   5. that name is taken by DIFFERENT content     → remap   (item 10)
 *   6. otherwise                                   → create
 *
 * Step 3 is why an entity whose content already exists is never duplicated merely
 * because the package chose another id; steps 4 and 5 are what stop an import from
 * silently overwriting what the user already has.
 */
export function decideIdentity(
  candidate: IdentityCandidate,
  locals: readonly LocalIdentityRow[],
): IdentityDecision {
  const identical = locals.filter((row) => deepEqual(row.content, candidate.content));

  if (identical.some((row) => row.id === candidate.packageId)) {
    return { action: 'reuse', id: candidate.packageId, reason: 'identical-content' };
  }

  const provenance = identical.find((row) => row.originId === candidate.packageId);
  if (provenance !== undefined) {
    return { action: 'reuse', id: provenance.id, reason: 'from-earlier-import' };
  }

  if (candidate.name !== undefined) {
    const sameName = identical.find((row) => row.name === candidate.name);
    if (sameName !== undefined) {
      return { action: 'reuse', id: sameName.id, reason: 'identical-content' };
    }
  }

  if (locals.some((row) => row.id === candidate.packageId)) {
    return {
      action: 'remap',
      originId: candidate.packageId,
      reason: 'id-collision-content-differs',
    };
  }

  if (candidate.name !== undefined && locals.some((row) => row.name === candidate.name)) {
    return {
      action: 'remap',
      originId: candidate.packageId,
      reason: 'same-name-different-content',
    };
  }

  return { action: 'create', id: candidate.packageId, reason: 'not-present' };
}
