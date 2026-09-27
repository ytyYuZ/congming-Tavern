/**
 * @smarttavern/packages — `.stpack` packing, unpacking and validation.
 *
 * BOUNDARY: adapter layer, and deliberately PURE logic so third parties can
 * reuse it (`docs/02-技术架构.md` §3, `docs/04` §11). May import
 * `@smarttavern/schema`; never a sibling adapter and never the UI. No filesystem
 * or network access in the packing core — callers supply the bytes and decide
 * what to do with the result.
 *
 * WHAT THIS BARREL EXPOSES: the package-level API (`pack` / `unpackPackage` /
 * `validatePackage`) plus the manifest builder and the limits. The ZIP container
 * below it (`./zip/read`, `./zip/write`) is an implementation detail of the
 * format, not a public API — third parties should not be writing raw `.stpack`
 * archives by hand.
 *
 * DETERMINISM: paths in ASCII order, `manifest.json` first, fixed timestamp
 * 1980-01-01, canonical JSON — so pack → unpack → pack is byte-identical
 * (`docs/04` §11, ADR-018). Readers ignore unknown fields (HANDOFF §4.1
 * invariant 5).
 */
export * from './canonical-json';
export * from './limits';
export * from './manifest';
export * from './pack';
export * from './unpack';
export * from './validate';
export * from './zip/errors';

/**
 * Workspace identity constant, kept from the M0-T0 scaffold.
 *
 * `index.test.ts` asserts on it, and it is the one string a caller can compare
 * against to be sure it resolved this workspace rather than a look-alike bundle.
 */
export const PACKAGES_PACKAGE = '@smarttavern/packages' as const;
