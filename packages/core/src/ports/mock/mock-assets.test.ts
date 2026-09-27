/**
 * Content-addressed asset double: identical bytes must dedupe, and the hash
 * function must be injected (docs/02 §7 资源生命周期).
 */

import type { AssetMeta } from '@smarttavern/schema';
import { describe, expect, it } from 'vitest';
import { fakeSha256, MockAssetError, MockAssetStore } from './index';

function meta(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id: 'a1',
    hash: fakeSha256(new Uint8Array([1, 2, 3])),
    kind: 'image',
    mime: 'image/png',
    width: 512,
    height: 512,
    bytes: 3,
    path: 'assets/a1.png',
    refCount: 1,
    meta: { characterId: 'c1' },
    createdAt: 0,
    ...overrides,
  };
}

const PORTRAIT = new Uint8Array([1, 2, 3]);
const OTHER = new Uint8Array([4, 5, 6]);

describe('MockAssetStore', () => {
  it('dedupes identical bytes and returns the existing id', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });

    const first = await store.put(PORTRAIT, meta({ id: 'a1' }));
    const second = await store.put(PORTRAIT, meta({ id: 'a2', path: 'assets/a2.png' }));

    expect(second.id).toBe(first.id);
    expect(second.hash).toBe(first.hash);
    expect(store.writes).toBe(1);
    expect(store.dedupeHits).toBe(1);
    expect(store.distinctContents).toBe(1);
    expect((await store.stats()).count).toBe(1);
    // The first metadata wins, and only the reference count moves.
    expect(store.metaOf(first.id)?.id).toBe('a1');
    expect(store.metaOf(first.id)?.refCount).toBe(2);
  });

  it('stores different bytes separately', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });
    const first = await store.put(PORTRAIT, meta({ id: 'a1' }));
    const second = await store.put(OTHER, meta({ id: 'a2' }));

    expect(second.id).not.toBe(first.id);
    expect(second.hash).not.toBe(first.hash);
    expect(store.writes).toBe(2);
    expect(store.dedupeHits).toBe(0);
    expect((await store.stats()).count).toBe(2);
  });

  it('reports the byte total of the originals', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });
    await store.put(PORTRAIT, meta());
    await store.put(OTHER, meta({ id: 'a2' }));
    expect(await store.stats()).toEqual({ count: 2, bytes: 6 });
  });

  it('hands out copies, so a caller cannot corrupt the store', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });
    const { id } = await store.put(PORTRAIT, meta());

    const read = await store.get(id);
    read[0] = 99;

    expect(Array.from(await store.get(id))).toEqual([1, 2, 3]);
  });

  it('rejects an unknown asset instead of returning empty bytes', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });
    await expect(store.get('missing')).rejects.toBeInstanceOf(MockAssetError);
    await expect(store.url('missing')).rejects.toBeInstanceOf(MockAssetError);
  });

  it('returns a non-URL route name, so app code cannot mistake it for a real one', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });
    const { id } = await store.put(PORTRAIT, meta());
    expect(await store.url(id)).toBe(`asset:${id}`);
  });

  it('forgets an asset on remove and tolerates removing it twice', async () => {
    const store = new MockAssetStore({ hash: fakeSha256 });
    const { id } = await store.put(PORTRAIT, meta());

    await store.remove(id);
    await store.remove(id);

    expect(store.has(id)).toBe(false);
    expect(await store.stats()).toEqual({ count: 0, bytes: 0 });
    // The address is free again, so re-adding the same bytes mints a new row.
    const again = await store.put(PORTRAIT, meta({ id: 'a9' }));
    expect(again.id).toBe('a9');
    expect(store.writes).toBe(2);
  });
});

describe('fakeSha256', () => {
  it('produces a 64-character lower-case hex string, whatever the input', () => {
    for (const bytes of [new Uint8Array(), PORTRAIT, new Uint8Array(1024).fill(7)]) {
      expect(fakeSha256(bytes)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is deterministic and sensitive to a single byte', () => {
    expect(fakeSha256(PORTRAIT)).toBe(fakeSha256(Uint8Array.from([1, 2, 3])));
    expect(fakeSha256(PORTRAIT)).not.toBe(fakeSha256(new Uint8Array([1, 2, 4])));
  });
});
