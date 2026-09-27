/**
 * @smarttavern/schema — the single source of truth for every cross-module data
 * structure (HANDOFF §4.1 invariant 2, ADR-016).
 *
 * BOUNDARY: this package imports nothing but `zod`. It must not import any other
 * internal package, do I/O, or hold business logic — enforced by biome.json and
 * by tools/scripts/check-dependency-direction.mjs.
 *
 * LAYOUT
 *   ./common      shared primitives, the `extensions` escape hatch, open enums
 *   ./plugins     the plugin contract (interfaces only, no runtime)
 *   ./versioning  immutability + lineage + `versionedEntity()`
 *   ./entities/*  one file per domain entity
 *   ./package     the `.stpack` manifest (frozen) + cross-field consistency
 *   ./tool        tool declarations (`docs/02` §5.3); the runtime is in core/ports
 *   ./json-schema the published JSON Schemas of the above
 *   ./migrations  `migrate(entity, from, to)`; the table is empty at v1
 *
 * CONSUMERS IMPORT FROM HERE, not from the deep paths, so the internal layout
 * stays free to move.
 */
export * from './common';
export * from './entities';
export * from './json-schema';
export * from './migrations';
export * from './package';
export * from './plugins';
export * from './tool';
export * from './versioning';

/** Identity marker, kept so the package is greppable and smoke-testable. */
export const SCHEMA_PACKAGE = '@smarttavern/schema' as const;
