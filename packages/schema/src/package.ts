/**
 * The `.stpack` manifest — the frozen contract of the sharing format
 * (`docs/04-分享格式规范.md` §3, ADR-009, ADR-018).
 *
 * This file is the ONLY definition of the manifest: `schema/package-1.json` is
 * generated from it by `tools/schema-export/export.mjs`, never hand-written
 * (ADR-016, docs/04 §11).
 *
 * THREE RULES THAT SHAPE THIS FILE
 *
 * 1. SHAPE ONLY, CROSS-FIELD RULES SEPARATELY. `PackageManifestSchema` validates
 *    the shape; relationships BETWEEN fields (entries ↔ assets ↔ schemaVersions
 *    ↔ contents.bytes) live in `validateManifestConsistency()`. Keeping them out
 *    of the schema keeps `z.toJSONSchema()` output faithful — JSON Schema cannot
 *    express them anyway — and lets the reader report every problem at once
 *    instead of only the first one Zod trips over.
 *
 * 2. UNKNOWN FIELDS ARE STRIPPED, NOT REJECTED. Plain `z.object` everywhere, so a
 *    v1 reader still opens a v1.x package (HANDOFF §4.1 invariant 5).
 *
 * 3. ENUMERATIONS THAT CONTRIBUTORS MAY EXTEND ARE OPEN. `kind` goes through
 *    `openEnum()`, so a plugin can ship `x-<namespace>` packages while the core
 *    seven stay closed. `platform` and `requirement` stay closed: they are
 *    intrinsic protocol semantics that readers switch on exhaustively.
 */
import { z } from 'zod';
import {
  ExtensionsSchema,
  IdSchema,
  JsonValueSchema,
  LocalizedTextSchema,
  openEnum,
  UuidV7Schema,
  VersionNumberSchema,
} from './common';
import { SHA256_HEX_PATTERN } from './entities/asset';
import { AssetKindSchema } from './plugins';
import { EntityKindSchema } from './versioning';

/* ──────────────────── 常量：格式的自我识别（不要改） ────────────────────── */

export const PACKAGE_FORMAT = 'smarttavern.package' as const;
export const PACKAGE_FORMAT_VERSION = 1 as const;
export const PACKAGE_EXTENSION = '.stpack' as const;
export const PACKAGE_MIME = 'application/vnd.smarttavern.package+zip' as const;

/** The manifest must be the FIRST ZIP entry and is never listed in `entries[]`. */
export const MANIFEST_PATH = 'manifest.json' as const;

/* ─────────────────────────────── 路径规则 ───────────────────────────────── */

const PATH_CHARSET = /^[A-Za-z0-9._/-]+$/;

/**
 * `docs/04` §2 path rules. Rejects, in order: empty, illegal characters,
 * absolute paths, trailing slash, `.` / `..` segments and empty segments.
 * ZIP-slip is a *reader* obligation too (`docs/04` §9) — this is the contract
 * saying such a path is invalid in the first place.
 */
export const PackagePathSchema = z
  .string()
  .min(1)
  .regex(PATH_CHARSET, 'only [A-Za-z0-9._/-] is allowed (docs/04 §2)')
  .refine((path) => !path.startsWith('/'), 'must be relative (docs/04 §2)')
  .refine((path) => !path.endsWith('/'), 'must not end with "/" (docs/04 §2)')
  .refine((path) => !path.split('/').includes('.'), '"." segments are not allowed')
  .refine((path) => !path.split('/').includes('..'), '".." segments are not allowed')
  .refine((path) => !path.includes('//'), 'empty path segments are not allowed');
export type PackagePath = z.infer<typeof PackagePathSchema>;

/** SHA-256 of a payload file, lower-case hex. One definition, shared with assets. */
export const PackageSha256Schema = z.string().regex(SHA256_HEX_PATTERN);
export type PackageSha256 = z.infer<typeof PackageSha256Schema>;

