/**
 * Structural equality for the JSON values an import compares (`docs/04` §7, §12
 * item 9: "相同内容复用").
 *
 * WHY NOT `JSON.stringify(a) === JSON.stringify(b)`: it is correct only while both
 * sides were parsed from text with the same key order. Here one side comes from a
 * package payload and the other from a stored row the importer may have rewritten
 * (references remapped, provenance keys added) — a comparison whose answer depends
 * on key insertion order is exactly the kind of "equal until it silently is not"
 * bug that turns a reuse into a duplicate.
 *
 * Arrays are order-sensitive (`docs/04` §11 rule 2: order is data); objects are
 * key-order-insensitive. Anything that is not JSON data compares by identity, and
 * `NaN` is handled the way `Object.is` does (never equal to itself), because a
 * payload that survived `JSON.parse` cannot contain it.
 */

/** True when two JSON values are structurally equal. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
  );
}
