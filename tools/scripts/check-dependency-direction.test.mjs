/**
 * Tests for the dependency-direction checker (M0-T0 item 5).
 *
 * These tests are the automated half of "a deliberate violation must make CI
 * fail": they feed the checker real forbidden imports and assert it reports
 * them, and assert the clean repository tree reports nothing. Both halves run
 * in `pnpm test`.
 *
 * The manual end-to-end proof (add a bad import to packages/core, watch
 * `pnpm lint` exit 1) is documented at the top of
 * tools/scripts/check-dependency-direction.mjs.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  checkAll,
  checkSpecifiersForLayer,
  checkWorkspaceDir,
  discoverWorkspaces,
  extractSpecifiers,
} from './check-dependency-direction.mjs';

/** Short package name → workspace dir, the same index the CLI builds. */
const nameToWorkspace = new Map([
  ['schema', 'packages/schema'],
  ['core', 'packages/core'],
  ['providers', 'packages/providers'],
  ['storage', 'packages/storage'],
  ['rules', 'packages/rules'],
  ['packages', 'packages/packages'],
  ['importers', 'packages/importers'],
  ['ui', 'packages/ui'],
  ['i18n', 'packages/i18n'],
]);

const check = (relDir, source, relFile = `${relDir}/src/x.ts`) =>
  checkSpecifiersForLayer({ relFile, source, relDir, nameToWorkspace });

describe('dependency-direction checker — clean tree', () => {
  it('reports no violations for the current repository', () => {
    expect(checkAll()).toEqual([]);
  });

  it('discovers every workspace from pnpm-workspace.yaml globs', () => {
    expect([...discoverWorkspaces().keys()].sort()).toEqual([
      'apps/desktop',
      'apps/web',
      'packages/core',
      'packages/i18n',
      'packages/importers',
      'packages/packages',
      'packages/providers',
      'packages/rules',
      'packages/schema',
      'packages/storage',
      'packages/ui',
      'tools/stpack-cli',
    ]);
  });

  it('accepts the legal edges of the graph', () => {
    expect(check('packages/core', "import type { WorldData } from '@smarttavern/schema';")).toEqual(
      [],
    );
    expect(check('packages/storage', "import { createEngine } from '@smarttavern/core';")).toEqual(
      [],
    );
    expect(check('apps/web', "import { pack } from '@smarttavern/packages';")).toEqual([]);
    expect(check('tools/stpack-cli', "import { validate } from '@smarttavern/packages';")).toEqual(
      [],
    );
  });
});

describe('dependency-direction checker — deliberate violations turn it red', () => {
  it('flags packages/core importing a concrete adapter (storage)', () => {
    const violations = check('packages/core', "import { openDb } from '@smarttavern/storage';");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('packages/core/src/x.ts:1');
    expect(violations[0]).toContain('must not import @smarttavern/storage [packages/storage]');
  });

  it('flags packages/core importing a concrete provider', () => {
    expect(check('packages/core', "import { openai } from '@smarttavern/providers';")).toHaveLength(
      1,
    );
  });

  it('flags packages/schema importing anything internal', () => {
    expect(
      check('packages/schema', "import { z } from 'zod';\nimport '@smarttavern/core';"),
    ).toHaveLength(1);
  });

  it('flags sibling adapter cross-imports (rules → importers)', () => {
    expect(check('packages/rules', "import '@smarttavern/importers';")).toHaveLength(1);
  });

  it('flags deep imports that the short-name lint rule cannot see', () => {
    expect(
      check('packages/core', "import { x } from '@smarttavern/storage/idb/open';"),
    ).toHaveLength(1);
  });

  it('flags dynamic import() and require() forms', () => {
    expect(check('packages/core', "await import('@smarttavern/rules');")).toHaveLength(1);
    expect(check('packages/core', "require('@smarttavern/rules');")).toHaveLength(1);
  });

  it('flags every import in a multi-line file and reports the right line', () => {
    const source = [
      "import type { WorldData } from '@smarttavern/schema';", // legal (line 1)
      '', // line 2
      "import { openDb } from '@smarttavern/storage';", // violation (line 3)
      "import { openai } from '@smarttavern/providers';", // violation (line 4)
    ].join('\n');
    const violations = check('packages/core', source);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain(':3');
    expect(violations[1]).toContain(':4');
  });

  it('refuses to allow a workspace that is missing from the layer map', () => {
    const violations = checkSpecifiersForLayer({
      relFile: 'packages/brand-new/src/index.ts',
      source: "import '@smarttavern/core';",
      relDir: 'packages/brand-new',
      nameToWorkspace,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('missing from the layer map');
  });
});

describe('dependency-direction checker — parser', () => {
  it('recognises every static import form', () => {
    const source = [
      "import a from '@smarttavern/schema';",
      "import '@smarttavern/core';",
      "export { b } from '@smarttavern/providers';",
      "const c = await import('@smarttavern/storage');",
      "const d = require('@smarttavern/rules');",
      "import type { T } from '@smarttavern/i18n';",
    ].join('\n');
    expect(extractSpecifiers(source)).toEqual([
      '@smarttavern/schema',
      '@smarttavern/core',
      '@smarttavern/providers',
      '@smarttavern/storage',
      '@smarttavern/rules',
      '@smarttavern/i18n',
    ]);
  });

  it('ignores relative imports, bare packages and dynamic specifiers', () => {
    const source = [
      "import { a } from './local';",
      "import { z } from 'zod';",
      'const name = "@smarttavern/core";',
      'const p = await import(someVariable);',
    ].join('\n');
    expect(extractSpecifiers(source)).toEqual(['./local', 'zod']);
  });

  it('does not invent an import from a quoted string on the following line', () => {
    // Regression guard: the side-effect form `import 'm'` used to match the
    // word "import" at the end of one line plus a quoted string on the NEXT
    // line, reporting violations that did not exist.
    const source = [
      "import { a } from './local';",
      "const x = 'import';",
      "'@smarttavern/storage';",
    ].join('\n');
    expect(extractSpecifiers(source)).toEqual(['./local']);
  });

  it('keeps the layer map and the real tree in sync (every workspace is mapped)', () => {
    const unmapped = [...discoverWorkspaces().keys()].filter((dir) => ALLOWED[dir] === undefined);
    expect(unmapped).toEqual([]);
    const stale = Object.keys(ALLOWED).filter((dir) => !discoverWorkspaces().has(dir));
    expect(stale).toEqual([]);
  });

  it('reports nothing for a workspace whose own files are clean', () => {
    expect(checkWorkspaceDir({ relDir: 'packages/schema', nameToWorkspace })).toEqual([]);
  });
});
