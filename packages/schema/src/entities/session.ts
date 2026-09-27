/**
 * Session — one playthrough of a world (docs/02 §4 `Session` / `SessionRefs` /
 * `SessionState` / `Deadline`, §7 `sessions`).
 *
 * THE ONE RULE THAT SHAPES THIS FILE (ADR-010)
 * Identity is a property of the SESSION, not of a character card.
 * `SessionRefs.playerCharacter` names the card the user plays; every other card
 * in `cast` is an NPC. A character card must therefore never carry a
 * player/cast flag, an `isPlayer`/`kind`/`role` field or a duplicate persona:
 * the same card has to be able to play the protagonist in one session and the
 * antagonist in the next, and an imported card that contained such a flag would
 * fight the session that owns it. See `./character.ts`, which is deliberately
 * free of any identity field.
 *
 * TIME (ADR-012, ADR-032)
 * `initialClock` is where this session started — the world's `startMinute`,
 * copied here so the session owns its origin, and it never moves. The *live* time
 * lives in `Session.state.clock` (`SessionState` below) and is snapshotted into
 * every checkpoint. A save that rolls the clock back must roll the rest of the
 * state back with it (docs/02 §5.7), which is why both numbers exist rather than
 * one.
 *
 * WHY THE LIVE STATE IS ON THE SESSION ROW (ADR-032)
 * `state` is a REQUIRED field of `Session`, not a nineteenth collection: ADR-022
 * freezes the collection list as "§7's eighteen, verbatim", the row is already
 * written every turn (`headMessageId`), and a checkpoint stays a full snapshot in
 * its OWN collection — live state is "now", a checkpoint is "then", and rollback
 * only means something while both exist. Rows written before this field existed
 * are completed AT THE READ BOUNDARY (`apps/web/src/db/repository.ts`) with
 * `defaultSessionState()`, which is what this file's helper is for: the missing
 * field can be DERIVED from `initialClock`, so no `migrations` row is needed.
 *
 * OPEN vs CLOSED
 * - `schedulerMode` and `Deadline.kind`/`status` are CLOSED: they are intrinsic
 *   protocol semantics the local scheduler and time engine switch on
 *   exhaustively, and a plugin-invented mode could not be honoured (docs/02 §4.1).
 * - The plugin channel for a session is `extensions`, as everywhere else.
 */
import { z } from 'zod';
import {
  EpochMinuteSchema,
  ExtensionsSchema,
  IdSchema,
  SamplingParamsSchema,
  TimestampSchema,
} from '../common';

/* ──────────────────────────────── 引用 ───────────────────────────────────── */

/**
 * A fully pinned reference: `{id, version}` and nothing else.
 *
 * Deliberately NOT `EntityRefSchema`: that one carries a `kind` (for
 * polymorphic slots) and an optional `version` (for "whatever the head is").
 * Here the surrounding field already names the kind, and every reference a
 * session holds must be pinned — an unpinned world would make an old save
 * re-render differently after an edit (ADR-010).
 */
export const EntityPinSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
});
export type EntityPin = z.infer<typeof EntityPinSchema>;

/**
 * What this session is made of. `playerCharacter` is required, not optional:
 * a session that does not know who the user plays cannot build a prompt.
 *
 * `id` is an `IdSchema`, never a `UuidV7Schema`: an imported session pack is
 * schema-validated *before* its ids are remapped (docs/04 §7 steps 3 and 8), so
 * a foreign-but-well-formed id must not be a hard failure here.
 */
export const SessionRefsSchema = z.object({
  world: EntityPinSchema,
  playerCharacter: EntityPinSchema,
  /** Everyone else on stage. Empty is legal (a solo opening scene). */
  cast: z.array(EntityPinSchema),
  promptPreset: EntityPinSchema,
  rulePack: EntityPinSchema.optional(),
  modelConfig: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    params: SamplingParamsSchema,
  }),
});
export type SessionRefs = z.infer<typeof SessionRefsSchema>;

/* ─────────────────────────── 会话状态（存档快照） ─────────────────────────── */

/**
 * Countdown / duration deadline. `targetId` is what the countdown is *about*
 * (a character, an agenda entry) and is optional because a plain "3 days until
 * the ritual" has no target.
 */
export const DeadlineSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  dueMinute: EpochMinuteSchema,
  /** CLOSED: intrinsic semantics the time engine switches on. */
  kind: z.enum(['countdown', 'duration']),
  targetId: IdSchema.optional(),
  /** CLOSED: the countdown state machine. */
  status: z.enum(['active', 'expired', 'cleared']),
});
export type Deadline = z.infer<typeof DeadlineSchema>;

