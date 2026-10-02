/**
 * The CHARACTER CARD half of the co-creation machinery (M1-C2 角色 AI 生成, M1-C3 发言档案自动评估).
 *
 * WHAT M1-C2 ASKS FOR, IN THE ROW'S OWN WORDS
 * docs/06 §2.3: `M1-C2 | 角色 AI 生成 | 基于所选世界的生成 + 共创对话 | M1-W2 | 生成结果符合世界观约束`.
 * Two halves, and this file is where both are stated:
 *   • 「基于所选世界的生成」 — a character generated AGAINST a world is generated against that world's
 *     CONTENT, so `worldContext` below reads the world card the author is working from (its name, era,
 *     premise, rules) and puts it in the instruction. The world is a REFERENCE and never a patch
 *     target: the scope below offers character paths only, so a proposal that tried to edit the world
 *     is refused by the same gate that refuses a stray character field.
 *   • 「共创对话 + 结构化流程」 — the conversation, the step plan, the per-step accept/reject and the
 *     snapshot undo are M1-W3's `co-create/plan.ts` machinery with a character step list; nothing here
 *     reimplements them. The plan is asserted at module load (`plan.ts` -> `target.ts`'s `buildPlan`)
 *     to cover every editable field of `cards/character.ts`'s inventory EXACTLY once, so a form field
 *     the schema gains fails the import rather than being silently ungeneratable.
 *   • 「生成结果符合世界观约束」 is enforced in words and in structure: the world card travels in the
 *     instruction as the setting the character must fit, and every path the model may write is a
 *     character path — so a character cannot be turned into a world edit, and the world cannot be
 *     edited by accident from the character editor.
 *
 * WHAT M1-C3 ASKS FOR, AND WHICH FIELDS IT EVALUATES
 * docs/06 §2.3: `M1-C3 | 发言档案自动评估 | evaluate_voice_profile 用例（提案形式） | M1-C1 | 生成欲望/
 * 能力值并给出理由；可手动覆盖`, and docs/01 §5.3: 发言档案支持依据角色描述让 AI 自动评估生成（提案形式）.
 * So the INPUT is the card's own content and the OUTPUT is a proposal like any other.
 *   • EVALUATED: `voice.desire`, `voice.ability` and `voice.roles`. The first two are the row's own
 *     words (欲望/能力值); `roles` is a CATEGORISATION the card's content supports (docs/01 §5.3 lists
 *     `冷静观察者` / `信息提供者` / `冲突制造者` as the kind of tag), so it is judged from the same
 *     evidence rather than invented.
 *   • NOT EVALUATED, AND WHY — `voice.maxLinesPerRound` and `voice.cooldown`: these are the
 *     SCHEDULER's HARD LIMITS (`packages/schema`'s `VoiceProfileSchema` says 「硬约束，AI 不能突破」),
 *     i.e. the author's own pacing decision about a card, not a fact the prose implies. Scoring them
 *     from a description would be inventing a number in the one part of the profile the schema marks as
 *     a constraint, so they stay the author's, and the instruction says so out loud.
 *   • 并给出理由: the reason is the answer's own `rationale` PLUS the deterministic sentence in
 *     `voiceEvaluationScope`, kept as a value (`VoiceEvaluation` in the store) and rendered beside the
 *     pending proposal — never written into the card, which has no field for an assessment argument.
 *   • 可手动覆盖: the four number/role controls stay ordinary form fields; an accepted proposal is an
 *     autosaved DRAFT edit like a keystroke, so typing over it needs no special path.
 *
 * WHAT A TOO-THIN CARD GETS — A FINDING, NOT INVENTED NUMBERS
 * Two layers, because they are two different facts:
 *   • LOCAL (`wordsToJudge`): `description`, `personality` and `scenario` are all blank, so there is
 *     nothing to judge at all. No request is sent; the store reports `co-create.voiceTooThin`.
 *   • THE MODEL'S OWN ANSWER: a card with a name and one vague line can still be too thin for a
 *     number. The instruction then REQUIRES `"ops": []` with the reason in `"message"`/`"rationale"`,
 *     and the store turns that into `co-create.voiceNoSignal` with the model's words. Neither layer
 *     writes a default 50 into the card, which is the failure the row's 「可手动覆盖」 would otherwise
 *     hide behind.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { type CharacterData, CharacterDataSchema, type VoiceProfile } from '@smarttavern/schema';
import { labelEntries } from '../app/fields';
import {
  APPEARANCE_FIELDS,
  CHARACTER_TEXT_FIELDS,
  SAMPLING_NUMBER_FIELDS,
  STYLE_FIELDS,
  VISUAL_PARAMS_NUMBER_FIELDS,
  VISUAL_PARAMS_TEXT_FIELDS,
  VOICE_NUMBER_FIELDS,
} from '../cards/character';
import {
  type CardTarget,
  type CoCreateScope,
  type PatchPath,
  PathLabels,
  type PlanInventory,
  pointerOf,
  registerCardTarget,
  type StepDefinition,
} from './target';

/* ────────────────────────── the field labels of the form ──────────────────── */

