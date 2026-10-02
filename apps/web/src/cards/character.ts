/**
 * The character card's payload, as the editor (M1-C1) works with it: the blank shape a new card
 * starts from, the tolerant reader of a stored DRAFT, the validation the publish gate uses, and
 * the inventory of fields the form renders.
 *
 * THERE IS NO PLAYER/CAST FIELD HERE, AND THAT IS THE POINT (ADR-010)
 * `packages/schema/src/entities/character.ts` states the rule and `session.ts`'s header repeats
 * it: identity is a property of the SESSION (`Session.refs.playerCharacter`), because the same
 * card has to play the protagonist in one session and the antagonist in the next. So this editor
 * offers no 「玩家角色」 checkbox, no `kind`, no `role` and no duplicate persona — the only
 * speaking-role vocabulary a card owns is `voice.roles` (发言角色标签), which the TURN SCHEDULER
 * matches against and which says nothing about who is playing whom. Adding such a field here
 * would be the bug that rule exists to prevent, and `cards/character.test.ts` pins the absence.
 *
 * WHAT M1-C1 NAMES, AND WHERE THE SILLYTAVERN MAPPING GOES
 * The SillyTavern-facing fields keep their exact upstream names (`first_mes`, `mes_example`,
 * `alternate_greetings`, …) and this editor stores them verbatim; `stExtensions` keeps foreign
 * ST extension keys that are not `x-` namespaced. The MAPPING to and from a real ST card (PNG
 * tEXt chunk / JSON, V1/V2/V3) belongs to M1-I1 and is deliberately not here — C1's acceptance
 * is that the fields EXIST and survive storage, and I1's is that a round trip loses none.
 *
 * 视觉档案 AND THE MISSING ASSET PIPELINE (docs/06 §10.5)
 * `visual.references[].assetId` is stored like any other field, and it may DANGLE: there is no
 * asset pipeline yet, so nothing validates that the id names a stored asset and nothing uploads
 * one. This editor therefore stores the id and says so in the panel's own hint; it does not
 * build an upload path, which is M2-I5's.
 *
 * 自定义字段 live in the version envelope's `extensions` (`cards/extensions.ts`), never in the
 * payload's `customFields` record — which hydration carries through untouched, because an
 * imported card may have one.
 */

import type { MessageKey } from '@smarttavern/i18n';
import {
  type CharacterData,
  CharacterDataSchema,
  mintUuidV7,
  type PartialSamplingParams,
  type VisualBible,
  type VoiceProfile,
} from '@smarttavern/schema';
import {
  asList,
  asNumber,
  asOptionalNumber,
  asString,
  asStringList,
  asStringRecord,
  type CardIssue,
  jsonObject,
  memberOf,
  memberValue,
  type NumberFieldSpec,
  type StringListFieldSpec,
  type TextFieldSpec,
} from './fields';

/* ─────────────────────────── the blank shapes (增) ───────────────────────── */

/**
 * A new card's speaking profile: the neutral middle of every range.
 *
 * `desire`/`ability` are 50 — a card nobody has assessed yet speaks neither more nor less than
 * its peers — and `maxLinesPerRound`/`cooldown` are the conservative ends of their ranges, so a
 * fresh card cannot dominate a round before M1-C3 has anything to say about it.
 */
export function blankVoiceProfile(): VoiceProfile {
  return { desire: 50, ability: 50, roles: [], maxLinesPerRound: 1, cooldown: 0 };
}

/** A new outfit row. `id` is minted (`docs/04` §4); `prompt` is the生图 text. */
export function blankOutfit(): VisualBible['outfits'][number] {
  return { id: mintUuidV7(), name: '', prompt: '' };
}

/** A new expression row (颜绘差分). */
export function blankExpression(): VisualBible['expressions'][number] {
  return { id: mintUuidV7(), label: '', prompt: '' };
}

/**
 * A new reference row (L2/L3 生图输入).
 *
 * `assetId` starts EMPTY rather than minted: an asset id names something that exists, and
 * this app cannot create one yet (docs/06 §10.5), so the honest blank is an id the validation
 * panel then refuses until the user pastes one.
 */
