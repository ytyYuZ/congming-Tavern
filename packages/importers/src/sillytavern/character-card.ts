/**
 * SillyTavern character card JSON ⇄ `CharacterData` — the mapping M1-I1 owns
 * (`docs/06` §2.6, `docs/04` §10, `docs/01` F9-1 / F9-2).
 *
 * THE MAPPING IS **ALMOST IDENTITY**, ON PURPOSE
 * `packages/schema/src/entities/character.ts` stores SillyTavern's V2/V3 field
 * names verbatim (`first_mes`, `mes_example`, `post_history_instructions`,
 * `system_prompt`, `alternate_greetings`, `character_version`). So there is no
 * rename table to read here: the thirteen ST-facing fields are copied name for
 * name. The only renames in this file are documented ST history:
 *
 *   ST V1 `creatorcomment`            → `creator_notes`   (V2 renamed the field)
 *   ST `extensions.smarttavern`       → `voice` / `visual` / `sampling`
 *     (`docs/04` §10: our own additions have no ST home, so they travel in the
 *      `extensions.smarttavern` bucket and are read back from it)
 *
 * WHAT CARRIES A CARD, AND WHAT EACH FORM CANNOT HOLD
 *   V1  the flat legacy object (`name`, `description`, … `creatorcomment`). It
 *       cannot hold `alternate_greetings`, `tags`, `creator`, `character_version`,
 *       `system_prompt`, `post_history_instructions`, `character_book` or any
 *       extension bucket; exporting one reports exactly which non-empty fields it
 *       had to leave behind.
 *   V2  `{ spec: 'chara_card_v2', spec_version: '2.0', data: {…} }`.
 *   V3  `{ spec: 'chara_card_v3', spec_version: '3.0', data: {…} }` — the same
 *       fields plus `nickname`, `source`, `group_only_greetings`, `assets`, …
 *
 * FIELDS ST HAS AND WE DO NOT — THEY SURVIVE AS DATA, AND ARE NAMED
 * `CharacterData` has no home for `character_book` (our lorebook is
 * `WorldbookEntry`, scoped to a WORLD, and it has no book container), nor for the
 * V3 additions, nor for a foreign `extensions` key. None of them is dropped: every
 * unmapped source member travels VERBATIM inside the reserved bag
 * `stExtensions['x-smarttavern.st-card']`, and each one gets a `st-field-no-home`
 * finding naming it. Export writes them back where they came from.
 *
 * WHY THE BAG IS A SINGLE RESERVED KEY AND NOT ONE KEY PER FIELD
 * `stExtensions` is documented as the bag of OTHER programs' keys (`talkativeness`,
 * `depth_prompt`, …) whose values are their authors' — and the web editor preserves
 * that bag verbatim through an edit. Reserving ONE key (`x-smarttavern.st-card`,
 * whose value is an object) means a foreign key can collide with our bookkeeping
 * in at most one place, and that collision is an ERROR finding rather than a
 * silent overwrite of somebody else's data. The bag is also the only reason a card
 * EDITED in SmartTavern can still export the `character_book` it arrived with: no
 * field of `CharacterData` can hold it.
 *
 * ONE FINDING PER UNMAPPED FIELD — and the worldbook side does it per ENTRY. A card
 * has a handful of extra fields and each one is worth pointing at; a lorebook of two
 * hundred entries with a dozen extra members each would bury the report it is
 * supposed to be, so `./worldbook.ts` names them in one finding per entry.
 *
 * ABSENT vs EMPTY: WHAT THIS FILE INVENTS AND WHAT IT DOES NOT
 * An ST card that does not carry a field gets the schema's blank value (`''` / `[]`)
 * with NO finding, because nothing was lost — ST had nothing there. A field that IS
 * present with an unusable type is a `st-field-invalid` warning and the blank value;
 * a value that is merely written in another JSON type (`"100"`, a lone string where
 * a list belongs) is coerced with a `st-field-coerced` note. The one invention that
 * IS reported is `voice` / `visual`: ST has no equivalent at all, so they are
 * defaulted and the default is stated once per import.
 *
 * A SPEC VERSION WE DO NOT KNOW IS REFUSED, NOT GUESSED
 * `chara_card_v9`, or a `spec_version` whose MAJOR disagrees with its `spec`, is an
 * error finding and no card is produced: mapping a shape nobody has written down is
 * how fields disappear quietly. A newer MINOR of a major we do know (V2's `spec` with
 * `spec_version: '2.1'`) is read leniently with a warning, because a minor revision
 * promises the fields we already map.
 */