/** One descriptor table as `[dotted path, label]` pairs. See `proposal.ts` for the cast's reason. */
function entries(
  scope: string,
  fields: readonly object[],
): readonly (readonly [string, MessageKey])[] {
  return labelEntries(
    scope,
    fields as readonly { readonly key: string; readonly label: MessageKey }[],
  );
}

const CHARACTER_GROUP_PATH_ENTRIES: readonly (readonly [string, MessageKey])[] = [
  ...entries('', CHARACTER_TEXT_FIELDS),
  ...entries('voice', VOICE_NUMBER_FIELDS),
  ...entries('visual.appearance', APPEARANCE_FIELDS),
  ...entries('visual.style', STYLE_FIELDS),
  ...entries('visual.params', VISUAL_PARAMS_TEXT_FIELDS),
  ...entries('visual.params', VISUAL_PARAMS_NUMBER_FIELDS),
  ...entries('sampling', SAMPLING_NUMBER_FIELDS),
];

/**
 * The form's own headings for the paths that carry no descriptor: a list, or a group edited one level
 * down. `visual.outfits` and `visual.expressions` are NOT here because they are not offered as patch
 * paths at all (see `CHARACTER_PATCH_PATHS`), but their members' labels still resolve through
 * `visual.outfits`' parent for the operation list.
 */
const CHARACTER_COMPOSITE_PATH_ENTRIES: readonly (readonly [string, MessageKey])[] = [
  ['tags', 'character.tagsLabel'],
  ['alternate_greetings', 'character.alternateGreetingsLabel'],
  ['voice.roles', 'character.rolesLabel'],
  ['visual.appearance.marks', 'character.marksLabel'],
  ['visual.outfits', 'character.outfitsLabel'],
  ['visual.expressions', 'character.expressionsLabel'],
  ['visual.params.seedPolicy', 'character.seedPolicyLabel'],
  ['visual.references', 'character.referencesLabel'],
  ['sampling.stop', 'character.samplingStopLabel'],
  ['sampling.reasoningEffort', 'character.samplingReasoningLabel'],
];

/** The character form's own labels, by dotted path. */
export const CHARACTER_PATH_LABELS = new PathLabels(
  CHARACTER_GROUP_PATH_ENTRIES,
  CHARACTER_COMPOSITE_PATH_ENTRIES,
);

/* ─────────────────────────── the editable paths ───────────────────────────── */

