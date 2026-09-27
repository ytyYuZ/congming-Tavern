/**
 * `translate.ts` — the translator, interpolation, and the two-step fallback.
 *
 * WHY THESE TESTS USE LITERAL COPY instead of reading the catalog back
 * `expect(t('common.save')).toBe(zhCN['common.save'])` would pass for ANY two
 * strings, including two empty ones, and would keep passing after a translator
 * wrongly returns the key. Naming the expected sentence is the whole point: this
 * package is the one place in the workspace where Chinese UI text belongs, so the
 * lint rule's "no bare CJK under apps/" exemption does not apply here and the text
 * can be asserted verbatim.
 *
 * WHY THE FALLBACK IS TESTED THROUGH `lookupMessage`
 * A well-formed catalog always has the key, so `t()` cannot reach the fallback chain
 * at all. The deliberately incomplete catalogs below are the only way to execute the
 * two steps that exist for the day the data is wrong.
 */
import { describe, expect, it } from 'vitest';
import { createTranslator, interpolate, lookupMessage } from './translate';

describe('createTranslator', () => {
  it('carries the locale it was created for and reads that catalog', () => {
    const zh = createTranslator('zh-CN');
    const english = createTranslator('en');

    expect(zh.locale).toBe('zh-CN');
    expect(english.locale).toBe('en');
    expect(zh.t('common.save')).toBe('保存');
    expect(english.t('common.save')).toBe('Save');
  });

  it('interpolates a real message in both languages', () => {
    expect(createTranslator('zh-CN').t('setup.testOk', { status: 200 })).toBe(
      '连接成功（HTTP 200）',
    );
    expect(createTranslator('en').t('setup.testOk', { status: 200 })).toBe('Connected (HTTP 200)');
    expect(createTranslator('zh-CN').t('setup.testHttpFailed', { status: 'unknown status' })).toBe(
      '连接失败：服务端返回 HTTP unknown status',
    );
  });

  it('leaves the placeholder visible when the caller forgot the parameter', () => {
    expect(createTranslator('zh-CN').t('setup.testOk')).toBe('连接成功（HTTP {status}）');
    expect(createTranslator('en').t('setup.testOk', { status: 0 })).toBe('Connected (HTTP 0)');
  });

  it('gives each locale an independent translator', () => {
    const zh = createTranslator('zh-CN');
    const english = createTranslator('en');
    expect(zh.t('play.send')).toBe('发送');
    expect(english.t('play.send')).toBe('Send');
    expect(zh.locale).not.toBe(english.locale);
  });
});

describe('interpolate', () => {
  it('substitutes every occurrence of a known parameter', () => {
    expect(interpolate('{a}/{a}/{b}', { a: 'x', b: 2 })).toBe('x/x/2');
  });

  it('leaves a placeholder visible when the parameter is missing or absent', () => {
    expect(interpolate('HTTP {status}', {})).toBe('HTTP {status}');
    expect(interpolate('HTTP {status}', { other: 1 })).toBe('HTTP {status}');
    expect(interpolate('HTTP {status}')).toBe('HTTP {status}');
  });

  it('ignores parameters the template does not mention', () => {
    expect(interpolate('plain text', { unused: 'value' })).toBe('plain text');
  });

  it('leaves text without placeholders alone', () => {
    expect(interpolate('', { a: 1 })).toBe('');
    expect(interpolate('{')).toBe('{');
  });
});

describe('the two-step fallback', () => {
  it('uses the active catalog when it has the key', () => {
    expect(lookupMessage({ 'common.save': 'Sauvegarder' }, 'common.save')).toBe('Sauvegarder');
  });

  it('falls back to the zh-CN source of truth when the active catalog lacks the key', () => {
    expect(lookupMessage({}, 'common.save')).toBe('保存');
    expect(lookupMessage({ 'play.send': undefined }, 'play.send')).toBe('发送');
  });

  it('falls back to the key itself when even zh-CN lacks it', () => {
    expect(lookupMessage({}, 'nope.missing')).toBe('nope.missing');
  });

  it('treats an empty value as missing rather than rendering a blank string', () => {
    expect(lookupMessage({ 'common.save': '' }, 'common.save')).toBe('保存');
    expect(lookupMessage({ 'common.save': 'Save' }, 'common.save')).toBe('Save');
  });
});
