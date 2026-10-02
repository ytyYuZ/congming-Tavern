/**
 * The SCOPE of one co-creation request (M1-W3 / M1-W4, generalised for M1-C2 / M1-C3): which payload
 * paths this turn may touch, and the one gate that decides whether an answer stayed inside them.
 *
 * WHAT THIS EXTENDS IN M1-W2'S MACHINERY, AND WHY IT IS AN EXTENSION RATHER THAN A SECOND ENGINE
 * M1-W2's turn is UNSCOPED: the instruction offers every editable path at once and the preview accepts
 * whatever the engine can apply. M1-W3 (生成模式), M1-W4 (字段级 AI 操作), M1-C2 (角色 AI 生成) and
 * M1-C3 (发言档案自动评估) each need the same second ingredient — a turn that may only write PART of
 * the card — and every one of those milestones states its acceptance over exactly that:
 *   • 「AI 采用结构化流程，不一次性生成全部」 — a generation step whose proposal covers only its own
 *     fields is what makes "not all at once" checkable rather than a claim about the prompt;
 *   • 「选定字段可 AI 重写」 — a proposal that touches another path has to be REFUSED, and that
 *     refusal IS the feature;
 *   • M1-C3's assessment may score `voice.desire`/`ability`/`roles` and nothing else.
 * So the scope is added as a value that travels with a request, and everything behind it stays one
 * engine: the same `PatchOp` / `applyOps` code, the same `readProposal` reader, the same
 * `previewProposal`, the same accept/reject/undo in `state/co-create-store.ts`. This module contains NO
 * patch arithmetic: it decides what a turn was allowed to address and what the model is told, and the
 * first of those is a comparison over JSON Pointers.
 *
 * WHY A SCOPE IS A SET OF POINTERS MATCHED BY TOKEN PREFIX
 * A step covers a GROUP (`/calendar/months`, `/visual/appearance`), and a model that fills a month has
 * to address a member inside it (`/calendar/months/0/name`). Prefix matching in POINTER TEXT would be
 * wrong in a way that reaches the user: `/calendar/month` would read as a prefix of `/calendar/months`,
 * so a scope on one field would silently authorise a write to a different one. The comparison is
 * therefore over `pointerTokens`, which also makes the escaping `target.ts` records (`a/b` as one
 * token) hold here.
 *
 * WHY THE CARD KIND TRAVELS IN THE SCOPE
 * The same scope shape serves two cards, and the store has to know WHICH DRAFT a proposal is about
 * before it previews or applies anything (`state/co-create-store.ts`). Putting the kind in the plan
 * would leave the two facts travelling separately, and a scope assembled by hand (a voice assessment,
 * M1-C4's future variable proposal) would have nowhere to say it.
 *
 * WHY THIS IS PURE AND READS NO STATE
 * The gate runs in the store (on a model's answer) and in the panel (to render what a step covers), and
 * both have to agree about what is in scope. A pure function of `(proposal, scope)` is the only shape
 * that makes that structural, and it is the shape `opIssues` already established.
 */
import { WORLD_PATCH_PATHS } from './proposal';
import type { CardKind, CoCreateRequestKind, PatchOp, PatchPath } from './target';
import { isPathWithin } from './target';

export type {
  CardKind,
  CoCreateRequest,
  CoCreateRequestKind,
  CoCreateScope,
  FieldOpKind,
} from './target';
export { isPathWithin };

/**
 * The card's name in an instruction: `WORLD CARD` or `CHARACTER CARD`.
 *
 * A function of the KIND rather than of the plan, because the two callers that build a scoped turn (a
 * generation step in `plan.ts` and the speaking-profile assessment in `character.ts`) both know which
 * card they are about and neither should have to pass a noun down from the panel.
 */
export function cardNounOf(kind: CardKind): string {
  return kind === 'world' ? 'WORLD CARD' : 'CHARACTER CARD';
}

/** The result of the gate: every operation, and the ones that fell outside the scope. */
export interface ScopeVerdict {
  /** The operations that stayed inside it, in the order they were written. */
  readonly inScope: readonly PatchOp[];
  /** The ones that did not. Non-empty means the whole proposal is refused, not partly applied. */
  readonly outOfScope: readonly PatchOp[];
}

/**
 * The verdict of one proposal against one scope.
 *
 * A proposal is judged as a WHOLE: `inScope` exists so a caller can report how many operations were
 * fine, and the store's rule is the one W4's acceptance asks for — if any operation is outside, the
 * proposal is refused and NOTHING is applied. Applying the in-scope half of a scoped proposal would
 * turn "this field may be rewritten" into "this field plus whatever else the model felt like".
 */
export function scopeVerdict(
  ops: readonly PatchOp[],
  scope: { readonly paths: readonly string[] },
): ScopeVerdict {
  const inScope: PatchOp[] = [];
  const outOfScope: PatchOp[] = [];
  for (const op of ops) {
    const inside = scope.paths.some((root) => isPathWithin(root, op.path));
    (inside ? inScope : outOfScope).push(op);
  }
  return { inScope, outOfScope };
}