/**
 * The character form's paths, as JSON Pointers a proposal may address.
 *
 * DERIVED FROM THE EDITOR'S OWN INVENTORY, one entry per field `cards/character.test.ts` already pins
 * against `CharacterDataSchema` — so 「字段完整」 and 「字段可生成」 are checked against the same list.
 * `customFields` is excluded for `proposal.ts`'s recorded reason (its keys are labels the author typed)
 * and is offered by its existing keys instead.
 *
 * WHAT IS NOT OFFERED, AND WHY IT IS NOT A HOLE
 *   • `visual.outfits` and `visual.expressions`: the schema calls these 「服装差分」 / 「表情差分」 — rows
 *     of IMAGE prompts whose `id` is minted by the app (`blankOutfit`). A model writing those rows would
 *     be writing生图 prompts, which is M2's generation pipeline and M1-C2's `visual` half is only the
 *     structured appearance, so they stay the author's.
 *   • `visual.references[].assetId`: it names a STORED ASSET, and no asset pipeline exists yet
 *     (docs/06 §10.5). An invented id would be a dangling reference the editor already refuses to
 *     pretend is complete.
 *   • `visual.params.*` and `sampling.*`: a provider, a model, a seed policy and a temperature are the
 *     AUTHOR'S configuration, not the character's content — the same split that keeps a world's clock
 *     out of its plan.
 * They are declared as `CHARACTER_RESERVED_PATHS` rather than omitted, so the step coverage assertion
 * fails loudly if one of them ever gains a step, and so the instruction can name them as untouchable.
 */
export const CHARACTER_PATCH_PATHS: readonly PatchPath[] = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'tags',
  'creator',
  'character_version',
  'voice.desire',
  'voice.ability',
  'voice.roles',
  'voice.maxLinesPerRound',
  'voice.cooldown',
  'visual.appearance.hair',
  'visual.appearance.eyes',
  'visual.appearance.build',
  'visual.appearance.skin',
  'visual.appearance.marks',
  'visual.style.preset',
  'visual.style.positive',
  'visual.style.negative',
  'visual.style.aspect',
  'customFields',
]
  .filter((path) => path !== 'customFields')
  .map((path) => ({ path: pointerOf(path), label: CHARACTER_PATH_LABELS.labelFor(path) }));

/**
 * The character form's paths this editor renders and no step may generate. See the header block above
 * `CHARACTER_PATCH_PATHS` for the reason each one is here.
 */
export const CHARACTER_RESERVED_PATHS: readonly string[] = [
  'visual.outfits',
  'visual.expressions',
  'visual.references',
  'visual.params.provider',
  'visual.params.model',
  'visual.params.sampler',
  'visual.params.steps',
  'visual.params.cfg',
  'visual.params.seedPolicy',
  'visual.params.seed',
  'sampling.temperature',
  'sampling.topP',
  'sampling.topK',
  'sampling.maxTokens',
  'sampling.presencePenalty',
  'sampling.frequencyPenalty',
  'sampling.repetitionPenalty',
  'sampling.seed',
  'sampling.stop',
  'sampling.reasoningEffort',
  'customFields',
].map((path) => pointerOf(path));

/** The character's inventory, as the shared plan builder needs it. */
export const CHARACTER_INVENTORY: PlanInventory = {
  kind: 'character',
  paths: CHARACTER_PATCH_PATHS.map((entry) => entry.path),
  reservedPaths: CHARACTER_RESERVED_PATHS,
};

/* ──────────────────────────── the step plan ───────────────────────────────── */

/**
 * The steps a character is written in, in the order docs/01 §5.3 and §F3 read the card in.
 *
 * THE ORDER IS THE ARGUMENT: who the character is, then the situation they act in, then the words they
 * say, then how they SPEAK (发言档案, which is what M1-C3 fills), then how they look. Each step's paths
 * are disjoint from every other's, and the coverage assertion in `plan.ts` holds them to the form.
 */
export const CHARACTER_STEP_DEFINITIONS: readonly StepDefinition[] = [
  {
    id: 'identity',
    label: 'co-create.stepIdentity',
    paths: ['/name', '/description', '/personality', '/tags'],
  },
  {
    id: 'scenario',
    label: 'co-create.stepScenario',
    paths: ['/scenario', '/system_prompt', '/post_history_instructions'],
  },
  {
    id: 'speech',
    label: 'co-create.stepSpeech',
    paths: ['/first_mes', '/alternate_greetings', '/mes_example'],
  },
  {
    id: 'voice',
    label: 'co-create.stepVoice',
    paths: [
      '/voice/desire',
      '/voice/ability',
      '/voice/roles',
      '/voice/maxLinesPerRound',
      '/voice/cooldown',
    ],
  },
  {
    id: 'looks',
    label: 'co-create.stepLooks',
    paths: [
      '/visual/appearance/hair',
      '/visual/appearance/eyes',
      '/visual/appearance/build',
      '/visual/appearance/skin',
      '/visual/appearance/marks',
      '/visual/style/preset',
      '/visual/style/positive',
      '/visual/style/negative',
      '/visual/style/aspect',
    ],
  },
  {
    id: 'credits',
    label: 'co-create.stepCredits',
    paths: ['/creator', '/character_version', '/creator_notes'],
  },
];

