import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { I18N_PACKAGE } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/i18n (M0-T0 scaffold)', () => {
  it('is a private workspace with no business dependencies', () => {
    expect(manifest.name).toBe('@smarttavern/i18n');
    expect(manifest.private).toBe(true);
    expect(I18N_PACKAGE).toBe('@smarttavern/i18n');
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
