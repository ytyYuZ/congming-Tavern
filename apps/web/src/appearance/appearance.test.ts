/**
 * The appearance RULES, as tables (M1-G2, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS FILE HAS NO DOM, NO REACT AND NO DATABASE
 * `appearance/appearance.ts` is the vocabulary four other files share, and everything
 * worth getting wrong in it is a pure question with a table-shaped answer: which stored
 * values are readable, what an out-of-band number becomes, and what `system` resolves to
 * on a host that cannot answer. Testing those through a mounted app would make every case
 * an integration test — and the one case that cannot be produced by a real browser (a
 * host with NO media-query engine) could not be tested at all. The DOM half lives in
 * `appearance/app-css.test.ts` (the stylesheet's contract) and `app/appearance.test.tsx`
 * (the rendered effect).
 *
 * WHY THE WRONG-TYPED CASES ARE SPELLED OUT RATHER THAN LUMPED TOGETHER
 * `isLocale`'s rule is that a row this app wrote must be EXACTLY right: `'Dark'` is a
 * writer bug, not a near miss worth guessing at, and silently accepting it would hide
 * that bug forever. A number is the least recoverable corruption of a string field, and
 * a string is the least recoverable corruption of a numeric one, so both directions are
 * pinned below.
 */
import { describe, expect, it } from 'vitest';
import {
  clampFontScale,
  DEFAULT_APPEARANCE,
  DEFAULT_FONT_SCALE,
  DEFAULT_MESSAGE_WIDTH,
  DEFAULT_THEME,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  isTheme,
  MESSAGE_WIDTH_MAX,
  MESSAGE_WIDTH_MIN,
  parseFontScale,
  parseMessageWidth,
  parseTheme,
  type ResolvedTheme,
  resolveTheme,
  THEMES,
  type Theme,
} from './appearance';

/** The documented defaults are inside the documented bounds, with room on both sides. */
describe('the documented bounds', () => {
  it('brackets the default font scale', () => {
    expect(FONT_SCALE_MIN).toBeLessThan(DEFAULT_FONT_SCALE);
    expect(DEFAULT_FONT_SCALE).toBeLessThan(FONT_SCALE_MAX);
  });

  it('brackets the default message width', () => {
    expect(MESSAGE_WIDTH_MIN).toBeLessThan(DEFAULT_MESSAGE_WIDTH);
    expect(DEFAULT_MESSAGE_WIDTH).toBeLessThanOrEqual(MESSAGE_WIDTH_MAX);
  });

  it('starts from `system`, so a first run follows the OS', () => {
    expect(DEFAULT_THEME).toBe('system');
    expect(THEMES[0]).toBe(DEFAULT_THEME);
    expect(DEFAULT_APPEARANCE).toEqual({
      theme: 'system',
      fontScale: 1,
      messageWidth: 85,
    });
  });

  it('is idempotent: the default passes its own parsers unchanged', () => {
    // A default the parsers would move is a default that never survives a restart.
    expect(parseTheme(DEFAULT_APPEARANCE.theme)).toBe(DEFAULT_APPEARANCE.theme);
    expect(parseFontScale(DEFAULT_APPEARANCE.fontScale)).toBe(DEFAULT_APPEARANCE.fontScale);
    expect(parseMessageWidth(DEFAULT_APPEARANCE.messageWidth)).toBe(
      DEFAULT_APPEARANCE.messageWidth,
    );
  });
});

describe('isTheme', () => {
  it.each([
    ['system', true],
    ['light', true],
    ['dark', true],
    // Exact, like `isLocale`: the row is data this app wrote.
    ['Dark', false],
    ['auto', false],
    ['', false],
    [42, false],
    [null, false],
    [undefined, false],
  ])('answers %s for %j', (value, expected) => {
    expect(isTheme(value)).toBe(expected);
  });
});

describe('parseTheme', () => {
  it.each([
    ['system', 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['Dark', DEFAULT_THEME],
    ['auto', DEFAULT_THEME],
    ['', DEFAULT_THEME],
    [0, DEFAULT_THEME],
    [null, DEFAULT_THEME],
    [undefined, DEFAULT_THEME],
    [{ theme: 'dark' }, DEFAULT_THEME],
  ])('reads %j as %s', (stored, expected) => {
    expect(parseTheme(stored)).toBe(expected);
  });
});

describe('parseFontScale', () => {
  it.each([
    // In band, including both edges: kept exactly, so a value the user chose survives.
    [1, 1],
    [1.15, 1.15],
    [FONT_SCALE_MIN, FONT_SCALE_MIN],
    [FONT_SCALE_MAX, FONT_SCALE_MAX],
    // Out of band: clamped to the nearest edge rather than thrown away.
    [0.1, FONT_SCALE_MIN],
    [99, FONT_SCALE_MAX],
    // Not a number at all: replaced. `Math.max(min, NaN)` is NaN, and an invalid
    // declaration is a blank screen.
    [Number.NaN, DEFAULT_FONT_SCALE],
    [Number.POSITIVE_INFINITY, DEFAULT_FONT_SCALE],
    [Number.NEGATIVE_INFINITY, DEFAULT_FONT_SCALE],
    // Wrong type: a string row is a writer bug, exactly like `'EN'` for a locale.
    ['1.15', DEFAULT_FONT_SCALE],
    [null, DEFAULT_FONT_SCALE],
    [undefined, DEFAULT_FONT_SCALE],
    [true, DEFAULT_FONT_SCALE],
  ])('reads %j as %j', (stored, expected) => {
    expect(parseFontScale(stored)).toBe(expected);
  });

  it('round-trips every value it accepts', () => {
    for (const value of [FONT_SCALE_MIN, 1, 1.15, FONT_SCALE_MAX]) {
      const parsed = parseFontScale(value);
      expect(clampFontScale(parsed)).toBe(parsed);
    }
  });
});

describe('parseMessageWidth', () => {
  it.each([
    [85, 85],
    [40, 40],
    [100, 100],
    [0, MESSAGE_WIDTH_MIN],
    [1000, MESSAGE_WIDTH_MAX],
    [Number.NaN, DEFAULT_MESSAGE_WIDTH],
    ['85', DEFAULT_MESSAGE_WIDTH],
    [null, DEFAULT_MESSAGE_WIDTH],
    [undefined, DEFAULT_MESSAGE_WIDTH],
  ])('reads %j as %j', (stored, expected) => {
    expect(parseMessageWidth(stored)).toBe(expected);
  });
});

describe('resolveTheme', () => {
  // The table is typed explicitly: without it the theme column widens to `string`, and the
  // assertions below would be checking a call the compiler no longer recognises.
  it.each<[Theme, boolean | undefined, ResolvedTheme | undefined]>([
    ['system', true, 'dark'],
    ['system', false, 'light'],
    // The host has no media-query engine (jsdom is one): "I do not know" is not `light`.
    ['system', undefined, undefined],
    // An explicit choice never asks the OS.
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['light', undefined, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['dark', undefined, 'dark'],
  ])('resolves (%s, prefersDark=%j) to %j', (theme, prefersDark, expected) => {
    expect(resolveTheme(theme, prefersDark)).toBe(expected);
  });
});
