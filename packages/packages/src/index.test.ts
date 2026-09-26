import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGES_PACKAGE } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/packages (M0-T0 scaffold)', () => {
  it('is a private adapter workspace on top of schema + core', () => {
    expect(manifest.name).toBe('@smarttavern/packages');
    expect(manifest.private).toBe(true);
    expect(PACKAGES_PACKAGE).toBe('@smarttavern/packages');
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@smarttavern/core',
      '@smarttavern/schema',
    ]);
  });
});
