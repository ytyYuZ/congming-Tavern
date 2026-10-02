/**
 * `catalog.ts` — the invariants that make a catalog safe to render.
 *
 * WHY THIS FILE EXISTS AT ALL, GIVEN THE COMPILER
 * `en: Messages` already makes a missing key a `tsc` error. These assertions cover
 * what a type cannot: an `as` cast that lies its way past the annotation (a copy of
 * zh-CN renamed `en` typechecks), an empty value (which no type forbids and which
 * renders as a blank button), a key that forgot its area prefix, and the source order
 * the two catalogs are meant to share so a reviewer can diff them line by line.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGS, en, zhCN } from './catalog';
import { LOCALES } from './locale';

/**
 * The areas a key may start with, in the order the catalog declares them.
 *
 * `world` and `character` were added by the two card editors (M1-W1 / M1-C1) and `session` by
 * the create-session flow (M1-S1), which is what this list is FOR: a new area is a deliberate
 * edit here rather than a prefix nobody reviewed. `co-create` was added by the AI co-creation
 * panel (M1-W2) for the same reason: its sentences are the PROPOSAL FLOW's — a conversation, a
 * patch, accept/reject, undo — not a world card's, and `M1-C2` and ADR-031's variable proposal
 * are the two callers that make that a distinction rather than a taste.
 */
const AREAS = [
  'common',
  'nav',
  'setup',
  'home',
  'session',
  'world',
  'co-create',
  'character',
  'play',
  'error',
];

describe('message catalogs', () => {
  it('is not empty', () => {
    expect(Object.keys(zhCN).length).toBeGreaterThan(0);
  });

  it('keeps the two catalogs key-for-key identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it('has a non-empty translation, distinct from its key, in every locale', () => {
    for (const locale of LOCALES) {
      const catalog = CATALOGS[locale];
      for (const [key, value] of Object.entries(catalog)) {
        expect(typeof value, `${locale} ${key} is not a string`).toBe('string');
        expect(value, `${locale} ${key} is empty`).not.toBe('');
        // A value equal to its key means a translation was never written; the
        // fallback chain would happily render it as if it were copy.
        expect(value, `${locale} ${key} still holds its key`).not.toBe(key);
      }
    }
  });

  it('namespaces every key as <area>.<thing>, with exactly one dot', () => {
    for (const key of Object.keys(zhCN)) {
      expect(key.split('.'), `${key} must be <area>.<thing>`).toHaveLength(2);
      expect(
        AREAS.some((area) => key.startsWith(`${area}.`)),
        `${key} does not start with a known area`,
      ).toBe(true);
    }
  });

  it('groups the keys by area, in the documented order', () => {
    const seen: string[] = [];
    for (const key of Object.keys(zhCN)) {
      const area = key.split('.')[0] ?? '';
      if (seen[seen.length - 1] !== area) seen.push(area);
    }
    expect(seen).toEqual(AREAS);
  });
});
