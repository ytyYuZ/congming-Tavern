/**
 * M1-W4's field-level AI operation (字段级 AI 操作): 重写 / 扩写 / 精简 of ONE selected field — and, for
 * M1-C3, the single-field plan and scope a speaking-profile assessment is built from.
 *
 * WHAT THIS EXTENDS, AND WHY THERE IS NOTHING NEW BEHIND IT
 * docs/06 §2.5's acceptance is 「选定字段可 AI 重写；重写可拒绝；重写可撤销」, and the third and second of
 * those are M1-W2's accept / reject / undo — already proven over the bytes of a draft row. So the new
 * ingredient is only the SCOPE: a turn about `/premise` must not be able to write `/era`, and the
 * proposal that tries is refused rather than trimmed. That scope lives in `co-create/scope.ts`, the
 * single-step plan in `co-create/plan.ts`, and everything else is the existing path
 * (`askCoCreate` -> `readProposal` -> `scopeVerdict` -> `previewProposal` -> the card's edit action).
 * The three gestures differ ONLY in the sentence they ask with: 重写 wants the same content said again,
 * 扩写 wants more of it, 精简 wants less, and all three write the same one field.
 *
 * WHY THE PLAN IS KEYED BY CARD KIND (M1-C2)
 * A character's field is a path in `CHARACTER_INVENTORY`, and `plan.ts` already holds both inventories.
 * Passing the kind through `fieldOpRequest` is therefore the whole of the character half — no second
 * gesture, no second plan builder, no second scope.
 *
 * WHY A GESTURE DOES NOT CARRY A "KEEP THE LENGTH" HEURISTIC
 * A word count enforced here would be a second opinion about the text, and the author's own next move
 * (typing, or asking again) is what actually decides. The instruction states the intent; the model's
 * answer is shown as a proposal and the author accepts or refuses it. The mechanism this milestone owes
 * is the SCOPING, and that is the part which is enforced rather than asked for.
 */
import type { JsonValue } from '@smarttavern/schema';
import {
  type CoCreateGenerationPlan,
  type CoCreateStep,
  cardFieldValue,
  fieldOpPlan,
} from './plan';
import type { CardKind, CoCreateScope, FieldOpKind } from './target';

/** The sentence each gesture asks with, and the label the panel prints for its button. */
export const FIELD_OP_KINDS: readonly FieldOpKind[] = ['rewrite', 'expand', 'condense'];

/**
 * What one gesture asks the model to do, in plain ASCII (see `target.ts`).
 *
 * A COMPLETE Instruction TASK RATHER THAN A VERB: the model is told what to write and what to keep, and
 * each of the three says the same second half ("the author's own facts are not negotiable") so that 精简
 * cannot be read as licence to drop a name.
 */
const FIELD_OP_ACTIONS: Readonly<Record<FieldOpKind, string>> = {
  rewrite:
    'REWRITE this field: say the same thing again, freshly, keeping its meaning and every fact the author already wrote into it.',
  expand:
    'EXPAND this field: keep what is already there and add specific, concrete detail. Do not contradict it and do not remove anything.',
  condense:
    'CONDENSE this field: keep every fact that matters and cut the rest, so that the same content is said in fewer words.',
};

/**
 * The request scope for one field operation.
 *
 * `excluded` lists the OTHER fields of the card, so the model is told in words what the gate enforces:
 * a proposal whose operations leave the field is refused, and the author reads which path it aimed at.
 * Naming them all (rather than saying "everything else") is deliberate: the instruction is built from
 * the card's own field inventory, which is what keeps it from drifting away from the form.
 */
export function fieldOpScope(
  data: unknown,
  path: string,
  fieldOp: FieldOpKind,
  others: readonly string[],
  card: CardKind = 'world',
): CoCreateScope {
  const label = dottedOfPointer(path);
  return {
    kind: 'field-op',
    card,
    fieldOp,
    fieldPath: path,
    paths: [path],
    excluded: others
      .filter((other) => other !== path)
      .map((other) => ({ path: other, why: 'another field of this card' })),
    why: [
      `THIS TURN EDITS EXACTLY ONE FIELD OF A CARD: ${path} (${label}).`,
      '',
      FIELD_OP_ACTIONS[fieldOp],
      'Answer with operations whose path is exactly this field, and leave every other field of the',
      'card alone: the author accepts or refuses this one field on its own.',
      '',
      `THE FIELD AS IT STANDS: ${cardFieldValue(data, path)}`,
    ].join('\n'),
  };
}

/**
 * The single-step plan a field operation runs as.
 *
 * A plan and not a special case: the store sends generically scoped turns, and a field operation is a
 * one-step plan over one path. That is what keeps 「逐字段生成」, 「从零生成」 and 重写 on one code path
 * instead of three — the failure mode this milestone names.
 *
 * The KIND is the last parameter and defaults to the world, so M1-W4's tests and its world callers keep
 * the two-argument shape they were written with while a character gesture passes `'character'`.
 */
export function fieldOpRequest(
  paths: readonly string[],
  kind: CardKind = 'world',
): {
  readonly plan: CoCreateGenerationPlan;
  readonly step: CoCreateStep;
} {
  const plan = fieldOpPlan(paths, kind);
  const step = plan.steps[0];
  if (step === undefined) throw new Error('a field operation needs a step');
  return { plan, step };
}

/**
 * One payload value, read by its dotted path.
 *
 * WHY THE PATH IS WALKED AS A STRING AND NOT TYPED: a card payload has index-free members, so a typed
 * read would need a `keyof` chain the caller cannot express from a runtime path. This is the same shape
 * `cards/fields.ts`'s `memberOf`/`memberValue` use for untrusted data, and it answers `undefined` for a
 * path that does not exist — which the instruction then prints as absent rather than as an empty string,
 * because "the field is empty" and "there is no such field" are different facts for a model about to
 * rewrite it.
 */
export function readPath(data: unknown, dotted: string): JsonValue | undefined {
  let node: unknown = data;
  for (const token of dotted.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as { [key: string]: unknown })[token];
  }
  return node as JsonValue | undefined;
}

/** One pointer as a dotted path, so the instruction can name the field the way the form does. */
function dottedOfPointer(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.split('~1').join('/').split('~0').join('~'))
    .join('.');
}
