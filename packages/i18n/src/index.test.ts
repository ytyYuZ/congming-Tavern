/**
 * The barrel's contract (M1-G1).
 *
 * WHY THIS TEST PINS THE EXPORT LIST
 * `index.ts` is the only import path other workspaces are allowed to use — the lint
 * rule's message says `t('area.key') from @smarttavern/i18n`, and the UI conversion
 * imports from here. Moving a symbol out of the barrel is therefore a breaking change
 * for a package this test cannot see, and an export that grows by accident becomes an
 * API somebody depends on. The summary is asserted exactly, and the manifest
 * assertion keeps the package dependency-free (the framework-free decision: the React
 * binding belongs to `apps/web`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as i18n from './index';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

/** Every runtime symbol the barrel is contracted to expose. */
const PINNED_EXPORTS = [
  'CATALOGS',
  'DEFAULT_LOCALE',
  'LOCALE_LABELS',
  'LOCALES',
  'createTranslator',
  'en',
  'isLocale',
  'resolveLocale',
  'zhCN',
];

describe('@smarttavern/i18n barrel', () => {
  it('is a private workspace with no dependencies at all', () => {
    expect(manifest.name).toBe('@smarttavern/i18n');
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it('exposes exactly the pinned surface', () => {
    expect(Object.keys(i18n).sort()).toEqual([...PINNED_EXPORTS].sort());
  });

  it('works through the barrel alone, as a consumer sees it', () => {
    expect(i18n.createTranslator(i18n.DEFAULT_LOCALE).t('common.save')).toBe('保存');
    expect(i18n.LOCALE_LABELS[i18n.resolveLocale(['en-GB'])]).toBe('English');
    expect(Object.keys(i18n.CATALOGS).sort()).toEqual([...i18n.LOCALES].sort());
    expect(i18n.CATALOGS.en).toBe(i18n.en);
  });
});
