/**
 * The application shell: TanStack Router's route tree and the `<App/>` component
 * (M0-T8, ADR-017).
 *
 * WHY MEMORY HISTORY
 * The app is served from a single HTML file and the desktop shell loads the same
 * bundle from a `tauri://` origin. A memory history makes both of those work with no
 * server rewrite rules, and it is what the tests drive too — so the router the tests
 * exercise is the router the app runs, not a look-alike.
 *
 * WHY THE THREE ROUTES ARE DEFINED IN ONE FILE
 * `createRoute` needs the parent route object, so splitting them into three files
 * would add an import-cycle hazard for no gain at three routes. The VIEWS live in
 * `app/routes/*`, which is where the size actually is.
 *
 * WHY `<App/>` TAKES A ROUTER INSTEAD OF BUILDING ONE
 * `mount.ts` has to `await router.load()` BEFORE the first render, because TanStack
 * Router resolves the initial match asynchronously and `hydrateRoot` only flushes
 * React's own microtask queue. A component that built its own router would finish
 * loading after that flush and render an empty shell. Taking the router as a prop
 * keeps that ordering in the one place that mounts the app, and lets each test render
 * its own router at its own path.
 *
 * WHY THE LANGUAGE PICKER LIVES IN THE SHARED HEADER (M1-G1)
 * Every page renders `AppHeader`, so the picker is on every route by construction: a
 * control only reachable from the screen you are already reading is useless to the
 * person who cannot read it. The options come from `LOCALES` and their labels from
 * `LOCALE_LABELS` — each language's name IN ITS OWN LANGUAGE, deliberately never
 * translated (see `i18n/use-translation.ts`) — while the select's accessible name IS
 * translated, because a screen reader reads it in the active interface language.
 */
import { isLocale } from '@smarttavern/i18n';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  RouterProvider,
} from '@tanstack/react-router';
import { type ChangeEvent, useEffect } from 'react';
import { useTranslation } from '../i18n/use-translation';
import { useLocaleStore } from '../state/locale-store';
import { HomeRoute } from './routes/home';
import { PlayRoute } from './routes/play';
import { SetupRoute } from './routes/setup';
import './app.css';

const rootRoute = createRootRoute();

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
});

const playRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/play/$sessionId',
  component: PlayPage,
});

/**
 * The header every route shares: the product name, the language picker, and the only
 * link to the setup screen.
 *
 * WHY IT DOES NOT LOAD THE PERSISTED LOCALE ITSELF
 * The read is `<App/>`'s (see that component's comment): it is the ONE place every mount
 * path goes through, whereas this header is rendered by each page separately. What this
 * component needs from the store is exactly two fields — the locale to render in, and the
 * setter.
 */
function AppHeader() {
  const { t, locales, localeLabels, setLocale } = useTranslation();
  const current = useLocaleStore((state) => state.locale);

  const onLocaleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    if (!isLocale(raw)) return;
    // Not awaited: the store switches immediately and reports a write failure through
    // its own `error` field, so a slow or failing write cannot stall the UI
    // (`state/locale-store.ts` records why).
    void setLocale(raw);
  };

  return (
    <header className="app-header">
      <h1>{t('common.appName')}</h1>
      <nav className="app-nav">
        <Link to="/setup">{t('nav.settings')}</Link>
        <select
          className="locale-picker"
          aria-label={t('nav.language')}
          value={current}
          onChange={onLocaleChange}
        >
          {locales.map((locale) => (
            <option key={locale} value={locale}>
              {localeLabels[locale]}
            </option>
          ))}
        </select>
      </nav>
    </header>
  );
}

function HomePage() {
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <HomeRoute />
      </main>
    </>
  );
}

function SetupPage() {
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <SetupRoute />
      </main>
    </>
  );
}

function PlayPage() {
  const { sessionId } = playRoute.useParams();
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <PlayRoute sessionId={sessionId} />
      </main>
    </>
  );
}

export const routeTree = rootRoute.addChildren([homeRoute, setupRoute, playRoute]);

/** A router over the tree, starting at `initialPath`. A factory so each test is fresh. */
export function createAppRouter(initialPath = '/') {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    // Scroll restoration calls `window.scrollTo`, which jsdom does not implement. The
    // app has one scroll container and no route-level scroll expectations in M0, so
    // turning it off removes a jsdom-only failure mode rather than hiding a real one.
    scrollRestoration: false,
  });
}

/**
 * The root component. The router is INJECTED rather than built here so `mount.ts`
 * can await its first load before rendering — see the file header.
 *
 * WHY THE STORED LANGUAGE IS READ HERE AND NOT IN `mountApp`
 * Restoring the persisted preference is an app-startup concern, but `mount.ts` is only
 * ONE of the ways `<App/>` is reached: a test renders it directly, and a future embedder
 * (the desktop shell's own frame, a storybook-style harness) would too. Putting the read
 * in a mount effect here covers EVERY path by construction, and it is how this app
 * already loads its other stores — a component effect calling `useXStore.getState()`.
 * The read only REFINES the store's constructed value (which is already a usable
 * language from `navigator.languages`), so it is safe for it to land after the first
 * paint; `state/locale-store.ts`'s `loadToken` is what makes it safe for it to land after
 * a user has already clicked the picker.
 */
export function App({ router }: { router: ReturnType<typeof createAppRouter> }) {
  const loadLocale = useLocaleStore((state) => state.load);

  useEffect(() => {
    void loadLocale();
  }, [loadLocale]);

  return <RouterProvider router={router} />;
}
