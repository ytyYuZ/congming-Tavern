/**
 * Public-surface tests for the schema package.
 *
 * Consumers import from `@smarttavern/schema` and never from the deep paths, so
 * this file checks the barrel actually exposes what the other packages will
 * need, and that the package still respects the root of the dependency graph
 * (HANDOFF §4.1 invariants 2 and 4: schema depends on nothing internal).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CharacterDataSchema,
  ExtensionsSchema,
  PluginManifestSchema,
  SCHEMA_PACKAGE,
} from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/schema', () => {
  it('is a private workspace consumed as TypeScript source', () => {
    expect(manifest.name).toBe('@smarttavern/schema');
    expect(manifest.private).toBe(true);
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });

  it('depends on zod and on nothing else', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([]);
  });

  it('re-exports the contracts other packages import', () => {
    expect(SCHEMA_PACKAGE).toBe('@smarttavern/schema');
    expect(typeof CharacterDataSchema.safeParse).toBe('function');
    expect(typeof ExtensionsSchema.safeParse).toBe('function');
    expect(typeof PluginManifestSchema.safeParse).toBe('function');
  });
});
