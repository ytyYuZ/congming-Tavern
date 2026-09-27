/**
 * Immutability and lineage: the rules that make history reproducible (ADR-010,
 * HANDOFF §5 point 5).
 *
 * A world or a character is never edited in place. Iterating produces a NEW
 * version; a save references the concrete `{id, version}` pair, so an old save
 * keeps rendering exactly what it rendered before. Everything that may need to
 * point at "some version of something" uses `EntityRefSchema`.
 *
 * Plugins get the same guarantees for free: a plugin that adds data through
 * `extensions` writes a new version like everybody else, and it can reference
 * core entities with `EntityRefSchema` without a core change.
 */
import { z } from 'zod';
import {
  ExtensionsSchema,
  IdSchema,
  openEnum,
  TimestampSchema,
  UuidV7Schema,
  VersionNumberSchema,
} from './common';

/**
 * Kinds of addressable entity. Open: a plugin may contribute
 * `x-<namespace>.<thing>` and it validates, which is what keeps a v1 reader
 * from having to be rebuilt when the ecosystem grows.
 */
export const EntityKindSchema = openEnum([
  'world',
  'worldbook',
  'character',
  'prompt-preset',
  'rulepack',
  'theme',
  'session',
  'message',
  'checkpoint',
  'agenda',
  'memory',
  'asset',
  'turn',
  'plugin',
] as const);
export type EntityKind = z.infer<typeof EntityKindSchema>;

/**
 * A pointer to one immutable version of one entity. `version` is optional only
 * because a few references legitimately mean "whatever the head is" (a theme, a
 * rule pack); anything that must stay reproducible pins it.
 */
export const EntityRefSchema = z.object({
  kind: EntityKindSchema,
  id: IdSchema,
  version: VersionNumberSchema.optional(),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

/** Why a version exists and what it came from. Append-only. */
export const LineageSchema = z.object({
  parentId: UuidV7Schema,
  parentVersion: VersionNumberSchema,
  reason: z.string().min(1).max(500),
  at: TimestampSchema,
});
export type Lineage = z.infer<typeof LineageSchema>;

/**
 * Builds the standard versioned envelope around a `data` schema:
 * `{ id, version, lineage?, createdAt, updatedAt, data, extensions? }`
 * (docs/02 §4 `Versioned<T>`).
 *
 * `extensions` sits on the envelope, not inside `data`, so plugin data can never
 * collide with a domain field and can be dropped without touching the payload.
 * Entity schemas add their own owner key on top (e.g. `characterId`), matching
 * the `*Versions` collections in docs/02 §7.
 */
export function versionedEntity<T extends z.ZodType>(data: T) {
  return z.object({
    id: UuidV7Schema,
    version: VersionNumberSchema,
    lineage: LineageSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    data,
    extensions: ExtensionsSchema.optional(),
  });
}

/**
 * Builds the head row that indexes a versioned entity: the mutable "current"
 * pointer the storage layer lists and sorts on (`docs/02` §7 `worlds` /
 * `characters`). The data itself lives in the immutable `*Version` rows.
 */
export const VersionedHeadFieldsSchema = z.object({
  id: UuidV7Schema,
  name: z.string().min(1).max(200),
  headVersion: VersionNumberSchema,
  tags: z.array(z.string()),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type VersionedHeadFields = z.infer<typeof VersionedHeadFieldsSchema>;
