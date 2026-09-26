import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/core (M0-T0 scaffold)', () => {
  it('is a private workspace with a TypeScript source entry point', () => {
    expect(manifest.name).toBe('@smarttavern/core');
    expect(manifest.private).toBe(true);
    expect(manifest.exports['.']).toBe('./src/index.ts');
  });

  it('depends on schema only (no concrete adapter)', () => {
    expect(CORE_PACKAGE).toBe('@smarttavern/core');
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@smarttavern/schema']);
  });
});
