/**
 * `mountApp(root, options)` — where the app is attached to a DOM element (M0-T8).
 *
 * WHY THIS IS NOT `index.ts`
 * `apps/desktop` wraps this bundle in a Tauri WebView, and it must not inherit a
 * `document.querySelector('#root')` that it does not own. It calls `mountApp` with its
 * own element and, when a vendor blocks browser CORS, its own `transport`
 * (ADR-003, HANDOFF §9 item 9). So the browser-specific lookup lives in `index.ts` and
 * this module stays a function of its arguments.
 *
 * WHY THE FIRST RENDER AWAITS `router.load()`
 * TanStack Router resolves the initial route match asynchronously. `createRoot` flushes
 * React's microtask queue and then stops, so rendering before the match resolves paints
 * an empty shell until a later store notification fills it. Awaiting the load makes the
 * very first paint the real view.
 *
 * WHY `createRoot` AND NOT `hydrateRoot`
 * The mount point is an EMPTY `<div id="root">` — this app renders no server-side HTML —
 * and hydrating an empty container makes React report a hydration mismatch on every
 * load. Hydration is for a server-rendered tree, which M0 has none of.
 *
 * WHY THIS FILE IS `.ts` AND CONTAINS NO JSX
 * It renders exactly one element, and `createElement` spells it. That keeps the seam
 * where it belongs: every component lives under `app/`, this file is a plain function
 * of its arguments, and the `jsx` compiler option stays a concern of the `.tsx` files
 * that actually contain markup.
 *
 * WHY THE DATABASE IS OPENED HERE
 * `MountOptions.databaseName` is how the acceptance test opens the app twice over the
 * same database ("restart and the data is still there"). It has to be applied before
 * anything reads, so it is the first statement of the function, and `db/database.ts`
 * records that the name is applied ONCE per mount.
 */
import type { FetchLike } from '@smarttavern/providers';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createAppRouter } from './app/app';
import { resetDatabase } from './db/database';
import { defaultTransport } from './platform/transport';
import { configureChat } from './state/chat-store';
import { configureCoCreate } from './state/co-create-store';

export interface MountOptions {
  /** Transport override. `apps/desktop` injects its Rust-side HTTP client here. */
  transport?: FetchLike;
  /** Database name. Defaults to `smarttavern` (`packages/storage`'s `DATABASE_NAME`). */
  databaseName?: string;
}

/**
 * The database and store handles the mounted app uses, re-exported for TESTS.
 *
 * WHY A RE-EXPORT AND NOT `import { … } from './state/chat-store'` IN A TEST
 * Vitest instantiates a module once per ENVIRONMENT, and this workspace mixes them:
 * `apps/web` opts into jsdom per file, so a store reached through one import graph can
 * be a DIFFERENT OBJECT from the store the mounted components read. A test that seeded
 * the other instance would set state that nothing renders and then assert against an
 * empty view — a green-looking failure, which is the worst kind.
 *
 * Taking the handle from this module makes the test and the components share one
 * instance by construction. It is not a production concern: a bundle has exactly one
 * module instance, and `index.test.ts` pins that the real mount renders.
 */
export { closeDatabase, resetDatabase, subscribe } from './db/database';
export { resetAppearanceStore, useAppearanceStore } from './state/appearance-store';
export { configureChat, resetChat, useChatStore } from './state/chat-store';
export {
  coCreateRequests,
  configureCoCreate,
  resetCoCreate,
  useCoCreateStore,
} from './state/co-create-store';
export { resetContentStore, useContentStore } from './state/content-store';
export { resetLocaleStore, useLocaleStore } from './state/locale-store';
export { resetSettingsStore, useSettingsStore } from './state/settings-store';

/**
 * Mount the app into `root` and return the router it created.
 *
 * The router is returned rather than kept private so a caller (a test, a future
 * desktop shell) can navigate without going through the DOM.
 *
 * WHERE THE STORED LANGUAGE IS RESTORED, AND WHY IT IS NOT HERE
 * `<App/>` reads it in a mount effect (`app/app.tsx` records the reasoning): this
 * function is only one of the ways the tree is reached, and a test that renders `<App/>`
 * directly must get the same startup behaviour as the browser entry. Duplicating the read
 * here would mean two `load()` calls racing on start-up for no benefit.
 *
 * NOTE ON `export … from` BELOW: the re-exports for tests do NOT create local bindings,
 * so this file must IMPORT anything it also calls — see the import block above. The two
 * shapes look identical at a glance and the mistake is a `ReferenceError` at runtime.
 */
export function mountApp(root: HTMLElement, options: MountOptions = {}) {
  if (options.databaseName !== undefined) resetDatabase(options.databaseName);
  const transport = options.transport ?? defaultTransport();
  configureChat({ transport });
  // The co-creation panel talks to the same provider through its own store (it has no session and no
  // transcript), so it is wired to the SAME transport object here — one place decides what the app
  // sends with, and a screen cannot end up on a different transport from its sibling.
  configureCoCreate({ transport });

  const router = createAppRouter();
  // `load()` resolves the first match; the render below is therefore the real view.
  void router.load().then(() => {
    createRoot(root).render(createElement(App, { router }));
  });
  return router;
}
