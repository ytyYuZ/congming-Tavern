#!/usr/bin/env node
/**
 * Generate `schema/package-1.json` from the Zod definition in `packages/schema`.
 *
 * WHY THIS GOES THROUGH VITE: the workspace consumes `@smarttavern/schema` as
 * TypeScript *source*, and those sources use extension-less relative imports
 * (tsconfig `moduleResolution: bundler`). Node's own ESM resolver cannot follow
 * them, so this script hands the module graph to Vite — which is already a root
 * devDependency — instead of adding a second TS runner.
 *
 * WHY THE CONVERSION LIVES IN THE SCHEMA PACKAGE: `z.toJSONSchema` needs `zod`,
 * which is a dependency of `packages/schema`, not of the repository root. Doing
 * the conversion here would mean importing `zod` from a workspace that does not
 * declare it (and would break under pnpm's default isolated linker in CI).
 *
 * Usage:  pnpm schema:export
 * Verify: `packages/schema/src/json-schema.test.ts` fails if the committed
 *         artifact drifts from the Zod source, so a hand-edited schema cannot
 *         survive CI.
 *
 * NOTE for sandboxed Windows hosts: run it as `pnpm schema:export` (which is what
 * CI runs); on a host that denies Vite's `net use` probe, preload
 * `tools/scripts/vite-sandbox-probe-shim.mjs` via NODE_OPTIONS, exactly like
 * `pnpm ci:local` does.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const server = await createServer({
  root: repoRoot,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});

try {
  const schema = await server.ssrLoadModule('/packages/schema/src/index.ts');

  for (const artifact of schema.JSON_SCHEMA_ARTIFACTS) {
    const target = join(repoRoot, artifact.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.build(), 'utf8');
    console.log(`[schema-export] wrote ${artifact.path}`);
  }
} finally {
  await server.close();
}
