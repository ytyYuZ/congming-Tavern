/**
 * Memory entry — long-term, timestamped recollection (docs/02 §4.1, §5.2 L3, §7
 * `memories`).
 *
 * WHY THIS IS NOT A WORLDBOOK ENTRY (ADR-015)
 * The two mechanisms stay separate on purpose: a worldbook entry is a *setting
 * fact* that deterministic keyword/time conditions pull into the prompt, while a
 * memory is something the AI extracted from the session with 语义抽取 and the
 * user confirmed. They share an editor and a storage layer, not a trigger.
 *
 * That difference is exactly why `status` exists and why `proposed` is the
 * default a writer should use: the AI's extraction is a PROPOSAL, never a fact,
 * until the user confirms it (docs/02 §5.2 L3 "AI 抽取 + 用户确认", docs/01
 * F5-5). A schema without `proposed` would let an unconfirmed guess into the
 * prompt forever.
 *
 * `atMinute` is the in-world time the memory is *about* (docs/02 §7 bolds it),
 * not when the row was written; `createdAt` is the wall-clock row timestamp.
 * "What happened on the third day" is answerable only because both exist.
 *
 * OPEN vs CLOSED
 * - `scope` is OPEN (`openEnum`): a plugin may add a scope it owns
 *   (`x-mythos.faction-memory`).
 * - `status` is CLOSED: the extraction/confirmation workflow is intrinsic to the
 *   app, and the UI filters on exactly these three states.
 */
import { z } from 'zod';
import {
  EpochMinuteSchema,
  ExtensionsSchema,
  IdSchema,
  openEnum,
  TimestampSchema,
} from '../common';

/* ─────────────────────────────── 作用域与状态 ────────────────────────────── */

/** OPEN: what a memory is attached to; plugins may add their own kind. */
export const MemoryScopeSchema = openEnum(['world', 'character', 'session', 'user'] as const);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** CLOSED: AI extraction -> user confirmation, the workflow the UI drives. */
export const MemoryStatusSchema = z.enum(['proposed', 'confirmed', 'rejected']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/* ──────────────────────────────── 记忆条目 ───────────────────────────────── */

export const MemoryEntrySchema = z.object({
  id: IdSchema,
  scope: MemoryScopeSchema,
  /** The world / character / session this memory belongs to. */
  targetId: IdSchema,
  /** The recollection itself, one self-contained statement. */
  text: z.string().min(1).max(2000),
  /** Retrieval keys, written by the extractor and editable by the user. */
  keywords: z.array(z.string()),
  /** 0-100, used to rank what survives the token budget (docs/02 §5.2 L3). */
  importance: z.number().int().min(0).max(100),
  /** When it happened in the world — an epoch minute (ADR-012). */
  atMinute: EpochMinuteSchema,
  status: MemoryStatusSchema,
  /** The message the extractor read it out of, for "why do you think that?". */
  sourceMessageId: IdSchema.optional(),
  /** When the row was written (wall clock, milliseconds). */
  createdAt: TimestampSchema,
  extensions: ExtensionsSchema.optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
