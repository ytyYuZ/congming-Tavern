/**
 * The step plan M1-W3 generates a world card with (生成模式).
 *
 * WHERE THE STEPS COME FROM, AND WHY THAT IS THE HONEST ANSWER
 * docs/06 §2.5's acceptance for this row is 「AI 采用结构化流程，不一次性生成全部」, so the deliverable is
 * a FLOW and the first question is who decides the steps. The answer recorded here is: this app does,
 * from the card's own field inventory — the descriptor tables in `cards/world.ts` that the editor
 * renders and `co-create/proposal.ts` already turns into the paths a proposal may address.
 *   • The model may not choose the plan, because then "not all at once" would be a promise in a
 *     prompt, and the milestone asks for a property of the program.
 *   • A hand-written list of step names would be a second opinion about what a card consists of, and
 *     its failure mode is silent: a field the schema gained would be in no step, so nobody could ever
 *     generate it, and no test would go red.
 * So a step is a NAME plus the inventory paths it covers, and `assertCoverage` below runs at module
 * evaluation: every editable content field is in exactly one step, or the module refuses to load.
 * Adding a field to the form therefore fails loudly here until somebody decides which step generates
 * it — which is what makes this list honest rather than merely current. The same assertion pins that
 * no step claims a path the inventory does not render, so a step cannot address a phantom field.
 *
 * WHAT IS DELIBERATELY NOT IN ANY STEP
 * `calendar.*`, `startMinute` and `timeRhythm.*` are the world's CLOCK: identity (`calendar.id`), the
 * hours and minutes the time engine divides by, the month and segment rows, and the pacing of play.
 * They are numbers and identifiers the author sets, and 「从零生成」 producing a 26-hour day because a
 * model felt like it is exactly the corruption `cards/world.ts` refuses to repair. They stay the
 * author's own, and the instruction for every step says so in words rather than leaving the model to
 * infer it from an absent path. `customFields` is excluded by `proposal.ts` for its own recorded
 * reason (its keys are labels the author typed).
 *
 * WHY 「从零生成」 AND 「逐字段生成」 SHARE THIS FILE
 * They are the same machinery at two scopes. 「从零生成」 walks EVERY step of the plan in order;
 * 「逐字段生成」 takes a subset of the steps' paths, chosen by the author, and walks only those. The
 * step, the scoped request, the gate that refuses an out-of-scope operation, the preview, accept /
 * reject and undo are one implementation; what differs is the list of fields the author selected and
 * whether the next step starts by itself (`state/co-create-store.ts`'s `CoCreateGeneration.mode`).
 * `fieldOpPlan` below is the bridge: a generation step covering ONE field (重写 / 扩写 / 精简 of a
 * selected field, M1-W4) is built as a single-step plan, so a field operation needs no code path of
 * its own either. `field-ops.ts` is what names that one field and the gesture.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { WORLD_PATCH_PATHS } from './proposal';
import { type CoCreateScope, excludedWhyFor, isPathWithin } from './scope';

/** One step: a name, the path group it was written against, and the inventory paths it covers. */
interface WorldStepDefinition {
  /** Stable id, also the `CoCreateRequest.step` the wire record and the tests read. */
  readonly id: string;
  /** The heading the UI prints for the step. */
  readonly label: MessageKey;
  /** Inventory paths (pointers) this step covers. Checked against the inventory at module load. */
  readonly paths: readonly string[];
}

/**
 * The plan, in the order a card is written.
 *
 * THE ORDER IS THE ARGUMENT: a one-line premise first, then the setting's facts, then the places and
 * powers, then the rules of nature, then the telling — the sequence docs/01 §F2-2's world fields
 * already read in, and the sequence a model produces coherent content in. Each step's paths are
 * disjoint from every other's, which is what lets a step be REFUSED (`/regions` rejected) without
 * touching what an earlier step wrote.
 */
