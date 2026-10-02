/**
 * The step plan M1-W3 generates a world card with (生成模式) — and the plan machinery, the kind lookup
 * and the scope builder that M1-C2 (角色 AI 生成) runs on as well.
 *
 * WHERE THE STEPS COME FROM, AND WHY THAT IS THE HONEST ANSWER
 * docs/06 §2.5's acceptance for the generation row is 「AI 采用结构化流程，不一次性生成全部」, so the
 * deliverable is a FLOW and the first question is who decides the steps. The answer recorded here is:
 * this app does, from the card's own field inventory — the descriptor tables in `cards/world.ts` (and
 * `cards/character.ts` for M1-C2) that the editors render and `co-create/proposal.ts` already turns
 * into the paths a proposal may address.
 *   • The model may not choose the plan, because then "not all at once" would be a promise in a
 *     prompt, and the milestone asks for a property of the program.
 *   • A hand-written list of step names would be a second opinion about what a card consists of, and
 *     its failure mode is silent: a field the schema gained would be in no step, so nobody could ever
 *     generate it, and no test would go red.
 * So a step is a NAME plus the inventory paths it covers, and `target.ts`'s `buildPlan` runs its
 * coverage assertion AT MODULE EVALUATION below: every editable content field is in exactly one step,
 * or the module refuses to load. Adding a field to a form therefore fails loudly here until somebody
 * decides which step generates it — which is what makes this list honest rather than merely current.
 *
 * WHAT IS DELIBERATELY NOT IN ANY STEP
 * `calendar.*`, `startMinute` and `timeRhythm.*` are the world's CLOCK: identity (`calendar.id`), the
 * hours and minutes the time engine divides by, the month and segment rows, and the pacing of play.
 * They are numbers and identifiers the author sets, and 「从零生成」 producing a 26-hour day because a
 * model felt like it is exactly the corruption `cards/world.ts` refuses to repair. `co-create/
 * character.ts` makes the same split for a character's generation parameters and image-diff rows. Both
 * blocks stay the author's own, and the instruction for every step says so in words rather than leaving
 * the model to infer it from an absent path. `customFields` is excluded by the two path tables for
 * their own recorded reason (its keys are labels the author typed).
 *
 * WHY 「从零生成」 AND 「逐字段生成」 SHARE THIS FILE
 * They are the same machinery at two scopes. 「从零生成」 walks EVERY step of the plan in order;
 * 「逐字段生成」 takes a subset of the steps' paths, chosen by the author, and walks only those. The
 * step, the scoped request, the gate that refuses an out-of-scope operation, the preview, accept /
 * reject and undo are one implementation; what differs is the list of fields the author selected and
 * whether the next step starts by itself (`state/co-create-store.ts`'s `CoCreateGeneration.mode`).
 * `fieldOpPlan` below is the bridge: a generation step covering ONE field (重写 / 扩写 / 精简 of a
 * selected field, M1-W4) is built as a single-step plan, so a field operation needs no code path of
 * its own either — and, being keyed by card KIND, neither does a character's.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { WorldData } from '@smarttavern/schema';
import {
  CHARACTER_INVENTORY,
  CHARACTER_PATH_LABELS,
  CHARACTER_STEP_DEFINITIONS,
} from './character';
import { WORLD_PATCH_PATHS } from './proposal';
import {
  buildPlan,
  type CardKind,
  type CoCreateGenerationPlan,
  type CoCreateScope,
  type CoCreateStep,
  dottedOf,
  excludedWhyFor,
  type PatchPath,
  type PlanInventory,
  patchPathValue,
  pointerOf,
  pointerTokens,
  type StepDefinition,
} from './target';

/** The plan types, re-exported so `state/co-create-store.ts` keeps ONE import site for a plan. */
export type { CoCreateGenerationPlan, CoCreateStep };

/* ─────────────────────────── the world's inventory ────────────────────────── */

