/**
 * @smarttavern/importers — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: adapter layer. May import `@smarttavern/schema` and
 * `@smarttavern/core`; never a sibling adapter and never the UI.
 *
 * Later tasks add the SillyTavern / Risu / Tavern import and export paths.
 * Round-trips must lose zero fields (docs/02-技术架构.md §11) and keys must
 * never end up in an exported package (HANDOFF §4.1 invariant 6).
 */
export const IMPORTERS_PACKAGE = '@smarttavern/importers' as const;
