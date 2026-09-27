/**
 * Asset port — `docs/02-技术架构.md` §6 (`AssetStore`), §7 资源生命周期, and
 * `@smarttavern/schema` `entities/asset.ts`.
 *
 * CONTENT ADDRESSING RULE (the invariant this port exists to protect)
 * `hash = sha256(bytes)`, lower-case hex, and the stored file name IS that hash.
 * Two identical portraits are therefore one file on disk and one row in
 * `assets`, and an import that re-encodes nothing dedupes for free. Consequences
 * a caller must respect:
 *   1. `put` is idempotent for identical bytes — it must not write a second copy;
 *   2. the BYTES never enter the database (§7: the row is an index entry);
 *   3. `refCount` is derived from reference rows, and an asset pinned by a
 *      checkpoint or a package cannot be collected;
 *   4. `remove` is a request, not a promise: the store may refuse to delete an
 *      asset that is still referenced (the M0-T7 implementation decides, but the
 *      contract says `remove` may be conservative, never eager).
 *
 * WHY THE HASH FUNCTION IS NOT HERE
 * `packages/core` performs no I/O and no platform calls (HANDOFF §4.1 invariant
 * 1; biome denies `fetch` et al. and forbids `node:` imports). Hashing bytes is
 * the real store's job (M0-T7) — so the type below is only used to inject a hash
 * function into the in-memory double under `./mock`.
 */
import type { AssetHash, AssetMeta, Id } from '@smarttavern/schema';

/**
 * `sha256(bytes)` as lower-case hex. Injected into the mock; implemented by the
 * real store. Not a function type the port itself calls.
 */
export type AssetHashFn = (bytes: Uint8Array) => string;

/** Result of a `put`, mirroring §6's `{ id, hash }`. */
export interface AssetPutResult {
  id: Id;
  /** Content address; equal for equal bytes, whatever the meta says. */
  hash: AssetHash;
}

/** `stats()` answer: what an asset cleaner needs to decide anything at all. */
export interface AssetStats {
  count: number;
  /** Sum of `meta.bytes` — the on-disk size of the originals. */
  bytes: number;
}

/**
 * §6's `AssetStore`, verbatim. `url` returns a string the CURRENT shell can
 * display (a blob: URL, an asset: path, a desktop file URL); it is deliberately
 * not a `URL` object so `packages/core` stays free of DOM types.
 */
export interface AssetStore {
  put(bytes: Uint8Array, meta: AssetMeta): Promise<AssetPutResult>;
  get(id: Id): Promise<Uint8Array>;
  url(id: Id): Promise<string>;
  remove(id: Id): Promise<void>;
  stats(): Promise<AssetStats>;
}
