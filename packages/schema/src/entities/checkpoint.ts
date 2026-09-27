/**
 * Checkpoint — the save point (docs/02 §4 `Checkpoint`, §5.7, §7 `checkpoints`,
 * docs/04 §6).
 *
 * THE INVARIANT THIS ENTITY EXISTS FOR
 * A checkpoint carries the FULL state snapshot, including the complete clock, so
 * loading a save never replays messages (docs/04 §6: "每个检查点自带完整 state
 * 快照，读档不依赖回放消息"). `state.clock`, `state.innerClock` and
 * `state.deadlines` are therefore all inside `state`, not referenced from it, and
 * "time went back but the state did not" is a bug this schema makes impossible to
 * express (docs/02 §5.7).
 *
 * `state` is `SessionStateSchema` — the same schema `state.json` in a session
 * package uses, so a save and an export cannot disagree about what state is.
 *
 * OPEN vs CLOSED: `agendaStatus[].status` reuses `AgendaStatusSchema` from
 * `./agenda` (CLOSED — the agenda state machine) rather than redeclaring it, so a
 * checkpoint can never mark an entry with a status the agenda itself rejects.
 */
import { z } from 'zod';
import { ExtensionsSchema, IdSchema, TimestampSchema } from '../common';
import { AgendaStatusSchema } from './agenda';
import { SessionStateSchema } from './session';

/* ───────────────────────────── 卡司状态 ──────────────────────────────────── */

/**
 * Where one character stands at this save point. Keyed by character id in
 * `castState`. `present` is required — the presence question always has an
 * answer — while the presentation details are optional because a card may not
 * have a matching outfit or emotion diff.
 */
export const CastStateSchema = z.object({
  present: z.boolean(),
  emotion: z.string().optional(),
  /** Outfit diff id from the card's `visual.outfits`. */
  outfit: z.string().optional(),
  /** Stage-muted: still on stage, deliberately not prompted. */
  muted: z.boolean().optional(),
});
export type CastState = z.infer<typeof CastStateSchema>;

/* ──────────────────────────────── 存档点 ─────────────────────────────────── */

export const CheckpointSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  label: z.string().min(1),
  /**
   * The message this save point sits at; the read path starts here.
   *
   * NULLABLE, AND IT MIRRORS `Session.headMessageId` (ADR-032). A session starts with
   * no messages — that field is `IdSchema.nullable()` for exactly that reason — so
   * "save a point before the first message" is a legal act and `null` is its ONE
   * spelling. It was a non-empty `Id` until this field's first real consumer measured
   * it: there is no message id to name at minute zero and `''` is refused by
   * `IdSchema`, so the act had no representation rather than being forbidden by design.
   *
   * REQUIRED all the same (`nullable()` is not `optional()`): a checkpoint always says
   * WHERE it is, and "no message" is a position, not an absent field.
   */
  messageId: IdSchema.nullable(),
  /** True when the engine wrote it (before/after a time advance), not the user. */
  auto: z.boolean(),
  /** The whole mutable world: clock, inner clock, vars, sheets, deadlines. */
  state: SessionStateSchema,
  /** Agenda entries whose status changed by this point, for restore + display. */
  agendaStatus: z.array(
    z.object({
      id: IdSchema,
      status: AgendaStatusSchema,
    }),
  ),
  /** Rolling summary shipped with the save so a cold load has context. */
  summary: z.string(),
  castState: z.record(IdSchema, CastStateSchema),
  createdAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