/** The plan id of the character's whole-card walk, and of the two narrower modes. */
export const PLAN_ID_CHARACTER = 'character-card';

/* ─────────────────────────────── the target ──────────────────────────────── */

/**
 * The character card as a PATCH TARGET: which schema judges a patch's result, and which fields the
 * form renders.
 *
 * `validate` and `issues` come from `cards/character.ts`, so the publish gate and the patch gate
 * cannot disagree about what a valid character is — the SAME rule the world target follows, which is
 * what makes one engine serve both without a second schema reference.
 */
export const CHARACTER_TARGET: CardTarget<CharacterData> = {
  kind: 'character',
  paths: CHARACTER_PATCH_PATHS.map((entry) => entry.path),
  parse: (value) => {
    const parsed = CharacterDataSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  },
  validate: (value) => {
    const parsed = CharacterDataSchema.safeParse(value);
    if (parsed.success) return { ok: true, path: '' };
    return { ok: false, path: parsed.error.issues[0]?.path.join('.') ?? '' };
  },
  /**
   * The schema's own issues, verbatim — see `proposal.ts`'s `WORLD_TARGET` for why this is NOT
   * `characterIssues`: that helper runs the same `safeParse` and would answer an empty list for a payload
   * that just failed, losing the path a refusal has to name.
   */
  issues: (value) => {
    const parsed = CharacterDataSchema.safeParse(value);
    if (parsed.success) return [];
    return parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  },
};

/* Registered at module evaluation, so the store can reach a character target by kind alone. */
registerCardTarget(CHARACTER_TARGET);

/* ─────────────────── M1-C3: the speaking-profile assessment ───────────────── */

/**
 * The `voice` fields C3 evaluates, and the ONLY paths its request may write.
 *
 * A subset of the profile that the card's own content can support. The two that are missing are the
 * scheduler's hard limits (see the header): a model asked for them would be asked to invent a
 * constraint.
 */
export const VOICE_EVALUATED_PATHS: readonly string[] = [
  '/voice/desire',
  '/voice/ability',
  '/voice/roles',
];

/** The profile fields C3 does NOT score, with the reason the model reads. */
export const VOICE_RESERVED_PATHS: readonly string[] = [
  '/voice/maxLinesPerRound',
  '/voice/cooldown',
];

/**
 * The card content an assessment is made FROM, in the order the model reads it.
 *
 * THE SAME LIST AS THE LOCAL PRECONDITION (`wordsToJudge`) — one list, so "the card is too thin" is a
 * statement about exactly the fields the assessment was going to read.
 */
export const VOICE_EVIDENCE_PATHS: readonly string[] = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
];

/**
 * The card's own words, as the evidence for an assessment: the fields of `VOICE_EVIDENCE_PATHS` that
 * are not blank, in the order above.
 *
 * WHY A FUNCTION AND NOT A BOOLEAN: the store needs BOTH facts — whether there is anything to judge
 * (empty list = too thin) and the text to quote in the instruction — and computing them once keeps the
 * precondition and the prompt from disagreeing about which fields count as evidence.
 */
export function voiceEvidence(
  data: CharacterData,
): readonly { readonly path: string; readonly text: string }[] {
  const values: Readonly<Record<string, string>> = {
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
  };
  return VOICE_EVIDENCE_PATHS.map((path) => ({ path, text: (values[path] ?? '').trim() })).filter(
    (entry) => entry.text !== '',
  );
}

