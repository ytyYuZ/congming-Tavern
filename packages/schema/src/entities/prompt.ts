/**
 * Prompt preset & blocks — what goes into the model, in order (docs/02 §5.1
 * `PromptBlock`, §7 `promptPresets`, docs/04 §2 `data/promptPresets.json`).
 *
 * WHY THIS ENTITY IS FLAT (one row) WHILE WORLDS AND CHARACTERS ARE NOT
 * `worlds`/`characters` are head+version pairs: editing one produces a new immutable
 * version, and every save pins `{id, version}` so history stays reproducible
 * (ADR-010). A preset is NOT stored that way, and this is deliberate, not an
 * oversight: `docs/02` §7 gives the `promptPresets` row `id, name, version, blocks[]`
 * — the blocks live ON the row — and `docs/04` §2 (FROZEN, v1) names the payload
 * `PromptPreset[]`, with no version collection beside it the way `worlds.json` is
 * explicitly `WorldVersion[]`.
 *
 * WHAT PROTECTS REPRODUCIBILITY INSTEAD: the prompt SNAPSHOT. `MessageMeta.promptSnapshotId`
 * points at the stored assembly a message was actually generated from, so a message
 * re-renders its own prompt even after someone edits the preset it came from. A preset
 * is therefore closer to a setting than to a world: a template the user keeps tuning,
 * whose `version` is a counter for display and migration, not an immutability claim.
 *
 * OPEN vs CLOSED (the one distinction this file turns on, docs/02 §4.1)
 * - `role`, `position` and `budget.priority` are CLOSED. The composer switches on all
 *   three exhaustively: `position` decides where a block lands, `priority` decides what
 *   gets trimmed when the budget is exceeded, and a plugin-invented member could not be
 *   honoured by either.
 * - `content`, `name` and the condition lists stay free strings/arrays: what a macro
 *   expands to is not a closed vocabulary, and `conditions.timeOfDay` matches segment
 *   ids that come from the world's own calendar data, so the schema cannot enumerate them.
 */
import { z } from 'zod';
import {
  ExtensionsSchema,
  IdSchema,
  TimestampSchema,
  UuidV7Schema,
  VersionNumberSchema,
} from '../common';

/**
 * Wire role of a block. Closed and deliberately a three-member subset of
 * `Message.role`: a preset cannot inject a `tool` turn (tool results come from the
 * runtime, not from a template) or a second `system` turn whose position would be
 * meaningless.
 */
export const PromptRoleSchema = z.enum(['system', 'user', 'assistant']);
export type PromptRole = z.infer<typeof PromptRoleSchema>;

/**
 * Where the block is inserted relative to the conversation history. Closed: this IS
 * the assembly order (docs/02 §5.1), and `depth` only has meaning inside
 * `in_history`.
 */
export const PromptBlockPositionSchema = z.enum(['pre_history', 'in_history', 'post_history']);
export type PromptBlockPosition = z.infer<typeof PromptBlockPositionSchema>;

/**
 * What happens to this block when the token budget is exceeded (docs/02 §5.1).
 * Closed, and ordered from most to least protected:
 * `required` is never trimmed and an over-budget assembly with a required block that
 * does not fit is an explicit error; the other three are trimmed low-to-high.
 */
export const PromptBlockPrioritySchema = z.enum(['required', 'high', 'normal', 'optional']);
export type PromptBlockPriority = z.infer<typeof PromptBlockPrioritySchema>;

/**
 * A block's claim on the budget.
 *
 * `share` is a FRACTION of the total budget (0 exclusive to 1 inclusive), not a token
 * count — a token count would be stale the moment the user switches model, while a
 * share survives it. It is a ceiling for this one block, not a reservation: the
 * composer may give it less when the whole assembly is over budget.
 */
export const PromptBlockBudgetSchema = z.object({
  share: z.number().gt(0).lte(1).optional(),
  priority: PromptBlockPrioritySchema,
});
export type PromptBlockBudget = z.infer<typeof PromptBlockBudgetSchema>;

/**
 * When a block is included at all. Every field is optional and they are ANDed: a
 * block with no conditions is always included, which is the common case.
 *
 * `timeOfDay` holds SEGMENT IDS (`DaySegment.id` from the world's calendar), not
 * display names — the same values `TimeEngine.segmentOf` returns, so a worldbook
 * condition and a block condition cannot disagree about what "dusk" means.
 */
export const PromptBlockConditionsSchema = z.object({
  /** Included only when the conversation so far mentions one of these. */
  keywords: z.array(z.string()).optional(),
  /** Included from this turn number onwards (a "cold open" block stops applying). */
  minTurns: z.number().int().nonnegative().optional(),
  /** Included only while the world clock is in one of these segments. */
  timeOfDay: z.array(z.string()).optional(),
});
export type PromptBlockConditions = z.infer<typeof PromptBlockConditionsSchema>;

/**
 * One ordered piece of the assembled prompt.
 *
 * `id` is an `IdSchema`, not a `UuidV7Schema`: a preset travels inside `.stpack`, and
 * `docs/04` §7 validates a foreign package BEFORE remapping its ids, so a
 * well-formed foreign block id must not be a hard failure here. `order` is an
 * integer rather than an array position because a preset's blocks are edited in a UI
 * where reordering must not rewrite every other block's identity.
 */
export const PromptBlockSchema = z.object({
  id: IdSchema,
  /** Shown in the preset editor. Free text: users name their own blocks. */
  name: z.string().min(1).max(200),
  role: PromptRoleSchema,
  /** Supports macros (`{{char}}`, `{{time}}`, …; docs/02 §5.1). Free text by design. */
  content: z.string(),
  /** Disabled blocks stay in the preset so turning one back on loses nothing. */
  enabled: z.boolean(),
  position: PromptBlockPositionSchema,
  /** Insert depth inside the history; only meaningful for `in_history`. */
  depth: z.number().int().nonnegative().optional(),
  order: z.number().int(),
  budget: PromptBlockBudgetSchema.optional(),
  conditions: PromptBlockConditionsSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});
export type PromptBlock = z.infer<typeof PromptBlockSchema>;

/**
 * A whole preset — the flat `promptPresets` row of docs/02 §7 and the
 * `data/promptPresets.json` element of docs/04 §2 (see this file's header for why it
 * is flat).
 *
 * `blocks` may be EMPTY: a preset an editor just created is legal, and a foreign pack
 * carrying an empty preset is not something a reader should reject — the composer
 * treats "no blocks" as "nothing to inject", which is a usable prompt.
 *
 * `version` is a counter for display and migration, not an immutability claim (again,
 * see the header).
 */
export const PromptPresetSchema = z.object({
  id: UuidV7Schema,
  name: z.string().min(1).max(200),
  version: VersionNumberSchema,
  blocks: z.array(PromptBlockSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type PromptPreset = z.infer<typeof PromptPresetSchema>;
