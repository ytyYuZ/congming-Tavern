/**
 * @smarttavern/desktop — Tauri 2 shell entry point (M0-T0 placeholder).
 *
 * BOUNDARY: per docs/02-技术架构.md §3 this app is a thin shell that reuses the
 * `apps/web` build output and adds native capability; it must not grow a second
 * UI implementation. Rust/Tauri wiring lands in M0-T8.
 *
 * The placeholder mirrors the web shell so `vite build` and the jsdom test
 * environment are both exercised for this workspace too.
 */
export const DESKTOP_APP = '@smarttavern/desktop' as const;

/** See apps/web/src/index.ts — same scaffold marker, desktop flavour. */
export function bootstrap(): string {
  const root = document.querySelector('[data-app="smarttavern"]');
  const message = 'SmartTavern desktop shell — M0-T0 scaffold (no features yet).';
  if (root instanceof HTMLElement) root.textContent = message;
  return message;
}