export function blankReference(): NonNullable<VisualBible['references']>[number] {
  return { assetId: '', role: 'face' };
}

/**
 * A new character payload: every required field present, every content field empty.
 *
 * Schema-valid on purpose, like `blankWorldData` — only `name` has a non-empty constraint — so
 * 「新建」 writes a first version instead of nothing. `sampling`, `stExtensions` and
 * `customFields` are absent because the schema makes them optional and "not set" is a different
 * fact from "set to empty" for each of them.
 */
export function blankCharacterData(name: string): CharacterData {
  return {
    name,
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    voice: blankVoiceProfile(),
    visual: {
      appearance: { hair: '', eyes: '', build: '', skin: '', marks: [] },
      outfits: [],
      expressions: [],
      style: { preset: '', positive: '', negative: '', aspect: '' },
      // L1 (fixed seed + fixed prompt) is the shipping consistency strategy (ADR-014), so a
      // fresh card starts on it rather than on a policy the user has to discover.
      params: { seedPolicy: 'fixed' },
    },
  };
}

/* ───────────────────── the tolerant reader of a draft (读) ───────────────── */

/** The seed policies `VisualBibleSchema` allows, as the union its own schema declares. */
export type SeedPolicy = VisualBible['params']['seedPolicy'];
export type ReferenceRole = NonNullable<VisualBible['references']>[number]['role'];
export type ReasoningEffort = NonNullable<PartialSamplingParams['reasoningEffort']>;

/**
 * The label of every seed policy.
 *
 * A `Record` over the schema's own union, so a policy the schema gains is a `tsc` error here
 * until somebody decides what it says — and, because the options are read from this record's
 * keys, there is exactly ONE list of policies in the app.
 */
export const SEED_POLICY_LABELS: Readonly<Record<SeedPolicy, MessageKey>> = {
  fixed: 'character.seedPolicyFixed',
  random: 'character.seedPolicyRandom',
  increment: 'character.seedPolicyIncrement',
};

/** The same, for what a reference image is FOR. */
export const REFERENCE_ROLE_LABELS: Readonly<Record<ReferenceRole, MessageKey>> = {
  face: 'character.referenceRoleFace',
  outfit: 'character.referenceRoleOutfit',
  style: 'character.referenceRoleStyle',
};

/** The same, for `ChatRequest.reasoningEffort`'s documented levels. */
export const REASONING_EFFORT_LABELS: Readonly<Record<ReasoningEffort, MessageKey>> = {
  minimal: 'character.reasoningMinimal',
  low: 'character.reasoningLow',
  medium: 'character.reasoningMedium',
  high: 'character.reasoningHigh',
};

/** Narrowing guards, so a `<select>`'s string can only become a member of the union. */
export function isSeedPolicy(value: string): value is SeedPolicy {
  return Object.hasOwn(SEED_POLICY_LABELS, value);
}

export function isReferenceRole(value: string): value is ReferenceRole {
  return Object.hasOwn(REFERENCE_ROLE_LABELS, value);
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return Object.hasOwn(REASONING_EFFORT_LABELS, value);
}

function completeAppearance(
  member: unknown,
  fallback: VisualBible['appearance'],
): VisualBible['appearance'] {
  const source = jsonObject(member);
  if (source === undefined) return fallback;
  return {
    hair: asString(source, 'hair', fallback.hair),
    eyes: asString(source, 'eyes', fallback.eyes),
    build: asString(source, 'build', fallback.build),
    skin: asString(source, 'skin', fallback.skin),
    marks: asStringList(source, 'marks', fallback.marks),
  };
}

function completeOutfit(member: unknown): VisualBible['outfits'][number] | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  return {
    id: asString(source, 'id', ''),
    name: asString(source, 'name', ''),
    prompt: asString(source, 'prompt', ''),
  };
}

