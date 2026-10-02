/**
 * The BUNDLE exporter the example content pack is built with (`docs/06` §2.6
 * M1-I2), plus the one call that builds the shipped example.
 *
 * WHY THIS IS NOT IN `export-package.ts`. That file's contract is "the three kinds
 * M1-M3 owns (world, character, session)" and `docs/04` §12 items 8–12 are its
 * regression suite; a `bundle` (`docs/04` §5: "上述任意组合") is a fourth kind, and
 * widening the delivered exporter is a product decision, not an example's. So the
 * bundle lives here, using the same `PackageWriter` port and the same payload
 * encoders (`../payload`), and a reader can diff the two exporters side by side.
 *
 * ONE PACK MAY CARRY SEVERAL WORLDS. §2.6 asks for two, and the payload format has
 * always allowed it (`data/worlds.json` is `WorldVersion[]`, `WorldbookEntry.worldId`
 * scopes each entry to its own world), so this exporter takes `worldIds` and writes
 * every world's head version plus that world's worldbook entries. The characters
 * are a flat list on purpose: which card belongs to which world is a SESSION's
 * decision, never a card's (ADR-010), so the pack states no such pairing.
 *
 * WHY A LIBRARY IS ALSO AN INPUT. Building a pack from STORED ROWS is what makes
 * "import → export → import" a real question: the second build reads what the
 * importer actually wrote (derived head rows, provenance extensions), so
 * `example-pack.test.ts` can assert the pack is a fixed point instead of asserting
 * that a constant equals itself. `buildExampleContentPack` is the convenience the
 * app and the CLI call, and it does NOT need a library — it writes the source
 * constants directly, so a first-run build needs no database at all.
 *
 * WHAT AN EXAMPLE PACK'S IDENTITY IS, AND WHY IT IS FIXED. `EXAMPLE_PACKAGE_ID`
 * and `EXAMPLE_CREATED_AT` are literals: a bundled example is the same object on
 * every start (the argument `apps/web/src/chat/builtin-content.ts` makes for its
 * `createdAt: 0`), and it is what makes the built bytes reproducible — two builds
 * are byte-identical, which the test suite asserts. `exportContentPack` leaves both
 * optional and lets the injected writer mint them, because a user-triggered export
 * is a new artifact every time.
 *
 * WHERE THE RULE-PACK AND PRESET HALVES ARE. Nowhere, deliberately, and the
 * artifact says so: there is no rule-pack schema or row in this repository
 * (`docs/06` §10.5) and no way to write a `promptPresets` row yet (`docs/06` §8.5
 * decision 1), so this pack writes no `data/rulepacks.json` and no
 * `data/promptPresets.json`, declares no ref for either, and reports `rulePacks: 0`
 * and `promptPresets: 0` rather than inventing rows. Its generated `README.txt`
 * lists both under "what is deliberately NOT inside".
 */
import {
  COLLECTIONS,
  calendarView,
  type PackageWriteEntry,
  type PackageWriter,
  resolvedSegmentsOf,
  type StorageAdapter,
  segmentOf,
  type Tx,
} from '@smarttavern/core';
import type {
  Character,
  CharacterVersion,
  PackageGenerator,
  PackageLicense,
  PackageRef,
  UuidV7,
  World,
  WorldbookEntry,
  WorldData,
  WorldVersion,
} from '@smarttavern/schema';
import { ExportError, type ExportResult } from '../export-package';
import { encodeCharacters, encodeWorldbooks, encodeWorlds, type PayloadFile } from '../payload';
import {
  EXAMPLE_CREATED_AT,
  EXAMPLE_LICENSE,
  EXAMPLE_PACK_DESCRIPTION,
  EXAMPLE_PACK_NAME,
  EXAMPLE_PACKAGE_ID,
  exampleCharacterVersions,
  exampleWorldbookEntries,
  exampleWorldVersions,
} from './content';

/* ─────────────────────────── the package's own files ─────────────────────── */

/** The two documents every package carries (`docs/04` §2: both are required). */
const LICENSE_PATH = 'LICENSE.txt';
const README_PATH = 'README.txt';

/**
 * The pack's `LICENSE.txt`. English on purpose: it is package METADATA that a tool
 * reads, like the README inside every other pack this repository writes
 * (`export-package.ts`'s `licenseText`), not world content.
 */
