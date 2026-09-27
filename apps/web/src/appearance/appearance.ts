/**
 * What the appearance settings ARE — the three values, their documented bounds, and how
 * an untrusted value becomes a usable one (M1-G2, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS MODULE IMPORTS NOTHING AT ALL
 * It is the vocabulary three layers share, and those layers must not import each other:
 * `db/repository.ts` validates a row with it, `state/appearance-store.ts` holds the live
 * values, and `appearance/apply-appearance.ts` together with `app/app.css` projects them
 * onto the DOM. Keeping the numbers, the bounds and the parsers here — no React, no
 * Dexie, no DOM, no i18n — is what lets them be tested as a table of values rather than
 * through a rendered app, and it is the same reason `isLocale` lives in the i18n package
 * and not in the locale store.
 *
 * WHY EACH SETTING IS ITS OWN `settings` ROW
 * The reason `LOCALE_SETTINGS_ID` gives (docs/02 §7): the three have different
 * lifetimes and different writers, and changing the font size must not have to rewrite
 * the row that remembers the theme. The ROWS are three; the STORE is one, because one
 * screen edits all three and one `load()` should read them together.
 *
 * WHY `system` IS THE DEFAULT RATHER THAN `light`
 * Nothing is stored on a first run, and the only honest answer at that moment is "do
 * what the operating system does": `app.css` follows `prefers-color-scheme` on its own,
 * so the first paint already matches the OS with no JavaScript involved. Picking `light`
 * would override a dark desktop and show a white flash on every cold start.
 *
 * WHY OUT-OF-RANGE VALUES ARE CLAMPED AND WRONG-TYPED ONES REPLACED
 * A `settings` row is JSON that this app wrote and that anything can later edit, so a
 * reader has two options: trust it, and render 15px * 900, or put it back in band. The
 * parsers below do the second — a wrong TYPE falls back to the documented default
 * (exactly as `isLocale` refuses `'EN'` rather than guessing) while a right-typed but
 * out-of-range NUMBER is clamped to the nearest bound, because `999` is a plausible
 * typo for `99` and rejecting it wholesale would throw away the user's intent.
 *
 * WHAT A BROWSER CANNOT DO — stated here so no claim overreaches
 * A stored theme that is NOT `system` can only be applied once its row has been read,
 * i.e. after the first paint: storage is asynchronous, and no synchronous hook runs
 * before the first paint in this app. So the flash is avoidable for `system` (the CSS
 * media query does it) and unavoidable for an explicit `light`/`dark` on the opposite
 * OS. `appearance/use-appearance-effect.ts` records the mechanics; nothing here or
 * anywhere else claims a flash-free start that a browser cannot deliver.
 */

/**
 * The three theme choices, in the order a picker should offer them.
 *
 * `system` first because it is the default and the option most people want; the tuple is
 * `as const` so `Theme` is DERIVED from it (the `LOCALES` idiom): adding a choice is one
 * entry, and every `Record<Theme, …>` in the app becomes a compile error until it is
 * filled in.
 */
export const THEMES = ['system', 'light', 'dark'] as const;

/** One theme preference. `system` follows the OS; the other two are explicit. */
export type Theme = (typeof THEMES)[number];

/** What the default is. Named rather than inlined so a reader can grep one word. */
export const DEFAULT_THEME: Theme = 'system';

/**
 * The theme that is actually applied (`resolvedTheme`), as opposed to the preference.
 * The DOM only ever holds one of these two — see `applyAppearance`.
 */
export type ResolvedTheme = 'light' | 'dark';

/**
 * The font-size multiplier. `1` is the app's base size, so the value is unitless and the
 * stylesheet applies it as `calc(15px * var(--font-scale, 1))`.
 */
export type FontScale = number;

/** The message-bubble width as a PERCENTAGE of the transcript column. */
export type MessageWidth = number;

/**
 * The font-size bounds, and why they are these numbers.
 *
 * The base size is 15px (`app.css`), so the band is 12px–22.5px. 12px is the smallest
 * size at which the densest screen (the setup form, with its hints) is still readable,
 * and 22.5px is where the header, the composer and a two-line bubble still fit the 760px
 * column without the layout collapsing. Anything outside the band is a writer bug.
 */
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.5;

/** Where a first run starts, and where a corrupt row lands: the base size. */
export const DEFAULT_FONT_SCALE: FontScale = 1;

/** The slider's granularity — 5% steps, which is as fine as a person can see. */
export const FONT_SCALE_STEP = 0.05;

