/**
 * HOW the appearance reaches the screen (M1-G2, docs/06-开发任务拆解.md §2.1).
 *
 * WHY THIS IS A SEPARATE MODULE FROM `appearance.ts`
 * `appearance.ts` is the vocabulary (what a theme is, what the bounds are) and it must
 * stay importable by `db/repository.ts` and testable without a DOM. This module is the
 * only place in the feature that touches an `HTMLElement`, so the one impure step —
 * "write the three values onto the element" — is a single function that a test can call
 * with a detached `<div>` instead of a mounted app.
 *
 * WHY CUSTOM PROPERTIES AND ONE ATTRIBUTE, RATHER THAN INLINE STYLES
 * `font-scale` and `message-width` are consumed by the stylesheet
 * (`calc(15px * var(--font-scale, 1))`, `max-width: var(--message-width, 85%)`), so
 * writing them as custom properties leaves the LAYOUT decision in the CSS file and puts
 * only the VALUE here. A component that set `element.style.fontSize = …` would duplicate
 * the base size and the column arithmetic in TypeScript, where the `var()` fallback —
 * the thing that keeps a first paint with no store at all readable — cannot reach it.
 *
 * WHY THE CALLER SUPPLIES `prefersDark` INSTEAD OF THIS MODULE READING IT
 * The value has to be re-read when the OS changes its mind, and that is a subscription
 * with a lifetime (installed on mount, removed on unmount) which belongs to the React
 * effect in `use-appearance-effect.ts`. Passing the boolean in keeps this function total
 * and side-effect-free apart from the element it is given, so the "OS went dark" case is
 * a plain unit test rather than something only a live media query can produce.
 */
import {
  type Appearance,
  FONT_SCALE_PROPERTY,
  MESSAGE_WIDTH_PROPERTY,
  PREFERS_DARK_QUERY,
  resolveTheme,
  THEME_ATTRIBUTE,
} from './appearance';

/**
 * Write `appearance` onto `element` (in the app, `document.documentElement`).
 *
 * Idempotent and total: the same values can be applied any number of times — which is
 * what happens when the font scale changes while the OS is also dark — and a theme of
 * `system` on a host with no media-query engine removes the attribute rather than
 * guessing (see `resolveTheme`).
 */
export function applyAppearance(
  element: HTMLElement,
  appearance: Appearance,
  prefersDark: boolean | undefined,
): void {
  const theme = resolveTheme(appearance.theme, prefersDark);
  if (theme === undefined) {
    element.removeAttribute(THEME_ATTRIBUTE);
  } else {
    element.setAttribute(THEME_ATTRIBUTE, theme);
  }
  element.style.setProperty(FONT_SCALE_PROPERTY, String(appearance.fontScale));
  element.style.setProperty(MESSAGE_WIDTH_PROPERTY, `${appearance.messageWidth}%`);
}

/**
 * The OS colour-scheme query, or `undefined` when the host has no media-query engine.
 *
 * WHY THIS IS ALLOWED TO BE UNDEFINED: jsdom does not implement `window.matchMedia` at
 * all (measured on the pinned version, not assumed), and a future non-browser host would
 * not either. The app must not depend on it — `app.css`'s `@media (prefers-color-scheme:
 * dark)` block gives the correct first paint on its own — so the only thing lost is the
 * LIVE follow, and the caller degrades to "leave the attribute alone" instead of
 * inventing a light theme.
 */
export function prefersDarkQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia(PREFERS_DARK_QUERY);
}
