/**
 * Vite config for the desktop shell (M0-T8).
 *
 * TWO THINGS ARE DIFFERENT FROM apps/web, and both exist because Tauri is now real:
 *
 * 1. `server.port = 1420` with `strictPort`. `tauri.conf.json`'s `devUrl` points at
 *    `http://localhost:1420`, so a Vite that quietly falls back to 1421 (its default
 *    behaviour when the port is taken) would leave `tauri dev` staring at a blank
 *    window while a dev server that cannot be reached sits on another port. Failing
 *    to start is the better outcome.
 * 2. `base: './'`. Tauri loads the production bundle from a custom protocol rooted
 *    at the dist directory, where an absolute `/assets/...` path does not resolve.
 *
 * The dev server binds to loopback only: this is a local-first app whose dev server
 * has no business being reachable from the network.
 */
import { defineConfig } from 'vite';

/** Must match `build.devUrl` in `src-tauri/tauri.conf.json`. */
const TAURI_DEV_PORT = 1420;

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: TAURI_DEV_PORT,
    strictPort: true,
    // Tauri's webview can otherwise keep a stale module graph alive across a Rust
    // restart, which reads as "my edit did nothing".
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  // Workspace packages are consumed as TypeScript SOURCE during M0 (their
  // package.json `exports` point at `./src/index.ts`), so Vite must not pre-bundle
  // them like closed npm packages.
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
      '@smarttavern/web',
    ],
  },
});