function completeExpression(member: unknown): VisualBible['expressions'][number] | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  return {
    id: asString(source, 'id', ''),
    label: asString(source, 'label', ''),
    prompt: asString(source, 'prompt', ''),
  };
}

function completeReference(
  member: unknown,
): NonNullable<VisualBible['references']>[number] | undefined {
  const source = jsonObject(member);
  if (source === undefined) return undefined;
  const role = asString(source, 'role', '');
  return {
    assetId: asString(source, 'assetId', ''),
    // An unreadable role falls back to `face`, the one a reference is most often FOR; a
    // dropped row would silently lose the asset id stored beside it.
    role: isReferenceRole(role) ? role : 'face',
  };
}

function completeVisual(member: unknown, fallback: VisualBible): VisualBible {
  const source = jsonObject(member);
  if (source === undefined) return fallback;
  const params = memberOf(source, 'params');
  const style = memberOf(source, 'style');
  const provider = asString(params, 'provider', '');
  const model = asString(params, 'model', '');
  const sampler = asString(params, 'sampler', '');
  const steps = asOptionalNumber(params, 'steps');
  const cfg = asOptionalNumber(params, 'cfg');
  const seed = asOptionalNumber(params, 'seed');
  const seedPolicy = asString(params, 'seedPolicy', '');
  const references = asList(source, 'references', completeReference, fallback.references ?? []);
  return {
    appearance: completeAppearance(memberOf(source, 'appearance'), fallback.appearance),
    outfits: asList(source, 'outfits', completeOutfit, fallback.outfits),
    expressions: asList(source, 'expressions', completeExpression, fallback.expressions),
    style: {
      preset: asString(style, 'preset', fallback.style.preset),
      positive: asString(style, 'positive', fallback.style.positive),
      negative: asString(style, 'negative', fallback.style.negative),
      aspect: asString(style, 'aspect', fallback.style.aspect),
    },
    params: {
      ...(provider === '' ? {} : { provider }),
      ...(model === '' ? {} : { model }),
      ...(sampler === '' ? {} : { sampler }),
      ...(steps === undefined ? {} : { steps }),
      ...(cfg === undefined ? {} : { cfg }),
      seedPolicy: isSeedPolicy(seedPolicy) ? seedPolicy : fallback.params.seedPolicy,
      ...(seed === undefined ? {} : { seed }),
    },
    ...(references.length === 0 ? {} : { references }),
  };
}

/**
 * Set one member of an accumulating optional record when it is present.
 *
 * WHY `Object.assign` AND NOT `target[key] = value`: the indexed write needs TypeScript to
 * narrow a GENERIC member's type (`PartialSamplingParams[K] | undefined`), which it cannot do
 * through an index signature; `Object.assign` is the spelling both the compiler and Biome accept.
 */
function put<K extends keyof PartialSamplingParams>(
  target: PartialSamplingParams,
  key: K,
  value: PartialSamplingParams[K] | undefined,
): void {
  if (value === undefined) return;
  Object.assign(target, { [key]: value });
}

function completeSampling(
  member: unknown,
  fallback: PartialSamplingParams | undefined,
): PartialSamplingParams | undefined {
  const source = jsonObject(member);
  if (source === undefined) return fallback;
  const sampling: PartialSamplingParams = {};
  put(sampling, 'temperature', asOptionalNumber(source, 'temperature'));
  put(sampling, 'topP', asOptionalNumber(source, 'topP'));
  put(sampling, 'topK', asOptionalNumber(source, 'topK'));
  put(sampling, 'maxTokens', asOptionalNumber(source, 'maxTokens'));
  put(sampling, 'presencePenalty', asOptionalNumber(source, 'presencePenalty'));
  put(sampling, 'frequencyPenalty', asOptionalNumber(source, 'frequencyPenalty'));
  put(sampling, 'repetitionPenalty', asOptionalNumber(source, 'repetitionPenalty'));
  put(sampling, 'seed', asOptionalNumber(source, 'seed'));
  const stop = asStringList(source, 'stop', []);
  if (stop.length > 0) sampling.stop = stop;
  const reasoning = asString(source, 'reasoningEffort', '');
  if (isReasoningEffort(reasoning)) sampling.reasoningEffort = reasoning;
  return sampling;
}

