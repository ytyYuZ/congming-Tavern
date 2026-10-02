/**
 * SillyTavern world info ⇄ `WorldbookEntry[]` — both ST shapes of it
 * (`docs/01` F9-3, `docs/04` §10, `docs/06` §2.6).
 *
 * THE TWO SHAPES, AND WHY BOTH ARE READ HERE
 *   `world_info`      the standalone file SillyTavern's World Info panel exports:
 *                     `{ entries: { "0": { uid, key, keysecondary, content, order,
 *                     position, depth, probability, useProbability, disable,
 *                     comment, … } } }` — entries keyed by their `uid`.
 *   `character_book`  the object inside a V2/V3 card (`data.character_book`):
 *                     `{ name, description, scan_depth, token_budget,
 *                     recursive_scanning, extensions, entries: [ { id, keys,
 *                     secondary_keys, content, insertion_order, position,
 *                     enabled, comment, … } ] }` — an ARRAY, and different field
 *                     names for the same ideas.
 * Both are read and written here; the card importer hands its `character_book`
 * straight to `importStCharacterBook`.
 *
 * THE MAPPING, FIELD BY FIELD (everything else is kept as data)
 *   `key` / `keys`                   → `keywords`
 *   `content`                        → `content`
 *   `order` / `insertion_order`      → `priority` (default 100, ST's own default)
 *   `position`                       → `position` (see the table below)
 *   `depth`                          → `depth` (default 4, ST's own `@Depth`
 *                                      default; `packages/core`'s composer counts
 *                                      depth back from the END of the history, which
 *                                      is what ST's number means — see
 *                                      `engine/prompt/compose.ts`)
 *   `probability` + `useProbability` → `probability` (`useProbability: false` means
 *                                      "ignore the roll, always inject", which our
 *                                      100 means; the raw pair is kept for export)
 *   `disable` / `enabled`            → `enabled` (inverted for `disable`)
 *   `comment`                        → `comment`
 *   `uid` / `id`                     → the entry's `id` (and the export's key)
 *
 * THE POSITION TABLE, AND WHY IT IS INVERTIBLE
 * ST's numeric positions are 0 before char defs, 1 after char defs, 2 before the
 * author's note, 3 after it and 4 `@depth`; the `character_book` spelling has only
 * `before_char` / `after_char`. Our vocabulary is `pre_history` / `in_history` /
 * `post_history`, and each of the three has an ST value that reads back as itself:
 *
 *   0 before_char → pre_history     4 @depth           → in_history
 *   1 after_char  → post_history    2/3 author's note  → in_history
 *
 * (2 and 3 collapse because ST injects the author's note at a depth INSIDE the
 * history, which is what `in_history` is.) The ORIGINAL ST value is kept in the
 * reserved bag, so an entry nobody edited is written back EXACTLY; the table above
 * is what an edited one gets. A `character_book` position has no `in_history`
 * spelling at all, so exporting one writes `after_char` and says what that means,
 * because the only alternatives are to guess or to drop the entry.
 *
 * WHAT HAS NO HOME, AND WHERE IT GOES
 * `WorldbookEntry` has `keywords`, `content`, `priority`, `position`, `depth`,
 * `probability`, `conditions`, `enabled`, `comment` and an `extensions` bag; ST has
 * more: `keysecondary` + `selective` + `selectiveLogic` (secondary keys and the
 * AND/OR between them), `constant`, `case_sensitive`, `matchWholeWords`,
 * `group`/`groupWeight`/`useGroupScoring`, `scanDepth`, `sticky`/`cooldown`/`delay`,
 * `role`, `vectorized`, `excludeRecursion`/`preventRecursion`/`delayUntilRecursion`,
 * `displayIndex`, `automationId`, the entry's own `extensions` object, and for a
 * `character_book` entry its `name`. None of them is dropped: the entry carries them
 * verbatim in `extensions['x-smarttavern.st-entry']`, one aggregated
 * `st-field-no-home` finding per entry NAMES them, and export writes them back. The
 * BOOK CONTAINER (`name`, `description`, `scan_depth`, `token_budget`,
 * `recursive_scanning`, `extensions`) has no entity at all — our schema scopes
 * entries to a WORLD and has no book row — so it is returned beside the entries and
 * must be passed back to export; that is reported too.
 *
 * ONE RULE FOR A MAPPED FIELD WITH AN UNUSABLE TYPE
 * A field our model DOES know, written in a type it cannot hold (`disable: "true"`,
 * `order: "high"`), is reported (`st-field-invalid`), replaced by the documented
 * default, and NOT copied into the reserved bag — the bag holds the fields our model
 * does not know, and a value this shape has no home as anything. `probability` and
 * `useProbability: false` are the exception, because there the VALUE is usable and
 * it is our field that cannot express it.
 *
 * TWO SEMANTIC GAPS THE DATA CANNOT CLOSE (reported, not papered over)
 * `constant: true` means "always inject, ignore the keys"; `WorldbookEntry` has no
 * such flag, so an imported constant entry matches by keyword like any other. And our
 * `conditions` (time-of-day, `afterMinute`, `withinDays`) have no ST spelling at all,
 * so a conditional entry exports as an unconditional one. In both directions the
 * value survives in our entity and in the bag; what changes is BEHAVIOUR, and that is
 * exactly the kind of thing a report exists to say.
 */