/**
 * The editable fields inside a scope, in the form's own order, with their own labels.
 *
 * WHY IT IS PASSED THE INVENTORY AND NOT A CARD KIND: the inventory is the one list of "which fields
 * exist" (`co-create/proposal.ts` derives the world's from `cards/world.ts`, `co-create/character.ts`
 * the character's from `cards/character.ts`), and a scope is serialised into a request record while a
 * field's LABEL is a rendering concern. Passing the list keeps this function from owning a second
 * opinion about either.
 */
export function patchPathsForScope(
  paths: readonly PatchPath[],
  scope: { readonly paths: readonly string[] },
): readonly PatchPath[] {
  return paths.filter((entry) => scope.paths.some((root) => isPathWithin(root, entry.path)));
}

/**
 * The instruction text for a scoped turn of ANY card, built from the draft exactly as M1-W2's is.
 *
 * EVERY SENTENCE IS PLAIN ASCII, and that is a rule rather than a style choice: `target.ts` records that
 * this project's i18n checker counts the em dash as a CJK punctuation mark, so prompt text that is not
 * translated must not look like copy. `data` is the payload only; the plugin bag on the version envelope
 * (`extensions`) is never part of a conversation.
 *
 * WHY IT IS THE GENERIC SPELLING AND `scopeInstruction` BELOW IS THE WORLD ONE: the world wrappers keep
 * M1-W2's and M1-W3's call shape (`scopeInstruction(data, scope)`), which is what the tests that proved
 * those milestones read, and they are thin enough that a reviewer can see exactly which two facts — the
 * noun and the path table — they bind. Everything else is one implementation.
 */
export function scopeInstructionFor(
  kind: CardKind,
  data: unknown,
  scope: CoCreateScopeInput,
  paths: readonly PatchPath[],
): string {
  return [
    ...scopePreambleFor(kind, scope),
    '',
    'PATHS YOU MAY EDIT (nothing else - a change anywhere else is refused and the author sees why):',
    ...patchPathsForScope(paths, scope).map((entry) => `- ${entry.path}  (${entry.label})`),
    ...excludedLines(scope),
    '',
    'THE CURRENT CARD (JSON - the payload the author is editing):',
    JSON.stringify(data, null, 2),
  ].join('\n');
}

/** What an instruction needs from a scope: the card kind, the reason, and the two path lists. */
export interface CoCreateScopeInput {
  readonly kind: CoCreateRequestKind;
  readonly card: CardKind;
  readonly paths: readonly string[];
  readonly excluded: readonly { readonly path: string; readonly why: string }[];
  readonly why: string;
}

/**
 * The part of a scoped instruction that says WHAT THIS TURN IS, without the card.
 *
 * Split out for the request record: a test that asserts the structure of a generation flow reads the
 * preamble of each request, and a preamble that still carried the whole payload would make the assertion
 * about JSON size rather than about which step was asked for.
 *
 * The card noun is derived from the KIND, because the same sentence is read by a model editing a WORLD
 * CARD and one editing a CHARACTER CARD, and a shared constant that said "world" for both would tell the
 * second model it is world-building.
 */
export function scopePreambleFor(kind: CardKind, scope: CoCreateScopeInput): string[] {
  const cardNoun = cardNounOf(kind);
  return [
    `You are co-writing a ${cardNoun} for a role-playing app with its author, one turn at a time.`,
    'You are NOT the game master here and this is NOT the role-play transcript: you discuss the card',
    'and propose concrete edits to it.',
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
    `already uses. The result must still be a valid ${cardNoun}, or the proposal is refused.`,
    'If nothing should change yet, answer with "ops": [] and ask your question in "message".',
  ];
}

/**
 * The WORLD spelling of `scopeInstructionFor`, kept for M1-W2's and M1-W3's call shape.
 *
 * It binds the two world facts — the noun and the path table — and nothing else, so the tests that pinned
 * those milestones read the same text they always did.
 */
export function scopeInstruction(data: unknown, scope: CoCreateScopeInput): string {
  return scopeInstructionFor('world', data, scope, WORLD_PATCH_PATHS);
}

/** The WORLD spelling of `scopePreambleFor`. See `scopeInstruction` for why the pair exists. */
export function scopePreamble(scope: CoCreateScopeInput): string[] {
  return scopePreambleFor('world', scope);
}

/** The "do not touch" block, and nothing at all when the scope excludes nothing. */
function excludedLines(scope: CoCreateScopeInput): string[] {
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
 * One sentence, one meaning, because the model reads it beside a path list and a longer explanation is
 * a longer thing to disobey: the path is not wrong, it is simply not this turn's.
 */
export { excludedWhyFor } from './target';
