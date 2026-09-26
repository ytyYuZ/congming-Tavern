import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STPACK_CLI } from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

describe('@smarttavern/stpack-cli (M0-T0 scaffold)', () => {
  it('is a private leaf tool with no libraries depending on it', () => {
    expect(manifest.name).toBe('@smarttavern/stpack-cli');
    expect(manifest.private).toBe(true);
    expect(STPACK_CLI).toBe('@smarttavern/stpack-cli');
  });
});
