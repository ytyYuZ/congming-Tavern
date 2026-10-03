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
 *
 * WHY THE APPEARANCE IS PROJECTED HERE TOO (M1-G2)
 * `<App/>` is the ONE component every mount path goes through, so it is where both
 * startup reads are started and where the appearance projection is mounted. The
 * projection is a child element (`<AppearanceEffect/>`) rather than a hook called here,
 * so its three store subscriptions cannot re-render the shell or the router tree.
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
import { useAppearanceEffect } from '../appearance/use-appearance-effect';
import { useTranslation } from '../i18n/use-translation';
import { useAppearanceStore } from '../state/appearance-store';
import { useChatStore } from '../state/chat-store';
import { useLocaleStore } from '../state/locale-store';
import { CharacterRoute } from './routes/character';
import { CharactersRoute } from './routes/characters';
import { HomeRoute } from './routes/home';
import { NewSessionRoute } from './routes/new-session';
import { PlayRoute } from './routes/play';
import { SetupRoute } from './routes/setup';
import { WorldRoute } from './routes/world';
import { WorldsRoute } from './routes/worlds';
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
 * Creating a session (M1-S1).
 *
 * WHY THIS IS A ROUTE OF ITS OWN AND NOT A MODE OF `/`: the create flow is a form over the two
 * card libraries — a world VERSION, a set of cards, a designation, a clock — so it has its own
 * address, and a reload, a bookmark and the back button all behave (`worlds.tsx`'s two editors
 * are split the same way). It also moves the WRITE out of the home view: 「新建会话」 there is a
 * LINK, and the row is written only when this screen's form is submitted.
 */
const newSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/new',
  component: NewSessionPage,
});

/**
 * The two card libraries and their editors (M1-W1 / M1-C1).
 *
 * WHY THEY ARE FOUR ROUTES AND NOT TWO: a library is a LIST and an editor is a DOCUMENT, and the
 * editor's lifetime is tied to the id in the address — so a reload, a bookmark and the back button
 * all land on the same card the same way the play screen's session does. A single route with a
 * mode flag would have to invent that state, and it would lose the URL.
 */
const worldsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/worlds',
  component: WorldsPage,
});

const worldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/worlds/$worldId',
  component: WorldPage,
});

const charactersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/characters',
  component: CharactersPage,
});

const characterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/characters/$characterId',
  component: CharacterPage,
});

/**
 * The header every route shares: the product name, the language picker, the session links, and the
 * only link to the setup screen.
 *
 * WHY IT DOES NOT LOAD THE PERSISTED LOCALE ITSELF
 * The read is `<App/>`'s (see that component's comment): it is the ONE place every mount
 * path goes through, whereas this header is rendered by each page separately. What this
 * component needs from the store is exactly two fields — the locale to render in, and the
 * setter.
 *
 * WHY IT IS NOT EXPORTED FOR TESTS (it briefly was). The acceptance fix A1 was first tested by
 * rendering this component alone, which turned out to be the wrong shape three times over: `<Link>`
 * needs router context, the locale store's initial value follows the BROWSER (jsdom reports
 * `en-US`, so the labels under test were English), and a seeded session is a real row. Its
 * assertions now live in `app/routes/routes.test.tsx`, which mounts the real `<App/>` on the very
 * library screen where the missing link was reported — so no seam is needed and this stays private.
 */
function AppHeader() {
  const { t, locales, localeLabels, setLocale } = useTranslation();
  const current = useLocaleStore((state) => state.locale);
  /**
   * The session this tab has open, read from the store rather than from the route (acceptance fix
   * A1). `AppHeader` is rendered by every page, so it cannot know which session the user came from;
   * the store can, because `chat-store` is module-level and survives navigation. Named
   * `openSession` rather than `current` because `current` above is the locale.
   */
  const openSession = useChatStore((state) => state.session);

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
        {/* The two ways OUT of an editor (acceptance fix A1). Before this, the header offered the
            two libraries and Settings only, so a user who opened a world or a character card had no
            way back to their session: `/play/$sessionId` needs an id, and only the store knows it.
            The list link is always there; the session link appears only when one is open, because
            without an id there is nothing honest to point at. */}
        <Link to="/">{t('nav.sessions')}</Link>
        {openSession === undefined ? null : (
          <Link to="/play/$sessionId" params={{ sessionId: openSession.id }}>
            {t('nav.currentSession')}
          </Link>
        )}
        {/* The two card libraries (M1-W1 / M1-C1) sit beside the setup link, because a library is
            something a user goes TO rather than something a screen offers. */}
        <Link to="/worlds">{t('nav.worlds')}</Link>
        <Link to="/characters">{t('nav.characters')}</Link>
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

function NewSessionPage() {
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <NewSessionRoute />
      </main>
    </>
  );
}

function WorldsPage() {
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <WorldsRoute />
      </main>
    </>
  );
}

function WorldPage() {
  const { worldId } = worldRoute.useParams();
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <WorldRoute worldId={worldId} />
      </main>
    </>
  );
}

function CharactersPage() {
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <CharactersRoute />
      </main>
    </>
  );
}

function CharacterPage() {
  const { characterId } = characterRoute.useParams();
  return (
    <>
      <AppHeader />
      <main className="app-main">
        <CharacterRoute characterId={characterId} />
      </main>
    </>
  );
}

export const routeTree = rootRoute.addChildren([
  homeRoute,
  setupRoute,
  newSessionRoute,
  playRoute,
  worldsRoute,
  worldRoute,
  charactersRoute,
  characterRoute,
]);

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
 * The appearance projection (M1-G2), isolated in a component that renders nothing.
 *
 * WHY IT IS A CHILD AND NOT A HOOK CALLED BY `<App/>`: `useAppearanceEffect` subscribes to
 * the theme, the font scale and the message width, so whatever calls it re-renders on
 * every step of a slider drag. Rendering it as a sibling of the router keeps that
 * subscription — and those re-renders — out of the shell and the route tree.
 */
function AppearanceEffect() {
  useAppearanceEffect();
  return null;
}

/**
 * The root component. The router is INJECTED rather than built here so `mount.ts`
 * can await its first load before rendering — see the file header.
 *
 * WHY THE STORED LANGUAGE AND APPEARANCE ARE READ HERE AND NOT IN `mountApp`
 * Restoring the persisted preferences is an app-startup concern, but `mount.ts` is only
 * ONE of the ways `<App/>` is reached: a test renders it directly, and a future embedder
 * (the desktop shell's own frame, a storybook-style harness) would too. Putting the reads
 * in a mount effect here covers EVERY path by construction, and it is how this app
 * already loads its other stores — a component effect calling `useXStore.getState()`.
 * Each read only REFINES the store's constructed value (which is already usable: a
 * language from `navigator.languages`, an appearance of `system`/1/85), so it is safe for
 * it to land after the first paint; `state/locale-store.ts`'s `loadToken` and the same
 * guard in `state/appearance-store.ts` are what make it safe for it to land after a user
 * has already moved a control.
 */
export function App({ router }: { router: ReturnType<typeof createAppRouter> }) {
  const loadLocale = useLocaleStore((state) => state.load);
  const loadAppearance = useAppearanceStore((state) => state.load);

  useEffect(() => {
    void loadLocale();
    void loadAppearance();
  }, [loadLocale, loadAppearance]);

  return (
    <>
      <AppearanceEffect />
      <RouterProvider router={router} />
    </>
  );
}
