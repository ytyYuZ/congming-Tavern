/**
 * @smarttavern/web — application shell entry point (M0-T0 placeholder).
 *
 * BOUNDARY: `apps/*` sit at the top of the dependency graph and may import any
 * internal package. This is the only layer allowed to touch the DOM directly;
 * `packages/web` does not exist because docs/02-技术架构.md §3 makes apps/web
 * the single UI implementation (desktop reuses its build output).
 *
 * M0-T8 replaces this with the real shell (wizard → roleplay view → settings)
 * and the "configure key → send → stream → persist → restart still there"
 * vertical slice. Nothing here is meant to be imported by another workspace.
 */
export const WEB_APP = '@smarttavern/web' as const;

/**
 * Placeholder client bootstrap so that `vite build` produces a real shell and
 * `apps/desktop` has something to wrap. It deliberately renders a visible
 * marker instead of silently doing nothing.
 */
export function bootstrap(): string {
  const root = document.querySelector('[data-app="smarttavern"]');
  const message = 'SmartTavern web shell — M0-T0 scaffold (no features yet).';
  if (root instanceof HTMLElement) root.textContent = message;
  return message;
}
