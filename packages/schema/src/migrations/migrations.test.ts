/**
 * Tests for the migration seam (`docs/04` §8).
 *
 * The table is empty at v1, so these tests pin the *failure* behaviour, which is
 * the part that matters: an importer must never quietly accept a payload it does
 * not understand.
 */
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSIONS, PACKAGE_SCHEMA_VERSION_KEYS } from '../package';
import { MIGRATIONS, migrate } from './index';

describe('schema versions', () => {
  it('declares a current version for every entity key in the manifest contract', () => {
    expect(Object.keys(CURRENT_SCHEMA_VERSIONS)).toEqual([...PACKAGE_SCHEMA_VERSION_KEYS]);
    for (const key of PACKAGE_SCHEMA_VERSION_KEYS) {
      expect(CURRENT_SCHEMA_VERSIONS[key]).toBeGreaterThan(0);
    }
  });
});

describe('migrate()', () => {
  it('is the identity when the payload is already current', () => {
    const payload = { hello: 'world' };
    expect(migrate('world', payload, 1)).toBe(payload);
    expect(migrate('message', payload, 1, 1)).toBe(payload);
  });

  it('ships no steps yet, and says so loudly instead of guessing', () => {
    expect(MIGRATIONS).toEqual([]);
    expect(() => migrate('world', {}, 0, 1)).toThrow(
      /no migration step for world from schema version 0/,
    );
  });

  it('refuses to migrate backwards, because that would fabricate data', () => {
    expect(() => migrate('world', {}, 2, 1)).toThrow(/backwards/);
  });
});
