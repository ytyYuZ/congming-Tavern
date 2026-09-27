/**
 * Asset metadata — content-addressed binary storage (docs/02 §4.1, §7 `assets`,
 * docs/04 §6).
 *
 * CONTENT ADDRESSING, AND WHAT IT IMPLIES
 * `hash = sha256(bytes)` and the stored file name IS that hash, so two identical
 * portraits are one file and an import that re-encodes nothing dedupes for free.
 * The bytes NEVER enter the database (docs/04 §6 "图片原文件不入库改格式"): this
 * row is an index entry — hash, kind, dimensions, byte count, path — and the
 * original bytes stay on disk untouched. `refCount` is derived from the
 * reference rows, and anything pinned by a checkpoint or a package cannot be
 * collected (docs/02 §7 资源生命周期).
 *
 * `meta` holds the labels the UI and the importer need (角色绑定, expression /
 * outfit tags) and is typed as the plugin-safe `JsonValue`, so a foreign asset
 * bundle can carry its own bookkeeping without a schema change. `source` records
 * how it was generated (prompt + params) so it can be regenerated or migrated to
 * another provider — docs/04 §6 states that requirement explicitly.
 *
 * OPEN vs CLOSED: `kind` is `AssetKindSchema` from `../plugins`, which is OPEN —
 * a plugin shipping a new asset class (`x-mythos.battlemap`) validates rather
 * than being dropped.
 */
import { z } from 'zod';
import { ExtensionsSchema, IdSchema, JsonValueSchema, TimestampSchema } from '../common';
import { AssetKindSchema } from '../plugins';

/* ───────────────────────────────── 哈希 ──────────────────────────────────── */

/** `sha256(bytes)` in lowercase hex. Lowercase only: it is a file name on Windows. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const AssetHashSchema = z.string().regex(SHA256_HEX_PATTERN);
export type AssetHash = z.infer<typeof AssetHashSchema>;

/* ──────────────────────────────── 资源元数据 ─────────────────────────────── */

/** How the asset was produced, so it can be reproduced (docs/04 §6). */
export const AssetSourceSchema = z.object({
  prompt: z.string().optional(),
  /** Provider params as JSON: seeds, steps, cfg — whatever the provider took. */
  params: JsonValueSchema.optional(),
});
export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const AssetMetaSchema = z.object({
  id: IdSchema,
  /** Content address. Also the stored file name. */
  hash: AssetHashSchema,
  /** OPEN asset kind from `../plugins`. */
  kind: AssetKindSchema,
  mime: z.string().min(1),
  /**
   * Pixels for images. NONNEGATIVE, not positive: an audio clip or a text
   * attachment has no meaningful width, and requiring > 0 would force a lie.
   */
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** Location inside the asset store (relative, never absolute). */
  path: z.string().min(1),
  /** Generated thumbnail, itself an asset row. */
  thumbId: IdSchema.optional(),
  /** Maintained by the reference rows; 0 means collectable after confirmation. */
  refCount: z.number().int().nonnegative(),
  /** Free-form labels: character binding, expression / outfit tags, provenance. */
  meta: z.record(z.string(), JsonValueSchema),
  source: AssetSourceSchema.optional(),
  createdAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type AssetMeta = z.infer<typeof AssetMetaSchema>;

/* ───────────────────────────────── 引用 ──────────────────────────────────── */

/**
 * A pointer to an asset from wherever it is used (a card's portrait, a message's
 * illustration). `role` is free text so a plugin can name a new use
 * ("battlemap-tile") without a core change.
 */
export const AssetRefSchema = z.object({
  assetId: IdSchema,
  role: z.string().optional(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;
