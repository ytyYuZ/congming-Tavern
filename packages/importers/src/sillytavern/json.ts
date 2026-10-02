/**
 * Tolerant readers for SillyTavern JSON: `unknown` in, a value or a reason out.
 *
 * WHY THESE LIVE IN ONE FILE
 * Both the card importer and the worldbook importer read objects written by
 * other people's programs, and their answers have to agree: "is this an array of
 * strings?" must not mean one thing on the card side and another on the lorebook
 * side, or a `tags: "crew"` card and a `key: "lamp"` entry would be coerced by
 * two different rules. So the coercion table lives here, once:
 *
 *   absent / null        → `undefined` (the caller decides the default)
 *   a number for an int  → the number, or a numeric string, coerced with a note
 *   a string for a list  → a one-element list, coerced with a note
 *   anything else        → `undefined`, and the caller emits `st-field-invalid`
 *
 * THE REASON IS RETURNED, NOT LOGGED. A reader answers `{ value }` or
 * `{ problem }`, and the caller turns the problem into a `StFinding` with the
 * field path it knows. That is why these functions never take a findings array:
 * a reader that wrote findings would decide the paths, and the paths are the
 * caller's.
 *
 * INDEX ACCESS IS SPELLED `memberOf`: `noPropertyAccessFromIndexSignature` forces
 * brackets on a `Record<string, unknown>`, and a parameterised key is the reading
 * that keeps one helper instead of a bracket at every call site.
 */

/** A JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A value described by its JSON kind, for a finding's sentence. Deliberately
 * coarse ("an array", "a string"): the sentence says what was expected and what
 * arrived, and the value itself is preserved elsewhere rather than printed.
 */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'an object';
    default:
      return `a ${typeof value}`;
  }
}

/** The member of a JSON object, or `undefined` when it is absent. */
export function memberOf(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/** The member when it is a string, else `undefined`. */
export function stringMember(record: Record<string, unknown>, key: string): string | undefined {
  const value = memberOf(record, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The member when it reads as an integer.
 *
 * `0x10` and `1e3` are NOT accepted as strings (`Number('1e3')` is 1000, which
 * would silently accept a value no ST writer emits); a plain decimal string is,
 * because some exporters stringify their numbers.
 */
export function integerMember(record: Record<string, unknown>, key: string): number | undefined {
  const value = memberOf(record, key);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** The member when it reads as a finite number (fractional values included). */
export function numberMember(record: Record<string, unknown>, key: string): number | undefined {
  const value = memberOf(record, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value.trim());
  }
  return undefined;
}

/** The member when it is a boolean. Strings are NOT coerced: `"false"` is a typo. */
export function booleanMember(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = memberOf(record, key);
  return typeof value === 'boolean' ? value : undefined;
}

/** The result of a tolerant list read: the usable members plus what was dropped. */
export interface StListRead {
  readonly values: readonly string[];
  /** Members that were present but are not strings, for one `st-field-invalid`. */
  readonly rejected: number;
  /** True when the source member was a lone string rather than a list. */
  readonly coerced: boolean;
}

/**
 * The member when it reads as a list of strings.
 *
 * `undefined` means the member was absent — which is a different fact from an
 * empty list, and the callers care (an absent `key` is ST's "no keywords").
 */
export function stringListMember(
  record: Record<string, unknown>,
  key: string,
): StListRead | undefined {
  const value = memberOf(record, key);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { values: [value], rejected: 0, coerced: true };
  if (!Array.isArray(value)) return { values: [], rejected: 1, coerced: false };
  const values: string[] = [];
  let rejected = 0;
  for (const item of value) {
    if (typeof item === 'string') values.push(item);
    else rejected += 1;
  }
  return { values, rejected, coerced: false };
}

/** Every own key of a record, in the order the source had them. */
export function keysOf(record: Record<string, unknown>): readonly string[] {
  return Object.keys(record);
}

/**
 * The record with `taken` keys removed — the source fields with no home in our
 * entity, which travel verbatim in the reserved bag instead of being dropped.
 */
export function withoutKeys(
  record: Record<string, unknown>,
  taken: readonly string[],
): Record<string, unknown> {
  const skip = new Set(taken);
  const out: Record<string, unknown> = {};
  for (const key of keysOf(record)) {
    if (skip.has(key)) continue;
    out[key] = record[key];
  }
  return out;
}
