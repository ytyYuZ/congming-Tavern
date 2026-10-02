/**
 * @smarttavern/importers — `.stpack` export and import with a visible report
 * (`docs/06-开发任务拆解.md` §2.6, M1-M3).
 *
 * BOUNDARY: adapter layer. May import `@smarttavern/schema` and
 * `@smarttavern/core`; never a sibling adapter and never the UI. Round-trips must
 * lose zero fields (`docs/02` §11) and keys must never end up in an exported
 * package (HANDOFF §4.1 invariant 6).
 *
 * THE ONE THING THAT SURPRISES PEOPLE HERE, SO IT IS SAID OUT LOUD: the real
 * container implementation lives in `@smarttavern/packages`, and this package may
 * NOT import it — `biome.json`'s adapter override and
 * `tools/scripts/check-dependency-direction.mjs` allow `packages/schema` and
 * `packages/core` only. So the packaging is INJECTED through the core ports
 * (`PackageReader` / `PackageWriter` / `PackageValidator`), exactly as `docs/02` §6
 * requires for every external capability. `tools/stpack-cli` does that wiring for
 * the command line, and `tools/stpack-cli/src/import.test.ts` is where the real
 * ZIP writer, the real reader and this importer meet:
 *
 *   const reader = createPackageReader();
 *   await importPackage(bytes, { reader, validator, storage, mintId });
 *
 * WHAT IS EXPORTED
 *   ./export-package  world / character / session → `.stpack` bytes
 *   ./import-package  `.stpack` bytes → rows + an `ImportReport`
 *   ./identity        the reuse / remap policy (items 9, 10, 12) and its reasons
 *   ./payload         the `data/` layout, canonical JSON and the row orderings
 *   ./sillytavern     SillyTavern character cards (PNG/JSON) and world info ⇄ our
 *                     entities, with the same "report, never throw" shape (M1-I1)
 *   ./examples        the M1-I2 example content pack: readable source, a bundle
 *                     builder, and the rows → session step that proves "import it
 *                     and start playing" at the row level
 *   ./testing/fixtures one complete library, for tests and for the CLI's demo
 *
 * The in-package test doubles live in `./testing/`. The storage double IS
 * re-exported (see the note on it below); the package double is not.
 */
export * from './canonical-json';
export * from './deep-equal';
export * from './examples';
export * from './export-package';
export * from './identity';
export * from './import-package';
export * from './payload';
export * from './sillytavern';
export * from './testing/fixtures';
/**
 * The in-memory `StorageAdapter` IS exported, deliberately: `tools/stpack-cli` has
 * no IndexedDB to import into and takes no new dependencies, so it composes this
 * adapter behind its own JSON library file (`tools/stpack-cli/src/library.ts`).
 * Re-using one transaction implementation is what keeps the import's atomicity
 * claim true of the store the CLI actually writes. The PACKAGE double
 * (`./testing/memory-package`) stays private: a fake container that could be
 * mistaken for the `.stpack` format is a footgun, while an in-memory store is just
 * a store.
 */
export * from './testing/memory-storage';

/** Identity marker, kept from the M0-T0 scaffold and asserted by `index.test.ts`. */
export const IMPORTERS_PACKAGE = '@smarttavern/importers' as const;
