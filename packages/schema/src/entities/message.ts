/**
 * Message — one node of the conversation tree (docs/02 §4 `Message` / `ToolCall`,
 * §7 `messages`).
 *
 * OPEN vs CLOSED, THE ONE DISTINCTION THIS FILE TURNS ON
 * - `role` is CLOSED. It is the wire protocol's own vocabulary — an OpenAI-shaped
 *   request can only send system/user/assistant/tool, and the prompt composer
 *   switches on it exhaustively. A plugin-invented role could not be sent
 *   anywhere, so opening it would buy nothing and cost the exhaustiveness check
 *   (`common.ts` rule 3, docs/02 §4.1).
 * - `kind` is OPEN (`MessageKindSchema` from `../plugins`): "narration vs
 *   dialogue vs ooc" is a *presentation* distinction, a plugin may legitimately
 *   add `x-<ns>.monologue`, and every consumer of it already has a default arm.
 * - `ToolCall.source` is OPEN too (`openEnum`): a plugin may answer over a new
 *   channel. `ToolCall.status` stays CLOSED (a three-state outcome the UI and the
 *   retry logic switch on) and `ToolCall.name` stays a free string, because tools
 *   are registered by name (HANDOFF §4.1 invariant 3).
 *
 * THE TREE
 * `parentId` is `null` for a root and points at another message otherwise. A
 * linear chat is the degenerate tree; regeneration, editing and rollback are all
 * "which child does `Session.headMessageId` point at" (docs/02 §7).
 */
import { z } from 'zod';
import {
  EpochMinuteSchema,
  ExtensionsSchema,
  IdSchema,
  openEnum,
  TimestampSchema,
} from '../common';
import { MessageKindSchema } from '../plugins';

/* ─────────────────────────────── 工具调用 ────────────────────────────────── */

/**
 * A structured tool call. `args` and `result` are `unknown` on purpose: each
 * tool owns its own argument schema in `core/ports` and core must not re-freeze
 * it here (docs/02 §5.3). Both are plain JSON in practice, which is what keeps
 * the round-trip stable.
 */
export const ToolCallSchema = z.object({
  id: IdSchema,
  /** Free string: a plugin-provided tool is registered by name (plugins.ts §3). */
  name: z.string().min(1),
  args: z.unknown(),
  result: z.unknown().optional(),
  /** CLOSED: 'ok' | 'rejected' | 'error' is the outcome vocabulary the UI shows. */
  status: z.enum(['ok', 'rejected', 'error']),
  /** OPEN: plugins may speak a new protocol, e.g. `x-mythos.function-call`. */
  source: openEnum(['native', 'json', 'text-protocol'] as const),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/* ──────────────────────────────── 元数据 ─────────────────────────────────── */

/**
 * What the debug panel and the time engine need to explain a message: how many
 * tokens it cost, which model produced it, which prompt snapshot and turn plan
 * it came from, and when in the *world* it happened.
 *
 * `emittedAtMinute` is why a message can be placed on the timeline even after
 * the clock has moved on — memory entries and agenda results reference it.
 */
export const MessageMetaSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  /** Id of the stored prompt snapshot this message was generated from. */
  promptSnapshotId: IdSchema.optional(),
  emittedAtMinute: EpochMinuteSchema.optional(),
  /** The local plan that decided who spoke (ADR-011). */
  turnPlanId: IdSchema.optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

/* ──────────────────────────────── 消息 ───────────────────────────────────── */

export const MessageSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** `null` for a root message; otherwise the tree edge (docs/02 §7). */
  parentId: IdSchema.nullable(),
  /** CLOSED wire protocol role — see the file header. */
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  /** Which card spoke. Absent for narration/system output. */
  speakerId: IdSchema.optional(),
  /** OPEN presentation kind from `../plugins`. */
  kind: MessageKindSchema,
  content: z.string(),
  /** Named expression the portrait should show (matches the card's diff ids). */
  emotion: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  /** Required: an empty object is fine, a missing one loses the debug trail. */
  meta: MessageMetaSchema,
  createdAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type Message = z.infer<typeof MessageSchema>;
