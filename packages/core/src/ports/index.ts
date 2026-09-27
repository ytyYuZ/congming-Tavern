/**
 * `core/ports` — the contracts every external capability is implemented behind
 * (docs/02 §6, §13 contracts #3, #7, #8).
 *
 * WHAT BELONGS HERE: interfaces, types and CONSTANTS ONLY — zero implementations
 * (docs/06 §8.4 决定 2). The implementations live in `packages/providers`,
 * `packages/storage` and `packages/packages`, and are injected; `packages/core`
 * never imports one (HANDOFF §4.1 invariants 1 and 4).
 *
 * The one exception is `./mock`, which holds in-memory test doubles. They are
 * deliberately reachable from the barrel because tests in other workspaces need
 * them, and they are still DOM-free and dependency-free. That reachability depends
 * on the line below: `package.json` exposes only `"."`, so a subpath import
 * (`@smarttavern/core/ports/mock`) is impossible and a double that is not re-exported
 * here is unreachable from every other package — which is how `packages/importers`
 * ended up writing its own. Production bundles do not pay for this: an unused
 * re-export is dropped by tree shaking.
 */
export * from './assets';
export * from './image';
export * from './llm';
export * from './mock';
export * from './package';
export * from './storage';
export * from './tools';
export * from './tools';