/** ISO 8601 in UTC, `Z`-suffixed (`docs/04` §3.1 `createdAt`). */
export const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const Iso8601UtcSchema = z
  .string()
  .regex(ISO_8601_UTC_PATTERN, 'ISO 8601 UTC expected, ending in "Z"');
export type Iso8601Utc = z.infer<typeof Iso8601UtcSchema>;

/* ──────────────────────────────── 枚举 ──────────────────────────────────── */

/** OPEN: a plugin may contribute its own package kind as `x-<namespace>`. */
export const PackageKindSchema = openEnum([
  'world',
  'character',
  'session',
  'rulepack',
  'prompt-preset',
  'theme',
  'bundle',
] as const);
export type PackageKind = z.infer<typeof PackageKindSchema>;

/** CLOSED: which shell produced the package. Readers may switch on it. */
export const PackagePlatformSchema = z.enum(['web', 'desktop', 'mobile', 'cli']);
export type PackagePlatform = z.infer<typeof PackagePlatformSchema>;

/** CLOSED: how badly a `refs[]` entry is needed (`docs/04` §4). */
export const PackageRequirementSchema = z.enum(['embedded', 'required', 'optional']);
export type PackageRequirement = z.infer<typeof PackageRequirementSchema>;

/**
 * SPDX identifier, or one of the two sentinels the spec allows. Deliberately a
 * pattern rather than a fixed list: SPDX grows, and rejecting a valid license
 * identifier would reject a valid package.
 */
export const SPDX_PATTERN = /^[A-Za-z0-9.+-]+$/;
export const PackageLicenseSchema = z.union([
  z.enum(['user-provided', 'mixed']),
  z
    .string()
    .min(1)
    .max(100)
    .regex(SPDX_PATTERN, 'expected an SPDX identifier, "user-provided" or "mixed"'),
]);
export type PackageLicense = z.infer<typeof PackageLicenseSchema>;

/* ────────────────────────── schemaVersions 键集 ─────────────────────────── */

/**
 * The fixed `schemaVersions` key set (`docs/04` §3.1, r2). Keys are optional —
 * a world-only package has no `message` schema to declare — but every entity
 * that IS present must appear; `validateManifestConsistency()` enforces that.
 */
export const PACKAGE_SCHEMA_VERSION_KEYS = [
  'world',
  'worldbook',
  'character',
  'promptPreset',
  'rulepack',
  'theme',
  'session',
  'message',
  'checkpoint',
  'agenda',
  'memory',
  'asset',
  'turn',
] as const;
export type PackageSchemaVersionKey = (typeof PACKAGE_SCHEMA_VERSION_KEYS)[number];

/** The schema version each entity is at in THIS build, i.e. what we can read natively. */
export const CURRENT_SCHEMA_VERSIONS: Readonly<Record<PackageSchemaVersionKey, number>> =
  Object.fromEntries(PACKAGE_SCHEMA_VERSION_KEYS.map((key) => [key, 1])) as Record<
    PackageSchemaVersionKey,
    number
  >;

export const PackageSchemaVersionsSchema = z.object(
  Object.fromEntries(
    PACKAGE_SCHEMA_VERSION_KEYS.map((key) => [key, VersionNumberSchema.optional()]),
  ) as Record<PackageSchemaVersionKey, z.ZodOptional<typeof VersionNumberSchema>>,
);
export type PackageSchemaVersions = z.infer<typeof PackageSchemaVersionsSchema>;

/* ─────────────────────── 目录清单：data/ 的合法文件 ─────────────────────── */

/**
 * Every legal `data/` payload and the entity schema version it declares
 * (`docs/04` §2). `state.json` is deliberately absent — a session's final state
 * is not a versioned entity — and lives in `MANIFEST_AUX_FILES` instead.
 */
export const MANIFEST_DATA_FILES = {
  'data/worlds.json': 'world',
  'data/worldbooks.json': 'worldbook',
  'data/characters.json': 'character',
  'data/promptPresets.json': 'promptPreset',
  'data/rulepacks.json': 'rulepack',
  'data/theme.json': 'theme',
  'data/session.json': 'session',
  'data/messages.jsonl': 'message',
  'data/checkpoints.json': 'checkpoint',
  'data/agenda.json': 'agenda',
  'data/memories.json': 'memory',
} as const satisfies Record<string, PackageSchemaVersionKey>;