import {
  type CharacterData,
  CharacterDataSchema,
  type PartialSamplingParams,
  PartialSamplingParamsSchema,
  type VisualBible,
  VisualBibleSchema,
  type VoiceProfile,
  VoiceProfileSchema,
} from '@smarttavern/schema';
import { type StFinding, stFinding, stOk } from './findings';
import {
  describeValue,
  isRecord,
  keysOf,
  memberOf,
  stringListMember,
  stringMember,
  withoutKeys,
} from './json';

/* ─────────────────────────────── vocabulary ──────────────────────────────── */

/** Which SillyTavern card document a payload is. */
export type StCardSpecVersion = 1 | 2 | 3;

/** The reserved `stExtensions` key that carries everything we cannot map. */
export const ST_CARD_BAG_KEY = 'x-smarttavern.st-card';

/** The member of `extensions` that holds OUR additions (`docs/04` §10). */
export const ST_SMARTTAVERN_BUCKET = 'smarttavern';

/** The `spec` string each wrapped version writes. */
const SPEC_OF_VERSION: Readonly<Record<2 | 3, string>> = {
  2: 'chara_card_v2',
  3: 'chara_card_v3',
};

/** The `spec_version` each wrapped version writes. */
const SPEC_VERSION_OF_VERSION: Readonly<Record<2 | 3, string>> = { 2: '2.0', 3: '3.0' };

/** The thirteen fields that map one for one. Used to find what has NO home. */
export const ST_CARD_FIELDS = [
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
] as const;

/** The six fields a V1 reader understands, kept at the top of a V2/V3 document. */
const V1_COMPAT_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
] as const;

/**
 * Everything the reserved bag holds. Members are absent when there is nothing to
 * keep, so the bag of a card that needed no rescue is `{ specVersion }` alone.
 */
export interface StCardBag {
  readonly specVersion: StCardSpecVersion;
  /** ST's `data.character_book`, verbatim — we have no field for it. */
  readonly characterBook?: unknown;
  /** Unmapped source members, verbatim, keyed by their ST name. */
  readonly fields?: Record<string, unknown>;
  /** Unknown members of our own `extensions.smarttavern` bucket. */
  readonly smarttavern?: Record<string, unknown>;
}

/* ──────────────────────────────── results ────────────────────────────────── */

/** What a card import produced: the payload, plus everything it noticed. */
export interface StCardImport {
  readonly ok: boolean;
  /** Absent when the card could not be mapped at all (the findings say why). */
  readonly card?: CharacterData;
  readonly specVersion?: StCardSpecVersion;
  /** ST's `character_book` verbatim, for the worldbook side to map. */
  readonly characterBook?: unknown;
  readonly findings: readonly StFinding[];
}

export interface StCardExportOptions {
  /** Override the document version; defaults to the source's own version. */
  readonly specVersion?: StCardSpecVersion;
  /**
   * The `character_book` to write. Defaults to the one preserved in the reserved
   * bag, so a card that came from an ST card keeps its book without the caller
   * having to hold it.
   */
  readonly characterBook?: unknown;
}

export interface StCardExport {
  readonly ok: boolean;
  /** The ST document, or absent when the card is unusable for export. */
  readonly value?: unknown;
  /** The document version actually written. */
  readonly specVersion?: StCardSpecVersion;
  readonly findings: readonly StFinding[];
}

/* ──────────────────────────────── importing ──────────────────────────────── */

