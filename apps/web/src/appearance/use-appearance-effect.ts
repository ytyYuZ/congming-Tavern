/**
 * The React binding that PROJECTS the appearance onto the document (M1-G2,
 * docs/06-开发任务拆解.md §2.1).
 *
 * WHY THE DOM WRITE LIVES IN AN EFFECT AND NOT IN THE STORE
 * The store holds three plain values; this hook is the only thing that touches
 * `document.documentElement`. That split is what gives the projection a LIFETIME: the
 * `prefers-color-scheme` subscription below must be installed while the theme is
 * `system` and removed when the theme changes or the shell unmounts, and React's effect
 * cleanup is the one mechanism that guarantees both. A store that installed the listener
 * itself would have no unmount, so the listener would outlive the shell — the leak the
 * tests in `app/appearance.test.tsx` pin.
 *
 * WHY IT SUBSCRIBES TO THREE PRIMITIVES RATHER THAN TO THE WHOLE STORE
 * `useAppearanceStore((state) => state.theme)` re-renders only when the theme changes,
 * so a font-size drag does not re-render the component that renders no markup at all
 * (see `<AppearanceEffect/>` in `app/app.tsx`) — and `error`/`ready` cannot cause a
 * re-render of a component that only paints.
 *
 * WHY THE LISTENER IS ONLY INSTALLED FOR `system`
 * A fixed `light`/`dark` choice does not care what the OS says, so subscribing to the OS
 * on its behalf would be a listener with nothing to do. `system` is the only value whose
 * meaning can change without a user action, and that is exactly what the subscription is
 * for. (The effect re-runs whenever the theme changes, so switching TO `system` installs
 * the listener and switching away removes it.)
 *
 * WHAT IS FLASH-FREE, AND WHAT CANNOT BE — the honest version
 *   • `system` (the DEFAULT, and therefore also the first-ever run): `app.css` carries
 *     the same palettes under `@media (prefers-color-scheme: dark)`, so the very first
 *     paint already matches the OS with no JavaScript and no stored row. This is the
 *     case the requirement "the first paint already matches the OS" is about, and it is
 *     genuinely flash-free.
 *   • a stored `light`/`dark`: NOT flash-free, and it cannot be. The row lives in
 *     IndexedDB, whose API is asynchronous, and a synchronous read before the first
 *     paint does not exist in this app (the store is built, then `app/app.tsx`'s mount
 *     effect asks for the row). So on a dark desktop with a stored `light` a first-time
 *     load paints dark for one frame and then corrects itself. Suppressing it would need
 *     a synchronous mirror of the row (a `localStorage` copy, an inline bootstrap
 *     script) — a second source of truth for the same preference, which is a worse bug
 *     than the flash. Nothing here claims otherwise.
 */
import { useEffect } from 'react';
import { useAppearanceStore } from '../state/appearance-store';
import { applyAppearance, prefersDarkQuery } from './apply-appearance';

/**
 * Keep `target` in sync with the appearance store, and follow the OS while the theme is
 * `system`.
 *
 * `target` is a parameter rather than a hard-coded `document.documentElement` so a test
 * can point it at a detached element; the app always uses the default.
 */
export function useAppearanceEffect(target: HTMLElement = document.documentElement): void {
  const theme = useAppearanceStore((state) => state.theme);
  const fontScale = useAppearanceStore((state) => state.fontScale);
  const messageWidth = useAppearanceStore((state) => state.messageWidth);

  useEffect(() => {
    const query = prefersDarkQuery();
    // The same closure is what the media listener calls, so a change event and a store
    // change apply through one code path (`query.matches` is re-read at call time).
    const apply = (): void => {
      applyAppearance(target, { theme, fontScale, messageWidth }, query?.matches);
    };
    apply();

    // `query === undefined` means the host has no media-query engine (jsdom is one):
    // `apply` has already left the theme attribute off so CSS decides, and there is
    // nothing to subscribe to. A fixed theme has nothing to follow either way.
    if (theme !== 'system' || query === undefined) return undefined;

    query.addEventListener('change', apply);
    return () => {
      query.removeEventListener('change', apply);
    };
  }, [target, theme, fontScale, messageWidth]);
}
