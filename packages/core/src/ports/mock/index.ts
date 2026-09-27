/**
 * In-memory test doubles, one per port (docs/06 §8.4: "有 mock 实现用于测试").
 *
 * WHY THEY LIVE IN `src/` AND NOT IN A `test/` FOLDER: `packages/providers`,
 * `packages/storage` and the app all need them, and a test-only folder is not
 * importable across workspaces. They are DOM-free and dependency-free for the
 * same reason the ports are — the same `tsc -b packages/core` compiles them.
 *
 * WHAT THEY ARE NOT: implementations. `ports/` holds contracts, `mock/` holds
 * doubles for tests, and the real adapters live in `providers/` / `storage/` /
 * `packages/` (docs/06 §8.4 决定 2).
 */
export * from './_support';
export * from './mock-assets';
export * from './mock-image';
export * from './mock-llm';
export * from './mock-package';
export * from './mock-storage';
export * from './mock-tools';
