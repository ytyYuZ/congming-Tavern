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
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  RouterProvider,
} from '@tanstack/react-router';
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

/** The header every route shares, including the only link to the setup screen. */
function AppHeader() {
  return (
    <header className="app-header">
      <h1>聪明酒馆 SmartTavern</h1>
      <Link to="/setup">设置</Link>
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
 */
export function App({ router }: { router: ReturnType<typeof createAppRouter> }) {
  return <RouterProvider router={router} />;
}
