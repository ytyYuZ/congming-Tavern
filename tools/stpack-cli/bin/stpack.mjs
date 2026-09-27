#!/usr/bin/env node
/**
 * Runnable wrapper for `stpack`.
 *
 * WHY THIS IS A `.mjs` FILE THAT LOADS TYPESCRIPT THROUGH VITE: during M0 the
 * workspace consumes every package as TypeScript *source*, and those sources use
 * extension-less relative imports (tsconfig `moduleResolution: bundler`) that
 * Node's own ESM resolver cannot follow. Handing the module graph to Vite —
 * already a root devDependency — avoids adding a second TypeScript runner or a
 * build step just to execute a CLI.
 *
 * Usage:  pnpm stpack -- <command> [args]   (see `src/cli.ts` for the commands)
 *
 * NOTE for sandboxed Windows hosts: this loads a Vite config, so on a host that
 * denies Vite's `net use` probe, preload
 * `tools/scripts/vite-sandbox-probe-shim.mjs` via NODE_OPTIONS exactly like
 * `pnpm ci:local` does.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const server = await createServer({
  root: repoRoot,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});

try {
  const cli = await server.ssrLoadModule('/tools/stpack-cli/src/cli.ts');
  process.exitCode = await cli.main(process.argv.slice(2));
} finally {
  await server.close();
}
