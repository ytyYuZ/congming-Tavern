/**
 * The SCOPE of one co-creation request (M1-W3 / M1-W4): which payload paths this turn may touch, and
 * the one gate that decides whether an answer stayed inside them.
 *
 * WHAT THIS EXTENDS IN M1-W2'S MACHINERY, AND WHY IT IS AN EXTENSION RATHER THAN A SECOND ENGINE
 * M1-W2's turn is UNSCOPED: `coCreateInstructions` offers every editable path at once and
 * `previewWorldProposal` accepts whatever the engine can apply. Both M1-W3 (生成模式) and M1-W4
 * (字段级 AI 操作) need the same second ingredient — a turn that may only write PART of the card —
 * and the milestone's acceptance for each is stated over exactly that:
 *   • 「AI 采用结构化流程，不一次性生成全部」 — a generation step whose proposal covers only its own
 *     fields is what makes "not all at once" checkable rather than a claim about the prompt;
 *   • 「选定字段可 AI 重写」 — a proposal that touches another path has to be REFUSED, and that
 *     refusal IS the feature.
 * So the scope is added as a value that travels with a request, and everything behind it stays
 * M1-W2's: the same `WorldOp` / `applyWorldOps` engine, the same `readProposal` reader, the same
 * `previewWorldProposal`, the same accept/reject/undo in `state/co-create-store.ts`. This module
 * contains NO patch arithmetic: it decides what a turn was allowed to address and what the model is
 * told, and the first of those is a comparison over JSON Pointers.
 *
 * WHY A SCOPE IS A SET OF POINTERS AND MATCHED BY TOKEN PREFIX
 * A step covers a GROUP (`/calendar/months`), and a model that fills a month has to address a member
 * inside it (`/calendar/months/0/name`). Prefix matching in POINTER TEXT would be wrong in a way that
 * reaches the user: `/calendar/month` would read as a prefix of `/calendar/months`, so a scope on one
 * field would silently authorise a write to a different one. The comparison is therefore over
 * `pointerTokens`, which also makes the escaping M1-W2 records (`a/b` as one token) hold here.
 *
 * WHY THIS IS PURE AND READS NO STATE
 * The gate runs in the store (on a model's answer) and in the panel (to render what a step covers),
 * and both have to agree about what is in scope. A pure function of `(proposal, scope)` is the only
 * shape that makes that structural, and it is the shape `worldOpIssues` already established.
 */
import type { WorldData } from '@smarttavern/schema';
import { pointerTokens, type WorldOp } from './json-patch';
import { WORLD_PATCH_PATHS, type WorldPatchPath } from './proposal';

/**
 * Why one request is being made. The store records it with the request, so the test that proves
 * 「不一次性生成全部」 can read the SHAPE of the flow off the wire rather than off the screen.
 */
export type CoCreateRequestKind =
  /** M1-W2's ordinary turn: the whole card is open for discussion. */
  | 'chat'
  /** M1-W3: one step of a generation plan. `step` names it. */
  | 'generate-step'
  /** M1-W4: one operation over the selected field. `fieldOp` says which gesture. */
  | 'field-op';

/** M1-W4's three gestures over a selected field, named by docs/06 §2.5 (重写 / 扩写 / 精简). */
export type FieldOpKind = 'rewrite' | 'expand' | 'condense';

/**
 * The paths one request may write, and why.
 *
 * `paths` is the ALLOW-LIST and nothing else: a path absent from it is refused, which is what makes
 * "the proposal covered only this field" a property of the store rather than of the model's
 * obedience. `excluded` carries the paths the model is told to leave alone, with the sentence half
 * that says why; it is informational and never consulted by the gate.
 */
export interface CoCreateScope {
  readonly kind: CoCreateRequestKind;
  /** The step this turn belongs to (`generate-step` only). */
  readonly step?: string;
  /** The gesture this turn performs (`field-op` only). */
  readonly fieldOp?: FieldOpKind;
  /** The field this turn is about (`field-op` only) — the path the author selected. */
  readonly fieldPath?: string;
  /** Every pointer this turn may address. */
  readonly paths: readonly string[];
  /** Paths this turn must NOT address, each with the reason the model reads. */
  readonly excluded: readonly { readonly path: string; readonly why: string }[];
  /** The action sentence that opens the instruction, in plain ASCII (see `proposal.ts`). */
  readonly why: string;
}

/** The result of the gate: every operation, and the ones that fell outside the scope. */
export interface ScopeVerdict {
  /** The operations that stayed inside it, in the order they were written. */
  readonly inScope: readonly WorldOp[];
  /** The ones that did not. Non-empty means the whole proposal is refused, not partly applied. */
  readonly outOfScope: readonly WorldOp[];
}

/** One request as it was actually sent. See `CoCreateRequestKind` for why this is recorded. */
export interface CoCreateRequest {
  readonly kind: CoCreateRequestKind;
  readonly step?: string;
  readonly fieldOp?: FieldOpKind;
  readonly paths: readonly string[];
  readonly instruction: string;
  /** The instruction WITHOUT the card and the path list: the part that says what this turn is. */
  readonly preamble: string;
}

/**
 * True when `path` is `root` itself or something inside it, compared token by token.
 *
 * NaN-free and total: a path that is not a pointer addresses nothing, so it is never inside a scope —
 * and `applyWorldOps` reports it as `path-missing` a moment later, which is where that belongs.
 */