/**
 * The plan, in the order a card is written.
 *
 * THE ORDER IS THE ARGUMENT: a one-line premise first, then the setting's facts, then the places and
 * powers, then the rules of nature, then the telling — the sequence docs/01 §F2-2's world fields
 * already read in, and the sequence a model produces coherent content in. Each step's paths are
 * disjoint from every other's, which is what lets a step be REFUSED (`/regions` rejected) without
 * touching what an earlier step wrote.
 */
const WORLD_STEP_DEFINITIONS: readonly StepDefinition[] = [
  {
    id: 'premise',
    label: 'co-create.stepPremise',
    paths: ['/premise'],
  },
  {
    id: 'basics',
    label: 'co-create.stepBasics',
    paths: ['/name', '/era', '/techOrMagic'],
  },
  {
    id: 'places',
    label: 'co-create.stepPlaces',
    paths: ['/regions'],
  },
  {
    id: 'powers',
    label: 'co-create.stepPowers',
    paths: ['/factions'],
  },
  {
    id: 'rules',
    label: 'co-create.stepRules',
    paths: ['/rulesOfNature/powerSource', '/rulesOfNature/limits', '/rulesOfNature/taboos'],
  },
  {
    id: 'narrative',
    label: 'co-create.stepNarrative',
    paths: ['/narrative/conflict', '/narrative/tone', '/narrative/style'],
  },
  {
    id: 'telling',
    label: 'co-create.stepTelling',
    paths: ['/genre', '/narrative/themes', '/openingHooks'],
  },
];

/**
 * The paths `proposal.ts` offers and this step plan deliberately does not.
 *
 * A POINTER LIST, not a predicate, because the two facts it separates are both about the FORM: every
 * path here is rendered by the editor (so it is not a missing field) and is either the world's clock
 * or a card id. `buildPlan` checks that everything else IS covered, so the only way a new field
 * escapes the plan is by being added here — which is a reviewed line rather than an omission.
 */
const WORLD_PLAN_EXCLUDED_PATHS: readonly string[] = [
  '/calendar/id',
  '/calendar/name',
  '/calendar/minutesPerHour',
  '/calendar/hoursPerDay',
  '/calendar/weekdays',
  '/calendar/epochLabel',
  '/calendar/months',
  '/calendar/segments',
  '/startMinute',
  '/timeRhythm/implicitAdvance',
  '/timeRhythm/advanceEveryTurns',
  '/timeRhythm/stepMinutes',
];

/** The world's inventory: the form's own paths, and the clock this plan never covers. */
const WORLD_INVENTORY: PlanInventory = {
  kind: 'world',
  paths: WORLD_PATCH_PATHS.map((entry) => entry.path),
  reservedPaths: WORLD_PLAN_EXCLUDED_PATHS.filter((path) =>
    WORLD_PATCH_PATHS.some((entry) => entry.path === path),
  ),
};

/**
 * The inventory, the step definitions and the path labels of each card kind, by kind.
 *
 * WHY A TABLE AND NOT A STORE FIELD: the store reads the inventory to build a free-conversation scope
 * and to tell a field operation which paths it may address, and both are facts about the FORM. One
 * lookup here keeps "which fields exist" a property of the card module rather than of the conversation
 * — and it is what lets `fieldOpPlan(kind, paths)` serve a character without a second plan builder.
 */
const INVENTORIES: Readonly<Record<CardKind, PlanInventory>> = {
  world: WORLD_INVENTORY,
  character: CHARACTER_INVENTORY,
};

const STEP_DEFINITIONS: Readonly<Record<CardKind, readonly StepDefinition[]>> = {
  world: WORLD_STEP_DEFINITIONS,
  character: CHARACTER_STEP_DEFINITIONS,
};