const WORLD_STEP_DEFINITIONS: readonly WorldStepDefinition[] = [
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
 * One step of the plan as the store and the UI use it: an id, a heading and the paths it covers.
 *
 * The heading is the step's OWN catalog key and not its paths' labels: a step covers a GROUP
 * (「世界设定」 is three fields), and the panel prints the group's name beside each of the step's own
 * fields, which it reads from `proposal.ts`'s `WORLD_PATCH_PATHS` — the same list the editor renders.
 */
export interface CoCreateStep {
  readonly id: string;
  readonly label: MessageKey;
  readonly paths: readonly string[];
}

/**
 * One generation plan: the steps, plus the two path sets every request is built from.
 *
 * `paths` is everything the plan covers (the accepted steps and the ones still to come), and
 * `contentPaths` is the CONTENT fields of the form — the ones a plan may cover at all. The second is
 * what lets a step's instruction name the clock as the author's own without the plan having to know
 * which of those paths exist: it is the difference between the two sets.
 */
export interface CoCreateGenerationPlan {
  /** A plan id, so a request record names the plan it belongs to. */
  readonly id: string;
  readonly steps: readonly CoCreateStep[];
  /** Every path the plan covers. */
  readonly paths: readonly string[];
  /** Every editable content path of the form. See the header for what is not one. */
  readonly contentPaths: readonly string[];
  /** The paths of the form that no plan covers — the clock. Rendered as the author's own. */
  readonly reservedPaths: readonly string[];
}

/** The whole-card label used to name the plan, so the two modes describe the same object. */
export const PLAN_ID_WHOLE_CARD = 'world-card';

/**
 * The paths `proposal.ts` offers and this step plan deliberately does not.
 *
 * A POINTER LIST, not a predicate, because the two facts it separates are both about the FORM: every
 * path here is rendered by the editor (so it is not a missing field) and is either the world's clock
 * or a card id. `assertCoverage` checks that everything else IS covered, so the only way a new field
 * escapes the plan is by being added here — which is a reviewed line rather than an omission.
 */
const PLAN_EXCLUDED_PATHS: readonly string[] = [
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

/** Every inventory path this plan may cover: everything offered, minus the clock and the ids. */
function contentPaths(): string[] {
  return WORLD_PATCH_PATHS.map((entry) => entry.path).filter(
    (path) => !PLAN_EXCLUDED_PATHS.includes(path),
  );
}

/**
 * Refuse to load when the step definitions and the form's own inventory disagree.
 *
 * WHY THIS THROWS AT MODULE EVALUATION RATHER THAN SOMEWHERE IN A UI: the invariant is about SOURCE,
 * not about a user's card — a field in no step is a field nobody can generate, and it would be
 * discovered by a reviewer reading two lists rather than by the program. Throwing here turns that
 * into a failing import, which every test and every dev-server reload sees immediately.
 */
function assertCoverage(): void {
  const offered = new Set(WORLD_PATCH_PATHS.map((entry) => entry.path));
  const content = new Set(contentPaths());
  const covered = new Map<string, string>();
  for (const step of WORLD_STEP_DEFINITIONS) {
    for (const path of step.paths) {
      if (!offered.has(path)) {
        throw new Error(
          `co-create plan: step ${step.id} claims ${path}, which the form does not offer`,
        );
      }
      if (!content.has(path)) {
        throw new Error(`co-create plan: step ${step.id} claims ${path}, which is reserved`);
      }
      const owner = covered.get(path);
      if (owner !== undefined) {
        throw new Error(`co-create plan: ${path} is in both ${owner} and ${step.id}`);
      }
      covered.set(path, step.id);
    }
  }
  const missing = [...content].filter((path) => !covered.has(path));
  if (missing.length > 0) {
    throw new Error(`co-create plan: no step generates ${missing.join(', ')}`);
  }
}

assertCoverage();

/** The header the two modes share; see the store for how each one walks the plan. */
export const PLAN_ID_FIELD_SET = 'world-card-fields';

/**
 * The whole-card plan: every step, in order.
 *
 * `id` distinguishes the two modes in a request record: the same steps walk either way, and a test
 * about 「逐字段生成」 has to be able to tell that the author chose a SUBSET rather than that the plan
 * was shorter.
 */
export function worldGenerationPlan(): CoCreateGenerationPlan {
  return buildPlan(PLAN_ID_WHOLE_CARD, WORLD_STEP_DEFINITIONS);
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
 */
export function fieldSetPlan(paths: readonly string[]): CoCreateGenerationPlan {
  const wanted = new Set(paths);
  const chosen = WORLD_STEP_DEFINITIONS.filter((step) =>
    step.paths.some((path) => wanted.has(path)),
  );
  return buildPlan(PLAN_ID_FIELD_SET, chosen);
}

/**
 * A single-step plan over exactly `paths` (M1-W4's 重写 / 扩写 / 精简).
 *
 * ONE STEP, ONE FIELD, and the step is a plan so that everything downstream — the scoped request, the
 * gate, the preview, accept / reject / undo — is M1-W3's machinery with a shorter list. The paths are
 * checked against the inventory for the reason `assertCoverage` records: a field operation on a path
 * the form does not render would be a control that promises an edit nothing can display.
 */
export function fieldOpPlan(paths: readonly string[]): CoCreateGenerationPlan {
  const offered = new Set(WORLD_PATCH_PATHS.map((entry) => entry.path));
  for (const path of paths) {
    if (!offered.has(path)) {
      throw new Error(`co-create plan: ${path} is not a field the form offers`);
    }
  }
  return buildPlan('world-card-field-op', [
    { id: 'field-op', label: 'co-create.stepField', paths },
  ]);
}

/** One plan from one step list. */
function buildPlan(
  id: string,
  definitions: readonly WorldStepDefinition[],
): CoCreateGenerationPlan {
  const steps: CoCreateStep[] = definitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    paths: definition.paths,
  }));
  const paths = steps.flatMap((step) => step.paths);
  return {
    id,
    steps,
    paths,
    contentPaths: contentPaths(),
    reservedPaths: PLAN_EXCLUDED_PATHS.filter((path) =>
      WORLD_PATCH_PATHS.some((entry) => entry.path === path),
    ),
  };
}

/** The scope of one step: the paths it may write, and the paths it must leave alone. */
export function stepScope(
  plan: CoCreateGenerationPlan,
  step: CoCreateStep,
  accepted: readonly string[],
): CoCreateScope {
  return {
    kind: 'generate-step',
    step: step.id,
    paths: step.paths,
    excluded: excludedPaths(plan, step.paths),
    why: [
      `THIS TURN GENERATES ONE STEP OF A CARD, and it is step "${step.id}" of ${plan.steps.length}.`,
      `Write only this step's fields: ${step.paths.join(', ')}.`,
      'The author accepts or refuses this step on its own, and every later step is a separate turn,',
      'so fill these fields properly and stop. Do not try to fill the rest of the card.',
      ...planInstruction(plan, accepted),
    ].join('\n'),
  };
}

/**
 * Every path this step does not own, with the reason the model reads.
 *
 * The clock comes first: it is the block the model must not touch at ANY step, and reading it before
 * the (longer) list of paths that merely belong to another step is what keeps the fixed rule from
 * looking like one more thing that changes per turn.
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
 * The plan as the model reads it when a step begins, so a request can say "step 3 of 7" in words.
 *
 * Kept beside the steps rather than in the store because it is a rendering of the PLAN, and the panel
 * prints the same list. It lists PATHS and not labels: a label is a `MessageKey`, and this text is
 * prompt content that must not follow the interface language (`proposal.ts` records the rule).
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
