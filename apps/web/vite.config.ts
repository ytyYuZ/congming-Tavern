/**
 * Vite config for the web shell (M0-T0).
 *
 * The framework decision (docs/02-技术架构.md D2, ADR-005) is still open —
 * Svelte 5 is the recommendation, React 19 the alternative — so this config
 * deliberately installs no framework plugin. Whichever wins adds one line here
 * plus its dependency; the workspace wiring below does not change.
 *
 * Workspace packages are consumed as TypeScript SOURCE during M0 (their
 * package.json `exports` point at `./src/index.ts`), so Vite must be told to
 * pre-bundle them like local files rather than like closed npm packages.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  // Importing `@smarttavern/...` from a dev server would otherwise optimize the
  // dependency as a prebuilt package and miss source edits.
  optimizeDeps: {
    exclude: [
      '@smarttavern/schema',
      '@smarttavern/core',
      '@smarttavern/providers',
      '@smarttavern/storage',
      '@smarttavern/rules',
      '@smarttavern/packages',
      '@smarttavern/importers',
      '@smarttavern/ui',
      '@smarttavern/i18n',
    ],
  },
});