/**
 * The message-width bounds, and why they are these numbers.
 *
 * 85% is the width M0 shipped the bubbles at, so it stays the default. 40% is the
 * narrowest bubble that still fits a short Chinese line without breaking after every
 * other character; 100% is the whole column, where the user and assistant bubbles are
 * told apart by alignment alone.
 */
export const MESSAGE_WIDTH_MIN = 40;
export const MESSAGE_WIDTH_MAX = 100;

/** The width a first run starts with, and where a corrupt row lands. */
export const DEFAULT_MESSAGE_WIDTH: MessageWidth = 85;

/** The slider's granularity, in percentage points. */
export const MESSAGE_WIDTH_STEP = 5;

/* ─────────────────────────── the DOM contract ────────────────────────────── */

/**
 * The attribute `applyAppearance` writes on `<html>`, and the selector `app.css` reads.
 *
 * The value is always a RESOLVED `light`/`dark`, never `system`: the stylesheet then
 * needs two palettes and one attribute rather than three states, and "what the OS says"
 * stays the live query's answer (see `use-appearance-effect.ts`) instead of a value CSS
 * would have to interpret twice.
 */
export const THEME_ATTRIBUTE = 'data-theme';

/** The custom property carrying `FontScale`. Read by `body`'s `font-size`. */
export const FONT_SCALE_PROPERTY = '--font-scale';

/** The custom property carrying `MessageWidth`. Read by the bubble's `max-width`. */
export const MESSAGE_WIDTH_PROPERTY = '--message-width';

/** The media query `system` follows. One spelling, shared by the hook and its test. */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/** The three preferences as the store and the applier pass them around. */
export interface Appearance {
  theme: Theme;
  fontScale: FontScale;
  messageWidth: MessageWidth;
}

/** What a first run shows, and what a corrupt row falls back to, field by field. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: DEFAULT_THEME,
  fontScale: DEFAULT_FONT_SCALE,
  messageWidth: DEFAULT_MESSAGE_WIDTH,
};

/* ───────────────────────────── the parsers ───────────────────────────────── */

/**
 * Is this value exactly one of the supported themes?
 *
 * Deliberately EXACT, like `isLocale`: the row was written by this app, so `'Dark'` or
 * `'auto'` is a bug in the writer rather than a near miss worth guessing at.
 */
export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEMES.some((theme) => theme === value);
}

/** A theme from an untrusted value, falling back to `DEFAULT_THEME`. Never throws. */
export function parseTheme(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

/**
 * Put a number back inside the font-size band.
 *
 * A non-finite number (`NaN`, `Infinity`, and therefore anything `Number()` produced
 * from garbage) is replaced rather than clamped: `Math.min(1.5, Math.max(0.8, NaN))` is
 * `NaN`, and `font-size: calc(15px * NaN)` is an invalid declaration — i.e. a blank
 * screen, which is exactly the failure this function exists to prevent.
 */
export function clampFontScale(value: number): FontScale {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SCALE;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

/**
 * A font scale from an untrusted value.
 *
 * Only a NUMBER is accepted, deliberately: `'1.15'` is a wrong-typed row, and the strict
 * check is what sends it to the documented default instead of letting a string reach a
 * CSS custom property. The slider's string is converted by the view, not here.
 */
export function parseFontScale(value: unknown): FontScale {
  return typeof value === 'number' ? clampFontScale(value) : DEFAULT_FONT_SCALE;
}

/** Put a number back inside the message-width band (see `clampFontScale`). */
export function clampMessageWidth(value: number): MessageWidth {
  if (!Number.isFinite(value)) return DEFAULT_MESSAGE_WIDTH;
  return Math.min(MESSAGE_WIDTH_MAX, Math.max(MESSAGE_WIDTH_MIN, value));
}

/** A message width from an untrusted value, falling back to the default. */
export function parseMessageWidth(value: unknown): MessageWidth {
  return typeof value === 'number' ? clampMessageWidth(value) : DEFAULT_MESSAGE_WIDTH;
}

/**
 * The theme to actually show: the explicit choice, or what the OS says.
 *
 * `prefersDark === undefined` means the host has NO media-query engine (jsdom is one —
 * measured, not assumed: `window.matchMedia` is simply absent there) and it is the one
 * case where the honest answer is "I do not know" instead of `false`. Answering `false`
 * would write `data-theme="light"` and thereby OVERRIDE the `prefers-color-scheme` block
 * in `app.css`, forcing a light interface onto a dark host. The caller removes the
 * attribute instead and lets CSS decide.
 */
export function resolveTheme(
  theme: Theme,
  prefersDark: boolean | undefined,
): ResolvedTheme | undefined {
  if (theme !== 'system') return theme;
  if (prefersDark === undefined) return undefined;
  return prefersDark ? 'dark' : 'light';
}
