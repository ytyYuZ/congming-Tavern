/**
 * The RFC 6902-shaped patch engine, as the app calls it: the generic operations from
 * `co-create/target.ts`, plus the two world-card spellings M1-W2/M1-W3/M1-W4 shipped.
 *
 * WHY THIS FILE IS NOW A FACADE (M1-C2)
 * The arithmetic, the pointer parser and the type-equality rule never named a world — only the schema
 * that judged the RESULT did (`WorldDataSchema.safeParse`). So the engine moved to
 * `co-create/target.ts`, generalised over a `CardTarget`, and what is left here is:
 *   • the generic operations, re-exported so the engine still has one import site for the patch
 *     format itself;
 *   • `applyWorldOps` / `worldOpIssues` / `readWorldOp`, which are the WORLD target bound to the
 *     generic functions (`co-create/proposal.ts` holds that target) and whose behaviour is unchanged:
 *     the world tests that proved M1-W2 through M1-W4 keep passing byte for byte, which is the proof
 *     that the generalisation did not fork the engine.
 * A character proposal goes through the SAME `applyOps` with `CHARACTER_TARGET` instead; there is no
 * second patch implementation anywhere in the app.
 */
import type { JsonValue, WorldData } from '@smarttavern/schema';
import { WORLD_TARGET } from './proposal';
import {
  applyOps,
  opIssues,
  type PatchOp,
  type PatchOpFailure,
  type PatchOpIssue,
  type PatchOpRead,
  type PatchOpReadFailure,
  readPatchOp,
} from './target';

export {
  type ApplyOpsRefusal,
  type ApplyOpsResult,
  applyOps,
  arrayIndexOf,
  type CardKind,
  type CardTarget,
  customFieldPaths,
  dottedOf,
  escapePointerToken,
  isJsonValue,
  MAX_POINTER_TOKENS,
  MAX_PROPOSAL_OPS,
  type PatchOp,
  type PatchOpFailure,
  type PatchOpIssue,
  type PatchOpRead,
  type PatchOpReadFailure,
  type PatchPath,
  type PatchTarget,
  type PatchVerb,
  PathLabels,
  pointerOf,
  pointerTokens,
  readPatchOp,
  sameJson,
} from './target';

/** One operation over a WORLD payload. See `PatchOp` for the format. */
export type WorldOp = PatchOp;

/** Why one operation cannot be applied to a world payload. */
export type WorldOpFailure = PatchOpFailure;

/** One failed operation, with the index and pointer the panel prints. */
export type WorldOpIssue = PatchOpIssue;

/** One operation, or the reason the value cannot be one. */
export type WorldOpRead = PatchOpRead;

/** Why a JSON value in an operation is unusable. */
export type WorldOpReadFailure = PatchOpReadFailure;

/**
 * The most operations one proposal may carry (the world spelling of `MAX_PROPOSAL_OPS`).
 *
 * Kept as its own name because the bound is what M1-W2's and M1-W3's tests assert, and because a
 * reader of `proposal.ts` should not have to know that the same 32 also bounds a character patch: it
 * bounds a PROPOSAL, and a proposal is one of either kind.
 */
export const MAX_WORLD_OPS = 32;

/** Read one untrusted JSON value as a `WorldOp`. See `readPatchOp` for the two distinctions it makes. */
export function readWorldOp(value: JsonValue): WorldOpRead {
  return readPatchOp(value);
}

/**
 * Why `ops` cannot be applied to a WORLD payload — the list the preview and the apply both report.
 *
 * `WorldData` is JSON by construction (`JsonValue`'s object arm is exactly its shape), so the cast
 * states what the type already guarantees rather than widening anything.
 */
export function worldOpIssues(payload: WorldData, ops: readonly WorldOp[]): WorldOpIssue[] {
  return opIssues(payload as JsonValue, ops);
}

/** The answer of `applyWorldOps`: the payload a patch produces, or why it cannot be produced. */
export type ApplyWorldOpsResult =
  | { readonly ok: true; readonly data: WorldData }
  | {
      readonly ok: false;
      readonly issues: readonly WorldOpIssue[];
      readonly schemaPath?: string;
    };

/**
 * The one function that turns `(world payload, operations)` into the payload they produce.
 *
 * THE PREVIEW AND THE APPLY CALL THIS AND NOTHING ELSE, and it is `applyOps` with the world target
 * bound — so a world proposal and a character proposal are computed by the same code and only differ
 * in which schema judges the result.
 */
export function applyWorldOps(payload: WorldData, ops: readonly WorldOp[]): ApplyWorldOpsResult {
  const result = applyOps(WORLD_TARGET, payload, ops);
  if (result.ok) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.issues,
    ...(result.schemaPath === undefined ? {} : { schemaPath: result.schemaPath }),
  };
}