/** The plan ids. One per mode per kind, so a request record names both the mode and the card. */
export const PLAN_ID_WHOLE_CARD = 'world-card';
export const PLAN_ID_CHARACTER_CARD = 'character-card';
export const PLAN_ID_FIELD_SET = 'world-card-fields';
export const PLAN_ID_FIELD_OP = 'world-card-field-op';
export const PLAN_ID_CHARACTER_FIELD_OP = 'character-card-field-op';

/* ────────────────────────────── the plans ────────────────────────────────── */

/**
 * The whole-card plan of one kind: every step, in order.
 *
 * `id` distinguishes the modes in a request record: the same steps walk either way, and a test about
 * 「逐字段生成」 has to be able to tell that the author chose a SUBSET rather than that the plan was
 * shorter. The steps come from one table, so a character walk is M1-W3's walk with a character list.
 */
export function cardPlan(kind: CardKind): CoCreateGenerationPlan {
  return buildPlan(
    INVENTORIES[kind],
    kind === 'world' ? PLAN_ID_WHOLE_CARD : PLAN_ID_CHARACTER_CARD,
    STEP_DEFINITIONS[kind],
  );
}

/** The world's whole-card plan — M1-W3's 「从零生成」. */
export function worldGenerationPlan(): CoCreateGenerationPlan {
  return cardPlan('world');
}

/**
 * The plan for a chosen set of fields (「逐字段生成」), still as STEPS.
 *
 * WHY A SUBSET OF THE SAME STEPS RATHER THAN ONE REQUEST PER FIELD: a field the author picks is
 * covered by the step that owns it, so selecting 「地区」 and 「势力」 runs those two steps and nothing
 * else. Re-using the step boundary is what keeps the two modes one implementation — and it keeps the
 * per-request scope identical, so the gate that refuses an out-of-scope operation is the same gate.
 *
 * An EMPTY selection produces a plan with no steps: the store reports that as 「nothing selected」
 * rather than sending a request with an empty scope, and `scopeVerdict` would refuse every operation
 * such a request could produce.
 *
 * The KIND is the last parameter and defaults to the world, so M1-W3's tests keep the one-argument shape
 * they were written with.
 */
export function fieldSetPlan(
  paths: readonly string[],
  kind: CardKind = 'world',
): CoCreateGenerationPlan {
  const wanted = new Set(paths);
  const chosen = STEP_DEFINITIONS[kind].filter((step) =>
    step.paths.some((path) => wanted.has(path)),
  );
  return buildPlan(INVENTORIES[kind], PLAN_ID_FIELD_SET, chosen, 'subset');
}

/**
 * A single-step plan over exactly `paths` (M1-W4's 重写 / 扩写 / 精简).
 *
 * ONE STEP, ONE FIELD, and the step is a plan so that everything downstream — the scoped request, the
 * gate, the preview, accept / reject / undo — is M1-W3's machinery with a shorter list. The paths are
 * checked against the inventory for the reason the coverage assertion records: a field operation on a
 * path the form does not render would be a control that promises an edit nothing can display.
 *
 * The KIND is the last parameter and defaults to the world, so M1-W4's tests and its world callers keep
 * the one-argument shape they were written with while a character gesture passes `'character'`.
 */
export function fieldOpPlan(
  paths: readonly string[],
  kind: CardKind = 'world',
): CoCreateGenerationPlan {
  const inventory = INVENTORIES[kind];
  const offered = new Set(inventory.paths);
  for (const path of paths) {
    if (!offered.has(path)) {
      throw new Error(`co-create plan: ${path} is not a field the form offers`);
    }
  }
  return buildPlan(
    inventory,
    kind === 'world' ? PLAN_ID_FIELD_OP : PLAN_ID_CHARACTER_FIELD_OP,
    [{ id: 'field-op', label: 'co-create.stepField', paths }],
    'subset',
  );
}

/* ──────────────────────── the scopes built from a plan ───────────────────── */

/**
 * The field inventory of one card kind, with each path's own label.
 *
 * The WORLD list is `proposal.ts`'s (already labelled); the character list is rebuilt from the
 * character module's label table, so a panel renders the same word beside a path here as beside its
 * control in the form.
 */