import { type Id, type WorldbookEntry, WorldbookEntrySchema } from '@smarttavern/schema';
import { type StFinding, stFinding, stOk } from './findings';
import {
  describeValue,
  integerMember,
  isRecord,
  keysOf,
  memberOf,
  numberMember,
  stringListMember,
  withoutKeys,
} from './json';

/* ─────────────────────────────── vocabulary ──────────────────────────────── */

/** Which ST document the entries came from (and go back to). */
export type StWorldbookForm = 'world_info' | 'character_book';

/** The reserved `extensions` key that carries an entry's unmapped ST members. */
export const ST_ENTRY_BAG_KEY = 'x-smarttavern.st-entry';

/** One of our three injection slots. */
type OurPosition = WorldbookEntry['position'];

/** ST's own default `order` / `insertion_order`, used when the source omits it. */
const DEFAULT_PRIORITY = 100;

/** ST's own default `@Depth` (its `convertCharacterBook` uses exactly this). */
const DEFAULT_DEPTH = 4;

/** The members each form's mapped fields account for. */
const TAKEN: Readonly<Record<StWorldbookForm, readonly string[]>> = {
  world_info: [
    'uid',
    'key',
    'content',
    'order',
    'position',
    'depth',
    'probability',
    'useProbability',
    'disable',
    'comment',
  ],
  character_book: [
    'id',
    'keys',
    'content',
    'insertion_order',
    'position',
    'depth',
    'probability',
    'useProbability',
    'enabled',
    'comment',
  ],
};

/* ──────────────────────────────── positions ──────────────────────────────── */

function ourPositionOfWorldInfo(value: number): OurPosition | undefined {
  switch (value) {
    case 0:
      return 'pre_history';
    case 1:
      return 'post_history';
    case 2:
    case 3:
    case 4:
      return 'in_history';
    default:
      return undefined;
  }
}

function stPositionOfWorldInfo(position: OurPosition): number {
  if (position === 'pre_history') return 0;
  if (position === 'in_history') return 4;
  return 1;
}

function ourPositionOfCharacterBook(value: string): OurPosition | undefined {
  if (value === 'before_char') return 'pre_history';
  if (value === 'after_char') return 'post_history';
  return undefined;
}

function stPositionOfCharacterBook(position: OurPosition): string {
  return position === 'pre_history' ? 'before_char' : 'after_char';
}

function numericText(value: string): number | undefined {
  return /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
}

