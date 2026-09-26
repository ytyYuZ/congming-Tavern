/**
 * @smarttavern/storage — workspace entry point (M0-T0 placeholder).
 *
 * BOUNDARY: adapter layer. May import `@smarttavern/schema` and
 * `@smarttavern/core` (it implements `core/ports` StorageAdapter/AssetStore);
 * never a sibling adapter and never the UI.
 *
 * M0-T7 adds `indexeddb/` (Dexie) with entity round-trip and transaction
 * rollback tests. This is the only layer allowed to touch IndexedDB / SQLite /
 * OPFS — browser and runtime APIs stop here.
 */
export const STORAGE_PACKAGE = '@smarttavern/storage' as const;