function licenseText(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  return [
    'The world, worldbook and character text in this package was written for the',
    'SmartTavern repository as example content, and is covered by the repository’s',
    'own licence (AGPL-3.0-only; see the repository root).',
    '',
    'No rule-pack text is embedded in this package: docs/04 §4 requires rule packs to',
    'travel as an `optional` reference so that no copyrighted rules are redistributed.',
    'This pack carries no rule-pack reference at all, because no rule-pack schema or',
    'row exists in this build (docs/06 §10.5). It also carries no prompt preset: the',
    'only preset in this build is the application’s built-in constant, not a stored',
    'row (docs/06 §8.5 decision 1).',
    '',
    'This package contains no API keys, absolute paths or device identifiers',
    '(docs/04 §9 redaction rules).',
    '',
  ].join('\n');
}

/** The rows a content pack's `data/` files hold. Shared by the README generator. */
interface ContentRows {
  readonly name: string;
  readonly worlds: readonly WorldVersion[];
  readonly worldbook: readonly WorldbookEntry[];
  readonly characters: readonly CharacterVersion[];
}

/**
 * Where a world starts, named by the SAME lookup a worldbook `timeOfDay` condition
 * performs — so the README cannot claim a segment the engine disagrees with.
 *
 * The try/catch is not defensive noise: `calendarView` validates segment hour bounds
 * more strictly than `CalendarSchema` does (a `toHour` past the end of the day is
 * schema-legal and engine-illegal today), and a world like that is the world's
 * problem, not this document's — so the line degrades to the bare minute instead of
 * failing an export over a sentence.
 */
function startLabel(world: WorldData): string {
  try {
    const view = calendarView(world.calendar);
    const at = segmentOf(
      view,
      resolvedSegmentsOf(world.calendar, view.hoursPerDay),
      world.startMinute,
    );
    return at === undefined
      ? `minute ${world.startMinute}, in no named segment`
      : `minute ${world.startMinute}, inside ${at.name} (${at.id})`;
  } catch {
    return `minute ${world.startMinute}`;
  }
}

/** One world's block of the README: its calendar, its start and its segment ids. */
function worldBlock(world: WorldVersion): string[] {
  const data = world.data;
  const calendar = data.calendar;
  const segments = calendar.segments.map((segment) => `${segment.name} (${segment.id})`).join(', ');
  return [
    `    • ${data.name} — ${calendar.hoursPerDay} hours per day, ${calendar.minutesPerHour} minutes per hour;`,
    `      starts at ${startLabel(data)}.`,
    `      Day segments: ${segments}.`,
  ];
}

/**
 * The pack's `README.txt`: the human-readable statement of contents `docs/04` §2
 * requires, with the counts derived from the rows it actually carries.
 *
 * The worlds' and the cards' NAMES and the segment names are quoted as content — a
 * reader has to be able to match this document to the payloads — while the prose
 * around them stays English, for the reason `licenseText` gives.
 */
function readmeText(rows: ContentRows): string {
  const names = rows.characters.map((card) => card.data.name).join(', ');
  const entriesPerWorld = rows.worlds.length === 0 ? 0 : rows.worldbook.length / rows.worlds.length;
  return [
    rows.name,
    '',
    'kind: bundle',
    'format: smarttavern.package v1',
    '',
    'This is SmartTavern’s built-in example content pack (docs/06 §2.6, M1-I2): the',
    'worlds below, playable immediately, with no upload and no other package.',
    'Everything in it is written to be played, not to be minimal.',
    '',
    'contents:',
    `  worlds: ${rows.worlds.length}`,
    `  worldbooks: ${rows.worldbook.length}`,
    `  characters: ${rows.characters.length}`,
    '',
    'what is inside:',
    `  data/worlds.json       ${rows.worlds.length} world${rows.worlds.length === 1 ? '' : 's'}, each with its OWN calendar:`,
    ...rows.worlds.flatMap(worldBlock),
    `  data/worldbooks.json   ${entriesPerWorld} entries per world, one per day segment, each`,
    '                         carrying a `timeOfDay` condition that names that',
    '                         world’s own segment id.',
    `  data/characters.json   ${names}.`,
    '',
    'what is deliberately NOT inside:',
    '  data/rulepacks.json     no rule-pack schema or row exists yet (docs/06 §10.5),',
    '                          so this pack declares no rulepack ref and reports a',
    '                          rulePacks count of 0 rather than inventing one.',
    '  data/promptPresets.json the prompt preset is the application’s built-in',
    '                          constant, not a stored row (docs/06 §8.5 decision 1),',
    '                          so promptPresets is 0 as well.',
    '',
    'See manifest.json for the licence, the entry checksums and the byte total.',
    '',
  ].join('\n');
}

/* ──────────────────────────── shared assembly ────────────────────────────── */

/** One content pack, before the writer turns it into bytes. */
interface BuiltContentPack extends ContentRows {
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly licenseText: string;
}

