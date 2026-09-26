/**
 * @smarttavern/packages — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: adapter layer, and deliberately PURE logic so third parties can
 * reuse it (docs/02-技术架构.md §3). May import `@smarttavern/schema` and
 * `@smarttavern/core`; never a sibling adapter and never the UI. No filesystem
 * or HTTP access in the packing core — callers supply the bytes.
 *
 * M0-T3 adds `pack` / `unpack` / `validate` with a DETERMINISTIC ZIP: paths in
 * lexicographic order, fixed timestamp 1980-01-01, stable JSON key order, so
 * that pack → unpack → pack is byte-identical. Readers must ignore unknown
 * fields (HANDOFF §4.1 invariant 5). M0-T4 wraps this in `tools/stpack-cli`.
 */
export const PACKAGES_PACKAGE = '@smarttavern/packages' as const;
