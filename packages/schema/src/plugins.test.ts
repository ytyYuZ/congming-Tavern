/**
 * Tests for the plugin contract. No plugin code runs anywhere in this project
 * yet — these assertions freeze the *shape* so that adding a loader later is
 * additive (see the `plugins.ts` header).
 */
import { describe, expect, it } from 'vitest';
import { AssetKindSchema, MessageKindSchema, PluginManifestSchema } from './plugins';

describe('plugin manifest', () => {
  const minimal = {
    id: 'x-mythos',
    name: 'Mythos Toolkit',
    version: '1.2.0',
    apiVersion: '1.0',
  };

  it('parses a minimal manifest', () => {
    expect(PluginManifestSchema.safeParse(minimal).success).toBe(true);
  });

  it('requires the id to be a namespaced plugin id', () => {
    expect(PluginManifestSchema.safeParse({ ...minimal, id: 'mythos' }).success).toBe(false);
  });

  it('round-trips contributions and extension data through JSON', () => {
    const manifest = {
      ...minimal,
      permissions: ['llm', 'x-mythos.dice'],
      contributes: { entityKinds: ['x-mythos.sanity'], toolNames: ['roll_sanity'] },
      extensions: { 'x-mythos.config': { strict: true } },
    };
    const parsed = PluginManifestSchema.parse(manifest);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(manifest);
  });

  it('rejects an unknown un-namespaced permission', () => {
    expect(PluginManifestSchema.safeParse({ ...minimal, permissions: ['root'] }).success).toBe(
      false,
    );
  });
});

describe('contributor-extensible enums re-exported for entities', () => {
  it('accepts core members plus x- namespaced ones', () => {
    expect(AssetKindSchema.safeParse('sprite').success).toBe(true);
    expect(AssetKindSchema.safeParse('x-mythos.moodboard').success).toBe(true);
    expect(AssetKindSchema.safeParse('video').success).toBe(false);

    expect(MessageKindSchema.safeParse('narration').success).toBe(true);
    expect(MessageKindSchema.safeParse('x-mythos.whisper').success).toBe(true);
  });
});
