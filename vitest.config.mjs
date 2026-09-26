/**
 * Vitest workspace configuration (M0-T0).
 *
 * WHY THIS FILE IS PLAIN JAVASCRIPT (.mjs) AND NOT vitest.config.ts:
 * a TypeScript config must be bundled before it can be read, and bundling needs
 * a transform step. A `.mjs` config is imported directly by Node, so `pnpm test`
 * works on every host — including ones that forbid the child processes some
 * transformers spawn. The `projects` list is plain data, so TypeScript buys
 * nothing here. The tests themselves are still TypeScript and are transformed
 * by the runner.
 *
 * WHY THE PROJECTS ARE LISTED EXPLICITLY: two reasons, both learned the hard
 * way. (1) A `tools/*` glob also matched `tools/schema-export`, which is a
 * placeholder directory without a package.json; (2) Vitest treats a bare
 * directory containing `vite.config.*` as a project and derives the project name
 * from the last path segment, so `apps/*` and explicit `apps/web` collide as
 * "web" and "scripts" was matched twice. An explicit list is boring and correct;
 * adding a workspace is one line.
 *
 * Every workspace is a Vitest project, so one `pnpm test` covers the monorepo
 * while still allowing a per-workspace environment override (apps/* opt into
 * jsdom with the `@vitest-environment` docblock).
 *
 * `pool` is NOT set here: a root-level `test.pool` is not inherited by the
 * projects (they resolve their own config), so the worker pool is chosen with
 * `--pool=threads` in the package.json scripts instead. Threads run in-process,
 * which keeps the suite working on hosts that forbid spawned processes.
 *
 * The dependency-direction check itself runs in the `lint` job
 * (tools/scripts/check-dependency-direction.mjs) and is covered by
 * tools/scripts/check-dependency-direction.test.mjs.
 */
export default {
  test: {
    projects: [
      'packages/schema',
      'packages/core',
      'packages/providers',
      'packages/storage',
      'packages/rules',
      'packages/packages',
      'packages/importers',
      'packages/ui',
      'packages/i18n',
      'apps/web',
      'apps/desktop',
      'tools/stpack-cli',
      'tools/scripts',
    ],
    // Contracts in packages/schema are frozen and imported by everyone: a test
    // that only passes once is worthless, so make accidental `.only` fatal.
    allowOnly: false,
    // A project with no test files is a mistake, not a pass.
    passWithNoTests: false,
  },
};
