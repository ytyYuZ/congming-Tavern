/**
 * In-memory `AssetStore` double (docs/06 §8.4: "有 mock 实现用于测试").
 *
 * TWO PROPERTIES IT EXISTS TO PROVE:
 * 1. IDENTICAL BYTES DEDUPE. `put` computes the content address and returns the
 *    EXISTING id when that hash is already stored, bumping `refCount` instead of
 *    writing a second copy (§7 资源生命周期).
 * 2. THE HASH FUNCTION IS INJECTED. `packages/core` may not call a crypto API —
 *    it is platform-free (HANDOFF §4.1 invariant 1) and hashing is M0-T7's job —
 *    so the constructor takes an `AssetHashFn`. Tests pass a fake; the real store
 *    passes real SHA-256.
 *
 * The route name is `asset:<id>`, deliberately not a `blob:`/`file:` URL: a
 * double must never look like a real displayable URL, or app code will start
 * depending on the shape.
 */
import type { AssetHash, AssetMeta, Id } from '@smarttavern/schema';
import type { AssetHashFn, AssetPutResult, AssetStats, AssetStore } from '../assets';
import { cloneValue } from './_support';

/** Raised for a missing asset, so `get`'s rejection is distinguishable in tests. */
export class MockAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockAssetError';
  }
}

interface StoredAsset {
  id: Id;
  hash: AssetHash;
  bytes: Uint8Array;
  meta: AssetMeta;
}

export interface MockAssetStoreOptions {
  /**
   * Required: core cannot hash (see the file header). Injected so the double
   * dedupes on real content addresses while a test can pass something trivial.
   */
  hash: AssetHashFn;
}

export class MockAssetStore implements AssetStore {
  private readonly hash: AssetHashFn;
  private readonly byId = new Map<Id, StoredAsset>();
  private readonly idByHash = new Map<string, Id>();

  /** How many `put` calls deduped onto an existing row — asserted by the tests. */
  dedupeHits = 0;

  /** How many `put` calls wrote new bytes. */
  writes = 0;

  constructor(options: MockAssetStoreOptions) {
    this.hash = options.hash;
  }

  async put(bytes: Uint8Array, meta: AssetMeta): Promise<AssetPutResult> {
    const hash = this.hash(bytes) as AssetHash;
    const existingId = this.idByHash.get(hash);
    if (existingId !== undefined) {
      // Same content: keep the FIRST id and meta, only bump the reference count.
      // Overwriting the meta would make the address depend on who wrote it last.
      const existing = this.byId.get(existingId);
      if (existing !== undefined) {
        existing.meta = { ...existing.meta, refCount: existing.meta.refCount + 1 };
      }
      this.dedupeHits += 1;
      return { id: existingId, hash };
    }

    const id = meta.id;
    const stored: StoredAsset = {
      id,
      hash,
      bytes: Uint8Array.from(bytes),
      meta: cloneValue({ ...meta, id, hash }),
    };
    this.byId.set(id, stored);
    this.idByHash.set(hash, id);
    this.writes += 1;
    return { id, hash };
  }

  async get(id: Id): Promise<Uint8Array> {
    const stored = this.byId.get(id);
    if (stored === undefined) throw new MockAssetError(`asset ${id} does not exist`);
    // A copy: handing out the internal buffer would let a caller corrupt the store.
    return Uint8Array.from(stored.bytes);
  }

  async url(id: Id): Promise<string> {
    if (!this.byId.has(id)) throw new MockAssetError(`asset ${id} does not exist`);
    return `asset:${id}`;
  }

  async remove(id: Id): Promise<void> {
    const stored = this.byId.get(id);
    if (stored === undefined) return;
    this.byId.delete(id);
    this.idByHash.delete(stored.hash);
  }

  async stats(): Promise<AssetStats> {
    let bytes = 0;
    for (const stored of this.byId.values()) bytes += stored.bytes.byteLength;
    return { count: this.byId.size, bytes };
  }

  /* ─────────────────────────── test conveniences ────────────────────────── */

  /** The stored metadata of an asset, for assertions about `refCount`. */
  metaOf(id: Id): AssetMeta | undefined {
    const stored = this.byId.get(id);
    return stored === undefined ? undefined : cloneValue(stored.meta);
  }

  /** How many distinct content addresses are stored. */
  get distinctContents(): number {
    return this.idByHash.size;
  }

  has(id: Id): boolean {
    return this.byId.has(id);
  }
}