export function isPathWithin(root: string, path: string): boolean {
  const rootTokens = pointerTokens(root);
  const pathTokens = pointerTokens(path);
  if (rootTokens === undefined || pathTokens === undefined) return false;
  if (pathTokens.length < rootTokens.length) return false;
  return rootTokens.every((token, index) => pathTokens[index] === token);
}

/**
 * The verdict of one proposal against one scope.
 *
 * A proposal is judged as a WHOLE: `inScope` exists so a caller can report how many operations were
 * fine, and the store's rule is the one W4's acceptance asks for — if any operation is outside, the
 * proposal is refused and NOTHING is applied. Applying the in-scope half of a scoped proposal would
 * turn "this field may be rewritten" into "this field plus whatever else the model felt like".
 */
export function scopeVerdict(ops: readonly WorldOp[], scope: CoCreateScope): ScopeVerdict {
  const inScope: WorldOp[] = [];
  const outOfScope: WorldOp[] = [];
  for (const op of ops) {
    const inside = scope.paths.some((root) => isPathWithin(root, op.path));
    (inside ? inScope : outOfScope).push(op);
  }
  return { inScope, outOfScope };
}

/**
 * The editable fields inside a scope, in the form's own order.
 *
 * WHY IT IS DERIVED FROM `WORLD_PATCH_PATHS` AND NOT CARRIED IN THE SCOPE: the scope is serialised
 * into a request record and compared against operations, and a field's LABEL is a rendering concern.
 * Reading it here keeps one list of "which fields exist" — proposal.ts's, which is itself derived
 * from `cards/world.ts`'s form inventory.
 */
export function patchPathsForScope(scope: CoCreateScope): readonly WorldPatchPath[] {
  return WORLD_PATCH_PATHS.filter((entry) =>
    scope.paths.some((root) => isPathWithin(root, entry.path)),
  );
}

/**
 * The instruction text for a scoped turn, built from the draft exactly as M1-W2's is.
 *
 * EVERY SENTENCE IS PLAIN ASCII, and that is a rule rather than a style choice: `proposal.ts` records
 * that this project's i18n checker counts the em dash as a CJK punctuation mark, so prompt text that
 * is not translated must not look like copy. `data` is the payload only; the plugin bag on the
 * version envelope (`extensions`) is never part of a conversation.
 */
export function scopeInstruction(data: WorldData, scope: CoCreateScope): string {
  return [
    ...scopePreamble(scope),
    '',
    'PATHS YOU MAY EDIT (nothing else - a change anywhere else is refused and the author sees why):',
    ...patchPathsForScope(scope).map((entry) => `- ${entry.path}  (${entry.label})`),
    ...excludedLines(scope),
    '',
    'THE CURRENT CARD (JSON - the payload the author is editing):',
    JSON.stringify(data, null, 2),
  ].join('\n');
}

/**
 * The part of a scoped instruction that says WHAT THIS TURN IS, without the card.
 *
 * Split out for the request record: a test that asserts the structure of a generation flow reads the
 * preamble of each request, and a preamble that still carried the whole payload would make the
 * assertion about JSON size rather than about which step was asked for.
 */
export function scopePreamble(scope: CoCreateScope): string[] {
  return [
    'You are co-writing a WORLD CARD for a role-playing app with its author, one turn at a time.',
    'You are NOT the game master here and this is NOT the role-play transcript: you discuss the world',
    'and propose concrete edits to the card.',
    '',
    scope.why,
    '',
    'HOW TO EDIT: answer with ONE JSON object and nothing else - no prose around it, no markdown fence:',
    '{"message": "<your reply to the author>", "rationale": "<why these edits>", "ops": [<operation>]}',
    '',
    'An operation is an RFC 6902 style object addressed at the CURRENT card below:',
    '- {"op":"replace","path":"/era","value":"..."}   change a value that already exists',
    '- {"op":"add","path":"/regions","value":{...}}    insert a new item into a list (optional "at": n,',
    '                                                  default is the end of the list)',
    '- {"op":"remove","path":"/openingHooks/0"}        delete a value',
    'Rules: a path is a JSON Pointer; "add" only creates (use "replace" to change something); a number',
    'must be an integer where the card has an integer; never write null; keep the JSON types the card',
    'already uses. The result must still be a valid world card, or the proposal is refused.',
    'If nothing should change yet, answer with "ops": [] and ask your question in "message".',
  ];
}

/** The "do not touch" block, and nothing at all when the scope excludes nothing. */
function excludedLines(scope: CoCreateScope): string[] {
  if (scope.excluded.length === 0) return [];
  return [
    '',
    'DO NOT EDIT THESE PATHS IN THIS TURN (they belong to another step or to the app itself):',
    ...scope.excluded.map((entry) => `- ${entry.path}  (${entry.why})`),
  ];
}

/**
 * The reason text for a path that a generation plan has not reached yet.
 *
 * One sentence, one meaning, because the model reads it beside a path list and a longer explanation
 * is a longer thing to disobey: the path is not wrong, it is simply not this turn's.
 */
export function excludedWhyFor(kind: 'later-step' | 'app-setting' | 'not-offered'): string {
  switch (kind) {
    case 'later-step':
      return 'reserved for a later step of this generation';
    case 'app-setting':
      return 'a calendar or pacing setting the author keeps by hand';
    default:
      return 'not offered for editing';
  }
}
