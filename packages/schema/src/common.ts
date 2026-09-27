/**
 * Shared primitives for every entity schema (M0-T1).
 *
 * WHY THIS FILE EXISTS
 * Every entity is built from these primitives, so "the frozen contracts" have
 * exactly one definition of an id, a timestamp, an epoch minute and — the part
 * that decides whether plugins can be added later without a format bump — one
 * definition of the plugin escape hatch.
 *
 * PLUGIN-FACING RULES (do not relax without an ADR)
 * 1. `extensions` is the ONLY sanctioned place for third-party data on an
 *    entity, and its keys must be `x-<namespace>` (docs/04 §1, §8). A plugin
 *    never edits a field it did not define.
 * 2. Unknown fields are STRIPPED, never rejected (plain `z.object`, Zod's
 *    default): a v1 reader still opens a v1.1 package, which is HANDOFF §4.1
 *    invariant 5. Stripping also keeps JSON round-trips byte-stable.
 * 3. Enumerations plugins may extend go through `openEnum()`, which accepts the
 *    known members plus anything namespaced `x-`. Enumerations that describe
 *    intrinsic protocol semantics (e.g. `Message.role`) stay closed: opening
 *    them would cost exhaustiveness checks and buy nothing.
 * 4. Nothing here executes plugin code. See `./plugins` for the contract itself.
 */
import { z } from 'zod';

/* ─────────────────────────────── identity ────────────────────────────────── */

/**
 * Opaque entity id.
 *
 * Deliberately NOT a UUID schema: ids we mint are UUIDv7 (docs/04 §4), but
 * external ids are legitimately slugs — a rule pack is `dnd5e-srd`, a theme may
 * be `solarized-dark`. Validating the *shape* of a foreign id would reject
 * valid third-party content, so the uuid check lives in `UuidV7Schema` and is
 * applied only where this project mints the id itself.
 */
export const IdSchema = z.string().min(1).max(200);
export type Id = z.infer<typeof IdSchema>;

/** UUIDv7 pattern: time-ordered, as required for minted entity ids (docs/04 §4). */
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const UuidV7Schema = z.string().regex(UUID_V7_PATTERN);
export type UuidV7 = z.infer<typeof UuidV7Schema>;

/**
 * Where a fresh id's randomness comes from: `crypto.getRandomValues` when the platform
 * has it (every supported Node and every browser), `Math.random` otherwise.
 *
 * The fallback is a deliberate degrade rather than a throw: this module is bundled into
 * browsers and imported by tooling, and "an id that is merely less random" beats "the
 * caller cannot create a row at all". It is two lines and it is the only place the two
 * entropy sources differ.
 */
