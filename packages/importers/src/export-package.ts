/**
 * Export: stored entities → `.stpack` bytes, for the three kinds M1-M3 owns
 * (world, character, session) — `docs/04` §2 (layout), §5 (package kinds), §6
 * (payload rules).
 *
 * TWO BOUNDARIES THIS FILE RESPECTS
 *
 * 1. IT READS THROUGH THE `StorageAdapter` PORT, NEVER A BACKEND. `docs/02` §6 /
 *    HANDOFF §4.1 invariant 4: the adapter layer is injected. So an export takes a
 *    `StorageAdapter` and a `PackageWriter` and knows nothing else — the app
 *    passes `packages/storage` + `packages/packages`, the CLI passes its own
 *    library, the tests pass doubles.
 *
 * 2. IT NEVER LOOKS AT `settings` OR `providers`. HANDOFF §4.1 invariant 6 /
 *    `docs/04` §1 ("绝不包含 API Key、绝对路径、设备标识") and §12 item 11: an API key
 *    lives in the `settings` collection, which is NOT an entity and must not be
 *    exportable. The exporter opens a FIXED list of entity collections — nothing
 *    derives a collection name from data — and `export-secrets.test.ts` proves it
 *    by recording every collection the export path opens.
 *
 * WHAT A SESSION EXPORT CARRIES (`docs/04` §5: "完整存档"): its own row, the
 * EMBEDDED pinned world + character versions (`requirement: 'embedded'`, §4), the
 * message tree, `state.json`, every checkpoint, agenda and the memories that
 * belong to the session or to what it embeds. Rule packs are never embedded (§4) —
 * they travel as an `optional` ref.
 *
 * WHERE THE SESSION'S "CURRENT" STATE COMES FROM: `docs/02` §7 has no
 * `sessionStates` collection — the live state of a session is what its newest
 * checkpoint snapshotted, so `state.json` is derived from that checkpoint, and a
 * session with no checkpoint gets a synthesised initial state reported as a
 * warning (never silently).
 *
 * WHAT THIS FILE DOES NOT DO: it never touches the filesystem, the network or a
 * clock of its own. Identity and `createdAt` belong to the injected writer
 * (`PackageWriterFactoryOptions`), so passing a writer with a fixed clock is what
 * makes an export reproducible.
 */
import {
  COLLECTIONS,
  type CollectionName,
  type PackageWriteEntry,
  type PackageWriter,
  type StorageAdapter,
  type Tx,
} from '@smarttavern/core';
import {
  type AgendaEntry,
  type Character,
  type CharacterVersion,
  type Checkpoint,
  MANIFEST_DATA_FILES,
  type MemoryEntry,
  type Message,
  PACKAGE_COUNT_KEYS,
  type PackageGenerator,
  type PackageI18n,
  type PackageKind,
  type PackageLicense,
  type PackageManifest,
  type PackageRef,
  type PromptPreset,
  type Session,
  type SessionState,
  type World,
  type WorldbookEntry,
  type WorldVersion,
} from '@smarttavern/schema';
import {
  encodeAgenda,
  encodeCharacters,
  encodeCheckpoints,
  encodeMemories,
  encodeMessages,
  encodePromptPresets,
  encodeSession,
  encodeState,
  encodeWorldbooks,
  encodeWorlds,
  LICENSE_PATH,
  type PayloadFile,
  README_PATH,
  sortByAtMinuteThenId,
  sortByCreatedAtThenId,
  sortById,
  sortMessagesForPackage,
  textFile,
} from './payload';

/* ──────────────────────────────── errors ─────────────────────────────────── */

/** Raised when the library cannot supply what a package needs. Lists every reason. */
export class ExportError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(problems.length > 0 ? `${message}: ${problems.join('; ')}` : message);
    this.name = 'ExportError';
  }
}

/** Something the export could not do exactly as asked, but did not fail on. */
export type ExportWarningCode = 'state-synthesized' | 'prompt-preset-not-embedded';

export interface ExportWarning {
  readonly code: ExportWarningCode;
  readonly detail: string;
}

/* ─────────────────────────────── requests ────────────────────────────────── */

/** What every export needs, whatever the kind. */
export interface ExportRequestBase {
  readonly storage: StorageAdapter;
  readonly writer: PackageWriter;
  /** Pin the package's own id (re-exports, tests); the writer mints one otherwise. */
  readonly id?: PackageManifest['id'];
  /** Display name; defaults to the entity's own name. */
  readonly name?: string;
  readonly license?: PackageLicense;
  readonly generator?: PackageGenerator;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly i18n?: PackageI18n;
  /** Replaces the generated `LICENSE.txt` when the caller knows the terms. */
  readonly licenseText?: string;
}