/** True when the card says enough for a request to be worth sending (see the header's two layers). */
export function hasVoiceEvidence(data: CharacterData): boolean {
  return voiceEvidence(data).length > 0;
}

/**
 * The scope of one 发言档案评估 turn.
 *
 * `paths` is the allow-list: an assessment that scores `maxLinesPerRound`, or that reaches for a
 * description field, is refused by the same gate that refuses a stray field operation — the feature is
 * the SCOPING as much as the numbers (M1-W4's acceptance, generalized).
 *
 * THE RUBRIC IS IN THE INSTRUCTION rather than in a prompt constant elsewhere, because it is what makes
 * 「并给出理由」 checkable: the model is told what each end of each range MEANS, told to judge from the
 * evidence quoted below it, and told that `"ops": []` is the required answer when the evidence does not
 * support a number.
 */
export function voiceEvaluationScope(data: CharacterData): CoCreateScope {
  const evidence = voiceEvidence(data);
  return {
    kind: 'voice-profile',
    card: 'character',
    paths: VOICE_EVALUATED_PATHS,
    excluded: [
      ...VOICE_RESERVED_PATHS.map((path) => ({
        path,
        why: 'a hard limit the scheduler enforces, so only the author sets it',
      })),
      ...CHARACTER_PATCH_PATHS.map((entry) => entry.path)
        .filter((path) => !VOICE_EVALUATED_PATHS.includes(path))
        .map((path) => ({ path, why: 'not part of the speaking profile' })),
    ],
    why: [
      'THIS TURN EVALUATES THE CHARACTER SPEAKING PROFILE from the card content already written, and',
      'proposes values for the fields that the content actually supports.',
      '',
      'WHAT EACH FIELD MEANS (propose a value only when the content supports it):',
      '- /voice/desire  0-100: how strongly this character starts talking or cuts in, versus staying',
      '                  quiet until spoken to.',
      '- /voice/ability 0-100: how much USEFUL content the character can contribute in a scene:',
      '                  information, authority of their position, and capacity to act.',
      '- /voice/roles   a short list of speaking-role tags for rule matching, for example a calm',
      '                  observer, an information source or a troublemaker. Free text, not a fixed',
      '                  vocabulary, so write the tags this character actually warrants.',
      '',
      'HOW TO JUDGE: read the evidence quoted below. A character described as forceful, senior or',
      'central with a lot to say scores HIGH on both numbers. A character described as quiet,',
      'secretive, subordinate or peripheral scores LOW. Say WHY in "rationale": name the part of the',
      'description or personality the numbers come from, so the author can disagree with the argument',
      'and not only with the number.',
      '',
      'WHEN THE CARD IS TOO THIN TO JUDGE, SAY SO INSTEAD OF GUESSING: answer with',
      '"ops": [] and explain in "message" and "rationale" what is missing. Do NOT propose a middle',
      'value (50) as a placeholder: an unassessed card is the author own to set by hand.',
      '',
      'DO NOT EDIT /voice/maxLinesPerRound OR /voice/cooldown: they are hard limits the scheduler',
      'enforces, and only the author sets them.',
      '',
      `THE CARD CONTENT THIS ASSESSMENT IS BASED ON (${evidence.length} of ${VOICE_EVIDENCE_PATHS.length} fields are written):`,
      ...(evidence.length === 0
        ? ['- (none: every field the assessment reads is empty)']
        : evidence.map((entry) => `- ${entry.path}: ${JSON.stringify(entry.text)}`)),
    ].join('\n'),
  };
}

/** The `voice` fields C3 may write, as a typed view, for a caller that wants to assert the set. */
export type EvaluatedVoiceFields = Pick<VoiceProfile, 'desire' | 'ability' | 'roles'>;

/**
 * Every path of a character proposal that lies outside the speaking profile.
 *
 * Used by the panel to explain a refusal in the author's own vocabulary ("that is a description field,
 * not part of the profile") rather than by pointer alone.
 */
export function isVoiceField(path: string): boolean {
  return VOICE_EVALUATED_PATHS.includes(path);
}
