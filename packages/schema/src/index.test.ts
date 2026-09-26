import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_PACKAGE } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/schema (M0-T0 scaffold)', () => {
  it('is a private workspace with a TypeScript source entry point', () => {
    expect(manifest.name).toBe('@smarttavern/schema');
    expect(manifest.private).toBe(true);
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });

  it('is importable and free of other internal dependencies', () => {
    expect(SCHEMA_PACKAGE).toBe('@smarttavern/schema');
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