/**
 * Complete a stored draft payload over the version it was based on, field by field.
 *
 * The same rule as `completeWorldData`: a member with the right TYPE is taken from the draft
 * (`''` and `0` included, because clearing a field is a real edit) and anything missing or
 * wrongly typed falls back to `base`. `stExtensions` is a bag of FOREIGN keys whose values this
 * app does not model, so it is preserved as it arrived — I1's round trip depends on nothing
 * here deciding it can be dropped.
 */
export function completeCharacterData(base: CharacterData, raw: unknown): CharacterData {
  const source = jsonObject(raw);
  if (source === undefined) return base;
  const voice = memberOf(source, 'voice');
  // An ABSENT key keeps the base's value (the draft never carried the field); a present but
  // unreadable one falls back the same way — `asStringRecord` / `jsonObject` decide.
  const stExtensions = memberOf(source, 'stExtensions') ?? base.stExtensions;
  const customFields =
    memberOf(source, 'customFields') === undefined
      ? base.customFields
      : asStringRecord(source, 'customFields', {});
  const sampling = completeSampling(memberValue(source, 'sampling'), base.sampling);
  return {
    name: asString(source, 'name', base.name),
    description: asString(source, 'description', base.description),
    personality: asString(source, 'personality', base.personality),
    scenario: asString(source, 'scenario', base.scenario),
    first_mes: asString(source, 'first_mes', base.first_mes),
    mes_example: asString(source, 'mes_example', base.mes_example),
    creator_notes: asString(source, 'creator_notes', base.creator_notes),
    system_prompt: asString(source, 'system_prompt', base.system_prompt),
    post_history_instructions: asString(
      source,
      'post_history_instructions',
      base.post_history_instructions,
    ),
    alternate_greetings: asStringList(source, 'alternate_greetings', base.alternate_greetings),
    tags: asStringList(source, 'tags', base.tags),
    creator: asString(source, 'creator', base.creator),
    character_version: asString(source, 'character_version', base.character_version),
    voice: {
      desire: asNumber(voice, 'desire', base.voice.desire),
      ability: asNumber(voice, 'ability', base.voice.ability),
      roles: asStringList(voice, 'roles', base.voice.roles),
      maxLinesPerRound: asNumber(voice, 'maxLinesPerRound', base.voice.maxLinesPerRound),
      cooldown: asNumber(voice, 'cooldown', base.voice.cooldown),
    },
    visual: completeVisual(memberValue(source, 'visual'), base.visual),
    ...(sampling === undefined ? {} : { sampling }),
    ...(stExtensions === undefined ? {} : { stExtensions }),
    ...(customFields === undefined ? {} : { customFields }),
  };
}

/* ───────────────────────────── validation (校验) ─────────────────────────── */

/**
 * Everything that stands between this payload and a published version.
 *
 * Schema-only, unlike the world's: nothing in a character card is arithmetic, so the Zod entity
 * IS the whole contract (`VoiceProfileSchema`'s 0-100 ranges, `VisualBibleSchema`'s required
 * members, the fourteen SillyTavern fields). The paths come back dotted, so the view can name the
 * field it is about to complain about.
 */
