/**
 * Automated dependency-direction check — M0-T0 item 5 (the authoritative one).
 *
 * Invariant (HANDOFF §4.1 #4, docs/06-开发任务拆解.md §0.2):
 *
 *     packages/schema ← packages/core ← {providers, storage, rules, packages,
 *     importers} ← apps/*
 *
 * Biome carries the same rule per package (biome.json → overrides →
 * `noRestrictedImports`), but a lint rule only sees what a developer wrote in
 * one file. This script walks the REAL import graph of every workspace, so it
 * additionally catches:
 *   • deep imports — "@smarttavern/core/engine/prompt" must not leak upward;
 *   • imports of a package the workspace never declared in its package.json;
 *   • any NEW internal package nobody remembered to add a lint rule for
 *     (discoverWorkspaces + a layer map with no silent default).
 *
 * Wired into the `lint` job: `pnpm lint` = `biome check .` + this script.
 *
 * ── How to prove it turns red (documented verification, ~30 seconds) ────────
 *   1. Add this line to packages/core/src/index.ts:
 *          import '@smarttavern/storage';
 *   2. Run `pnpm lint` (or `node tools/scripts/check-dependency-direction.mjs`).
 *      Expected: non-zero exit and a report such as
 *          [deps] 1 dependency-direction violation(s):
 *            - packages/core/src/index.ts:4
 *              packages/core (layer "packages/core") must not import @smarttavern/storage [packages/storage]
 *              allowed from packages/core: packages/schema
 *   3. Revert the line; `pnpm lint` is green again.
 *   The same experiment runs automatically in
 *   tools/scripts/check-dependency-direction.test.mjs (`pnpm test`), which fails
 *   if this checker ever stops reporting violations.
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = configuration error.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

/** Internal scope. Everything SmartTavern ships lives under it. */
const SCOPE = '@smarttavern/';

/** Repository root. The check is always invoked from there (pnpm lint). */
const repoRoot = process.cwd();

/**
 * THE layer map. Keys are workspace directories (`<group>/<name>`), values are
 * the workspaces a workspace may import. `'*'` means "any internal package".
 *
 * This encodes docs/02-技术架构.md §1 (three invariants) and §3/§5 with the
 * task list's §0.2 wording. Relaxing an entry needs an ADR in
 * docs/05-决策记录.md — do not edit it casually.
 */
export const ALLOWED = {
  // packages/schema — the frozen contract at the bottom of the graph.
  'packages/schema': [],

  // packages/core — domain + engines: schema only. Being DOM-free (invariant
  // #1) is enforced twice: tsconfig.core.json drops the DOM lib (typecheck
  // fails on `window`), Biome noRestrictedGlobals bans the globals at lint time.
  'packages/core': ['packages/schema'],

  // Adapter layer — schema + core only, never a sibling adapter.
  'packages/providers': ['packages/schema', 'packages/core'],
  'packages/storage': ['packages/schema', 'packages/core'],
  'packages/rules': ['packages/schema', 'packages/core'],
  'packages/packages': ['packages/schema', 'packages/core'],
  'packages/importers': ['packages/schema', 'packages/core'],

  // Shared presentation + locale data. The docs fix the direction of the five
  // chains above but never place ui/i18n, so the narrower reading was chosen:
  // they are leaves that may use schema+core, and nothing may import them.
  // (Recorded as an open decision in CONTRIBUTING.md §6.)
  'packages/ui': ['packages/schema', 'packages/core'],
  'packages/i18n': ['packages/schema', 'packages/core'],

  // UI shells — top of the graph, free to wire everything together.
  'apps/web': '*',
  'apps/desktop': '*',

  // Tools are leaves too: they consume the libraries, never the reverse.
  'tools/stpack-cli': '*',
};

/** Groups whose direct children may be workspaces. */
const WORKSPACE_GROUPS = ['packages', 'apps', 'tools'];

/** Directories never scanned (mirrors biome.json `files.includes`). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.pnpm-store',
  '.npm-cache',
  '.git',
  'src-tauri',
]);

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
/** Declaration files are generated; skip them but keep real sources visible. */
const SKIP_FILE = /\.d\.ts$/;

/**
 * Static import forms we recognise. A regex is sufficient because only the
 * module specifier and its position matter, and any form missed here still
 * fails in `tsc`, Vite or Biome. `import type …` counts as a dependency on
 * purpose: invariant #2 says entity types may only come from packages/schema.
 *
 * Each pattern is anchored to ONE line with [^\n] classes and \n anchors. That
 * is not cosmetic: the side-effect form `import 'm'` would otherwise match an
 * `import` at the end of a line plus a quoted string on a LATER line, which
 * silently invents imports (and would have made this checker report violations
 * that do not exist).
 */
const IMPORT_PATTERNS = [
  /^[ \t]*import\s+[^\n'"();]*?from\s*['"]([^'\n"]+)['"]/gm, // import x from 'm'
  /^[ \t]*import\s*['"]([^'\n"]+)['"]/gm, // import 'm' (side effect)
  /^[ \t]*export\s+[^\n'"();]*?from\s*['"]([^'\n"]+)['"]/gm, // export … from 'm'
  /(?:^|[^.\w$])import\s*\(\s*['"]([^'\n"]+)['"]\s*\)/gm, // await import('m')
  /(?:^|[^.\w$])require\s*\(\s*['"]([^'\n"]+)['"]\s*\)/gm, // require('m')
];