/** `id`-order, so two builds of the same content are the same bytes. */
function sortedById<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * `docs/04` §4's `embedded` declaration: the worlds and the cards ARE this package's
 * content, so the importer checks that the payloads really carry them and refuses a
 * bundle that lost one. Sorted by `(kind, id)` — the order `export-package.ts`
 * writes — so the manifest is stable.
 */
function embeddedRefs(rows: ContentRows): PackageRef[] {
  const refs: PackageRef[] = [
    ...rows.worlds.map(
      (world): PackageRef => ({
        kind: 'world',
        id: world.worldId,
        version: world.version,
        requirement: 'embedded',
      }),
    ),
    ...rows.characters.map(
      (card): PackageRef => ({
        kind: 'character',
        id: card.characterId,
        version: card.version,
        requirement: 'embedded',
      }),
    ),
  ];
  return refs.sort((left, right) => {
    const leftKey = `${left.kind}:${left.id}`;
    const rightKey = `${right.kind}:${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * The pack's `data/` files. The rows become canonical JSON (`docs/04` §11, v1-r3)
 * through `../payload`, so the bytes here are the bytes `exportWorldPackage` would
 * write for the same rows.
 */
function contentPayloads(rows: ContentRows): PayloadFile[] {
  return [
    encodeWorlds(sortedById(rows.worlds)),
    encodeWorldbooks(sortedById(rows.worldbook)),
    encodeCharacters(sortedById(rows.characters)),
  ];
}

/** Whatever identity, licence and shell a caller pinned on the pack. */
interface ContentPackIdentity {
  readonly id?: UuidV7;
  readonly createdAt?: string;
  readonly license?: PackageLicense;
  /** Which shell produced this package; the writer's default is its own business. */
  readonly generator?: PackageGenerator;
}

async function writeContentPack(
  writer: PackageWriter,
  built: BuiltContentPack,
  identity: ContentPackIdentity,
): Promise<ExportResult> {
  const entries: PackageWriteEntry[] = [
    ...contentPayloads(built).map((payload) => ({ path: payload.path, bytes: payload.bytes })),
    { path: LICENSE_PATH, bytes: new TextEncoder().encode(built.licenseText) },
    { path: README_PATH, bytes: new TextEncoder().encode(readmeText(built)) },
  ];

  const result = await writer.write(entries, {
    kind: 'bundle',
    name: built.name,
    ...(identity.id === undefined ? {} : { id: identity.id }),
    ...(identity.createdAt === undefined ? {} : { createdAt: identity.createdAt }),
    ...(identity.generator === undefined ? {} : { generator: identity.generator }),
    license: identity.license ?? 'user-provided',
    refs: embeddedRefs(built),
    ...(built.description === undefined ? {} : { description: built.description }),
    ...(built.tags === undefined ? {} : { tags: [...built.tags] }),
  });

  return { kind: 'bundle', bytes: result.bytes, manifest: result.manifest, warnings: [] };
}

/* ───────────────────────── build from the source ─────────────────────────── */

export interface BuildExampleContentPackRequest {
  /** The real container is injected: this package may import `packages/core` only. */
  readonly writer: PackageWriter;
  readonly name?: string;
  /** Override the fixed identity, for a caller that wants a fresh artifact. */
  readonly id?: UuidV7;
  readonly createdAt?: string;
  /**
   * Which shell is building this. A CLI and the web app produce the same CONTENT
   * (`docs/04`'s determinism claim is about content), but the manifest has to say
   * honestly which one ran, so the caller supplies it.
   */
  readonly generator?: PackageGenerator;
}

/**
 * Every genre the example's worlds declare, de-duplicated and in declaration order —
 * derived rather than typed out, so the manifest's tags cannot drift from the
 * content the way a second literal list would.
 */
function exampleTags(worlds: readonly WorldVersion[]): string[] {
  const tags: string[] = [];
  for (const world of worlds) {
    for (const genre of world.data.genre) if (!tags.includes(genre)) tags.push(genre);
  }
  return tags;
}

/**
 * Build the shipped example pack straight from `./content` — no storage, no
 * database, no clock of its own. This is what a first-run flow calls, and it is
 * deterministic: the same build twice produces the same bytes.
 */
export async function buildExampleContentPack(
  request: BuildExampleContentPackRequest,
): Promise<ExportResult> {
  const worlds = exampleWorldVersions();
  const built: BuiltContentPack = {
    name: request.name ?? EXAMPLE_PACK_NAME,
    description: EXAMPLE_PACK_DESCRIPTION,
    tags: exampleTags(worlds),
    worlds,
    worldbook: exampleWorldbookEntries(),
    characters: exampleCharacterVersions(),
    licenseText: licenseText(undefined),
  };

  return writeContentPack(request.writer, built, {
    id: request.id ?? (EXAMPLE_PACKAGE_ID as UuidV7),
    createdAt: request.createdAt ?? EXAMPLE_CREATED_AT,
    license: EXAMPLE_LICENSE,
    ...(request.generator === undefined ? {} : { generator: request.generator }),
  });
}

/* ───────────────────────── build from a library ─────────────────────────── */

export interface ExportContentPackRequest {
  readonly storage: StorageAdapter;
  readonly writer: PackageWriter;
  /** The worlds whose head versions (and whose worldbook entries) to export. */
  readonly worldIds: readonly string[];
  /** The characters whose head versions to export. */
  readonly characterIds: readonly string[];
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly id?: UuidV7;
  readonly createdAt?: string;
  readonly license?: PackageLicense;
  readonly licenseText?: string;
  /** Which shell produced this package; see `BuildExampleContentPackRequest`. */
  readonly generator?: PackageGenerator;
}

/**
 * `export-package.ts`'s `pickVersion` rule, restated: trust the head pointer, and
 * fall back to the highest version when it is stale. A second spelling of one rule
 * is a liability, so this is a DELIBERATE copy with the same meaning — the two
 * exporters must not disagree about which version "the head" is.
 */
function pickVersion<T extends { readonly version: number }>(
  rows: readonly T[],
  headVersion: number,
  what: string,
): T {
  const head = rows.find((row) => row.version === headVersion);
  if (head !== undefined) return head;
  const highest = [...rows].sort((left, right) => left.version - right.version).at(-1);
  if (highest === undefined) throw new ExportError(`${what} has no version rows to export`);
  return highest;
}

async function readWorldVersion(tx: Tx, worldId: string): Promise<WorldVersion> {
  const head = await tx.collection<World>(COLLECTIONS.worlds).get(worldId);
  if (head === undefined) throw new ExportError(`no world ${worldId} in the library`);
  const versions = await tx
    .collection<WorldVersion>(COLLECTIONS.worldVersions)
    .list({ where: { worldId } });
  return pickVersion(versions, head.headVersion, `world ${worldId}`);
}

async function readCharacterVersion(tx: Tx, characterId: string): Promise<CharacterVersion> {
  const head = await tx.collection<Character>(COLLECTIONS.characters).get(characterId);
  if (head === undefined) throw new ExportError(`no character ${characterId} in the library`);
  const versions = await tx
    .collection<CharacterVersion>(COLLECTIONS.characterVersions)
    .list({ where: { characterId } });
  return pickVersion(versions, head.headVersion, `character ${characterId}`);
}

/**
 * Export one content pack (`kind: bundle`) from a library: each named world with its
 * worldbook entries, plus the head version of each named character.
 *
 * WHY IT READS THROUGH THE PORT: the same boundary `export-package.ts` respects —
 * the exporter knows a `StorageAdapter`, never a backend, and never `settings` or
 * `providers` (`docs/04` §12 item 11).
 */
export async function exportContentPack(request: ExportContentPackRequest): Promise<ExportResult> {
  const built = await request.storage.transaction(async (tx): Promise<BuiltContentPack> => {
    const worlds: WorldVersion[] = [];
    const worldbook: WorldbookEntry[] = [];
    for (const worldId of request.worldIds) {
      worlds.push(await readWorldVersion(tx, worldId));
      worldbook.push(
        ...(await tx
          .collection<WorldbookEntry>(COLLECTIONS.worldbookEntries)
          .list({ where: { worldId } })),
      );
    }

    const characters: CharacterVersion[] = [];
    for (const characterId of request.characterIds) {
      characters.push(await readCharacterVersion(tx, characterId));
    }

    // A pack's own name, when the caller does not give one: the worlds it carries, in
    // the order asked for — never a single world standing in for a multi-world pack.
    const derivedName = worlds.map((world) => world.data.name).join(' · ');
    return {
      name: request.name ?? derivedName,
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.tags === undefined ? {} : { tags: [...request.tags] }),
      worlds,
      worldbook,
      characters,
      licenseText: licenseText(request.licenseText),
    };
  });

  return writeContentPack(request.writer, built, {
    ...(request.id === undefined ? {} : { id: request.id }),
    ...(request.createdAt === undefined ? {} : { createdAt: request.createdAt }),
    ...(request.license === undefined ? {} : { license: request.license }),
    ...(request.generator === undefined ? {} : { generator: request.generator }),
  });
}
