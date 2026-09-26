/**
 * Vite config for the desktop shell (M0-T0).
 *
 * Tauri 2 loads a static bundle from a local path, so the base must be relative
 * and the output directory is fixed. Until Tauri is wired (M0-T8) this config
 * produces the same static shell, which keeps `pnpm build` meaningful and lets
 * CI catch asset-path regressions from day one.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  // Rust serves the assets from a local path: absolute "/assets/..." would 404.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
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