/** The document a card's fields are read from, and which version said so. */
interface CardSource {
  readonly source: Record<string, unknown>;
  readonly specVersion: StCardSpecVersion;
  /** The prefix a finding's `where` uses: `data.` for a wrapped card, `''` for V1. */
  readonly prefix: string;
}

function specVersionOfSpec(spec: string): 2 | 3 | undefined {
  if (spec === SPEC_OF_VERSION[2]) return 2;
  if (spec === SPEC_OF_VERSION[3]) return 3;
  return undefined;
}

/**
 * Accept or refuse the `spec_version` string.
 *
 * Same major → read, with a warning when the minor is newer than this build's.
 * Different or unparseable → refuse, because a major bump is allowed to mean the
 * fields moved.
 */
function specVersionAccepted(
  declared: string | undefined,
  version: 2 | 3,
  spec: string,
  findings: StFinding[],
): boolean {
  if (declared === undefined) {
    findings.push(
      stFinding(
        'st-spec-missing',
        `${spec} carries no spec_version; read as ${SPEC_VERSION_OF_VERSION[version]}`,
      ),
    );
    return true;
  }
  const [majorText, minorText = '0'] = declared.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    findings.push(
      stFinding(
        'st-unknown-spec-version',
        `spec_version ${JSON.stringify(declared)} is not a major.minor number`,
        'spec_version',
      ),
    );
    return false;
  }
  if (major !== version) {
    findings.push(
      stFinding(
        'st-unknown-spec-version',
        `spec ${spec} declares spec_version ${declared}, whose major is not ${version}`,
        'spec_version',
      ),
    );
    return false;
  }
  if (minor > 0) {
    findings.push(
      stFinding(
        'st-spec-version-newer',
        `spec_version ${declared} is newer than this build's ${SPEC_VERSION_OF_VERSION[version]}; the known fields are mapped and unknown ones are kept as data`,
        'spec_version',
      ),
    );
  }
  return true;
}

/** Which document the payload is, and where its fields live. */
function cardSourceOf(
  value: Record<string, unknown>,
  findings: StFinding[],
): CardSource | undefined {
  const spec = memberOf(value, 'spec');
  if (typeof spec === 'string') {
    const version = specVersionOfSpec(spec);
    if (version === undefined) {
      findings.push(
        stFinding(
          'st-unknown-spec-version',
          `the spec ${JSON.stringify(spec)} is not a card spec this build knows`,
          'spec',
        ),
      );
      return undefined;
    }
    const data = memberOf(value, 'data');
    if (!isRecord(data)) {
      findings.push(stFinding('st-card-shape', `${spec} requires a data object`, 'data'));
      return undefined;
    }
    if (!specVersionAccepted(stringMember(value, 'spec_version'), version, spec, findings)) {
      return undefined;
    }
    return { source: data, specVersion: version, prefix: 'data.' };
  }

  if (spec !== undefined) {
    findings.push(
      stFinding(
        'st-unknown-spec-version',
        `spec is ${describeValue(spec)}, not a card spec string`,
        'spec',
      ),
    );
    return undefined;
  }

  const data = memberOf(value, 'data');
  if (isRecord(data)) {
    findings.push(
      stFinding(
        'st-spec-missing',
        'the card has a data object but no spec; read as a V2 card, which is the shape that object has in the wild',
        'spec',
      ),
    );
    return { source: data, specVersion: 2, prefix: 'data.' };
  }

  return { source: value, specVersion: 1, prefix: '' };
}

/** A neutral speaking profile: the middle of every range (`VoiceProfileSchema`). */
function neutralVoice(): VoiceProfile {
  return { desire: 50, ability: 50, roles: [], maxLinesPerRound: 1, cooldown: 0 };
}

/** An empty visual bible — nothing is invented about how a character looks. */
function emptyVisual(): VisualBible {
  return {
    appearance: { hair: '', eyes: '', build: '', skin: '', marks: [] },
    outfits: [],
    expressions: [],
    style: { preset: '', positive: '', negative: '', aspect: '' },
    params: { seedPolicy: 'fixed' },
  };
}

