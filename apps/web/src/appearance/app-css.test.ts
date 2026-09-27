/**
 * The stylesheet's half of the appearance contract (M1-G2, docs/06-开发任务拆解.md §2.1).
 *
 * WHY A TEST READS A CSS FILE
 * `app/app.css` and `appearance/appearance.ts` must agree about three things no compiler
 * can check: the names of the custom properties and the theme attribute, the FALLBACKS
 * (which are what a first paint with no store at all renders at — the app has to be
 * readable before any of its JavaScript has decided anything), and the fact that the dark
 * palette is declared TWICE. Plain CSS cannot share those two blocks — a selector list
 * cannot contain an at-rule, and `light-dark()` would put the whole palette behind a
 * function an older WebView2 drops, taking every colour with it — so the duplication is
 * deliberate and a test is what keeps it from drifting. A drifted second palette is a
 * theme that changes colour the moment a setting is touched.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_SCALE,
  DEFAULT_MESSAGE_WIDTH,
  FONT_SCALE_PROPERTY,
  MESSAGE_WIDTH_PROPERTY,
  PREFERS_DARK_QUERY,
  THEME_ATTRIBUTE,
} from './appearance';

/**
 * The stylesheet, with double quotes normalised to single.
 *
 * WHY: the selectors below are attribute selectors, and which quote character Biome's CSS
 * formatter prefers is its decision, not this test's subject. Normalising once keeps the
 * assertions about the PALETTE rather than about typography.
 */
const css = readFileSync(new URL('../app/app.css', import.meta.url), 'utf8').replace(/"/g, "'");

/** `text` as a regex literal: these selectors are full of punctuation. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The declarations of the FIRST rule whose selector is exactly `selector` followed by
 * `{`, normalised and sorted so a harmless reordering does not fail the comparison.
 *
 * The `{` is required rather than optional on purpose: this stylesheet's own comments
 * mention both dark selectors, and a bare `indexOf` would happily return the comment. A
 * selector that is NOT in the file throws instead of returning `[]` — deleting a block
 * must fail loudly here rather than make an equality assertion pass trivially.
 */
function declarationsOf(selector: string): string[] {
  const match = new RegExp(`${escapeRegExp(selector)}\\s*\\{`).exec(css);
  if (match === null) throw new Error(`app.css declares no rule for ${selector}`);
  const open = match.index + match[0].length - 1;
  const close = css.indexOf('}', open);
  return css
    .slice(open + 1, close)
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '')
    .sort();
}

describe('app/app.css — the appearance contract', () => {
  it('declares ONE dark palette, spelled the same for the OS and for an explicit choice', () => {
    const byAttribute = declarationsOf(`:root[${THEME_ATTRIBUTE}='dark']`);
    const byMediaQuery = declarationsOf(`:root:not([${THEME_ATTRIBUTE}='light'])`);
    expect(byAttribute).toEqual(byMediaQuery);
    // A palette, not an empty block that trivially equals another empty block.
    expect(byAttribute.length).toBeGreaterThan(5);
  });

  it('keeps the OS palette working before any JavaScript has run', () => {
    // The same query `apply-appearance.ts` subscribes to, in the sheet: this is the block
    // that makes the first paint match the OS with no stored row and no code executed.
    expect(css).toContain(`@media ${PREFERS_DARK_QUERY}`);
    // And the media block must stand down for an explicit Light choice, or a dark desktop
    // could never be told "light".
    expect(declarationsOf(`:root[${THEME_ATTRIBUTE}='light']`)).toContain('color-scheme: light');
  });

  it('falls back to the documented defaults when nothing set a custom property', () => {
    expect(css).toContain(`var(${FONT_SCALE_PROPERTY}, ${DEFAULT_FONT_SCALE})`);
    expect(css).toContain(`var(${MESSAGE_WIDTH_PROPERTY}, ${DEFAULT_MESSAGE_WIDTH}%)`);
  });
});