/**
 * The slot an ST position value names, whichever numbering it used.
 *
 * A number is read with the world-info table (the shared lorebook object uses it)
 * and a string with the `character_book` table — but a value written in the other
 * notation is read anyway, because tolerating what other exporters write is the
 * whole job here. The two vocabularies agree where they overlap: `before_char` is
 * 0 (pre_history) and `after_char` is 1 (post_history) in both.
 */
function ourPositionOfRaw(value: unknown): OurPosition | undefined {
  if (typeof value === 'number') return ourPositionOfWorldInfo(value);
  if (typeof value === 'string') {
    const numeric = numericText(value);
    if (numeric !== undefined) return ourPositionOfWorldInfo(numeric);
    return ourPositionOfCharacterBook(value);
  }
  return undefined;
}

/** As above, plus the note a value written in the other notation deserves. */
function ourPositionOf(
  value: unknown,
  form: StWorldbookForm,
  where: string,
  findings: StFinding[],
): OurPosition | undefined {
  if (typeof value === 'number' && form === 'character_book') {
    findings.push(
      stFinding(
        'st-field-coerced',
        'a numeric position in a character_book entry; read with the world info numbering',
        where,
      ),
    );
  } else if (typeof value === 'string' && form === 'world_info') {
    findings.push(
      stFinding(
        'st-field-coerced',
        `position is the string ${JSON.stringify(value)}; read as the slot it names`,
        where,
      ),
    );
  }
  return ourPositionOfRaw(value);
}

/* ──────────────────────────────── results ────────────────────────────────── */

/** How an entry's `id` is derived when the caller does not supply a rule. */
export interface StEntryIdentity {
  /** ST's own entry number (`uid` in world info, `id` in a character_book). */
  readonly uid?: number;
  /** The key the entry sat under in the `entries` map, when it was a map. */
  readonly key?: string;
}

export interface StWorldbookImportOptions {
  /**
   * The world the entries belong to. Required: `WorldbookEntry.worldId` is part of
   * the entity, and a standalone ST world info file does not name a world — which
   * world it describes is the caller's decision, not something to invent here.
   */
  readonly worldId: Id;
  /** Override the id rule. Default: ST's `uid`/`id` as a decimal string. */
  readonly newId?: (identity: StEntryIdentity, index: number) => Id;
}

export interface StWorldbookImport {
  /** False when any finding is an error; the entries that validated are still here. */
  readonly ok: boolean;
  readonly entries: readonly WorldbookEntry[];
  /**
   * The book container ST keeps beside the entries, verbatim and without
   * `entries`. Our schema has no book entity, so this is data the caller holds and
   * passes back to export; it is named in a finding as well.
   */
  readonly container?: Record<string, unknown>;
  readonly form: StWorldbookForm;
  readonly findings: readonly StFinding[];
}

export interface StWorldbookExportOptions {
  /** The container to write around the entries (`importStWorldInfo` returned it). */
  readonly container?: Record<string, unknown>;
}

export interface StWorldbookExport {
  readonly ok: boolean;
  /** The ST document; present whenever at least one entry was written. */
  readonly value?: unknown;
  readonly findings: readonly StFinding[];
}

/* ──────────────────────────────── importing ──────────────────────────────── */

/** What the reserved bag of one entry holds. */
interface StEntryBag {
  readonly form: StWorldbookForm;
  readonly uid?: number;
  /** The ST position value as it arrived, for an exact write-back. */
  readonly position?: unknown;
  /** Every unmapped ST member, verbatim, in the source form's spelling. */
  readonly raw: Record<string, unknown>;
}

/** One entry read out of an ST `entries` member, plus where it sat. */
interface EntrySource {
  readonly record: Record<string, unknown>;
  readonly index: number;
  readonly uid?: number;
  readonly mapKey?: string;
}

/* ── tolerant readers that report what they could not use ─────────────────── */

/** An optional text member: a scalar is coerced, a container is refused. */
function optionalTextOf(
  record: Record<string, unknown>,
  key: string,
  where: string,
  findings: StFinding[],
): string | undefined {
  const raw = memberOf(record, key);
  if (raw === undefined || raw === null) return undefined;
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
      `${key} is ${describeValue(raw)}, not text; the empty value is used`,
      where,
    ),
  );
  return undefined;
}