/** A text field: a string is itself, a scalar is coerced, anything else is blank. */
function textOf(
  source: Record<string, unknown>,
  key: string,
  where: string,
  findings: StFinding[],
): string {
  const raw = memberOf(source, key);
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    findings.push(
      stFinding(
        'st-field-coerced',
        `${key} is ${describeValue(raw)}; read as its text form`,
        where,
      ),
    );
    return String(raw);
  }
  findings.push(
    stFinding(
      'st-field-invalid',
      `${key} is ${describeValue(raw)}, not text; using the empty value`,
      where,
    ),
  );
  return '';
}

/** A list-of-strings field: a lone string becomes a one-element list, with a note. */
function listOf(
  source: Record<string, unknown>,
  key: string,
  where: string,
  findings: StFinding[],
): string[] {
  const read = stringListMember(source, key);
  if (read === undefined) return [];
  if (read.coerced) {
    findings.push(
      stFinding('st-field-coerced', `${key} is a single string; read as a one-element list`, where),
    );
  }
  if (read.rejected > 0) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${read.rejected} member(s) of ${key} are not strings and were dropped`,
        where,
      ),
    );
  }
  return [...read.values];
}

/** The card's own additions, read from `extensions.smarttavern`. */
function smarttavernOf(
  bucket: Record<string, unknown> | undefined,
  findings: StFinding[],
): { voice: VoiceProfile; visual: VisualBible; sampling?: PartialSamplingParams } {
  if (bucket === undefined) {
    findings.push(
      stFinding(
        'st-fields-defaulted',
        'voice and visual were defaulted (a neutral speaking profile and an empty visual bible): the SillyTavern card format has no equivalent',
        `extensions.${ST_SMARTTAVERN_BUCKET}`,
      ),
    );
    return { voice: neutralVoice(), visual: emptyVisual() };
  }

  const voice = memberOf(bucket, 'voice');
  const visual = memberOf(bucket, 'visual');
  const parsedVoice = voice === undefined ? undefined : VoiceProfileSchema.safeParse(voice);
  const parsedVisual = visual === undefined ? undefined : VisualBibleSchema.safeParse(visual);

  if (voice !== undefined && parsedVoice !== undefined && !parsedVoice.success) {
    findings.push(
      stFinding(
        'st-field-invalid',
        'voice is not a speaking profile; the neutral one is used',
        `extensions.${ST_SMARTTAVERN_BUCKET}.voice`,
      ),
    );
  } else if (voice === undefined) {
    findings.push(
      stFinding(
        'st-fields-defaulted',
        'voice is absent; the neutral speaking profile is used',
        `extensions.${ST_SMARTTAVERN_BUCKET}.voice`,
      ),
    );
  }
  if (visual !== undefined && parsedVisual !== undefined && !parsedVisual.success) {
    findings.push(
      stFinding(
        'st-field-invalid',
        'visual is not a visual bible; an empty one is used',
        `extensions.${ST_SMARTTAVERN_BUCKET}.visual`,
      ),
    );
  } else if (visual === undefined) {
    findings.push(
      stFinding(
        'st-fields-defaulted',
        'visual is absent; an empty visual bible is used',
        `extensions.${ST_SMARTTAVERN_BUCKET}.visual`,
      ),
    );
  }

  const rawSampling = memberOf(bucket, 'sampling');
  const parsedSampling =
    rawSampling === undefined ? undefined : PartialSamplingParamsSchema.safeParse(rawSampling);
  if (parsedSampling !== undefined && !parsedSampling.success) {
    findings.push(
      stFinding(
        'st-field-invalid',
        'sampling is not a sampling-parameter object; it is dropped',
        `extensions.${ST_SMARTTAVERN_BUCKET}.sampling`,
      ),
    );
  }

  return {
    voice: parsedVoice?.success === true ? parsedVoice.data : neutralVoice(),
    visual: parsedVisual?.success === true ? parsedVisual.data : emptyVisual(),
    ...(parsedSampling?.success === true ? { sampling: parsedSampling.data } : {}),
  };
}

/** Map one parsed ST card document (already JSON) onto a `CharacterData`. */
function mapCard(value: Record<string, unknown>): StCardImport {
  const findings: StFinding[] = [];
  const located = cardSourceOf(value, findings);
  if (located === undefined) return { ok: false, findings };

  const { source, specVersion, prefix } = located;
  const name = textOf(source, 'name', `${prefix}name`, findings);
  if (name.trim() === '') {
    findings.push(
      stFinding(
        'st-missing-name',
        'the card has no usable name, so there is nothing to store it as',
        `${prefix}name`,
      ),
    );
    return { ok: false, findings };
  }

  // `creatorcomment` is V1's name for `creator_notes`; V2 renamed it, and a V1
  // card has no `creator_notes` to prefer. Only the flat form is read this way:
  // inside a V2 `data` object an unknown `creatorcomment` is simply unmapped data.
  const creatorNotes =
    specVersion === 1 && memberOf(source, 'creator_notes') === undefined
      ? textOf(source, 'creatorcomment', 'creatorcomment', findings)
      : textOf(source, 'creator_notes', `${prefix}creator_notes`, findings);

  const extensionsValue = memberOf(source, 'extensions');
  const extensions = isRecord(extensionsValue) ? extensionsValue : undefined;
  if (extensionsValue !== undefined && extensions === undefined) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `extensions is ${describeValue(extensionsValue)}, not an object; it is kept verbatim in the reserved bag`,
        `${prefix}extensions`,
      ),
    );
  }
  const bucketValue =
    extensions === undefined ? undefined : memberOf(extensions, ST_SMARTTAVERN_BUCKET);
  const bucket = isRecord(bucketValue) ? bucketValue : undefined;
  if (bucketValue !== undefined && bucket === undefined) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${ST_SMARTTAVERN_BUCKET} is ${describeValue(bucketValue)}, not an object; voice and visual are defaulted`,
        `extensions.${ST_SMARTTAVERN_BUCKET}`,
      ),
    );
  }

  // The reserved-key check runs BEFORE anything else is made of the card: a refusal
  // names its own cause instead of also reporting the defaults of a card it rejects.
  const foreignExtensions = withoutKeys(extensions ?? {}, [ST_SMARTTAVERN_BUCKET]);
  if (Object.hasOwn(foreignExtensions, ST_CARD_BAG_KEY)) {
    findings.push(
      stFinding(
        'st-reserved-key-collision',
        `the card's own extensions already use ${ST_CARD_BAG_KEY}, which this adapter reserves; refusing rather than overwriting somebody else's key`,
        `extensions.${ST_CARD_BAG_KEY}`,
      ),
    );
    return { ok: false, findings };
  }

  const own = smarttavernOf(bucket, findings);

  /* ── what has no home in CharacterData: kept verbatim, and named ────────── */

  const taken: string[] = [...ST_CARD_FIELDS, 'extensions', 'character_book'];
  if (specVersion === 1) taken.push('creatorcomment');
  const fields = withoutKeys(source, taken);
  for (const key of keysOf(fields)) {
    findings.push(
      stFinding(
        'st-field-no-home',
        `${key} has no home in CharacterData; it is kept verbatim in ${ST_CARD_BAG_KEY} and written back on export`,
        `${prefix}${key}`,
      ),
    );
  }

  const characterBook = memberOf(source, 'character_book');
  if (characterBook !== undefined && !isRecord(characterBook)) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `character_book is ${describeValue(characterBook)}, not an object; it is kept verbatim and written back unchanged`,
        `${prefix}character_book`,
      ),
    );
  }

  const smarttavernExtra = withoutKeys(bucket ?? {}, ['voice', 'visual', 'sampling']);
  for (const key of keysOf(smarttavernExtra)) {
    findings.push(
      stFinding(
        'st-field-no-home',
        `extensions.${ST_SMARTTAVERN_BUCKET}.${key} is not a member this build maps; it is kept verbatim`,
        `extensions.${ST_SMARTTAVERN_BUCKET}.${key}`,
      ),
    );
  }

  const bag: StCardBag = {
    specVersion,
    ...(characterBook === undefined ? {} : { characterBook }),
    ...(keysOf(fields).length === 0 ? {} : { fields }),
    ...(keysOf(smarttavernExtra).length === 0 ? {} : { smarttavern: smarttavernExtra }),
  };
  const stExtensions = { ...foreignExtensions, [ST_CARD_BAG_KEY]: bag };

  const assembled = {
    name,
    description: textOf(source, 'description', `${prefix}description`, findings),
    personality: textOf(source, 'personality', `${prefix}personality`, findings),
    scenario: textOf(source, 'scenario', `${prefix}scenario`, findings),
    first_mes: textOf(source, 'first_mes', `${prefix}first_mes`, findings),
    mes_example: textOf(source, 'mes_example', `${prefix}mes_example`, findings),
    creator_notes: creatorNotes,
    system_prompt: textOf(source, 'system_prompt', `${prefix}system_prompt`, findings),
    post_history_instructions: textOf(
      source,
      'post_history_instructions',
      `${prefix}post_history_instructions`,
      findings,
    ),
    alternate_greetings: listOf(
      source,
      'alternate_greetings',
      `${prefix}alternate_greetings`,
      findings,
    ),
    tags: listOf(source, 'tags', `${prefix}tags`, findings),
    creator: textOf(source, 'creator', `${prefix}creator`, findings),
    character_version: textOf(source, 'character_version', `${prefix}character_version`, findings),
    ...own,
    stExtensions,
  };

  // The assembled payload is validated against the entity contract, so a card that
  // our own mapping made illegal (an over-long name, say) is refused HERE rather
  // than stored and discovered later.
  const parsed = CharacterDataSchema.safeParse(assembled);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push(
        stFinding(
          'st-card-shape',
          `${issue.message} (the mapped card does not satisfy CharacterData)`,
          issue.path.join('.'),
        ),
      );
    }
    return { ok: false, specVersion, findings };
  }

  return {
    ok: stOk(findings),
    card: parsed.data,
    specVersion,
    ...(characterBook === undefined ? {} : { characterBook }),
    findings,
  };
}

