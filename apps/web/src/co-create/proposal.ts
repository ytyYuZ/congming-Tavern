/**
 * The WORLD CARD half of the co-creation machinery (M1-W2): the world's own target — which schema
 * judges a patch's result, and which fields the world's form renders — its instruction, and the world
 * spellings of the shared reader and preview.
 *
 * WHAT MOVED, AND WHY (M1-C2)
 * M1-W2/M1-W3/M1-W4 wrote all of this in one file because a world was the only card there was. M1-C2
 * makes a CHARACTER CARD co-creatable, and the honest split turned out to be:
 *   • `co-create/target.ts` — the engine and everything that never named a world: the operations, the
 *     pointer parser, the type-equality rule, the proposal reader, `previewProposal`, the step-plan
 *     builder, the path labeller and the instruction format.
 *   • THIS FILE — the world's target (`WORLD_PATCH_PATHS`, `WORLD_TARGET`), its step list (via
 *     `co-create/plan.ts`), its `customFields` derivation and `coCreateInstructions`.
 * Everything below that is not a world fact is a re-export, so a caller that only ever edits a world
 * keeps ONE import site and the world tests M1-W2 shipped keep passing unchanged.
 *
 * WHY `customFields` IS OFFERED BY ITS EXISTING KEYS AND NOT AS A PATH
 * Its KEYS are arbitrary labels the user typed, so a patch into it needs a pointer the model cannot
 * know; `customFieldPaths` offers the ones that exist. The panel for creating a NEW field is
 * `app/fields.tsx`'s, not a conversation's.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { type JsonValue, type WorldData, WorldDataSchema } from '@smarttavern/schema';
import { labelEntries } from '../app/fields';
import {
  CALENDAR_NUMBER_FIELDS,
  CALENDAR_TEXT_FIELDS,
  NARRATIVE_TEXT_FIELDS,
  REGION_FIELDS,
  RHYTHM_BOOLEAN_FIELDS,
  RHYTHM_NUMBER_FIELDS,
  RULES_FIELDS,
  WORLD_FORM_PATHS,
  WORLD_TEXT_FIELDS,
} from '../cards/world';
import { type CoCreateScopeInput, scopeInstruction } from './scope';
import {
  type CardTarget,
  cardInstructions,
  customFieldPaths,
  dottedOf,
  type PatchOp,
  type PatchPath,
  PathLabels,
  type ProposalPreview,
  pointerOf,
  previewProposal,
  registerCardTarget,
  sameJson,
} from './target';

/**
 * One descriptor table as `[dotted path, label]` pairs, scoped by its prefix.
 *
 * The cast is because the tables are typed by their OWN object (`TextFieldSpec<WorldData>`, then
 * `TextFieldSpec<WorldData['rulesOfNature']>`), while `labelEntries` only needs the `key`/`label` pair
 * — which is exactly what it declares (`app/fields.tsx`). The rule that a message key is the only
 * spelling of a field's name is preserved: the VALUE of every entry is still a `MessageKey`.
 */
function entries(
  scope: string,
  fields: readonly object[],
): readonly (readonly [string, MessageKey])[] {
  return labelEntries(
    scope,
    fields as readonly { readonly key: string; readonly label: MessageKey }[],
  );
}

const GROUP_PATH_ENTRIES: readonly (readonly [string, MessageKey])[] = [
  ...entries('', WORLD_TEXT_FIELDS),
  ...entries('rulesOfNature', RULES_FIELDS),
  ...entries('narrative', NARRATIVE_TEXT_FIELDS),
  ...entries('calendar', CALENDAR_TEXT_FIELDS),
  ...entries('calendar', CALENDAR_NUMBER_FIELDS),
  ...entries('timeRhythm', RHYTHM_BOOLEAN_FIELDS),
  ...entries('timeRhythm', RHYTHM_NUMBER_FIELDS),
  ...entries('regions', REGION_FIELDS),
];

/**
 * The dotted paths the form renders that carry no descriptor of their own — a list, or a group whose
 * members are edited one level down. Their labels are the headings the editor already shows.
 */
const COMPOSITE_PATH_ENTRIES: readonly (readonly [string, MessageKey])[] = [
  ['genre', 'world.genreLabel'],
  ['regions', 'world.regionsLabel'],
  ['factions', 'world.factionsLabel'],
  ['calendar', 'world.calendarNameLabel'],
  ['openingHooks', 'world.openingHooksLabel'],
];

/** The world form's own labels, by dotted path. See `PathLabels` for how a path finds one. */
export const WORLD_PATH_LABELS = new PathLabels(GROUP_PATH_ENTRIES, COMPOSITE_PATH_ENTRIES);

/** One payload path a proposal may write, with the label the editor renders for it. */
export type WorldPatchPath = PatchPath;