/** A numeric member written as a string, noted once: some exporters stringify. */
function noteStringNumber(
  record: Record<string, unknown>,
  key: string,
  where: string,
  findings: StFinding[],
): void {
  const raw = memberOf(record, key);
  if (typeof raw !== 'string') return;
  findings.push(
    stFinding(
      'st-field-coerced',
      `${key} is the string ${JSON.stringify(raw)}; read as a number`,
      where,
    ),
  );
}

/** An integer member, rounded with a note when the source wrote a fraction. */
function integerOf(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  where: string,
  findings: StFinding[],
): number {
  const raw = numberMember(record, key);
  if (raw === undefined) {
    const present = memberOf(record, key);
    if (present !== undefined && present !== null) {
      findings.push(
        stFinding(
          'st-field-invalid',
          `${key} is ${describeValue(present)}, not a number; ${fallback} is used`,
          where,
        ),
      );
    }
    return fallback;
  }
  noteStringNumber(record, key, where, findings);
  const rounded = Math.round(raw);
  if (rounded !== raw) {
    findings.push(
      stFinding(
        'st-field-coerced',
        `${key} is ${raw}; rounded to ${rounded} (the field is an integer)`,
        where,
      ),
    );
  }
  return rounded;
}

/** A boolean member: anything else is reported and the fallback is used. */
function booleanOf(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
  where: string,
  findings: StFinding[],
): boolean {
  const raw = memberOf(record, key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  findings.push(
    stFinding(
      'st-field-invalid',
      `${key} is ${describeValue(raw)}, not a boolean; ${fallback ? 'true' : 'false'} is used`,
      where,
    ),
  );
  return fallback;
}

function entryIdOf(
  identity: StEntryIdentity,
  index: number,
  options: StWorldbookImportOptions,
  findings: StFinding[],
  where: string,
): Id {
  if (options.newId !== undefined) return options.newId(identity, index);
  if (identity.uid !== undefined) return String(identity.uid);
  if (identity.key !== undefined && identity.key !== '') return identity.key;
  findings.push(
    stFinding(
      'st-entry-id-missing',
      'the entry has no uid/id and no map key; its id comes from its position',
      where,
    ),
  );
  return `st-entry-${index}`;
}

function mapEntry(
  source: EntrySource,
  form: StWorldbookForm,
  options: StWorldbookImportOptions,
  findings: StFinding[],
): WorldbookEntry | undefined {
  const record = source.record;
  const uid = source.uid;
  const identity: StEntryIdentity = {
    ...(uid === undefined ? {} : { uid }),
    ...(source.mapKey === undefined ? {} : { key: source.mapKey }),
  };
  const id = entryIdOf(identity, source.index, options, findings, `entry ${source.index}`);
  const where = `entry ${id}`;

  const keyRead = stringListMember(record, form === 'world_info' ? 'key' : 'keys');
  const rejected = keyRead?.rejected ?? 0;
  if (keyRead?.coerced === true) {
    findings.push(
      stFinding(
        'st-field-coerced',
        'the keyword member is a single string; read as a one-element list',
        where,
      ),
    );
  }
  if (rejected > 0) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${rejected} keyword(s) are not strings and were dropped`,
        where,
      ),
    );
  }

  const content = optionalTextOf(record, 'content', where, findings) ?? '';
  const priority = integerOf(
    record,
    form === 'world_info' ? 'order' : 'insertion_order',
    DEFAULT_PRIORITY,
    where,
    findings,
  );

  const rawPosition = memberOf(record, 'position');
  const mapped =
    rawPosition === undefined ? undefined : ourPositionOf(rawPosition, form, where, findings);
  if (rawPosition !== undefined && mapped === undefined) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `position is ${describeValue(rawPosition)}, which names no slot; pre_history is used`,
        where,
      ),
    );
  }

  let depth = integerOf(record, 'depth', DEFAULT_DEPTH, where, findings);
  if (depth < 0) {
    findings.push(stFinding('st-field-invalid', `depth is ${depth}, below zero; 0 is used`, where));
    depth = 0;
  }

  const useProbability = booleanOf(record, 'useProbability', true, where, findings);
  const probabilityRaw = numberMember(record, 'probability');
  let probability = 100;
  if (!useProbability) {
    // "Ignore the roll, always inject" is what our 100 means.
    probability = 100;
  } else if (probabilityRaw !== undefined) {
    noteStringNumber(record, 'probability', where, findings);
    const rounded = Math.round(probabilityRaw);
    if (rounded !== probabilityRaw) {
      findings.push(
        stFinding(
          'st-field-coerced',
          `probability is ${probabilityRaw}; rounded to ${rounded}`,
          where,
        ),
      );
    }
    probability = Math.min(100, Math.max(0, rounded));
    if (probability !== rounded) {
      findings.push(
        stFinding(
          'st-field-invalid',
          `probability ${rounded} is outside 0-100; clamped to ${probability}`,
          where,
        ),
      );
    }
  }

  const enabled =
    form === 'world_info'
      ? !booleanOf(record, 'disable', false, where, findings)
      : booleanOf(record, 'enabled', true, where, findings);
  const comment = optionalTextOf(record, 'comment', where, findings);

  /* ── everything ST has and we do not: kept verbatim, and named ─────────── */

  const raw = withoutKeys(record, TAKEN[form]);
  const named = keysOf(raw);
  if (named.length > 0) {
    findings.push(
      stFinding(
        'st-field-no-home',
        `no home in WorldbookEntry: ${named.join(', ')} (kept verbatim in ${ST_ENTRY_BAG_KEY} and written back on export)`,
        where,
      ),
    );
  }
  if (memberOf(record, 'constant') === true) {
    findings.push(
      stFinding(
        'st-field-no-home',
        'constant: true has no home — our entries are keyword- and condition-triggered, so this entry will not always inject the way SillyTavern injected it (the flag itself is kept)',
        where,
      ),
    );
  }
  // `probability` + `useProbability: false` is the one case where OUR field cannot
  // hold a usable source value, so the pair travels in the bag instead.
  const bagRaw: Record<string, unknown> = useProbability
    ? raw
    : {
        ...raw,
        useProbability: false,
        ...(probabilityRaw === undefined ? {} : { probability: probabilityRaw }),
      };

  const bag: StEntryBag = {
    form,
    ...(uid === undefined ? {} : { uid }),
    ...(rawPosition === undefined ? {} : { position: rawPosition }),
    raw: bagRaw,
  };

  const assembled = {
    id,
    worldId: options.worldId,
    keywords: [...(keyRead?.values ?? [])],
    content,
    priority,
    position: mapped ?? 'pre_history',
    depth,
    probability,
    conditions: {},
    enabled,
    ...(comment === undefined ? {} : { comment }),
    extensions: { [ST_ENTRY_BAG_KEY]: bag },
  };

  const parsed = WorldbookEntrySchema.safeParse(assembled);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push(
        stFinding(
          'st-worldbook-shape',
          `${issue.message} (the mapped entry does not satisfy WorldbookEntry)`,
          `${where}.${issue.path.join('.')}`,
        ),
      );
    }
    return undefined;
  }
  return parsed.data;
}

/** One entry list: an array, or the `uid`-keyed map world info uses. */
function entrySourcesOf(
  entries: unknown,
  form: StWorldbookForm,
  findings: StFinding[],
): readonly EntrySource[] {
  if (Array.isArray(entries)) {
    return entries.flatMap((item, index) => {
      if (!isRecord(item)) {
        findings.push(
          stFinding(
            'st-worldbook-shape',
            `entry ${index} is ${describeValue(item)}, not an object`,
            `entry ${index}`,
          ),
        );
        return [];
      }
      const uid =
        form === 'character_book' ? integerMember(item, 'id') : integerMember(item, 'uid');
      return [{ record: item, index, ...(uid === undefined ? {} : { uid }) }];
    });
  }
  if (isRecord(entries)) {
    // JavaScript iterates integer-like keys in ascending order, which is the order
    // SillyTavern writes them in; any other key keeps the source order.
    return keysOf(entries).flatMap((mapKey, index) => {
      const item = memberOf(entries, mapKey);
      if (!isRecord(item)) {
        findings.push(
          stFinding(
            'st-worldbook-shape',
            `entry ${mapKey} is ${describeValue(item)}, not an object`,
            `entry ${mapKey}`,
          ),
        );
        return [];
      }
      const declared =
        form === 'character_book' ? integerMember(item, 'id') : integerMember(item, 'uid');
      const uid = declared ?? numericText(mapKey);
      return [{ record: item, index, mapKey, ...(uid === undefined ? {} : { uid }) }];
    });
  }
  findings.push(
    stFinding(
      'st-worldbook-shape',
      `entries is ${describeValue(entries)}, not an array or an object map`,
      'entries',
    ),
  );
  return [];
}

/** The `entries` member of an ST document, or a refusal. */
function entriesMemberOf(
  value: unknown,
  form: StWorldbookForm,
  findings: StFinding[],
): { entries: unknown; container?: Record<string, unknown> } | undefined {
  const label = form === 'world_info' ? 'world info' : 'character_book';
  if (!isRecord(value)) {
    findings.push(
      stFinding(
        'st-worldbook-shape',
        `an ST ${label} document is a JSON object, not ${describeValue(value)}`,
      ),
    );
    return undefined;
  }
  if (!Object.hasOwn(value, 'entries')) {
    findings.push(
      stFinding('st-worldbook-shape', `the ST ${label} document has no entries member`, 'entries'),
    );
    return undefined;
  }
  const rest = withoutKeys(value, ['entries']);
  return {
    entries: memberOf(value, 'entries'),
    ...(keysOf(rest).length === 0 ? {} : { container: rest }),
  };
}

function importEntries(
  value: unknown,
  form: StWorldbookForm,
  options: StWorldbookImportOptions,
): StWorldbookImport {
  const findings: StFinding[] = [];
  const located = entriesMemberOf(value, form, findings);
  if (located === undefined) return { ok: false, entries: [], form, findings };

  const entries: WorldbookEntry[] = [];
  for (const source of entrySourcesOf(located.entries, form, findings)) {
    const entry = mapEntry(source, form, options, findings);
    if (entry !== undefined) entries.push(entry);
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      continue;
    }
    if (!seen.has(`reported:${entry.id}`)) {
      seen.add(`reported:${entry.id}`);
      findings.push(
        stFinding(
          'st-entry-id-duplicate',
          `two entries map to the id ${entry.id}; a collection would keep only one of them`,
          `entry ${entry.id}`,
        ),
      );
    }
  }

  if (located.container !== undefined) {
    findings.push(
      stFinding(
        'st-field-no-home',
        `the ${form === 'world_info' ? 'world info' : 'character_book'} container (${keysOf(located.container).join(', ')}) has no entity in SmartTavern: it is returned beside the entries and must be passed back to export`,
        'container',
      ),
    );
  }

  return {
    ok: stOk(findings),
    entries,
    ...(located.container === undefined ? {} : { container: located.container }),
    form,
    findings,
  };
}

/** Read a standalone SillyTavern world info document. */
export function importStWorldInfo(
  value: unknown,
  options: StWorldbookImportOptions,
): StWorldbookImport {
  return importEntries(value, 'world_info', options);
}

/** Read a world info document from its text form. */
export function parseStWorldInfo(
  text: string,
  options: StWorldbookImportOptions,
): StWorldbookImport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      entries: [],
      form: 'world_info',
      findings: [stFinding('st-not-json', `the text is not JSON: ${String(cause)}`)],
    };
  }
  return importStWorldInfo(value, options);
}

/** Read the `character_book` object of a V2/V3 card. */
export function importStCharacterBook(
  value: unknown,
  options: StWorldbookImportOptions,
): StWorldbookImport {
  return importEntries(value, 'character_book', options);
}

/* ──────────────────────────────── exporting ──────────────────────────────── */

/** Read one entry's reserved bag back, tolerantly. */
function stEntryBagOf(entry: WorldbookEntry): { bag?: StEntryBag; findings: StFinding[] } {
  const findings: StFinding[] = [];
  const value = entry.extensions?.[ST_ENTRY_BAG_KEY];
  if (value === undefined) return { findings };
  if (!isRecord(value)) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${ST_ENTRY_BAG_KEY} is ${describeValue(value)}, not an object; the entry is exported without the fields it held`,
        `entry ${entry.id}`,
      ),
    );
    return { findings };
  }
  const rawValue = memberOf(value, 'raw');
  if (rawValue !== undefined && !isRecord(rawValue)) {
    findings.push(
      stFinding(
        'st-field-invalid',
        `${ST_ENTRY_BAG_KEY}.raw is ${describeValue(rawValue)}, not an object; it is ignored`,
        `entry ${entry.id}`,
      ),
    );
  }
  const position = memberOf(value, 'position');
  return {
    bag: {
      form: memberOf(value, 'form') === 'character_book' ? 'character_book' : 'world_info',
      ...(integerMember(value, 'uid') === undefined ? {} : { uid: integerMember(value, 'uid') }),
      ...(position === undefined ? {} : { position }),
      raw: isRecord(rawValue) ? rawValue : {},
    },
    findings,
  };
}

