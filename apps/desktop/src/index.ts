/**
 * @smarttavern/desktop — the desktop entry point (M0-T8).
 *
 * WHAT THIS FILE IS: three lines of wiring. The desktop app is NOT a second UI —
 * `apps/web` owns the interface (docs/02-技术架构.md §3), and the shell's only job
 * is to mount that UI with a native transport injected. Keeping the entry this
 * small is the point: it is the boundary where "the desktop build is the web build
 * plus native capability" is either true or a lie, and a reviewer can check it at a
 * glance.
 *
 * WHY THE TRANSPORT IS INJECTED AND NOT DETECTED. `mountApp` accepts a `FetchLike`,
 * so the desktop passes one that goes through Rust (bypassing CORS, HANDOFF §9 item
 * 9) and the browser build passes nothing at all. A runtime `isTauri()` check inside
 * the UI would put platform branching in the layer that is supposed to be
 * platform-free; injecting at the entry point keeps that decision where the
 * platform is actually known.
 *
 * WHY `root` IS ASSERTED AND NOT CREATED. `index.html` owns the root element (the same
 * `#root` the web build ships), so a missing one is a build mistake worth failing
 * loudly on rather than a blank app.
 *
 * WHY THE IMPORT IS THE `./mount` SUBPATH AND NOT THE PACKAGE ROOT. `@smarttavern/web`'s
 * main entry is the BROWSER bootstrap: importing it would run its own
 * `document.querySelector('#root')` and mount a second React root into this very
 * document. The package therefore exposes `./mount` (the function) separately from `.`
 * (the bootstrap), and the desktop shell imports the function.
 */
import { mountApp } from '@smarttavern/web/mount';
import { createTauriFetch } from './transport/tauri-fetch';

/** The element id `index.html` provides, identical to the web shell's. */
export const DESKTOP_ROOT_SELECTOR = '#root';

/** Mount the web UI with the desktop transport. Returns the root it mounted into. */
export function bootstrap(): HTMLElement {
  const root = document.querySelector(DESKTOP_ROOT_SELECTOR);
  if (!(root instanceof HTMLElement)) {
    throw new Error(`the shell markup is missing ${DESKTOP_ROOT_SELECTOR}`);
  }
  mountApp(root, { transport: createTauriFetch() });
  return root;
}

// The module is the entry point: `index.html` loads it as a module script, so
// mounting happens on import. A failure is logged rather than swallowed: a desktop
// window with nothing in it and no explanation is the worst possible outcome.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => run());
} else {
  run();
}

function run(): void {
  try {
    bootstrap();
  } catch (cause) {
    console.error('[smarttavern] the desktop shell could not start', cause);
  }
}
