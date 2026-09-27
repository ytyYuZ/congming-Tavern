/**
 * `locale.ts` — the supported set, the exact-id validator and the fuzzy resolver.
 *
 * WHY THE CASES ARE THE REAL-WORLD SHAPES
 * `resolveLocale` exists because browsers, stored settings and HTTP headers hand this
 * app tags it does not ship (`en-US`, `zh-Hans-CN`, `zh-TW`, `''`). Testing it with
 * the tags that actually appear there is the only way to know the fallback order is
 * the one a user would want; the interesting cases are pinned with the reason in the
 * test name, so a future "simplification" that drops the priority order fails here
 * with an explanation instead of shipping English to a Chinese-first user.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, isLocale, LOCALE_LABELS, LOCALES, resolveLocale } from './locale';

describe('LOCALES / DEFAULT_LOCALE', () => {
  it('ships zh-CN and en, and defaults to the source-of-truth catalog', () => {
    expect([...LOCALES]).toEqual(['zh-CN', 'en']);
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
  });

  it('labels each locale in its own language, one label per locale', () => {
    expect(LOCALE_LABELS['zh-CN']).toBe('中文');
    expect(LOCALE_LABELS.en).toBe('English');
    expect(Object.keys(LOCALE_LABELS).sort()).toEqual([...LOCALES].sort());
  });
});

describe('isLocale', () => {
  it('accepts every supported id', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
  });

  it('rejects a primary subtag alone, a different case, and non-strings', () => {
    expect(isLocale('zh')).toBe(false);
    expect(isLocale('EN')).toBe(false);
    expect(isLocale('en-US')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(42)).toBe(false);
    expect(isLocale({ locale: 'en' })).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('returns an exact tag unchanged, case-insensitively', () => {
    expect(resolveLocale(['en'])).toBe('en');
    expect(resolveLocale(['zh-CN'])).toBe('zh-CN');
    expect(resolveLocale(['ZH-cn'])).toBe('zh-CN');
  });

  it('matches a region or script variant by its primary subtag', () => {
    expect(resolveLocale(['en-US'])).toBe('en');
    expect(resolveLocale(['en-GB'])).toBe('en');
    expect(resolveLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(resolveLocale(['zh-TW'])).toBe('zh-CN');
  });

  it('keeps the caller’s preference order rather than preferring exact matches', () => {
    // navigator.languages is a priority list: the first tag we can serve wins, so a
    // supported primary subtag at position 0 beats an exact match at position 1.
    expect(resolveLocale(['zh-Hans-CN', 'en'])).toBe('zh-CN');
    expect(resolveLocale(['en-US', 'zh-CN'])).toBe('en');
    expect(resolveLocale(['fr-CA', 'en-GB', 'zh-CN'])).toBe('en');
  });

  it('skips tags it cannot serve and keeps looking', () => {
    expect(resolveLocale(['fr-FR', 'zh-CN'])).toBe('zh-CN');
    expect(resolveLocale(['de', '', 'en'])).toBe('en');
  });

  it('falls back to the default for unknown, empty and blank input', () => {
    expect(resolveLocale(['fr-FR', 'de-DE'])).toBe('zh-CN');
    expect(resolveLocale(['zh-Hant'])).toBe('zh-CN');
    expect(resolveLocale([])).toBe('zh-CN');
    expect(resolveLocale([''])).toBe('zh-CN');
    expect(resolveLocale(['   '])).toBe('zh-CN');
  });
});
