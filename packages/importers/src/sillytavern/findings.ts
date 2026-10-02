/**
 * The SillyTavern adapter's report vocabulary: what a mapping could not do
 * exactly, and how loudly it says so.
 *
 * WHY A REPORT AND NOT AN EXCEPTION
 * A SillyTavern asset is written by many programs, many upstream versions and a
 * long tail of half-broken exporters. A truncated `tEXt` chunk, a base64 blob
 * with a stray character and a `spec_version` from the future are EXPECTED input
 * here, not internal errors: the user still wants the fields that could be read,
 * and the importer still owes them one sentence about what it refused. So every
 * entry point in `./` returns data plus findings and none of them throws for
 * input it can describe.
 *
 * `ok` IS DERIVED, NOT JUDGED: it is `false` exactly when a finding has
 * `severity: 'error'`. A result may carry values even when `ok` is false, and
 * whether that is possible is stated per entry point (the worldbook import is
 * per-entry and returns everything that validated; a character card is atomic and
 * returns nothing when the name or the spec is unusable).
 *
 * ONE SEVERITY PER CODE, FIXED HERE
 * `ST_SEVERITY` is the only place a severity is decided, so two call sites cannot
 * disagree about how bad "a field has no home" is. The three levels mean:
 *
 *   error    data is lost or the asset cannot be used as asked for at all
 *   warning  the value was mapped, but it is not what the source said, or a
 *            source field has no home in our entity (it IS kept as data)
 *   info     a faithful note about a mapping decision (a default was used, a
 *            field was coerced, a newer minor spec was read leniently)
 *
 * The `where` locator is deliberately terse and mechanical — a dotted path
 * (`data.creator_notes`), a chunk (`tEXt@42`), an entry (`entry 3`) — because the
 * UI and the CLI format their own sentences; this layer only says WHICH thing.
 */

/** How loudly a mapping problem speaks. */
export type StSeverity = 'error' | 'warning' | 'info';

/**
 * Every code this adapter emits. Adding a code means adding a severity below:
 * the record is exhaustive, so a new code without a decision does not compile.
 */
export type StFindingCode =
  /* ── card JSON and PNG ─────────────────────────────────────────────────── */
  | 'st-not-json'
  | 'st-not-base64'
  | 'st-card-shape'
  | 'st-spec-missing'
  | 'st-unknown-spec-version'
  | 'st-spec-version-newer'
  | 'st-missing-name'
  | 'st-reserved-key-collision'
  /* ── the generic field vocabulary (cards and worldbook entries) ────────── */
  | 'st-field-coerced'
  | 'st-field-invalid'
  | 'st-fields-defaulted'
  | 'st-field-no-home'
  /* ── PNG chunk surgery ─────────────────────────────────────────────────── */
  | 'st-png-not-png'
  | 'st-png-corrupt-chunk'
  | 'st-png-crc-mismatch'
  | 'st-png-payload-corrupt'
  | 'st-png-missing-chara-chunk'
  | 'st-png-unsupported-text-chunk'
  | 'st-png-duplicate-chunk'
  | 'st-png-text-not-ascii'
  | 'st-png-base-image-required'
  /* ── worldbook ─────────────────────────────────────────────────────────── */
  | 'st-worldbook-shape'
  | 'st-entry-id-missing'
  | 'st-entry-id-duplicate'
  | 'st-form-conversion';

/** The one severity each code has. Read this table to learn the vocabulary. */
export const ST_SEVERITY: Readonly<Record<StFindingCode, StSeverity>> = {
  'st-not-json': 'error',
  'st-not-base64': 'error',
  'st-card-shape': 'error',
  'st-spec-missing': 'info',
  'st-unknown-spec-version': 'error',
  'st-spec-version-newer': 'warning',
  'st-missing-name': 'error',
  'st-reserved-key-collision': 'error',
  'st-field-coerced': 'info',
  'st-field-invalid': 'warning',
  'st-fields-defaulted': 'info',
  'st-field-no-home': 'warning',
  'st-png-not-png': 'error',
  'st-png-corrupt-chunk': 'error',
  'st-png-crc-mismatch': 'warning',
  'st-png-payload-corrupt': 'error',
  'st-png-missing-chara-chunk': 'error',
  'st-png-unsupported-text-chunk': 'warning',
  'st-png-duplicate-chunk': 'warning',
  'st-png-text-not-ascii': 'error',
  'st-png-base-image-required': 'error',
  'st-worldbook-shape': 'error',
  'st-entry-id-missing': 'info',
  'st-entry-id-duplicate': 'warning',
  'st-form-conversion': 'warning',
};

/** One thing a mapping could not do exactly. Data, so the caller words it. */
export interface StFinding {
  readonly severity: StSeverity;
  readonly code: StFindingCode;
  /** A dotted field path, a chunk locator, an entry id — see the file header. */
  readonly where?: string;
  readonly detail: string;
}

/**
 * Build one finding, taking its severity from the table above.
 *
 * `where` is optional-but-third for the same reason `packages/core` orders its
 * arguments this way: the sentence is mandatory, the locator is not.
 */
export function stFinding(code: StFindingCode, detail: string, where?: string): StFinding {
  return {
    severity: ST_SEVERITY[code],
    code,
    ...(where === undefined ? {} : { where }),
    detail,
  };
}

/** True when a finding set means "something was lost or refused". */
export function hasErrors(findings: readonly StFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

/**
 * The `ok` a result reports: derived from its findings, never passed in. Keeping
 * the derivation here is what stops one entry point from calling a set with an
 * error in it "ok".
 */
export function stOk(findings: readonly StFinding[]): boolean {
  return !hasErrors(findings);
}