/** Legal payload paths that do not correspond to a versioned entity. */
export const MANIFEST_AUX_FILES = [
  'data/state.json',
  'assets/refs.json',
  'LICENSE.txt',
  'README.txt',
] as const;

/* ─────────────────────────── manifest 组件 ──────────────────────────────── */

/** Multi-language display name (`docs/04` §3.1 `i18n.name`). */
export const PackageI18nSchema = z.object({
  name: LocalizedTextSchema.optional(),
});
export type PackageI18n = z.infer<typeof PackageI18nSchema>;

export const PackageGeneratorSchema = z.object({
  app: z.string().min(1).max(100),
  /**
   * Free string, NOT semver: a third-party generator may use any version scheme,
   * and refusing to read its package over a version format would be absurd.
   */
  version: z.string().min(1).max(100),
  platform: PackagePlatformSchema,
});
export type PackageGenerator = z.infer<typeof PackageGeneratorSchema>;

export const PackageSourceSchema = z.object({
  url: z.string().url().optional(),
  author: z.string().max(200).optional(),
  originalPackageId: IdSchema.optional(),
  originalAuthor: z.string().max(200).optional(),
});
export type PackageSource = z.infer<typeof PackageSourceSchema>;

/** A dependency on an external entity (`docs/04` §4). */
export const PackageRefSchema = z.object({
  kind: EntityKindSchema,
  id: IdSchema,
  version: VersionNumberSchema.optional(),
  requirement: PackageRequirementSchema,
});
export type PackageRef = z.infer<typeof PackageRefSchema>;

/**
 * Asset metadata carried in the manifest (`docs/04` §3.1 `assets[]`). Distinct
 * from the storage-layer `AssetMeta` in `./entities/asset`: this one is keyed by
 * the path inside the package, that one by a database id.
 */
export const PackageAssetSchema = z.object({
  path: PackagePathSchema,
  sha256: PackageSha256Schema,
  mime: z.string().min(1).max(200),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  kind: AssetKindSchema,
  thumb: PackagePathSchema.optional(),
  /** Character binding, expression/outfit tags, source prompt — free-form on purpose. */
  meta: z.record(z.string(), JsonValueSchema).optional(),
});
export type PackageAsset = z.infer<typeof PackageAssetSchema>;

/** Declares that the exporter removed secrets and machine-specific paths. */
export const PackageRedactionSchema = z.object({
  apiKeys: z.literal('excluded'),
  absolutePaths: z.literal('excluded'),
});
export type PackageRedaction = z.infer<typeof PackageRedactionSchema>;

/* ────────────────────────────── 内容清单 ────────────────────────────────── */

/**
 * Fixed `contents.counts` key set (`docs/04` §3.1 + §12 item 15). Every key is
 * REQUIRED — a category with nothing in it must be written as `0`, not omitted,
 * so two packages with the same content have the same manifest shape.
 */
export const PACKAGE_COUNT_KEYS = [
  'worlds',
  'worldbooks',
  'characters',
  'promptPresets',
  'rulePacks',
  'themes',
  'sessions',
  'messages',
  'checkpoints',
  'agenda',
  'memories',
  'assets',
] as const;
export type PackageCountKey = (typeof PACKAGE_COUNT_KEYS)[number];

export const PackageCountsSchema = z.object(
  Object.fromEntries(
    PACKAGE_COUNT_KEYS.map((key) => [key, z.number().int().nonnegative()]),
  ) as Record<PackageCountKey, z.ZodNumber>,
);
export type PackageCounts = z.infer<typeof PackageCountsSchema>;

