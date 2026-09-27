/**
 * Drift guard for the published JSON Schemas (`docs/04` §11: the Zod definition is
 * the single source of truth, and hand-writing a second schema is forbidden).
 *
 * This test is what makes that rule mechanical rather than aspirational: if an
 * artifact stops matching its Zod source, CI fails and tells the developer to
 * re-run `pnpm schema:export`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JSON_SCHEMA_ARTIFACTS,
  PACKAGE_JSON_SCHEMA_PATH,
  TOOL_JSON_SCHEMA_PATH,
} from './json-schema';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const readArtifact = (relativePath: string) => readFileSync(join(repoRoot, relativePath), 'utf8');

describe('published JSON Schemas', () => {
  it('are committed and match the Zod definitions byte for byte', () => {
    for (const artifact of JSON_SCHEMA_ARTIFACTS) {
      const onDisk = readArtifact(artifact.path);
      if (onDisk !== artifact.build()) {
        throw new Error(
          `${artifact.path} has drifted from packages/schema — run \`pnpm schema:export\` and commit the result`,
        );
      }
      expect(onDisk).toBe(artifact.build());
    }
  });

  it('declares the 2020-12 dialect and pins the manifest format literals', () => {
    const parsed = JSON.parse(readArtifact(PACKAGE_JSON_SCHEMA_PATH));
    expect(parsed.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(parsed.properties.format.const).toBe('smarttavern.package');
    expect(parsed.properties.formatVersion.const).toBe(1);
  });

  it('expands the recursive extension bag into $defs rather than inlining it forever', () => {
    const parsed = JSON.parse(readArtifact(PACKAGE_JSON_SCHEMA_PATH));
    expect(Object.keys(parsed.$defs ?? {}).length).toBeGreaterThan(0);
  });

  it('publishes the tool declaration schema with the fields the runtime decides on', () => {
    const parsed = JSON.parse(readArtifact(TOOL_JSON_SCHEMA_PATH));
    expect(parsed.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    for (const field of [
      'name',
      'summary',
      'parameters',
      'owner',
      'mutatesState',
      'requiresApproval',
    ]) {
      expect(parsed.required).toContain(field);
    }
  });
});