export function patchPathsOf(kind: CardKind): readonly PatchPath[] {
  if (kind === 'world') return WORLD_PATCH_PATHS;
  return CHARACTER_INVENTORY.paths.map((path) => ({
    path,
    label: CHARACTER_PATH_LABELS.labelFor(dottedOf(path)),
  }));
}

/**
 * The scope of one step: the paths it may write, and the paths it must leave alone.
 *
 * WHY THE CARD KIND IS IN THE SCOPE rather than only in the plan: the scope is what travels with a
 * request and what the gate compares an answer against, and the store needs it to know WHICH draft the
 * proposal is about (`state/co-create-store.ts`). Burying the kind inside the plan would make the two
 * facts travel separately.
 */
export function stepScope(
  plan: CoCreateGenerationPlan,
  step: CoCreateStep,
  accepted: readonly string[],
  world?: WorldData,
): CoCreateScope {
  // THE CALL, NOT THE FUNCTION: this line read `worldContext === undefined` at first, which is never
  // true — and a template literal happily interpolated the FUNCTION'S SOURCE into the instruction, so
  // the model was sent the code that builds the world block instead of the world. Calling it once here
  // keeps the block a value the branch can actually test.
  const setting = worldContext(world);
  return {
    kind: 'generate-step',
    card: plan.kind,
    step: step.id,
    paths: step.paths,
    excluded: excludedPaths(plan, step.paths),
    why: [
      `THIS TURN GENERATES ONE STEP OF A CARD, and it is step "${step.id}" of ${plan.steps.length}.`,
      `Write only this step's fields: ${step.paths.join(', ')}.`,
      'The author accepts or refuses this step on its own, and every later step is a separate turn,',
      'so fill these fields properly and stop. Do not try to fill the rest of the card.',
      ...planInstruction(plan, accepted),
      // M1-C2's 「生成结果符合世界观约束」: the world the author chose is the setting this character has to
      // fit. See `worldContext` for why it is prompt text and never a path the scope allows.
      ...(setting === undefined ? [] : ['', setting]),
    ].join('\n'),
  };
}

/**
 * The world a character is being generated INTO, as the prompt text that constrains it (M1-C2).
 *
 * WHY THE WORLD IS PROMPT TEXT AND NOT A SCOPE ENTRY: docs/06 §2.3's acceptance for M1-C2 is
 * 「生成结果符合世界观约束」 — the character has to FIT the world. Fitting is a property of the CONTENT
 * the model writes, which is what an instruction can ask for; a world PATH in the scope would mean the
 * character editor could edit the world, which is the opposite of a constraint. So the world is read
 * here, quoted into every character step, and never offered as something a proposal may write.
 *
 * `undefined` when the author has no world open: a character may be written on its own, and inventing a
 * setting to constrain it would be worse than saying nothing.
 */
export function worldContext(world: WorldData | undefined): string | undefined {
  if (world === undefined) return undefined;
  const facts = characterSettingFacts(world);
  return [
    'THE WORLD THIS CHARACTER HAS TO FIT (this is the setting the author is working from - the',
    'character must be consistent with it, and this turn may NOT edit it):',
    ...facts,
  ].join('\n');
}

/** The world facts a character is written against, in the order the model should read them. */
function characterSettingFacts(world: WorldData): string[] {
  const lines: string[] = [`- world name: ${JSON.stringify(world.name)}`];
  const optional: readonly (readonly [string, string])[] = [
    ['premise', world.premise],
    ['era', world.era],
    ['techOrMagic', world.techOrMagic],
    ['genre', world.genre.join(', ')],
    ['rules of nature', world.rulesOfNature.powerSource],
    ['limits of those rules', world.rulesOfNature.limits],
    ['taboos', world.rulesOfNature.taboos],
    ['narrative tone', world.narrative.tone],
  ];
  for (const [label, value] of optional) {
    const text = value.trim();
    if (text !== '') lines.push(`- ${label}: ${JSON.stringify(text)}`);
  }
  return lines;
}

