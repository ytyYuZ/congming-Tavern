/**
 * @smarttavern/schema — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: this package is the single source of truth for every cross-module
 * data structure (HANDOFF §4.1 invariant 2). It must not import any other
 * internal package — enforced by biome.json and by
 * tools/scripts/check-dependency-direction.mjs.
 *
 * M0-T1 adds `entities/{world,character,session,message,checkpoint,agenda,
 * memory,asset,turn}.ts` (Zod schemas + `z.infer` types); M0-T2 adds
 * `package.ts` and the exported `schema/package-1.json`. No business logic and
 * no I/O belongs here — only frozen contracts.
 *
 * Until then this file exports nothing but its own identity so that the
 * workspace graph, typecheck and CI have something real to chew on.
 */
export const SCHEMA_PACKAGE = '@smarttavern/schema' as const;
