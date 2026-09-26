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