/**
 * Every path this step does not own, with the reason the model reads.
 *
 * The reserved block comes first: it is the part the model must not touch at ANY step (a world's
 * clock, a character's generation parameters), and reading it before the (longer) list of paths that
 * merely belong to another step is what keeps the fixed rule from looking like one more thing that
 * changes per turn.
 */
function excludedPaths(
  plan: CoCreateGenerationPlan,
  own: readonly string[],
): { path: string; why: string }[] {
  return [
    ...plan.reservedPaths.map((path) => ({ path, why: excludedWhyFor('app-setting') })),
    ...plan.contentPaths
      .filter((path) => !own.some((root) => isPathWithin(root, path)))
      .map((path) => ({ path, why: excludedWhyFor('later-step') })),
  ];
}

/**
 * True when `path` is `root` itself or something inside it, compared TOKEN BY TOKEN.
 *
 * A COPY OF `target.ts`'s RULE, and the copy is on purpose: this module builds a plan's own exclusions
 * while `co-create/scope.ts` builds an instruction's, and `scope.ts` imports `plan.ts` — so importing
 * the rule back would be a cycle at module evaluation. The two spellings are three lines each, and both
 * are pinned by tests that assert the case a text-prefix comparison gets wrong (`/narrative/style` is
 * not a prefix of `/narrative/styles`), which is what keeps them from drifting apart in silence.
 */
function isPathWithin(root: string, path: string): boolean {
  const rootTokens = pointerTokens(root);
  const pathTokens = pointerTokens(path);
  if (rootTokens === undefined || pathTokens === undefined) return false;
  if (pathTokens.length < rootTokens.length) return false;
  return rootTokens.every((token, index) => pathTokens[index] === token);
}

/**
 * The plan as the model reads it when a step begins, so a request can say "step 3 of 7" in words.
 *
 * Kept beside the steps rather than in the store because it is a rendering of the PLAN, and the panel
 * prints the same list. It lists PATHS and not labels: a label is a `MessageKey`, and this text is
 * prompt content that must not follow the interface language (`target.ts` records the rule).
 */
function planInstruction(plan: CoCreateGenerationPlan, accepted: readonly string[]): string[] {
  return [
    '',
    `THE PLAN FOR THIS CARD (${plan.steps.length} steps, in order):`,
    ...plan.steps.map(
      (step, index) =>
        `- ${index + 1}. ${step.id}  (${step.paths.join(', ')})${
          accepted.includes(step.id) ? '  [already accepted]' : ''
        }`,
    ),
  ];
}

/* ───────────────────────── the world plan's own spellings ───────────────────── */

/** One payload path a proposal may write, with the label the editor renders for it. */
export type WorldPatchPath = PatchPath;

/** The world card's editable paths, re-exported so a caller needs one import for the inventory. */
export { WORLD_PATCH_PATHS };

/* ─────────────────────────── the value of one field ─────────────────────────── */

/**
 * One field of a card as the instruction quotes it: JSON so a list stays legible as a list, with an
 * absent path named as absent rather than shown as an empty string — "the field is empty" and "there
 * is no such field" are different facts for a model about to write it.
 */
export function cardFieldValue(data: unknown, pointer: string): string {
  return patchPathValue(data, dottedOf(pointer));
}

/** A dotted form path as a JSON Pointer, for a caller that has the form's own spelling. */
export function pointerForPath(dotted: string): string {
  return pointerOf(dotted);
}

/** The catalog key of a path's own label in one card's form, for a caller that has only the kind. */
export function labelForPathVariable(kind: CardKind, path: string): MessageKey | undefined {
  if (kind === 'world') return WORLD_PATCH_PATHS.find((entry) => entry.path === path)?.label;
  return CHARACTER_PATH_LABELS.labelOf(path);
}
