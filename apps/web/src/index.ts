/**
 * The browser entry point (M0-T8).
 *
 * WHY THE MOUNT IS SEPARATE FROM THE ENTRY
 * `apps/desktop` wraps the same bundle and must be able to import `mountApp` and hand
 * it its own root element and its own transport (the Rust-side HTTP client that dodges
 * vendor CORS — ADR-003, HANDOFF §9 item 9) without this module reaching for
 * `document` at import time. So `index.ts` is the only file that knows about `#root`.
 *
 * WHY IT WAITS FOR THE DOM
 * The script tag is a module, so it runs after the HTML above it has been parsed —
 * but only when the tag is in `<head>` with `defer` semantics, and a future bundler
 * setting can change that. Waiting for `DOMContentLoaded` when the document is still
 * loading makes the mount order-independent, and keeps an import of this module in a
 * test process from mounting anything.
 */
import { mountApp } from './mount';

function mount(): void {
  const root = document.querySelector('#root');
  if (root instanceof HTMLElement) mountApp(root);
  else console.error('@smarttavern/web: no #root element in the document — nothing mounted');
}

if (document.readyState === 'loading')
  window.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