/** Combat rounds / turns, which suspend the narrative clock (docs/02 §5.7). */
export const InnerClockSchema = z.object({
  kind: z.enum(['round', 'turn']),
  current: z.number().int().nonnegative(),
  total: z.number().int().positive().optional(),
  /** Used to convert tracks back into narrative minutes when the fight ends. */
  secondsPerRound: z.number().positive(),
  note: z.string(),
});
export type InnerClock = z.infer<typeof InnerClockSchema>;

/**
 * The mutable state a checkpoint snapshots whole (docs/04 §6) AND the live state
 * every session row carries in `Session.state` (ADR-032). Everything the UI shows
 * mid-scene is here, so restoring a save never needs to replay messages: `scene`,
 * the clocks, free variables, rule-pack sheets and deadlines.
 *
 * `vars` is primitives only (macros substitute into text), while `sheets` holds
 * whatever a rule pack needs per actor — `unknown` there on purpose, because the
 * rule pack owns its schema and core must not.
 */
export const SessionStateSchema = z.object({
  scene: z.object({
    title: z.string(),
    location: z.string(),
    time: EpochMinuteSchema,
  }),
  clock: EpochMinuteSchema,
  innerClock: InnerClockSchema.optional(),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  sheets: z.record(IdSchema, z.record(z.string(), z.unknown())),
  deadlines: z.array(DeadlineSchema),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * The state a session starts from: an untitled scene whose only real content is
 * the clock, which is where the session itself started.
 *
 * WHY THIS IS A DERIVATION AND NOT A CONSTANT (ADR-032's addendum)
 * `Session.state` is required, so every writer has to supply one AND every reader
 * has to complete a row written before the field existed. Both cases answer the
 * same question — "what does a session with nothing recorded yet look like?" — and
 * the honest answer is derivable from what the row already carries: the clock is
 * `initialClock`, and the rest is empty. Deriving it (rather than reading a stored
 * `migrations` row) is exactly why no migration is needed: a migration is for a
 * change of MEANING, and this field's meaning is recoverable from a field that is
 * already there.
 *
 * `scene.title` and `scene.location` are deliberately EMPTY: only the clock has a
 * value the session already knows. Copying the session title into the scene would
 * make "the scene was never named" indistinguishable from "the scene is named
 * after the save", and a location is not something that can be invented.
 */
export function defaultSessionState(initialClock: number): SessionState {
  return {
    scene: { title: '', location: '', time: initialClock },
    clock: initialClock,
    vars: {},
    sheets: {},
    deadlines: [],
  };
}

/* ─────────────────────────────── 会话 ────────────────────────────────────── */

/**
 * Who decides the speaking order (ADR-011): the user, the local rule scoring, or
 * the AI's proposal. CLOSED — the scheduler has exactly these three behaviours,
 * and `TurnPlan.mode` reuses this same schema so the two cannot drift.
 */
export const SchedulerModeSchema = z.enum(['user', 'rules', 'ai']);
export type SchedulerMode = z.infer<typeof SchedulerModeSchema>;

/**
 * WHY THE STATE SECTION SITS ABOVE THIS ONE: a Zod object evaluates its fields
 * when it is built, so `state: SessionStateSchema` would read a `const` before its
 * declaration — a temporal-dead-zone crash, not a style preference. So this file
 * reads top-down in dependency order: common → refs → state (Deadline / InnerClock
 * / SessionState / default) → session.
 */
export const SessionSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(200),
  refs: SessionRefsSchema,
  /**
   * The world's `startMinute`, copied here so the session owns its origin.
   *
   * NOT the live clock (ADR-012): `state.clock` below is the one that moves, and
   * it is what `clockOf` reads. This field is kept because a rollback, a package
   * export and a freshly derived default state all need to know where the session
   * began — deleting it would lose the origin, not a redundant copy.
   */
  initialClock: EpochMinuteSchema,
  /**
   * The LIVE session state — what the UI shows and what a turn advances
   * (docs/02 §5.7, §7; ADR-032). Required, because a session without a clock, a
   * scene or variables cannot be played; a row written before this field existed
   * is completed at the read boundary with `defaultSessionState()`.
   */
  state: SessionStateSchema,
  schedulerMode: SchedulerModeSchema,
  /**
   * Tip of the message tree (`null` before the first message). The displayed
   * history is this node's ancestor chain reversed (docs/02 §7).
   */
  headMessageId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;