export interface ExportWorldRequest extends ExportRequestBase {
  readonly kind: 'world';
  readonly worldId: string;
}

export interface ExportCharacterRequest extends ExportRequestBase {
  readonly kind: 'character';
  readonly characterId: string;
}

export interface ExportSessionRequest extends ExportRequestBase {
  readonly kind: 'session';
  readonly sessionId: string;
}

export type ExportRequest = ExportWorldRequest | ExportCharacterRequest | ExportSessionRequest;

export interface ExportResult {
  readonly kind: PackageKind;
  readonly bytes: Uint8Array;
  readonly manifest: PackageManifest;
  readonly warnings: readonly ExportWarning[];
}

/* ──────────────────────────── shared helpers ─────────────────────────────── */

/** One built package: everything but the container bytes. */
interface BuiltPackage {
  readonly kind: PackageKind;
  readonly name: string;
  readonly refs: readonly PackageRef[];
  readonly payloads: readonly PayloadFile[];
  readonly warnings: readonly ExportWarning[];
}

const TEXT = new TextDecoder('utf-8', { fatal: true });

function byKey(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** The head version row, or the highest version when the head pointer is stale. */
function pickVersion<T extends { version: number }>(
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

/** How many entities one payload file holds, for the human-readable README. */
function countPayload(payload: PayloadFile): number {
  if ((MANIFEST_DATA_FILES as Record<string, string | undefined>)[payload.path] === undefined)
    return 0;
  const text = TEXT.decode(payload.bytes);
  if (payload.path.endsWith('.jsonl')) {
    return text.split('\n').filter((line) => line.trim() !== '').length;
  }
  const parsed: unknown = text.trim() === '' ? [] : JSON.parse(text);
  return Array.isArray(parsed) ? parsed.length : 1;
}

/** The README `docs/04` §2 requires: a human-readable statement of what is inside. */
function readmeText(
  packageName: string,
  kind: PackageKind,
  payloads: readonly PayloadFile[],
): string {
  const lines: string[] = [packageName, '', `kind: ${kind}`, 'format: smarttavern.package v1', ''];
  lines.push('contents:');
  for (const key of PACKAGE_COUNT_KEYS) {
    const total = payloads.reduce((sum, payload) => sum + countPayload(payload), 0);
    if (total > 0) lines.push(`  ${key}: ${total}`);
  }
  lines.push('', 'See manifest.json for the licence, the entry checksums and the byte total.');
  return `${lines.join('\n')}\n`;
}

/** The `LICENSE.txt` §2 requires: a statement, because we cannot invent licence terms. */
function licenseText(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  return [
    'The world, character, session and asset content in this package is provided by',
    'the person who exported it; see manifest.json for the declared licence.',
    '',
    'No rule-pack text is embedded in this package: docs/04 §4 requires rule packs to',
    'travel as an `optional` reference so that no copyrighted rules are redistributed.',
    '',
    'This package contains no API keys, absolute paths or device identifiers',
    '(docs/04 §9 redaction rules).',
    '',
  ].join('\n');
}

/** Turn a built package into bytes through the injected writer. */
async function writePackage(
  request: ExportRequestBase,
  built: BuiltPackage,
): Promise<ExportResult> {
  const entries: PackageWriteEntry[] = [
    ...built.payloads.map((payload) => ({ path: payload.path, bytes: payload.bytes })),
    textFile(LICENSE_PATH, licenseText(request.licenseText)),
    textFile(README_PATH, readmeText(built.name, built.kind, built.payloads)),
  ];

  const result = await request.writer.write(entries, {
    kind: built.kind,
    name: built.name,
    ...(request.id === undefined ? {} : { id: request.id }),
    ...(request.license === undefined ? {} : { license: request.license }),
    ...(request.generator === undefined ? {} : { generator: request.generator }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.tags === undefined ? {} : { tags: [...request.tags] }),
    ...(request.i18n === undefined ? {} : { i18n: request.i18n }),
    refs: [...built.refs],
  });

  return {
    kind: built.kind,
    bytes: result.bytes,
    manifest: result.manifest,
    warnings: built.warnings,
  };
}

/** How a session's `state.json` is derived when the session has no checkpoint. */
function synthesisedState(session: Session): SessionState {
  return {
    scene: { title: session.title, location: '', time: session.initialClock },
    clock: session.initialClock,
    vars: {},
    sheets: {},
    deadlines: [],
  };
}

/** `refs[]` are sorted so two exports of the same content produce the same bytes. */
function sortedRefs(refs: readonly PackageRef[]): PackageRef[] {
  return [...refs].sort((left, right) =>
    byKey(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`),
  );
}

/* ──────────────────────────────── world ──────────────────────────────────── */

/** A `kind: 'world'` package: the head version, plus the world's worldbook entries. */
export async function exportWorldPackage(request: ExportWorldRequest): Promise<ExportResult> {
  const built = await request.storage.transaction(async (tx): Promise<BuiltPackage> => {
    const head = await tx.collection<World>(COLLECTIONS.worlds).get(request.worldId);
    if (head === undefined) {
      throw new ExportError(`no world ${request.worldId} in the library`);
    }

    const versions = await tx
      .collection<WorldVersion>(COLLECTIONS.worldVersions)
      .list({ where: { worldId: request.worldId } });
    const version = pickVersion(versions, head.headVersion, `world ${request.worldId}`);

    const worldbooks = await tx
      .collection<WorldbookEntry>(COLLECTIONS.worldbookEntries)
      .list({ where: { worldId: request.worldId } });

    const payloads: PayloadFile[] = [encodeWorlds([version])];
    if (worldbooks.length > 0) payloads.push(encodeWorldbooks(sortById(worldbooks)));

    return { kind: 'world', name: request.name ?? head.name, refs: [], payloads, warnings: [] };
  });

  return writePackage(request, built);
}

/* ────────────────────────────── character ────────────────────────────────── */

/** A `kind: 'character'` package: the head version of one card. */
export async function exportCharacterPackage(
  request: ExportCharacterRequest,
): Promise<ExportResult> {
  const built = await request.storage.transaction(async (tx): Promise<BuiltPackage> => {
    const head = await tx.collection<Character>(COLLECTIONS.characters).get(request.characterId);
    if (head === undefined) {
      throw new ExportError(`no character ${request.characterId} in the library`);
    }

    const versions = await tx
      .collection<CharacterVersion>(COLLECTIONS.characterVersions)
      .list({ where: { characterId: request.characterId } });
    const version = pickVersion(versions, head.headVersion, `character ${request.characterId}`);

    return {
      kind: 'character',
      name: request.name ?? head.name,
      refs: [],
      payloads: [encodeCharacters([version])],
      warnings: [],
    };
  });

  return writePackage(request, built);
}

/* ─────────────────────────────── session ─────────────────────────────────── */

/**
 * The world version the session pins. A pin that is not in the library is a hard
 * failure: §4 requires a session package to embed what it references, and an
 * export that quietly dropped the world would produce a package that cannot
 * reproduce the save.
 */
async function readPinnedWorld(
  tx: Tx,
  session: Session,
): Promise<{ version?: WorldVersion; problems: string[] }> {
  const { id, version } = session.refs.world;
  const rows = await tx
    .collection<WorldVersion>(COLLECTIONS.worldVersions)
    .list({ where: { worldId: id } });
  const found = rows.find((row) => row.version === version);
  return found === undefined
    ? { problems: [`world ${id} v${version} (pinned by the session) is not in the library`] }
    : { version: found, problems: [] };
}

/** Every character version the session pins, deduplicated by `(id, version)`. */
async function readPinnedCharacters(
  tx: Tx,
  session: Session,
): Promise<{ versions: CharacterVersion[]; problems: string[] }> {
  const pins = [session.refs.playerCharacter, ...session.refs.cast];
  const seen = new Set<string>();
  const versions: CharacterVersion[] = [];
  const problems: string[] = [];

  for (const pin of pins) {
    const key = `${pin.id}@${pin.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = await tx
      .collection<CharacterVersion>(COLLECTIONS.characterVersions)
      .list({ where: { characterId: pin.id } });
    const found = rows.find((row) => row.version === pin.version);
    if (found === undefined) {
      problems.push(
        `character ${pin.id} v${pin.version} (pinned by the session) is not in the library`,
      );
      continue;
    }
    versions.push(found);
  }

  return { versions, problems };
}

/**
 * A `kind: 'session'` package: the whole save — session, embedded world and
 * characters, messages, checkpoints, agenda, memories and the final state
 * (`docs/04` §5).
 */
export async function exportSessionPackage(request: ExportSessionRequest): Promise<ExportResult> {
  const built = await request.storage.transaction(async (tx): Promise<BuiltPackage> => {
    const session = await tx.collection<Session>(COLLECTIONS.sessions).get(request.sessionId);
    if (session === undefined) {
      throw new ExportError(`no session ${request.sessionId} in the library`);
    }

    const world = await readPinnedWorld(tx, session);
    const characters = await readPinnedCharacters(tx, session);
    if (world.version === undefined) {
      throw new ExportError(
        `session ${request.sessionId} references content that is missing from the library`,
        [...world.problems, ...characters.problems],
      );
    }
    if (characters.problems.length > 0) {
      throw new ExportError(
        `session ${request.sessionId} references content that is missing from the library`,
        characters.problems,
      );
    }

    const messages = await tx
      .collection<Message>(COLLECTIONS.messages)
      .list({ where: { sessionId: request.sessionId } });
    const checkpoints = await tx
      .collection<Checkpoint>(COLLECTIONS.checkpoints)
      .list({ where: { sessionId: request.sessionId } });
    const agenda = await tx
      .collection<AgendaEntry>(COLLECTIONS.agenda)
      .list({ where: { sessionId: request.sessionId } });
    /** No index reaches "the memories of this save", so this is an honest full scan. */
    const allMemories = await tx.collection<MemoryEntry>(COLLECTIONS.memories).list();
    const owners = new Set<string>([
      session.id,
      world.version.worldId,
      ...characters.versions.map((row) => row.characterId),
    ]);
    const memories = allMemories.filter((row) => owners.has(row.targetId));

    const payloads: PayloadFile[] = [
      encodeSession(session),
      encodeWorlds([world.version]),
      encodeCharacters(sortById(characters.versions)),
      encodeMessages(sortMessagesForPackage(messages)),
      encodeCheckpoints(sortByCreatedAtThenId(checkpoints)),
      encodeAgenda(sortByAtMinuteThenId(agenda)),
      encodeMemories(sortByAtMinuteThenId(memories)),
    ];

    const warnings: ExportWarning[] = [];
    const newest = sortByCreatedAtThenId(checkpoints).at(-1);
    if (newest === undefined) {
      warnings.push({
        code: 'state-synthesized',
        detail:
          'no checkpoint: state.json was synthesised from the session clock (docs/02 §7 has no sessionStates collection, so a checkpoint is what persists live state)',
      });
      payloads.push(encodeState(synthesisedState(session)));
    } else {
      payloads.push(encodeState(newest.state));
    }

    const refs: PackageRef[] = [
      {
        kind: 'world',
        id: world.version.worldId,
        version: world.version.version,
        requirement: 'embedded',
      },
      ...characters.versions.map(
        (row): PackageRef => ({
          kind: 'character',
          id: row.characterId,
          version: row.version,
          requirement: 'embedded',
        }),
      ),
    ];

    const preset = await tx
      .collection<PromptPreset>(COLLECTIONS.promptPresets)
      .get(session.refs.promptPreset.id);
    if (preset === undefined) {
      warnings.push({
        code: 'prompt-preset-not-embedded',
        detail: `prompt preset ${session.refs.promptPreset.id} is not in the library: the package carries an optional reference instead of the preset`,
      });
      refs.push({
        kind: 'prompt-preset',
        id: session.refs.promptPreset.id,
        version: session.refs.promptPreset.version,
        requirement: 'optional',
      });
    } else {
      payloads.push(encodePromptPresets([preset]));
      refs.push({
        kind: 'prompt-preset',
        id: preset.id,
        version: preset.version,
        requirement: 'embedded',
      });
    }

    if (session.refs.rulePack !== undefined) {
      // Never embedded: docs/04 §4 forbids shipping copyrighted rule text.
      refs.push({
        kind: 'rulepack',
        id: session.refs.rulePack.id,
        version: session.refs.rulePack.version,
        requirement: 'optional',
      });
    }

    return {
      kind: 'session',
      name: request.name ?? session.title,
      refs: sortedRefs(refs),
      payloads,
      warnings,
    };
  });

  return writePackage(request, built);
}

/* ────────────────────────────── dispatcher ───────────────────────────────── */

/** Export whichever kind `request` names. */
export async function exportPackage(request: ExportRequest): Promise<ExportResult> {
  switch (request.kind) {
    case 'world':
      return exportWorldPackage(request);
    case 'character':
      return exportCharacterPackage(request);
    case 'session':
      return exportSessionPackage(request);
  }
}

/**
 * The collections an export may open — the fixed list `docs/04` §12 item 11
 * depends on. `settings` and `providers` are absent on purpose: they hold API keys
 * and are not entities, so they are not exportable at all.
 */
export const EXPORTABLE_COLLECTIONS: readonly CollectionName[] = [
  COLLECTIONS.worlds,
  COLLECTIONS.worldVersions,
  COLLECTIONS.worldbookEntries,
  COLLECTIONS.characters,
  COLLECTIONS.characterVersions,
  COLLECTIONS.promptPresets,
  COLLECTIONS.sessions,
  COLLECTIONS.messages,
  COLLECTIONS.checkpoints,
  COLLECTIONS.agenda,
  COLLECTIONS.memories,
];