/** The number an ST entry is keyed by: the preserved uid, a numeric id, the index. */
function uidOf(bag: StEntryBag | undefined, entry: WorldbookEntry, index: number): number {
  if (bag?.uid !== undefined) return bag.uid;
  return numericText(entry.id) ?? index;
}

/** Our own fields ST cannot express, named for one aggregated finding. */
function ourLosses(entry: WorldbookEntry): readonly string[] {
  const losses: string[] = [];
  if (Object.keys(entry.conditions).length > 0) losses.push('conditions');
  const foreign = withoutKeys(entry.extensions ?? {}, [ST_ENTRY_BAG_KEY]);
  for (const key of keysOf(foreign)) losses.push(`extensions.${key}`);
  return losses;
}

function writeEntry(
  entry: WorldbookEntry,
  index: number,
  form: StWorldbookForm,
  findings: StFinding[],
): Record<string, unknown> | undefined {
  const parsed = WorldbookEntrySchema.safeParse(entry);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push(
        stFinding(
          'st-worldbook-shape',
          `${issue.message} (the entry cannot be written as ST world info)`,
          `entry ${entry.id}.${issue.path.join('.')}`,
        ),
      );
    }
    return undefined;
  }

  const { bag, findings: bagFindings } = stEntryBagOf(entry);
  findings.push(...bagFindings);
  const where = `entry ${entry.id}`;
  if (bag !== undefined && bag.form !== form) {
    const held = keysOf(bag.raw);
    findings.push(
      stFinding(
        'st-form-conversion',
        `the entry's preserved fields came from a ${bag.form} document; they are not written into a ${form} one, so ${held.length === 0 ? 'nothing' : held.join(', ')} stay in SmartTavern only`,
        where,
      ),
    );
  }

  const raw = bag === undefined || bag.form !== form ? {} : { ...bag.raw };
  const hadUseProbabilityFalse = memberOf(raw, 'useProbability') === false;
  const rawProbability = memberOf(raw, 'probability');
  const uid = uidOf(bag, entry, index);

  /* position: the original when our slot still maps to it, else the table */
  const rawPosition = bag?.position;
  const restored = rawPosition !== undefined && ourPositionOfRaw(rawPosition) === entry.position;
  if (form === 'character_book' && !restored && entry.position === 'in_history') {
    findings.push(
      stFinding(
        'st-field-no-home',
        'a character_book position has only before_char/after_char: in_history is written as after_char, which reads back as post_history — keep the entry in a standalone world info file to preserve the slot',
        where,
      ),
    );
  }
  const position =
    form === 'world_info'
      ? restored
        ? rawPosition
        : stPositionOfWorldInfo(entry.position)
      : restored
        ? rawPosition
        : stPositionOfCharacterBook(entry.position);

  // The "always inject" pair is written back only when our 100 still means it.
  const probability: Record<string, unknown> =
    hadUseProbabilityFalse && entry.probability === 100
      ? {
          ...(rawProbability === undefined ? {} : { probability: rawProbability }),
          useProbability: false,
        }
      : { probability: entry.probability };

  const mapped: Record<string, unknown> =
    form === 'world_info'
      ? {
          uid,
          key: [...entry.keywords],
          content: entry.content,
          order: entry.priority,
          position,
          depth: entry.depth,
          disable: !entry.enabled,
        }
      : {
          id: uid,
          keys: [...entry.keywords],
          content: entry.content,
          insertion_order: entry.priority,
          position,
          depth: entry.depth,
          enabled: entry.enabled,
        };

  const losses = ourLosses(entry);
  if (losses.length > 0) {
    findings.push(
      stFinding(
        'st-field-no-home',
        `no ST spelling for: ${losses.join(', ')} (the values stay in SmartTavern)`,
        where,
      ),
    );
  }

  return {
    // The fields ST has and we do not come first, so a mapped field always wins.
    ...withoutKeys(raw, ['useProbability', 'probability']),
    ...mapped,
    ...probability,
    ...(entry.comment === undefined ? {} : { comment: entry.comment }),
  };
}