const toPosix = (p) => p.split(sep).join(posix.sep);

/** Recursively collect source files below an absolute directory. */
export function collectSourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectSourceFiles(abs));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Discover workspaces: `<group>/<name>` → { name, declared } where `declared`
 * is the set of internal package short names listed in its package.json.
 * A directory counts as a workspace only when it has a package.json.
 */
export function discoverWorkspaces(root = repoRoot) {
  const found = new Map();
  for (const group of WORKSPACE_GROUPS) {
    let entries;
    try {
      entries = readdirSync(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relDir = `${group}/${entry.name}`;
      let manifest;
      try {
        manifest = JSON.parse(
          readFileSync(join(root, relDir, 'package.json'), { encoding: 'utf8' }),
        );
      } catch {
        continue;
      }
      const declared = new Set(
        [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
        ]
          .filter((name) => name.startsWith(SCOPE))
          .map((name) => name.slice(SCOPE.length)),
      );
      found.set(relDir, { relDir, name: manifest.name, declared });
    }
  }
  return found;
}

/**
 * Extract every literal module specifier from a source string, in SOURCE ORDER.
 * Order matters: the violation report quotes the first offending line, and a
 * checker whose output depends on pattern iteration order is harder to trust.
 */
export function extractSpecifiers(source) {
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push({ index: match.index ?? 0, specifier: match[1] });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((entry) => entry.specifier);
}

/**
 * Pure core: check one file's import specifiers against the layer map.
 * `nameToWorkspace` maps a short package name ("storage") to its workspace dir.
 * Returns a list of multi-line violation reports (empty = clean).
 */
export function checkSpecifiersForLayer({
  relFile,
  source,
  relDir,
  allowed = ALLOWED,
  nameToWorkspace,
}) {
  const policy = allowed[relDir];
  if (policy === undefined) {
    return [
      `${relDir}: missing from the layer map in tools/scripts/check-dependency-direction.mjs.\n    Add the new workspace explicitly — an unknown package must never be allowed silently.`,
    ];
  }
  if (policy === '*') return [];

  const permitted = new Set(policy);
  const violations = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const spec of extractSpecifiers(line)) {
      if (!spec.startsWith(SCOPE)) continue;
      const shortName = spec.slice(SCOPE.length).split('/')[0];
      if (!shortName) continue;
      const targetWs = nameToWorkspace?.get(shortName) ?? `${'packages'}/${shortName}`;
      if (permitted.has(targetWs)) continue;
      violations.push(
        [
          `${relFile}:${index + 1}`,
          `${relDir} (layer "${relDir}") must not import ${spec} [${targetWs}]`,
          `allowed from ${relDir}: ${policy.length === 0 ? '(no internal package)' : policy.join(', ')}`,
        ].join('\n    '),
      );
    }
  });
  return violations;
}

function buildNameIndex(workspaces) {
  const index = new Map();
  for (const [relDir, info] of workspaces) {
    if (typeof info.name === 'string' && info.name.startsWith(SCOPE)) {
      index.set(info.name.slice(SCOPE.length), relDir);
    }
  }
  return index;
}

/** Check one workspace that exists on disk. */
export function checkWorkspaceDir({ relDir, root = repoRoot, allowed = ALLOWED, nameToWorkspace }) {
  const files = collectSourceFiles(join(root, relDir));
  const index = nameToWorkspace ?? buildNameIndex(discoverWorkspaces(root));
  const violations = [];
  for (const abs of files) {
    violations.push(
      ...checkSpecifiersForLayer({
        relFile: toPosix(relative(root, abs)),
        source: readFileSync(abs, { encoding: 'utf8' }),
        relDir,
        allowed,
        nameToWorkspace: index,
      }),
    );
  }
  return violations;
}

/** Walk every discovered workspace and return a flat list of violations. */
export function checkAll(root = repoRoot) {
  const workspaces = discoverWorkspaces(root);
  const index = buildNameIndex(workspaces);
  const violations = [];
  for (const relDir of workspaces.keys()) {
    violations.push(...checkWorkspaceDir({ relDir, root, nameToWorkspace: index }));
  }
  return violations;
}

function main() {
  let workspaces;
  let violations;
  try {
    workspaces = discoverWorkspaces();
    violations = checkAll();
  } catch (error) {
    console.error('[deps] configuration error:', error);
    process.exit(2);
  }
  if (violations.length > 0) {
    console.error(`[deps] ${violations.length} dependency-direction violation(s):`);
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error(
      '\n[deps] Invariant (HANDOFF §4.1 #4): schema <- core <- {providers, storage, rules, packages, importers} <- apps/*',
    );
    process.exit(1);
  }
  console.log(
    `[deps] OK — ${workspaces.size} workspaces respect the dependency direction (schema <- core <- adapters <- apps).`,
  );
}

main();
