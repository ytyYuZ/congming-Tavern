/**
 * @smarttavern/core — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY (HANDOFF §4.1 invariants 1 and 4): core may depend on
 * `packages/schema` and nothing else. It must never import a DOM/browser API
 * and never a concrete provider, storage, rules, packaging or importer
 * implementation — those arrive through `core/ports` interfaces instead.
 *
 * Enforced by: tsconfig.core.json (DOM lib removed → typecheck fails on
 * `window`/`document`), biome.json (noRestrictedGlobals + noRestrictedImports),
 * and tools/scripts/check-dependency-direction.mjs.
 *
 * M0-T1 adds `domain/`; M0-T5 adds `ports/`; M0-T5+ fills `engine/` with the
 * pure functions (PromptComposer, TurnScheduler, TimeEngine, DiceEngine) that
 * docs/02-技术架构.md §11 requires to be unit-testable without any I/O.
 */
export const CORE_PACKAGE = '@smarttavern/core' as const;

/**
 * The prompt composer (`docs/02` §5.1, M1-G4): the §5.1 assembly order, the
 * macro registry and the token budget with its priority trim. Pure functions
 * over the ADR-029 `PromptPreset` — it defines no block shape of its own and
 * does no I/O.
 */
export * from './engine/prompt';
/**
 * The world clock (`docs/02` §5.7, M1-T1). Pure functions only: `advance`,
 * `setTime`, `display`, `segmentOf`, `fireDue` and the deadline sweep, plus the
 * calendar arithmetic they are built on. See `./engine/time` for what is
 * deliberately not there (`innerClock`, the `advance_time` policy).
 */
export * from './engine/time';
/**
 * The port contracts (docs/02 §6, §13 #3/#7/#8) and their in-memory test
 * doubles. Re-exported from the entry point so an adapter package imports one
 * specifier; `./ports/mock` stays reachable through the barrel for tests.
 */
export * from './ports';
