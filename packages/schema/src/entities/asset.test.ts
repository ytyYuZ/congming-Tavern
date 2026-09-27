/**
 * Tests for the asset contract (docs/02 §4.1, §7; docs/04 §6).
 *
 * The cases that carry the design:
 * 1. content addressing — `hash` is a lowercase sha256 hex and the row is an
 *    *index* into the file store, so the bytes have nowhere to live in the schema;
 * 2. `kind` is the open `AssetKindSchema`, so a plugin asset class validates;
 * 3. dimensions are nonnegative, not positive: an audio clip has no pixels and
 *    the schema must not force the writer to invent some.
 */
import { describe, expect, it } from 'vitest';
import { AssetMetaSchema, AssetRefSchema, SHA256_HEX_PATTERN } from './asset';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const ASSET_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2101';
const THUMB_ID = '0192f0a1-7c3d-7a4e-9b21-5c8f0d3a2102';
const NOW = 1_790_000_000_000;

/** sha256 hex of the fixture bytes — lowercase, because it is a file name. */
const HASH = '9f2c1d4b6a8e0f3c5d7b9a1e2f4c6d8b0a3e5f7c9d1b3a5e7f9c1d3b5a7e9f1c';

const fullAsset = {
  id: ASSET_ID,
  hash: HASH,
  kind: 'portrait',
  mime: 'image/png',
  width: 832,
  height: 1216,
  bytes: 421_337,
  path: `assets/9f/2c/${HASH}.png`,
  thumbId: THUMB_ID,
  refCount: 2,
  meta: { binding: 'player', expression: 'wary', tags: ['颜绘', null] },
  source: { prompt: 'silver-haired watchkeeper, soft light', params: { seed: 42, steps: 28 } },
  createdAt: NOW,
};

/* ──────────────────────────────── helpers ────────────────────────────────── */

type Parseable = { safeParse: (value: unknown) => { success: boolean } };

/** Required-field driver: deleting any listed field must make the parse fail. */
function expectRequired(schema: Parseable, fixture: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const broken: Record<string, unknown> = { ...fixture };
    delete broken[field];
    expect(`${field}:${schema.safeParse(broken).success}`).toBe(`${field}:false`);
  }
}

/** Unknown fields are stripped, never rejected (HANDOFF §4.1 invariant 5). */
function expectStrips(schema: Parseable, fixture: Record<string, unknown>) {
  const parsed = schema.safeParse({ ...fixture, someFutureField: 1 });
  expect(parsed.success).toBe(true);
  expect((parsed as { data?: Record<string, unknown> }).data ?? {}).not.toHaveProperty(
    'someFutureField',
  );
}

/* ───────────────────────────────── tests ─────────────────────────────────── */