function exportEntries(
  entries: readonly WorldbookEntry[],
  form: StWorldbookForm,
  options: StWorldbookExportOptions,
): StWorldbookExport {
  const findings: StFinding[] = [];
  const written: Record<string, unknown>[] = [];
  for (const [index, entry] of entries.entries()) {
    const output = writeEntry(entry, index, form, findings);
    if (output !== undefined) written.push(output);
  }

  const container = options.container ?? {};
  if (Object.hasOwn(container, 'entries')) {
    findings.push(
      stFinding(
        'st-form-conversion',
        'the container carried an entries member; the entries argument wins and that member is not written',
        'container.entries',
      ),
    );
  }
  const around = withoutKeys(container, ['entries']);

  if (form === 'world_info') {
    // The map world info uses, keyed by uid — which is also what SillyTavern reads.
    // A uid already taken gets the lowest free integer, so two entries cannot
    // collapse onto one key without a word.
    const map: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const [index, output] of written.entries()) {
      const uid = memberOf(output, 'uid');
      let key = typeof uid === 'number' ? String(uid) : String(index);
      if (used.has(key)) {
        let candidate = 0;
        while (used.has(String(candidate))) candidate += 1;
        findings.push(
          stFinding(
            'st-entry-id-duplicate',
            `entry ${key} repeats a uid already written; it is written as ${candidate} instead`,
            `entry ${key}`,
          ),
        );
        key = String(candidate);
      }
      used.add(key);
      map[key] = output;
    }
    return { ok: stOk(findings), value: { ...around, entries: map }, findings };
  }

  return { ok: stOk(findings), value: { ...around, entries: written }, findings };
}

/** Write a standalone SillyTavern world info document. */
export function exportStWorldInfo(
  entries: readonly WorldbookEntry[],
  options: StWorldbookExportOptions = {},
): StWorldbookExport {
  return exportEntries(entries, 'world_info', options);
}

/** Write a V2/V3 `character_book` object. */
export function exportStCharacterBook(
  entries: readonly WorldbookEntry[],
  options: StWorldbookExportOptions = {},
): StWorldbookExport {
  return exportEntries(entries, 'character_book', options);
}
