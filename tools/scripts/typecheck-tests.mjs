#!/usr/bin/env node
//
// Typecheck the TEST files, which `tsc -b` deliberately does not see.
//
// WHY THIS EXISTS
// Every workspace's tsconfig.json carries an `exclude` for its test files, so the
// project graph the CI `typecheck` job builds contains no test file at all. Vitest
// only TRANSPILES tests — it strips types without checking them — so a type error
// inside a test stays invisible until it fails at runtime. That is not theoretical:
// a helper called with the wrong argument shape typechecked clean and blew up in the
// middle of a suite, and the same blind spot forced one agent to hand-build a
// throwaway tsconfig just to check its own new assertions.
//
// HOW
// Each workspace has a sibling tsconfig.test.json that extends its own config and
// puts the tests back. Per workspace rather than one root-level project on purpose:
// packages/core extends tsconfig.core.json, which REMOVES the DOM lib to keep core
// browser-free (HANDOFF §4.1). A single root project would hand core's tests the DOM
// back — weakening the very constraint that config exists to keep.
//
// A workspace without a tsconfig.test.json is simply not checked, so the file is the
// opt-in. Discovery FAILS LOUDLY when it finds none, because a rename that silently
// drops all coverage is worse than no coverage: the job would stay green while
// checking nothing.
//
// NOTE FOR EDITORS: this header uses line comments, not a block comment, because a
// glob like the test-file pattern contains the characters that end a block comment.
//
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_ROOTS = ['packages', 'apps', 'tools'];
const CONFIG_NAME = 'tsconfig.test.json';

/** Run one command with inherited stdio; resolves to its exit code. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

const configs = [];
for (const root of WORKSPACE_ROOTS) {
  const dir = join(process.cwd(), root);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const config = join(dir, entry.name, CONFIG_NAME);
    if (existsSync(config)) configs.push(config);
  }
}

if (configs.length === 0) {
  console.error(
    `[types] ERROR — no ${CONFIG_NAME} found under ${WORKSPACE_ROOTS.join('/')}; ` +
      'test files would go unchecked without anybody noticing.',
  );
  process.exit(1);
}

const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const failed = [];
for (const config of configs) {
  if ((await run(process.execPath, [tsc, '-p', config])) !== 0) failed.push(config);
}

if (failed.length > 0) {
  console.error(`\n[types] ${failed.length} test project(s) failed to typecheck:`);
  for (const config of failed) console.error(`  - ${config}`);
  process.exit(1);
}

console.log(`[types] OK — ${configs.length} test projects typecheck clean.`);
