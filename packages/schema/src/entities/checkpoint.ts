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
 *
 * `CastStateSchema` is likewise IMPORTED from `./session`, not declared here: it is
 * live session state (`Session.state.cast`, M1-S4) that this snapshot copies, and
 * `castState` below is the "then" of a value whose "now" lives on the session row
 * (ADR-032). One shape, two moments — declared once, in the file that owns the
 * moment it is live in.
 */
import { z } from 'zod';
import { ExtensionsSchema, IdSchema, TimestampSchema } from '../common';
import { AgendaStatusSchema } from './agenda';
import { CastStateSchema, SessionStateSchema } from './session';

/**
 * Re-exported because this file is where `castState` is a FIELD, and a reader asking
 * "what shape is a checkpoint's cast state?" should not have to know that the answer
 * is declared next door. It is the live schema itself (`Session.state.cast`), so the
 * save point and the session row cannot drift into two shapes.
 */
export { CastStateSchema };

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
  /**
   * The cast as it stood AT THIS SAVE POINT — the "then" of `Session.state.cast`
   * (M1-S4), copied by the saver so the row is self-contained (docs/04 §6). It is
   * deliberately NOT the live value: reading a session must never read a save point,
   * and a checkpoint that shared the session's record would follow every later
   * intervention instead of recording the one it was taken at.
   */
  castState: z.record(IdSchema, CastStateSchema),
  createdAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