describe('asset meta', () => {
  it('parses a fully populated asset', () => {
    expect(AssetMetaSchema.safeParse(fullAsset).success).toBe(true);
  });

  it('parses a minimal asset (thumb and generation source may be absent)', () => {
    const minimal: Record<string, unknown> = { ...fullAsset };
    delete minimal.thumbId;
    delete minimal.source;
    expect(AssetMetaSchema.safeParse(minimal).success).toBe(true);
    expectRequired(AssetMetaSchema, fullAsset, [
      'id',
      'hash',
      'kind',
      'mime',
      'width',
      'height',
      'bytes',
      'path',
      'refCount',
      'meta',
      'createdAt',
    ]);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, mime: '' }).success).toBe(false);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, path: '' }).success).toBe(false);
  });

  it('keeps the bytes out of the database: this row is an index entry', () => {
    const keys = Object.keys(AssetMetaSchema.shape);
    for (const forbidden of ['data', 'bytesBase64', 'blob', 'content', 'file']) {
      expect(keys).not.toContain(forbidden);
    }
    // The hash is the content address and doubles as the stored file name.
    expect(SHA256_HEX_PATTERN.test(fullAsset.hash)).toBe(true);
    expect(fullAsset.path.endsWith(`${fullAsset.hash}.png`)).toBe(true);
  });

  it('rejects a malformed or non-lowercase sha256 hash', () => {
    expect(AssetMetaSchema.safeParse({ ...fullAsset, hash: HASH.slice(0, 63) }).success).toBe(
      false,
    );
    expect(AssetMetaSchema.safeParse({ ...fullAsset, hash: `${HASH}a` }).success).toBe(false);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, hash: HASH.toUpperCase() }).success).toBe(
      false,
    );
    expect(AssetMetaSchema.safeParse({ ...fullAsset, hash: 'not-a-hash' }).success).toBe(false);
    expect(SHA256_HEX_PATTERN.test(HASH)).toBe(true);
  });

  it('opens the asset kind to plugins and rejects an un-namespaced one', () => {
    for (const kind of [
      'sprite',
      'portrait',
      'scene',
      'thumbnail',
      'reference',
      'audio',
      'other',
    ]) {
      expect(`${kind}:${AssetMetaSchema.safeParse({ ...fullAsset, kind }).success}`).toBe(
        `${kind}:true`,
      );
    }
    expect(AssetMetaSchema.safeParse({ ...fullAsset, kind: 'spritesheet' }).success).toBe(false);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, kind: 'x-mythos.battlemap' }).success).toBe(
      true,
    );
  });

  it('allows a pixel-less asset instead of inventing dimensions for it', () => {
    const audio = { ...fullAsset, kind: 'audio', mime: 'audio/ogg', width: 0, height: 0 };
    expect(AssetMetaSchema.safeParse(audio).success).toBe(true);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, width: -1 }).success).toBe(false);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, bytes: -1 }).success).toBe(false);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, refCount: -1 }).success).toBe(false);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, createdAt: -1 }).success).toBe(false);
  });

  it('accepts only JSON in meta and in the generation params', () => {
    expect(
      AssetMetaSchema.safeParse({ ...fullAsset, meta: { tags: ['a', { b: 1 }, null] } }).success,
    ).toBe(true);
    expect(AssetMetaSchema.safeParse({ ...fullAsset, meta: { fn: undefined } }).success).toBe(
      false,
    );
    const badParams = { ...fullAsset, source: { params: { onDone: () => 1 } } };
    expect(AssetMetaSchema.safeParse(badParams).success).toBe(false);
  });

  it('strips unknown fields instead of rejecting them (forward compatibility)', () => {
    expectStrips(AssetMetaSchema, fullAsset);
  });

  it('is JSON round-trip stable, meta and params included', () => {
    const once = JSON.stringify(AssetMetaSchema.parse(fullAsset));
    expect(JSON.stringify(AssetMetaSchema.parse(JSON.parse(once)))).toBe(once);
  });

  it('round-trips an x- plugin extension and rejects an un-namespaced key', () => {
    const withExtension = { ...fullAsset, extensions: { 'x-mythos.upscale': { factor: 2 } } };
    const parsed = AssetMetaSchema.parse(withExtension);
    expect(parsed.extensions).toEqual({ 'x-mythos.upscale': { factor: 2 } });
    expect(JSON.stringify(AssetMetaSchema.parse(JSON.parse(JSON.stringify(parsed))))).toBe(
      JSON.stringify(parsed),
    );
    expect(AssetMetaSchema.safeParse({ ...fullAsset, extensions: { factor: 2 } }).success).toBe(
      false,
    );
  });
});

describe('asset ref', () => {
  it('parses a role-tagged reference and a bare one', () => {
    const full = { assetId: ASSET_ID, role: 'portrait' };
    expect(AssetRefSchema.safeParse(full).success).toBe(true);
    expect(AssetRefSchema.safeParse({ assetId: ASSET_ID }).success).toBe(true);
    expectRequired(AssetRefSchema, full, ['assetId']);
  });

  it('keeps the role free-form so a plugin can name a new use', () => {
    expect(AssetRefSchema.safeParse({ assetId: ASSET_ID, role: 'x-mythos.tile' }).success).toBe(
      true,
    );
    expect(AssetRefSchema.safeParse({ assetId: '' }).success).toBe(false);
    expect(AssetRefSchema.safeParse({ assetId: ASSET_ID, role: 7 }).success).toBe(false);
  });

  it('strips unknown fields and is JSON round-trip stable', () => {
    expectStrips(AssetRefSchema, { assetId: ASSET_ID, role: 'portrait' });
    const once = JSON.stringify(AssetRefSchema.parse({ assetId: ASSET_ID, role: 'portrait' }));
    expect(JSON.stringify(AssetRefSchema.parse(JSON.parse(once)))).toBe(once);
  });
});
