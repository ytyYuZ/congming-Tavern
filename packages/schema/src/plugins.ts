/**
 * Plugin contract — INTERFACES ONLY, no runtime, nothing executes plugin code.
 *
 * WHY THIS FILE EXISTS NOW
 * Plugin support is not an M0 feature, but the *shape* of the extension surface
 * is expensive to change later: it is referenced by the manifest that ships in
 * every `.stpack`, and by entity rows already written to users' IndexedDB. So
 * M0 freezes the seams and defers the loader. Adding a plugin runtime later must
 * be additive against this file, never a migration of it.
 *
 * THE SIX EXTENSION POINTS (all usable today, none of them an edit to core)
 * 1. entity extensions — `extensions` on every entity, keys `x-<namespace>`
 *    (`./common`); survives pack -> unpack -> pack unchanged.
 * 2. new kinds — every extensible enumeration goes through `openEnum()`, so a
 *    plugin can contribute an entity kind, agenda source, memory origin or
 *    asset kind as `x-<namespace>` and still pass validation.
 * 3. tools — `ToolCall.name` is a free string and `ToolRuntime` lives in
 *    `packages/core/ports`; a plugin-provided tool is registered by name and
 *    executes locally after validation (HANDOFF §4.1 invariant 3).
 * 4. providers — `LLMProvider` / `ImageProvider` are interfaces keyed by a free
 *    `id`; a plugin can supply an implementation without core knowing it.
 * 5. rule packs and prompt presets — pure declarative data, evaluated by a
 *    whitelist evaluator; a plugin can never inject code (HANDOFF §9.3).
 * 6. locales — message catalogs are addressed by id, so a plugin can ship a
 *    translation without touching our bundles.
 *
 * HARD RULES
 * - A plugin's id, and every id it contributes, is namespaced `x-<vendor>`.
 *   This is what makes collisions impossible without a central registry.
 * - A plugin declares its `apiVersion` and `permissions` up front, so a future
 *   loader can refuse an incompatible or over-reaching plugin before running it.
 * - A plugin's private state goes in `extensions`, never in a core field.
 */
import { z } from 'zod';
import {
  ExtensionKeySchema,
  ExtensionsSchema,
  IdSchema,
  LocalizedTextSchema,
  openEnum,
  PluginNamespaceSchema,
  SemverSchema,
} from './common';

/** Version of the plugin API this build implements. Bumped only on breaking changes. */
export const PLUGIN_API_VERSION = '1.0' as const;

export const PluginApiVersionSchema = z.string().regex(/^\d+\.\d+$/);
export type PluginApiVersion = z.infer<typeof PluginApiVersionSchema>;

/** Plugin id === its namespace, so contributed names can be derived from it. */
export const PluginIdSchema = PluginNamespaceSchema;
export type PluginId = z.infer<typeof PluginIdSchema>;

/**
 * What a plugin may ask for. Open, because a future capability (MIDI output,
 * a hosted model, a system keyring) is a new string, not a new schema version.
 */
export const PluginPermissionSchema = openEnum([
  'llm',
  'image',
  'assets',
  'storage',
  'network',
  'clipboard',
  'shell',
] as const);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/** Asset kinds the core understands; plugins add their own as `x-<ns>`. */
export const AssetKindSchema = openEnum([
  'sprite',
  'portrait',
  'scene',
  'thumbnail',
  'reference',
  'audio',
  'other',
] as const);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/** Message kinds the core understands; plugins add their own as `x-<ns>`. */
export const MessageKindSchema = openEnum(['narration', 'dialogue', 'action', 'ooc'] as const);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/**
 * What a plugin registers. Every list is optional: a theme plugin contributes
 * nothing here, and an empty manifest must stay valid.
 */
export const PluginContributionsSchema = z.object({
  /** Extra entity kinds, e.g. `x-mythos.sanity-track`. */
  entityKinds: z.array(ExtensionKeySchema).optional(),
  /** Tool names it answers to, resolved through `core/ports/tools`. */
  toolNames: z.array(z.string().min(1)).optional(),
  /** Provider ids it implements (`llm:`/`image:` prefixed by convention). */
  providerIds: z.array(z.string().min(1)).optional(),
  /** Rule packs / prompt presets it ships, as data. */
  rulePackIds: z.array(IdSchema).optional(),
  promptPresetIds: z.array(IdSchema).optional(),
  /** Extra asset or message kinds. */
  assetKinds: z.array(ExtensionKeySchema).optional(),
  messageKinds: z.array(ExtensionKeySchema).optional(),
  /** Locales it can translate, as BCP-47 tags. */
  locales: z.array(z.string().min(2)).optional(),
});
export type PluginContributions = z.infer<typeof PluginContributionsSchema>;

/**
 * A plugin's self-description. Stored as data, shown to the user before
 * anything is enabled, and never trusted to describe what the plugin *may* do —
 * `permissions` is a request, the loader decides.
 */
export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1).max(200),
  i18n: z.object({ name: LocalizedTextSchema.optional() }).optional(),
  version: SemverSchema,
  apiVersion: PluginApiVersionSchema,
  description: z.string().max(2000).optional(),
  author: z.string().max(200).optional(),
  homepage: z.string().url().optional(),
  license: z.string().max(200).optional(),
  /** Minimum app version that can host it; checked by the future loader. */
  minAppVersion: SemverSchema.optional(),
  permissions: z.array(PluginPermissionSchema).optional(),
  contributes: PluginContributionsSchema.optional(),
  enabledByDefault: z.boolean().optional(),
  /** Plugin-private state and future metadata, under its own namespace. */
  extensions: ExtensionsSchema.optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * An installed plugin's state. Kept next to the manifest so the loader can
 * persist trust decisions without mutating the manifest the plugin shipped.
 */
export const PluginStateSchema = z.object({
  id: PluginIdSchema,
  manifest: PluginManifestSchema,
  enabled: z.boolean(),
  /** Permissions the user actually granted (may be a subset of the request). */
  grantedPermissions: z.array(PluginPermissionSchema),
  installedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Set when the loader refused to load it, for display in the UI. */
  loadError: z.string().optional(),
  extensions: ExtensionsSchema.optional(),
});
export type PluginState = z.infer<typeof PluginStateSchema>;
