import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_PACKAGE } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/ui (M0-T0 scaffold)', () => {
  it('is a private workspace with no business dependencies', () => {
    expect(manifest.name).toBe('@smarttavern/ui');
    expect(manifest.private).toBe(true);
    expect(UI_PACKAGE).toBe('@smarttavern/ui');
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
