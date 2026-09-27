/**
 * Shared plumbing for the in-memory doubles in this folder.
 *
 * Kept tiny on purpose: a mock that needs infrastructure stops being a mock. The
 * only things here are the two facts every double shares — an id minter and the
 * abort check — plus the clone helper that makes transaction rollback possible.
 */

/**
 * True when the signal has already fired.
 *
 * CANCELATION IS "STOP", NOT "THROW". `packages/core` is platform-free, so the
 * DOM's `DOMException` and Node's `AbortError` are both out of reach (HANDOFF
 * §4.1 invariant 1); rather than invent a third abort exception for callers to
 * catch, an aborted `stream()` simply ENDS — zero events if it was aborted
 * before it started, the events already delivered otherwise. Cancellation is a
 * normal outcome, and `docs/02` §6 asks only that generation be cancellable.
 */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * Deterministic id minter: `prefix-1`, `prefix-2`, … No randomness, no clock, so
 * a test can assert exact ids instead of a regex (docs/02 §11: reproducible).
 */
export function createIdMinter(prefix = 'mock'): (label?: string) => string {
  let counter = 0;
  return (label = prefix) => {
    counter += 1;
    return `${label}-${counter}`;
  };
}

/**
 * Deep copy that a transaction can discard.
 *
 * `structuredClone` is an ES2022 global and handles exactly what these stores
 * hold (plain objects, arrays, `Uint8Array`), so no JSON round-trip is needed —
 * important, because JSON would silently drop `undefined` fields and turn a
 * `Timestamp`-less row into a different row.
 */
export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
