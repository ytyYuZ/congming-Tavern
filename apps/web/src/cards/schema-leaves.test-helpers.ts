/**
 * Walking a Zod entity's LEAF PATHS, for the card editors' completeness suites (M1-W1 / M1-C1).
 *
 * WHY THIS EXISTS AS A SHARED HELPER
 * Both editors claim 「字段完整」, and the only honest way to check a claim about a form is to
 * compare it against the contract it is a form OF. So `cards/world.test.ts` and
 * `cards/character.test.ts` each walk their payload schema with this function and assert that
 * every leaf is either rendered or explicitly delegated.
 *
 * WHY AN ARRAY IS A LEAF, AND WHY THAT NEEDS SAYING
 * `z.array(x).unwrap()` returns the ELEMENT, not the array, so a walker that unwraps eagerly
 * descends into `regions[].name` and reports the array itself as missing — which is exactly the
 * false alarm this helper produced before the array check was put FIRST. The editors do render
 * `regions` and `outfits` as one control per LIST, so the list is the unit and its elements are
 * not separate paths. A record is a leaf for the same reason: its key space is open.
 *
 * Optional wrappers are unwrapped (a draft is checked against the schema as if every optional
 * field were present, because the editor renders them all).
 */
import { z } from 'zod';

/** Unwrap `optional` (and `nullish`'s optional half) down to the schema that decides the type. */
function unwrapOptional(schema: unknown): unknown {
  return schema instanceof z.ZodOptional ? unwrapOptional(schema.unwrap()) : schema;
}

/**
 * Every leaf path of a schema, dotted (`visual.params.seedPolicy`).
 *
 * An object node is recursed into; anything else — a primitive, an array, a record, a union — is
 * one leaf. That is the granularity the editors work at, so the comparison in the suites is
 * between like and like.
 */
export function leafPaths(schema: unknown, prefix = ''): string[] {
  const node = unwrapOptional(schema);
  if (node instanceof z.ZodArray) return [prefix];
  if (!(node instanceof z.ZodObject)) return [prefix];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(node.shape)) {
    paths.push(...leafPaths(child, prefix === '' ? key : `${prefix}.${key}`));
  }
  return paths;
}