export function characterIssues(data: CharacterData): readonly CardIssue[] {
  const parsed = CharacterDataSchema.safeParse(data);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/* ─────────────────────── the form's field inventory (改) ─────────────────── */

/**
 * The SillyTavern V2/V3 fields, in the order `docs/01` §5.3 lists them.
 *
 * The upstream names are the KEYS, because that is what is stored; only the labels are ours.
 * `description`/`personality`/`scenario` and the three message fields are multi-line: they are
 * prose the model reads, not identifiers.
 */
export const CHARACTER_TEXT_FIELDS: readonly TextFieldSpec<CharacterData>[] = [
  { key: 'name', label: 'character.nameLabel' },
  { key: 'description', label: 'character.descriptionLabel', multiline: true },
  { key: 'personality', label: 'character.personalityLabel', multiline: true },
  { key: 'scenario', label: 'character.scenarioLabel', multiline: true },
  { key: 'first_mes', label: 'character.firstMesLabel', multiline: true },
  { key: 'mes_example', label: 'character.mesExampleLabel', multiline: true },
  { key: 'creator_notes', label: 'character.creatorNotesLabel', multiline: true },
  { key: 'system_prompt', label: 'character.systemPromptLabel', multiline: true },
  { key: 'post_history_instructions', label: 'character.postHistoryLabel', multiline: true },
  { key: 'creator', label: 'character.creatorLabel' },
  { key: 'character_version', label: 'character.characterVersionLabel' },
];

export const CHARACTER_TAGS_FIELD: StringListFieldSpec<CharacterData> = {
  key: 'tags',
  label: 'character.tagsLabel',
};

/**
 * `alternate_greetings` is a PROSE list (`rows`): each greeting is a whole message that may
 * contain line breaks, so its control is one textarea per greeting rather than one line per
 * greeting.
 */
export const CHARACTER_GREETINGS_FIELD: StringListFieldSpec<CharacterData> = {
  key: 'alternate_greetings',
  label: 'character.alternateGreetingsLabel',
  rows: true,
};

/** 发言档案 (docs/01 §F3-4, ADR-011): the numbers the local `TurnScheduler` reads. */
export const VOICE_NUMBER_FIELDS: readonly NumberFieldSpec<VoiceProfile>[] = [
  { key: 'desire', label: 'character.desireLabel', integer: true, min: 0, max: 100 },
  { key: 'ability', label: 'character.abilityLabel', integer: true, min: 0, max: 100 },
  { key: 'maxLinesPerRound', label: 'character.maxLinesLabel', integer: true, min: 1, max: 5 },
  { key: 'cooldown', label: 'character.cooldownLabel', integer: true, min: 0, max: 3 },
];

export const VOICE_ROLES_FIELD: StringListFieldSpec<VoiceProfile> = {
  key: 'roles',
  label: 'character.rolesLabel',
};

/** 视觉档案 (ADR-014): the appearance, the diffs, the style and the generation parameters. */
export const APPEARANCE_FIELDS: readonly TextFieldSpec<VisualBible['appearance']>[] = [
  { key: 'hair', label: 'character.hairLabel' },
  { key: 'eyes', label: 'character.eyesLabel' },
  { key: 'build', label: 'character.buildLabel' },
  { key: 'skin', label: 'character.skinLabel' },
];

export const APPEARANCE_MARKS_FIELD: StringListFieldSpec<VisualBible['appearance']> = {
  key: 'marks',
  label: 'character.marksLabel',
};

export const OUTFIT_FIELDS: readonly TextFieldSpec<VisualBible['outfits'][number]>[] = [
  { key: 'id', label: 'character.outfitIdLabel' },
  { key: 'name', label: 'character.outfitNameLabel' },
  { key: 'prompt', label: 'character.outfitPromptLabel', multiline: true },
];

export const EXPRESSION_FIELDS: readonly TextFieldSpec<VisualBible['expressions'][number]>[] = [
  { key: 'id', label: 'character.expressionIdLabel' },
  { key: 'label', label: 'character.expressionNameLabel' },
  { key: 'prompt', label: 'character.expressionPromptLabel', multiline: true },
];

export const STYLE_FIELDS: readonly TextFieldSpec<VisualBible['style']>[] = [
  { key: 'preset', label: 'character.stylePresetLabel' },
  { key: 'positive', label: 'character.stylePositiveLabel', multiline: true },
  { key: 'negative', label: 'character.styleNegativeLabel', multiline: true },
  { key: 'aspect', label: 'character.styleAspectLabel' },
];

export const VISUAL_PARAMS_TEXT_FIELDS: readonly TextFieldSpec<VisualBible['params']>[] = [
  { key: 'provider', label: 'character.paramsProviderLabel' },
  { key: 'model', label: 'character.paramsModelLabel' },
  { key: 'sampler', label: 'character.paramsSamplerLabel' },
];

export const VISUAL_PARAMS_NUMBER_FIELDS: readonly NumberFieldSpec<VisualBible['params']>[] = [
  { key: 'steps', label: 'character.paramsStepsLabel', integer: true, min: 1, optional: true },
  { key: 'cfg', label: 'character.paramsCfgLabel', optional: true },
  { key: 'seed', label: 'character.seedLabel', integer: true, optional: true },
];

export const REFERENCE_TEXT_FIELDS: readonly TextFieldSpec<
  NonNullable<VisualBible['references']>[number]
>[] = [{ key: 'assetId', label: 'character.referenceAssetIdLabel' }];

/** 默认采样参数: every knob is optional, and an empty input means "do not override". */
export const SAMPLING_NUMBER_FIELDS: readonly NumberFieldSpec<PartialSamplingParams>[] = [
  {
    key: 'temperature',
    label: 'character.samplingTemperatureLabel',
    optional: true,
    min: 0,
    max: 2,
  },
  { key: 'topP', label: 'character.samplingTopPLabel', optional: true, min: 0, max: 1 },
  { key: 'topK', label: 'character.samplingTopKLabel', optional: true, integer: true, min: 1 },
  {
    key: 'maxTokens',
    label: 'character.samplingMaxTokensLabel',
    optional: true,
    integer: true,
    min: 1,
  },
  {
    key: 'presencePenalty',
    label: 'character.samplingPresenceLabel',
    optional: true,
    min: -2,
    max: 2,
  },
  {
    key: 'frequencyPenalty',
    label: 'character.samplingFrequencyLabel',
    optional: true,
    min: -2,
    max: 2,
  },
  { key: 'repetitionPenalty', label: 'character.samplingRepetitionLabel', optional: true, min: 0 },
  { key: 'seed', label: 'character.samplingSeedLabel', optional: true, integer: true },
];

export const SAMPLING_STOP_FIELD: StringListFieldSpec<PartialSamplingParams> = {
  key: 'stop',
  label: 'character.samplingStopLabel',
};

/**
 * Every payload path this form RENDERS, including the composite groups.
 *
 * `cards/character.test.ts` walks `CharacterDataSchema` and fails when a field is in neither
 * this list nor `CHARACTER_DELEGATED_PATHS`, so 「字段完整」 is checked against the contract
 * itself instead of against a reviewer's memory.
 */
export const CHARACTER_FORM_PATHS: readonly string[] = [
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
  'visual.outfits',
  'visual.expressions',
  'visual.style.preset',
  'visual.style.positive',
  'visual.style.negative',
  'visual.style.aspect',
  'visual.params.provider',
  'visual.params.model',
  'visual.params.sampler',
  'visual.params.steps',
  'visual.params.cfg',
  'visual.params.seedPolicy',
  'visual.params.seed',
  'visual.references',
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
];

/**
 * The VERSION ENVELOPE's slot the custom-field panel edits.
 *
 * Not a payload path: `versionedEntity` owns the plugin channel and `common.ts` rule 1 makes it
 * the only sanctioned one (`cards/extensions.ts`). Listed so the completeness check can tell
 * "rendered" from "forgotten" without pretending `extensions` is a field of `CharacterData`.
 */
export const CHARACTER_ENVELOPE_PATHS: readonly string[] = ['extensions'];

/**
 * Payload fields the editor does NOT render, and why:
 * - `stExtensions` holds FOREIGN SillyTavern extension keys (talkativeness, depth_prompt, …)
 *   that this app does not model. I1's import/export round trip needs them preserved verbatim,
 *   and a form that rendered them would have to invent a type for each key.
 * - `customFields` is the payload's own custom-field record, superseded for new data by the
 *   envelope's `extensions` (`cards/extensions.ts`); hydration preserves it, never edits it.
 */
export const CHARACTER_DELEGATED_PATHS: readonly string[] = ['stExtensions', 'customFields'];