function defaultEntropy(): Uint8Array {
  const bytes = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

/** State of the counter that orders two ids minted inside the same millisecond. */
let lastMintedAt = -1;
let sequence = 0;

/**
 * Mint a UUIDv7 — `docs/04` §4's rule that minted ids are time-ordered, so an id sort
 * is a creation-order sort.
 *
 * WHY THE MINTER LIVES NEXT TO THE PATTERN. The pattern, the `UuidV7` type and the
 * minter are three statements of one rule. They had drifted into two implementations —
 * `packages/packages` minted manifest ids from `Math.random`, `apps/web` minted row ids
 * from `crypto.getRandomValues` — so two ids in one database could have different
 * entropy guarantees. This is the extraction the repository's "extract it when the
 * second implementation appears" rule asks for.
 *
 * MONOTONIC WITHIN A MILLISECOND: 12 of the 74 non-timestamp bits carry a sequence
 * (RFC 9562's "monotonic random" method), so ids minted in the same millisecond still
 * sort in creation order. That is the guarantee, and it stops there: a clock that goes
 * BACKWARDS (NTP correction, a checkpoint rollback) starts a new millisecond's sequence,
 * so an id minted after the correction sorts BELOW one minted before it — the alternative
 * would be an id claiming a time the clock never reported. After 4096 ids in one
 * millisecond the sequence wraps; nothing here mints at that rate, and the 62 remaining
 * random bits still make a collision vanishingly unlikely.
 *
 * Both inputs are injectable so a test can be exact: `now` fixes the clock and
 * `entropy` fixes the 16 random bytes. Production passes neither.
 */
export function mintUuidV7(
  now: () => Date = () => new Date(),
  entropy: () => Uint8Array = defaultEntropy,
): UuidV7 {
  const timestamp = now().getTime();
  if (timestamp === lastMintedAt) sequence = (sequence + 1) & 0x0fff;
  else {
    lastMintedAt = timestamp;
    sequence = 0;
  }

  const bytes = entropy();
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  // 48-bit big-endian milliseconds, built by division and not by shifting: JavaScript's
  // bitwise operators are 32-bit and would silently truncate a millisecond timestamp.
  let stamp = '';
  for (let shift = 5; shift >= 0; shift -= 1) {
    stamp += hex(Math.trunc(timestamp / 2 ** (shift * 8)) % 256);
  }
  // Group 4 is the variant nibble (10xx) plus 3 hex of entropy; group 5 is 12 more.
  let tail = '';
  for (let index = 0; index < 8; index += 1) tail += hex(bytes[index] ?? 0);
  const variant = (0x8 + ((bytes[8] ?? 0) & 0x3)).toString(16);

  return `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${sequence.toString(16).padStart(3, '0')}-${variant}${tail.slice(0, 3)}-${tail.slice(3, 15)}`;
}

/* ──────────────────────────────── time ───────────────────────────────────── */

/**
 * Minutes since the calendar epoch — the single source of truth for time
 * (ADR-012). Never a wall-clock date: the world's calendar is a display mapping
 * over this number, and the clock has to roll back with a checkpoint.
 */
export const EpochMinuteSchema = z.number().int();
export type EpochMinute = z.infer<typeof EpochMinuteSchema>;

/** Unix milliseconds (docs/02 §7 约定：时间戳为毫秒). */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

/* ─────────────────────── versions, semver, locales ───────────────────────── */

/** Positive integer revision of an immutable entity version, starting at 1. */
export const VersionNumberSchema = z.number().int().positive();
export type VersionNumber = z.infer<typeof VersionNumberSchema>;

/** Loose semver, for plugin and app versions (`1.2.3`, `1.2.3-beta.1`). */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const SemverSchema = z.string().regex(SEMVER_PATTERN);
export type Semver = z.infer<typeof SemverSchema>;

/**
 * Localized text: BCP-47 tag -> string (docs/04 §3.1 `i18n.name`).
 * Keys are validated so a typo cannot silently create an unreachable locale.
 */
export const BCP_47_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const LocalizedTextSchema = z.record(z.string().regex(BCP_47_PATTERN), z.string());
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

/* ───────────────────── the plugin extension surface ──────────────────────── */

/** A plugin namespace: `x-<vendor>`. */
export const PLUGIN_NAMESPACE_PATTERN = /^x-[a-z0-9][a-z0-9-]*$/;
export const PluginNamespaceSchema = z.string().regex(PLUGIN_NAMESPACE_PATTERN);
export type PluginNamespace = z.infer<typeof PluginNamespaceSchema>;

/**
 * Extension key: `x-<namespace>` optionally followed by dot-separated segments
 * (`x-mythos`, `x-mythos.sanity.value`). Same pattern doubles as the value space
 * for `openEnum()`, so a plugin has one namespacing rule to learn.
 */
export const EXTENSION_KEY_PATTERN = /^x-[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
export const ExtensionKeySchema = z.string().regex(EXTENSION_KEY_PATTERN);
export type ExtensionKey = z.infer<typeof ExtensionKeySchema>;

/** Anything JSON can hold — the only thing a plugin may store. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * THE plugin data channel, mixed into every entity as optional `extensions`.
 * Carried through `parse` -> `JSON.stringify` -> `parse` unchanged, so a plugin
 * can persist state without the core schema knowing anything about it.
 */
export const ExtensionsSchema = z.record(ExtensionKeySchema, JsonValueSchema);
export type Extensions = z.infer<typeof ExtensionsSchema>;

/**
 * Open enumeration: the known members, plus `x-` namespaced members contributed
 * by a plugin. This is what lets a plugin introduce a new entity kind, agenda
 * source or memory origin and still be *validated* rather than silently ignored.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(known: T) {
  // The cast is honest: at runtime a value is either one of `known` or an
  // `x-` namespaced string, which is exactly `T[number] | `x-${string}``.
  return z.union([z.enum(known), z.string().regex(EXTENSION_KEY_PATTERN)]) as unknown as z.ZodType<
    T[number] | `x-${string}`
  >;
}

/* ─────────────────────── sampling parameters (frozen) ────────────────────── */

/**
 * docs/02 §4 references `SamplingParams` (`SessionRefs.modelConfig.params` and
 * `CharacterData.sampling`) but never defines it. Frozen here so providers,
 * character cards and session config cannot drift apart.
 *
 * `temperature` and `topP` are required because every provider this project
 * targets accepts both; everything else is optional so a character card can
 * override just one knob.
 */
export const SamplingParamsSchema = z.object({
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  topK: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  repetitionPenalty: z.number().positive().optional(),
  stop: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
});
export type SamplingParams = z.infer<typeof SamplingParamsSchema>;

/** Per-character overrides: any subset of the session's sampling parameters. */
export const PartialSamplingParamsSchema = SamplingParamsSchema.partial();
export type PartialSamplingParams = z.infer<typeof PartialSamplingParamsSchema>;
