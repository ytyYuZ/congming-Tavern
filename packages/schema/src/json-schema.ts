/**
 * The published JSON Schemas (`docs/04-分享格式规范.md` §11, `docs/02` §5.3).
 *
 * `packages/schema` owns the conversion so that the two consumers — the export
 * script in `tools/schema-export` and the drift test next to this file — cannot
 * disagree, and so the tooling never needs its own copy of `zod`.
 *
 * Zod 4 has `z.toJSONSchema` built in, so this costs no dependency. Recursive
 * schemas (`Extensions` → `JsonValue`) come out as `$defs` + `$ref`, which is why
 * the artifacts declare the 2020-12 dialect.
 */
import { z } from 'zod';
import { PackageManifestSchema } from './package';
import { ToolDefinitionSchema } from './tool';

/** Where the generated artifacts live, relative to the repository root. */
export const PACKAGE_JSON_SCHEMA_PATH = 'schema/package-1.json' as const;
export const TOOL_JSON_SCHEMA_PATH = 'schema/tools-1.json' as const;

/** Every generated artifact, in the order the export script writes them. */
export const JSON_SCHEMA_ARTIFACTS = [
  { path: PACKAGE_JSON_SCHEMA_PATH, build: packageManifestJsonSchemaText },
  { path: TOOL_JSON_SCHEMA_PATH, build: toolDefinitionsJsonSchemaText },
] as const;

/** Shared options: we publish the *output* shape and never hide a construct. */
const TO_JSON_SCHEMA_OPTIONS = { io: 'output', unrepresentable: 'any' } as const;

/** The manifest's JSON Schema. Hand-written copies are forbidden (ADR-016). */
export function buildPackageManifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PackageManifestSchema, TO_JSON_SCHEMA_OPTIONS) as unknown as Record<
    string,
    unknown
  >;
}

/** The tool-declaration JSON Schema, for plugin authors and prompt builders. */
export function buildToolDefinitionsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ToolDefinitionSchema, TO_JSON_SCHEMA_OPTIONS) as unknown as Record<
    string,
    unknown
  >;
}

/**
 * The exact bytes that belong in each artifact: two-space indent and a trailing
 * newline, so the files are diff-friendly and the drift test can compare strings
 * instead of deep-equalling objects.
 */
export function packageManifestJsonSchemaText(): string {
  return `${JSON.stringify(buildPackageManifestJsonSchema(), null, 2)}\n`;
}

export function toolDefinitionsJsonSchemaText(): string {
  return `${JSON.stringify(buildToolDefinitionsJsonSchema(), null, 2)}\n`;
}