/**
 * Read one card document. `value` is what `JSON.parse` returned.
 *
 * Refusals are findings and no card: an unknown spec version, a wrapped spec with
 * no `data` object, no usable name, or a reserved-key collision.
 */
export function importStCharacterCardJson(value: unknown): StCardImport {
  if (!isRecord(value)) {
    return {
      ok: false,
      findings: [
        stFinding(
          'st-card-shape',
          `a character card is a JSON object, not ${describeValue(value)}`,
        ),
      ],
    };
  }
  return mapCard(value);
}

/** Read a card document from its text form (`st-not-json` when it is not JSON). */
export function parseStCharacterCardJson(text: string): StCardImport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      findings: [stFinding('st-not-json', `the text is not JSON: ${String(cause)}`)],
    };
  }
  return importStCharacterCardJson(value);
}

/* ──────────────────────────────── exporting ──────────────────────────────── */

/** Read the reserved bag back, tolerantly: a hand-edited bag is not a crash. */
export function stCardBagOf(
  card: { readonly stExtensions?: Record<string, unknown> },
  findings: StFinding[] = [],
): StCardBag | undefined {
  const value = card.stExtensions?.[ST_CARD_BAG_KEY];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${ST_CARD_BAG_KEY} is ${describeValue(value)}, not an object; the card is exported without what it held`,
        ST_CARD_BAG_KEY,
      ),
    );
    return undefined;
  }
  const declared = memberOf(value, 'specVersion');
  let specVersion: StCardSpecVersion = 2;
  if (declared === 1 || declared === 2 || declared === 3) {
    specVersion = declared;
  } else {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${ST_CARD_BAG_KEY}.specVersion is ${describeValue(declared)}; exporting as V2`,
        `${ST_CARD_BAG_KEY}.specVersion`,
      ),
    );
  }
  const characterBook = memberOf(value, 'characterBook');
  const fields = memberOf(value, 'fields');
  const smarttavern = memberOf(value, 'smarttavern');
  return {
    specVersion,
    ...(characterBook === undefined ? {} : { characterBook }),
    ...(isRecord(fields) ? { fields } : {}),
    ...(isRecord(smarttavern) ? { smarttavern } : {}),
  };
}