export const PackageContentsSchema = z.object({
  counts: PackageCountsSchema,
  /**
   * Sum of every `entries[].bytes`, i.e. the uncompressed size of everything in
   * the package except the manifest itself (`docs/04` §3.1: "包内所有载荷与资源
   * 字节之和"). `validateManifestConsistency()` checks the arithmetic.
   */
  bytes: z.number().int().nonnegative(),
});
export type PackageContents = z.infer<typeof PackageContentsSchema>;

/** One file in the package, excluding the manifest. */
export const PackageEntrySchema = z.object({
  path: PackagePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: PackageSha256Schema,
});
export type PackageEntry = z.infer<typeof PackageEntrySchema>;

/* ──────────────────────────────── manifest ─────────────────────────────── */

export const PackageManifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  /** Only the major version lives here; additive changes do NOT bump it (docs/04 §8). */
  formatVersion: z.literal(PACKAGE_FORMAT_VERSION),
  kind: PackageKindSchema,
  id: UuidV7Schema,
  name: z.string().min(1).max(200),
  i18n: PackageI18nSchema.optional(),
  description: z.string().max(2000).optional(),
  createdAt: Iso8601UtcSchema,
  generator: PackageGeneratorSchema,
  license: PackageLicenseSchema,
  source: PackageSourceSchema.optional(),
  tags: z.array(z.string()).optional(),
  schemaVersions: PackageSchemaVersionsSchema,
  refs: z.array(PackageRefSchema).optional(),
  contents: PackageContentsSchema,
  entries: z.array(PackageEntrySchema),
  assets: z.array(PackageAssetSchema).optional(),
  redaction: PackageRedactionSchema,
  /** Reserved for v1: always `null`. Signing is a later format version. */
  signature: z.null().optional(),
  extensions: ExtensionsSchema.optional(),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

/* ─────────────────────── 跨字段一致性（不是 schema） ────────────────────── */

/**
 * Cross-field rules that JSON Schema cannot express. Returns every problem it
 * finds rather than throwing, so an importer can show the user one complete
 * list (`docs/04` §7 step 7) and so M0-T3 can report all of them at once.
 *
 * Runs on an already-validated manifest: this assumes the shape is sound.
 */
export function validateManifestConsistency(manifest: PackageManifest): string[] {
  const problems: string[] = [];
  const paths = manifest.entries.map((entry) => entry.path);
  const unique = new Set(paths);

  if (unique.has(MANIFEST_PATH)) {
    problems.push(`entries[] must not list ${MANIFEST_PATH} (docs/04 §3.1)`);
  }
  if (unique.size !== paths.length) {
    problems.push('entries[] contains duplicate paths');
  }

  const knownData = new Set<string>([
    ...Object.keys(MANIFEST_DATA_FILES),
    ...MANIFEST_AUX_FILES.filter((path) => path.startsWith('data/')),
  ]);
  for (const path of paths) {
    if (path.startsWith('data/') && !knownData.has(path)) {
      problems.push(`unknown data payload: ${path} (docs/04 §2)`);
      continue;
    }
    const key = (MANIFEST_DATA_FILES as Record<string, PackageSchemaVersionKey | undefined>)[path];
    if (key !== undefined && manifest.schemaVersions[key] === undefined) {
      problems.push(
        `${path} is present but schemaVersions.${key} is missing (docs/04 §12 item 15)`,
      );
    }
  }

  const declaredBytes = manifest.contents.bytes;
  const actualBytes = manifest.entries.reduce((total, entry) => total + entry.bytes, 0);
  if (declaredBytes !== actualBytes) {
    problems.push(
      `contents.bytes is ${declaredBytes} but entries[].bytes sums to ${actualBytes} (docs/04 §3.1)`,
    );
  }

  for (const asset of manifest.assets ?? []) {
    if (!unique.has(asset.path)) {
      problems.push(`assets[] references ${asset.path}, which is not in entries[]`);
      continue;
    }
    const entry = manifest.entries.find((candidate) => candidate.path === asset.path);
    if (entry !== undefined && entry.sha256 !== asset.sha256) {
      problems.push(`${asset.path}: assets[].sha256 disagrees with entries[].sha256`);
    }
  }

  return problems;
}