/**
 * Every payload path a proposal may name, in the order `cards/world.ts` declares the form's fields.
 *
 * WHY IT IS DERIVED FROM `WORLD_FORM_PATHS` AND NOT WRITTEN OUT HERE
 * A second list would be a second opinion about which fields exist, and its failure mode is silent in
 * the direction that reaches the user: the model offers to fill a field this editor does not render,
 * or the editor grows a field no proposal can reach. So the dotted paths are filtered out of the
 * form's own inventory — which `cards/world.test.ts` already pins against the schema — and a path
 * with no descriptor of its own falls back to its group's heading.
 *
 * WHAT IS EXCLUDED: `customFields`, for the reason the header records.
 */
export const WORLD_PATCH_PATHS: readonly WorldPatchPath[] = WORLD_FORM_PATHS.filter(
  (path) => path !== 'customFields',
).map((path) => ({ path: pointerOf(path), label: WORLD_PATH_LABELS.labelFor(path) }));

/**
 * The world card as a PATCH TARGET: which schema judges a patch's result and which fields the form
 * renders.
 *
 * `validate` and `issues` come from `cards/world.ts` rather than from a schema named here, so the
 * publish gate and the patch gate cannot disagree about what a valid world is — a patch accepted by
 * the engine is a draft the editor is willing to publish, or the refusal names the schema's own path.
 */
export const WORLD_TARGET: CardTarget<WorldData> = {
  kind: 'world',
  paths: WORLD_PATCH_PATHS.map((entry) => entry.path),
  parse: (value) => {
    const parsed = WorldDataSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  },
  validate: (value) => {
    const parsed = WorldDataSchema.safeParse(value);
    if (parsed.success) return { ok: true, path: '' };
    return { ok: false, path: parsed.error.issues[0]?.path.join('.') ?? '' };
  },
  /**
   * The schema's own issues, verbatim, and NOT filtered through `worldIssues`: `worldIssues` runs the
   * same `safeParse`, so asking it for a payload that just failed would answer an EMPTY list and lose
   * the path the refusal has to name. `worldIssues` is what the editor's panel calls on a payload it
   * believes is a world; this is the engine asking about one that is not yet.
   */
  issues: (value) => {
    const parsed = WorldDataSchema.safeParse(value);
    if (parsed.success) return [];
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  },
};

/* Registered at module evaluation, so the store can reach a world target by kind alone. */
registerCardTarget(WORLD_TARGET);

/**
 * The instruction for one UNSCOPED co-creation turn over a world card (M1-W2's conversation).
 *
 * Kept as its own export because M1-W2's tests read it and because its text is the world's: the two
 * sentences that name the card are the only thing `co-create/character.ts` has a different spelling
 * of, and both come from `target.ts`'s `instructionFormat`.
 */
export function coCreateInstructions(data: WorldData): string {
  return cardInstructions('WORLD CARD', [...WORLD_PATCH_PATHS, ...customFieldPaths(data)], data);
}

/**
 * The scoped instruction for a WORLD turn, with the world's own path labels and noun.
 *
 * A world-bound call of `scope.ts`'s `scopeInstruction`, which IS the world spelling — kept here because
 * `json-patch.ts` and this file are the two world modules, and a caller that only ever edits a world
 * should not have to know that the same function serves a character.
 */
export function worldScopeInstruction(data: WorldData, scope: CoCreateScopeInput): string {
  return scopeInstruction(data, scope);
}

/* ───────────────────── the world spellings of shared values ───────────────── */

/**
 * The ONE function that turns `(world draft, proposal)` into the payload the proposal proposes.
 *
 * A world-bound call of `target.ts`'s `previewProposal`: the preview the panel renders and the apply
 * the store persists both go through it, so they cannot disagree about what a proposal does.
 */
export function previewWorldProposal(
  data: WorldData,
  proposal: { readonly ops: readonly PatchOp[] },
): ProposalPreview<WorldData> {
  return previewProposal(WORLD_TARGET, data, proposal);
}

/** True when two world payloads are the same document, compared as JSON text. */
export function sameWorldData(left: WorldData, right: WorldData): boolean {
  return sameJson(left, right);
}

/** The catalog key of the form's own label for an operation's target, when the form has one. */
export function opTargetLabel(op: PatchOp): MessageKey | undefined {
  return WORLD_PATH_LABELS.labelOf(op.path);
}

/** The target as a dotted path, for a caller whose operation has no catalogued label. */
export function opPathText(op: PatchOp): string {
  return dottedOf(op.path);
}

/* ─────────────── the shared proposal values, re-exported for one import site ─────────────── */

export type {
  CoCreateProposal,
  MalformedProposal,
  MalformedProposalReason,
  ProposalPreview,
  ProposalRead,
  ProposalRefusal,
} from './target';
export {
  customFieldPaths,
  dottedOf,
  MAX_PROPOSAL_OPS,
  PROPOSAL_RESPONSE_SCHEMA,
  pointerOf,
  readProposal,
  sameJson,
} from './target';
/** A JSON value, re-exported so a caller can type one without a second import. */
export type { JsonValue };