/** The version this card should be written as, before an explicit override. */
export function stCardSpecVersionOf(card: CharacterData): StCardSpecVersion {
  return stCardBagOf(card)?.specVersion ?? 2;
}

/**
 * The fields a V1 document cannot carry, so the caller is told what a downgrade
 * costs instead of discovering it in SillyTavern.
 */
function v1Losses(
  card: CharacterData,
  bucket: Record<string, unknown>,
  book: unknown,
): readonly string[] {
  const losses: string[] = [];
  if (card.alternate_greetings.length > 0) losses.push('alternate_greetings');
  if (card.tags.length > 0) losses.push('tags');
  if (card.creator !== '') losses.push('creator');
  if (card.character_version !== '') losses.push('character_version');
  if (card.system_prompt !== '') losses.push('system_prompt');
  if (card.post_history_instructions !== '') losses.push('post_history_instructions');
  if (book !== undefined) losses.push('character_book');
  if (keysOf(bucket).length > 0) losses.push('extensions.smarttavern (voice, visual, sampling)');
  return losses;
}

/** Write one ST card document from a `CharacterData`. */
export function exportStCharacterCardJson(
  card: CharacterData,
  options: StCardExportOptions = {},
): StCardExport {
  const findings: StFinding[] = [];
  const parsed = CharacterDataSchema.safeParse(card);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push(stFinding('st-card-shape', issue.message, issue.path.join('.')));
    }
    return { ok: false, findings };
  }

  const bag = stCardBagOf(card, findings);
  const specVersion = options.specVersion ?? bag?.specVersion ?? 2;
  const fields = bag?.fields ?? {};
  const foreign = withoutKeys(card.stExtensions ?? {}, [ST_CARD_BAG_KEY]);
  const bucket: Record<string, unknown> = {
    ...(bag?.smarttavern ?? {}),
    voice: card.voice,
    visual: card.visual,
    ...(card.sampling === undefined ? {} : { sampling: card.sampling }),
  };
  const book = options.characterBook === undefined ? bag?.characterBook : options.characterBook;

  if (specVersion === 1) {
    const losses = v1Losses(card, bucket, book);
    if (losses.length > 0) {
      findings.push(
        stFinding(
          'st-form-conversion',
          `a V1 card document cannot carry ${losses.join(', ')}; they stay in SmartTavern and are not written here`,
          'data',
        ),
      );
    }
    const value = {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mes_example,
      ...(card.creator_notes === '' ? {} : { creatorcomment: card.creator_notes }),
      ...fields,
      // V1's foreign app fields (`talkativeness`, `fav`, …) live at the top level.
      ...foreign,
    };
    return { ok: stOk(findings), value, specVersion, findings };
  }

  const extensions =
    keysOf(foreign).length === 0
      ? { [ST_SMARTTAVERN_BUCKET]: bucket }
      : { ...foreign, [ST_SMARTTAVERN_BUCKET]: bucket };
  const data: Record<string, unknown> = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    creator_notes: card.creator_notes,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    alternate_greetings: [...card.alternate_greetings],
    tags: [...card.tags],
    creator: card.creator,
    character_version: card.character_version,
    ...fields,
    ...(book === undefined ? {} : { character_book: book }),
    extensions,
  };
  const legacy: Record<string, unknown> = {};
  for (const key of V1_COMPAT_FIELDS) legacy[key] = memberOf(data, key);

  return {
    ok: stOk(findings),
    value: {
      ...legacy,
      spec: SPEC_OF_VERSION[specVersion],
      spec_version: SPEC_VERSION_OF_VERSION[specVersion],
      data,
    },
    specVersion,
    findings,
  };
}
