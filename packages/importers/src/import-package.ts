/**
 * Import: `.stpack` bytes → rows in the local library, plus a REPORT a person can
 * act on (`docs/04` §7 steps 1–9, §12 items 8–12).
 *
 * THE REPORT IS THE FEATURE, NOT A LOG LINE. §7 step 9 requires "重映射了哪些 ID、
 * 跳过了什么、是否有降级", and §7's closing line makes it a principle: the report
 * "必须展示给用户", because an import must never overwrite anything silently. So the
 * result is a typed object — `ok`, the package's identity, the port's validation
 * findings, one record per entity (created / reused / remapped / skipped) and the
 * counts — that the CLI prints and the UI can render. Nothing here formats text.
 *
 * ATOMICITY IS STRUCTURAL, NOT DEFENSIVE. The port's only write entry point is
 * `StorageAdapter.transaction`, and a callback that throws rolls back. So the whole
 * import — reads, decisions, reference rewriting and every write — happens inside
 * ONE transaction: "as few transactions as the port allows" is exactly one, and no
 * code path can leave half a package behind. A validation failure returns a report
 * with `ok: false` and never opens the transaction at all; a storage failure
 * propagates (the caller reports it as I/O, which is what it is).
 *
 * THE IDENTITY POLICY lives in `./identity.ts`. In one line: identical content is
 * REUSED, an id (or name) taken by different content is REMAPPED to a new id with
 * `x-smarttavern.origin-id` recorded, and everything else is CREATED. Item 9 is
 * "the second import reuses everything", item 10 is the remap, item 12 is the
 * remap PLUS every reference in the session and its messages following it.
 *
 * WHAT THIS FILE REFUSES TO GUESS
 * - §7 step 6: a `required` reference that is missing locally stops the import and
 *   names what is missing. An `embedded` reference whose payload is absent is a
 *   broken package, not a degraded one.
 * - `data/state.json`: `docs/02` §7 has no `sessionStates` collection, so the live
 *   state of a session is what its newest CHECKPOINT holds (§6 derives
 *   `state.json` from it). A `state.json` no checkpoint agrees with is reported;
 *   and a package with no checkpoint at all cannot persist a clock, which is also
 *   reported. Both are warnings, because such a package is still importable — the
 *   honest answer is to say what could not be stored.
 * - Schema versions: payloads are validated with the CURRENT build's schemas, and
 *   a payload written by a newer schema is refused by the package validator before
 *   this code runs. `packages/schema/migrations` owns the migration table.
 * - Binary assets are out of M1-M3's scope: a package carries no `assets/*`, so a
 *   character's `visual.references[].assetId` may point at an asset that is not in
 *   the local library. Nothing here pretends otherwise.
 */
import {
  COLLECTIONS,
  type CollectionName,
  type PackageFinding,
  type PackageFindingCode,
  type PackageReader,
  type PackageReadResult,
  type PackageSource,
  type PackageValidationCoverage,
  type PackageValidator,
  type RowBase,
  type StorageAdapter,
  type Tx,
} from '@smarttavern/core';
import {
  type AgendaEntry,
  type Character,
  type CharacterVersion,
  type Checkpoint,
  type Extensions,
  type Id,
  type MemoryEntry,
  type Message,
  mintUuidV7,
  type PackageManifest,
  type PromptPreset,
  type Session,
  type SessionState,
  type UuidV7,
  type World,
  type WorldbookEntry,
  type WorldVersion,
} from '@smarttavern/schema';
import { deepEqual } from './deep-equal';
import {
  decideIdentity,
  type IdentityReason,
  type LocalIdentityRow,
  originIdOf,
  provenanceExtensions,
  stripImportExtensions,
} from './identity';
import {
  type DecodedPackage,
  decodePackage,
  type PayloadCategory,
  sortByAtMinuteThenId,
  sortByCreatedAtThenId,
  sortMessagesForPackage,
} from './payload';

/* ──────────────────────────────── the report ─────────────────────────────── */

export type ImportSeverity = 'error' | 'warning' | 'info';

/**
 * Every code this importer can emit. The port's `PackageFindingCode` values are
 * reused VERBATIM for anything a validator found (no translation layer to drift),
 * and the `import-*` / `payload-*` codes name the checks only an importer can run.
 */
export type ImportFindingCode =
  | PackageFindingCode
  | 'payload-schema'
  | 'import-missing-dependency'
  | 'import-reference-unresolved'
  | 'import-state-without-checkpoint'
  | 'import-state-mismatch';

export interface ImportFinding {
  readonly severity: ImportSeverity;
  readonly code: ImportFindingCode;
  /** The in-package file it is about, when it is about one. */
  readonly path?: string;
  /** A locator inside the target: a dotted field path, a JSONL line, a reference site. */
  readonly where?: string;
  readonly detail: string;
}

/** The entity classes an import report speaks about. */
export type ImportEntityKind =
  | 'world'
  | 'worldbook'
  | 'character'
  | 'promptPreset'
  | 'session'
  | 'message'
  | 'checkpoint'
  | 'agenda'
  | 'memory';

export type ImportAction = 'created' | 'reused' | 'remapped' | 'skipped';

/** Why an entity was remapped or skipped. Stable tokens, not sentences. */
export type ImportReason = IdentityReason | 'not-selected';

export interface ImportEntityReport {
  readonly entity: ImportEntityKind;
  /** The collection it landed in, so a caller can point at the row. */
  readonly collection: CollectionName;
  readonly action: ImportAction;
  /** The id the entity had INSIDE THE PACKAGE. */
  readonly packageId: string;
  /** The local id; absent only for `skipped`. */
  readonly id?: string;
  /** Set for `remapped`: the package id the new row was imported from. */
  readonly originId?: string;
  readonly version?: number;
  readonly name?: string;
  readonly reason?: ImportReason;
}

export interface ImportCounts {
  readonly created: number;
  readonly reused: number;
  readonly remapped: number;
  readonly skipped: number;
}

/** What the package said about itself, so a report can name it. */
export interface ImportPackageSummary {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly formatVersion: number;
}

export interface ImportReport {
  /** False when the package was refused; the findings say why. */
  readonly ok: boolean;
  readonly package?: ImportPackageSummary;
  readonly findings: readonly ImportFinding[];
  readonly entities: readonly ImportEntityReport[];
  readonly counts: ImportCounts;
  /** Present when a `PackageValidator` was injected. */
  readonly coverage?: PackageValidationCoverage;
}

/* ──────────────────────────────── the options ────────────────────────────── */

export interface ImportOptions {
  /**
   * How the bytes become a manifest plus payload bytes. INJECTED, because the only
   * real implementation is `@smarttavern/packages`' `createPackageReader` and this
   * package may not import it: `biome.json`'s adapter override and
   * `tools/scripts/check-dependency-direction.mjs` restrict `packages/importers` to
   * `packages/schema` + `packages/core`. The app and `tools/stpack-cli` do the
   * wiring; `docs/02` §6 says packaging is injected, and this is that seam.
   */
  readonly reader: PackageReader;
  /** Where the rows go. The importer never knows which database is behind it. */
  readonly storage: StorageAdapter;
  /** Optional second pass; its findings are merged and its coverage reported. */
  readonly validator?: PackageValidator;
  /**
   * What to import (§7 step 7: the user picks). A category set to `false` is
   * reported as skipped rather than silently dropped. Dependencies are NOT
   * auto-excluded — importing a session without its characters is allowed, and the
   * dangling references are reported.
   */
  readonly select?: Partial<Record<PayloadCategory, boolean>>;
  /** Clock for the default id minter. */
  readonly now?: () => Date;
  /** Identity source for remapped rows; must mint UUIDv7 (`docs/04` §4). */
  readonly mintId?: () => UuidV7;
}

/* ────────────────────────────── entry point ──────────────────────────────── */

/** Read a `.stpack` and write what is new into `storage`, returning the report. */
export async function importPackage(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportReport> {
  const now = options.now ?? (() => new Date());
  const mintId = options.mintId ?? (() => mintUuidV7(now));
  const source: PackageSource = { kind: 'bytes', bytes };
  const findings: ImportFinding[] = [];

  let read: PackageReadResult;
  try {
    read = await options.reader.read(source);
  } catch (cause) {
    findings.push({
      severity: 'error',
      code: 'zip-corrupt',
      detail: `cannot read the package: ${messageOf(cause)}`,
    });
    return refused(findings);
  }
  findings.push(...read.findings.map(portFinding));

  let coverage: PackageValidationCoverage | undefined;
  if (options.validator !== undefined) {
    const validated = await options.validator.validate(source);
    findings.push(...validated.findings.map(portFinding));
    coverage = validated.coverage;
  }

  const manifest = read.manifest;
  if (hasErrors(findings)) return refused(findings, manifest, coverage);

  const decoded = decodePackage(read.entries);
  for (const problem of decoded.problems) {
    findings.push({
      severity: 'error',
      code: 'payload-schema',
      path: problem.path,
      ...(problem.where === undefined ? {} : { where: problem.where }),
      detail: problem.detail,
    });
  }
  if (hasErrors(findings)) return refused(findings, manifest, coverage);

  const outcome = await options.storage.transaction((tx) =>
    commit(tx, { decoded, manifest, mintId, select: options.select ?? {} }),
  );
  findings.push(...outcome.findings);

  return {
    ok: !hasErrors(findings),
    package: {
      id: manifest.id,
      kind: manifest.kind,
      name: manifest.name,
      formatVersion: manifest.formatVersion,
    },
    findings,
    entities: outcome.entities,
    counts: countActions(outcome.entities),
    ...(coverage === undefined ? {} : { coverage }),
  };
}

/* ──────────────────────────── small helpers ──────────────────────────────── */

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function hasErrors(findings: readonly ImportFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

/** The port's finding, unchanged: one vocabulary, no translation to drift. */
function portFinding(finding: PackageFinding): ImportFinding {
  return {
    severity: finding.severity,
    code: finding.code,
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.where === undefined ? {} : { where: finding.where }),
    detail: finding.detail,
  };
}

const NO_COUNTS: ImportCounts = { created: 0, reused: 0, remapped: 0, skipped: 0 };

function countActions(entities: readonly ImportEntityReport[]): ImportCounts {
  const counts = { ...NO_COUNTS };
  for (const entity of entities) counts[entity.action] += 1;
  return counts;
}

function refused(
  findings: readonly ImportFinding[],
  manifest?: PackageManifest,
  coverage?: PackageValidationCoverage,
): ImportReport {
  return {
    ok: false,
    ...(manifest === undefined
      ? {}
      : {
          package: {
            id: manifest.id,
            kind: manifest.kind,
            name: manifest.name,
            formatVersion: manifest.formatVersion,
          },
        }),
    findings,
    entities: [],
    counts: NO_COUNTS,
    ...(coverage === undefined ? {} : { coverage }),
  };
}

/* ────────────────────────── the local snapshot ───────────────────────────── */

/**
 * The local rows this import may rewrite, read once inside the transaction.
 *
 * FULL SCANS ON PURPOSE: the port's `list()` without an index is an honest full
 * scan (its own comment says so), an import is not a hot path, and deciding
 * identity against a partial read would be deciding against a stale library.
 * `settings` and `providers` are absent — they are not entities (§12 item 11).
 */
interface LocalState {
  readonly worlds: World[];
  readonly worldVersions: WorldVersion[];
  readonly worldbooks: WorldbookEntry[];
  readonly characters: Character[];
  readonly characterVersions: CharacterVersion[];
  readonly promptPresets: PromptPreset[];
  readonly rulePacks: { id: Id }[];
  readonly sessions: Session[];
  readonly messages: Message[];
  readonly checkpoints: Checkpoint[];
  readonly agenda: AgendaEntry[];
  readonly memories: MemoryEntry[];
}

async function loadLocalState(tx: Tx): Promise<LocalState> {
  return {
    worlds: await tx.collection<World>(COLLECTIONS.worlds).list(),
    worldVersions: await tx.collection<WorldVersion>(COLLECTIONS.worldVersions).list(),
    worldbooks: await tx.collection<WorldbookEntry>(COLLECTIONS.worldbookEntries).list(),
    characters: await tx.collection<Character>(COLLECTIONS.characters).list(),
    characterVersions: await tx.collection<CharacterVersion>(COLLECTIONS.characterVersions).list(),
    promptPresets: await tx.collection<PromptPreset>(COLLECTIONS.promptPresets).list(),
    rulePacks: await tx.collection<{ id: Id }>(COLLECTIONS.rulePacks).list(),
    sessions: await tx.collection<Session>(COLLECTIONS.sessions).list(),
    messages: await tx.collection<Message>(COLLECTIONS.messages).list(),
    checkpoints: await tx.collection<Checkpoint>(COLLECTIONS.checkpoints).list(),
    agenda: await tx.collection<AgendaEntry>(COLLECTIONS.agenda).list(),
    memories: await tx.collection<MemoryEntry>(COLLECTIONS.memories).list(),
  };
}

/* ─────────────────────── identity rows (what reuse sees) ─────────────────── */

/** The comparable content of one immutable version row: its identity is `(version, data)`. */
function versionFingerprint(row: { readonly version: number; readonly data: unknown }): unknown {
  return { version: row.version, data: row.data };
}

/**
 * One identity row per local world version, each carrying the OWNER id — the id a
 * reuse would point at. A world contributes one row per version, so "is this
 * content already here?" is answered against the whole history, not only the head.
 */
function worldIdentityRows(state: LocalState): LocalIdentityRow[] {
  return state.worldVersions.map((version) => ({
    id: version.worldId,
    ...(originIdOf(version) === undefined ? {} : { originId: originIdOf(version) }),
    name: version.data.name,
    content: versionFingerprint(version),
  }));
}

function characterIdentityRows(state: LocalState): LocalIdentityRow[] {
  return state.characterVersions.map((version) => ({
    id: version.characterId,
    ...(originIdOf(version) === undefined ? {} : { originId: originIdOf(version) }),
    name: version.data.name,
    content: versionFingerprint(version),
  }));
}

/** A flat row's whole content, minus the provenance this importer itself added. */
function flatIdentityRows(
  rows: readonly { id: string; extensions?: Extensions }[],
): LocalIdentityRow[] {
  return rows.map((row) => ({
    id: row.id,
    ...(originIdOf(row) === undefined ? {} : { originId: originIdOf(row) }),
    content: stripImportExtensions(row),
  }));
}

/* ─────────────────────────── derived head rows ───────────────────────────── */

/**
 * The head row a versioned entity needs. `docs/04` §2 carries `WorldVersion[]` /
 * `CharacterVersion[]` and NO head row, so the head is DERIVED — and deriving it
 * from the payload is what keeps the import from inventing anything: name and tags
 * come from the payload, both timestamps from the version row, so two imports of
 * the same package derive the same head.
 */
function worldHead(version: WorldVersion, ownerId: UuidV7, provenance?: [string, string]): World {
  return {
    id: ownerId,
    name: version.data.name,
    headVersion: version.version,
    tags: [...version.data.genre],
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    ...(provenance === undefined
      ? {}
      : { extensions: provenanceExtensions(version.extensions, provenance[0], provenance[1]) }),
  };
}

function characterHead(
  version: CharacterVersion,
  ownerId: UuidV7,
  provenance?: [string, string],
): Character {
  return {
    id: ownerId,
    name: version.data.name,
    headVersion: version.version,
    tags: [...version.data.tags],
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    ...(provenance === undefined
      ? {}
      : { extensions: provenanceExtensions(version.extensions, provenance[0], provenance[1]) }),
  };
}

/* ──────────────────────────── the transaction ────────────────────────────── */

interface CommitInput {
  readonly decoded: DecodedPackage;
  readonly manifest: PackageManifest;
  readonly mintId: () => UuidV7;
  readonly select: Partial<Record<PayloadCategory, boolean>>;
}

interface CommitOutcome {
  readonly entities: ImportEntityReport[];
  readonly findings: ImportFinding[];
}

/** Everything the import does to the library — one transaction, one atomic unit. */
async function commit(tx: Tx, input: CommitInput): Promise<CommitOutcome> {
  const findings: ImportFinding[] = [];
  const entities: ImportEntityReport[] = [];
  const packageId = input.manifest.id;

  // §7 step 6 runs FIRST: a refusal must not have written anything.
  const dependencyProblems = await checkReferences(tx, input);
  if (dependencyProblems.length > 0) return { entities, findings: dependencyProblems };

  const state = await loadLocalState(tx);
  const select = (category: PayloadCategory): boolean => input.select[category] !== false;

  /** Collection name → rows to write, filled in as entities are decided. */
  const writes = new Map<CollectionName, RowBase[]>();
  const queue = (collection: CollectionName, row: RowBase): void => {
    const rows = writes.get(collection);
    if (rows === undefined) writes.set(collection, [row]);
    else rows.push(row);
  };

  /* ── worlds and characters: the entities everything else references ─────── */

  const worldRows = worldIdentityRows(state);
  const worldRemap = new Map<string, string>();
  for (const version of sortVersions(input.decoded.worlds, (row) => row.worldId)) {
    if (!select('worlds')) {
      entities.push(
        skipped('world', COLLECTIONS.worlds, version.worldId, version.data.name, version.version),
      );
      continue;
    }

    const decision = decideIdentity(
      { packageId: version.worldId, name: version.data.name, content: versionFingerprint(version) },
      worldRows,
    );

    if (decision.action === 'reuse') {
      worldRemap.set(version.worldId, decision.id);
      entities.push(
        reused(
          'world',
          COLLECTIONS.worlds,
          version.worldId,
          decision.id,
          decision.reason,
          version.version,
          version.data.name,
        ),
      );
      continue;
    }

    const localId = decision.action === 'create' ? version.worldId : input.mintId();
    const row: WorldVersion =
      decision.action === 'create'
        ? version
        : {
            ...version,
            id: input.mintId(),
            worldId: localId,
            extensions: provenanceExtensions(version.extensions, version.worldId, packageId),
          };
    queue(COLLECTIONS.worldVersions, row);
    if (!state.worlds.some((head) => head.id === localId)) {
      queue(
        COLLECTIONS.worlds,
        worldHead(
          row,
          localId,
          decision.action === 'remap' ? [version.worldId, packageId] : undefined,
        ),
      );
    }
    worldRows.push({
      id: localId,
      ...(originIdOf(row) === undefined ? {} : { originId: originIdOf(row) }),
      name: row.data.name,
      content: versionFingerprint(row),
    });
    worldRemap.set(version.worldId, localId);
    entities.push(
      decided(
        decision.action,
        'world',
        COLLECTIONS.worlds,
        version.worldId,
        localId,
        decision.reason,
        version.version,
        version.data.name,
      ),
    );
  }

  const characterRows = characterIdentityRows(state);
  const characterRemap = new Map<string, string>();
  for (const version of sortVersions(input.decoded.characters, (row) => row.characterId)) {
    if (!select('characters')) {
      entities.push(
        skipped(
          'character',
          COLLECTIONS.characters,
          version.characterId,
          version.data.name,
          version.version,
        ),
      );
      continue;
    }

    const decision = decideIdentity(
      {
        packageId: version.characterId,
        name: version.data.name,
        content: versionFingerprint(version),
      },
      characterRows,
    );

    if (decision.action === 'reuse') {
      characterRemap.set(version.characterId, decision.id);
      entities.push(
        reused(
          'character',
          COLLECTIONS.characters,
          version.characterId,
          decision.id,
          decision.reason,
          version.version,
          version.data.name,
        ),
      );
      continue;
    }

    const localId = decision.action === 'create' ? version.characterId : input.mintId();
    const row: CharacterVersion =
      decision.action === 'create'
        ? version
        : {
            ...version,
            id: input.mintId(),
            characterId: localId,
            extensions: provenanceExtensions(version.extensions, version.characterId, packageId),
          };
    queue(COLLECTIONS.characterVersions, row);
    if (!state.characters.some((head) => head.id === localId)) {
      queue(
        COLLECTIONS.characters,
        characterHead(
          row,
          localId,
          decision.action === 'remap' ? [version.characterId, packageId] : undefined,
        ),
      );
    }
    characterRows.push({
      id: localId,
      ...(originIdOf(row) === undefined ? {} : { originId: originIdOf(row) }),
      name: row.data.name,
      content: versionFingerprint(row),
    });
    characterRemap.set(version.characterId, localId);
    entities.push(
      decided(
        decision.action,
        'character',
        COLLECTIONS.characters,
        version.characterId,
        localId,
        decision.reason,
        version.version,
        version.data.name,
      ),
    );
  }

  /* ── flat rows: presets and worldbook entries reference the above ───────── */

  const presetOutcome = decideFlat<PromptPreset>({
    entity: 'promptPreset',
    collection: COLLECTIONS.promptPresets,
    incoming: [...input.decoded.promptPresets].sort(byId((row) => row.id)),
    identityRows: flatIdentityRows(state.promptPresets),
    selected: select('promptPresets'),
    packageId,
    mintId: input.mintId,
    rewrite: (row) => row,
    nameOf: (row) => row.name,
  });
  for (const row of presetOutcome.writes) queue(COLLECTIONS.promptPresets, row);
  entities.push(...presetOutcome.reports);

  const worldbookOutcome = decideFlat<WorldbookEntry>({
    entity: 'worldbook',
    collection: COLLECTIONS.worldbookEntries,
    incoming: [...input.decoded.worldbooks].sort(byId((row) => row.id)),
    identityRows: flatIdentityRows(state.worldbooks),
    selected: select('worldbooks'),
    packageId,
    mintId: input.mintId,
    rewrite: (row) => ({ ...row, worldId: rewire(row.worldId, worldRemap) }),
  });
  for (const row of worldbookOutcome.writes) queue(COLLECTIONS.worldbookEntries, row);
  entities.push(...worldbookOutcome.reports);

  /* ── the session, then the tree that hangs off it ───────────────────────── */

  const sessionOutcome = decideFlat<Session>({
    entity: 'session',
    collection: COLLECTIONS.sessions,
    incoming: input.decoded.session === undefined ? [] : [input.decoded.session],
    identityRows: flatIdentityRows(state.sessions),
    selected: select('session'),
    packageId,
    mintId: input.mintId,
    rewrite: (row) =>
      rewriteSession(row, {
        worldRemap,
        characterRemap,
        presetRemap: presetOutcome.remap,
      }),
  });
  for (const row of sessionOutcome.writes) queue(COLLECTIONS.sessions, row);
  entities.push(...sessionOutcome.reports);

  const messageOutcome = decideMessages({
    incoming: input.decoded.messages,
    state,
    selected: select('messages'),
    packageId,
    mintId: input.mintId,
    sessionRemap: sessionOutcome.remap,
    characterRemap,
  });
  for (const row of messageOutcome.writes) queue(COLLECTIONS.messages, row);
  entities.push(...messageOutcome.reports);

  /* ── agenda BEFORE checkpoints: a checkpoint may point at an agenda entry ── */

  const agendaOutcome = decideFlat<AgendaEntry>({
    entity: 'agenda',
    collection: COLLECTIONS.agenda,
    incoming: sortByAtMinuteThenId(input.decoded.agenda),
    identityRows: flatIdentityRows(state.agenda),
    selected: select('agenda'),
    packageId,
    mintId: input.mintId,
    rewrite: (row) => ({
      ...row,
      sessionId: rewire(row.sessionId, sessionOutcome.remap),
      actors: row.actors.map((actor) => rewire(actor, characterRemap)),
      ...(row.resultingMessageId === undefined
        ? {}
        : { resultingMessageId: rewire(row.resultingMessageId, messageOutcome.remap) }),
    }),
  });
  for (const row of agendaOutcome.writes) queue(COLLECTIONS.agenda, row);
  entities.push(...agendaOutcome.reports);

  const checkpointOutcome = decideFlat<Checkpoint>({
    entity: 'checkpoint',
    collection: COLLECTIONS.checkpoints,
    incoming: sortByCreatedAtThenId(input.decoded.checkpoints),
    identityRows: flatIdentityRows(state.checkpoints),
    selected: select('checkpoints'),
    packageId,
    mintId: input.mintId,
    rewrite: (row) =>
      rewriteCheckpoint(row, {
        sessionRemap: sessionOutcome.remap,
        messageRemap: messageOutcome.remap,
        characterRemap,
        agendaRemap: agendaOutcome.remap,
      }),
  });
  for (const row of checkpointOutcome.writes) queue(COLLECTIONS.checkpoints, row);
  entities.push(...checkpointOutcome.reports);

  const memoryOutcome = decideFlat<MemoryEntry>({
    entity: 'memory',
    collection: COLLECTIONS.memories,
    incoming: sortByAtMinuteThenId(input.decoded.memories),
    identityRows: flatIdentityRows(state.memories),
    selected: select('memories'),
    packageId,
    mintId: input.mintId,
    rewrite: (row) =>
      rewriteMemory(row, {
        worldRemap,
        characterRemap,
        sessionRemap: sessionOutcome.remap,
        messageRemap: messageOutcome.remap,
      }),
  });
  for (const row of memoryOutcome.writes) queue(COLLECTIONS.memories, row);
  entities.push(...memoryOutcome.reports);

  /* ── reference consistency: every target an imported row points at ───────── */

  const known = knownIds(state);
  for (const entity of entities) {
    const key = KNOWN_KEY[entity.entity];
    if (key !== undefined && entity.id !== undefined) known[key].add(entity.id);
  }

  const seenWarnings = new Set<string>();
  const note = (
    kind: keyof KnownIds,
    id: string | null | undefined,
    path: string,
    where: string,
  ): void => {
    if (id === null || id === undefined || id === '') return;
    if (known[kind].has(id)) return;
    const key = `${kind}:${id}:${path}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    findings.push({
      severity: 'warning',
      code: 'import-reference-unresolved',
      path,
      where,
      detail: `${where} points at ${kind} ${id}, which is neither in the package nor in the local library`,
    });
  };

  for (const row of messageOutcome.writes) {
    note('session', row.sessionId, 'data/messages.jsonl', `message ${row.id}.sessionId`);
    note('character', row.speakerId, 'data/messages.jsonl', `message ${row.id}.speakerId`);
    note('message', row.parentId, 'data/messages.jsonl', `message ${row.id}.parentId`);
  }
  for (const row of checkpointOutcome.writes) {
    note('session', row.sessionId, 'data/checkpoints.json', `checkpoint ${row.id}.sessionId`);
    note('message', row.messageId, 'data/checkpoints.json', `checkpoint ${row.id}.messageId`);
    for (const id of Object.keys(row.castState)) {
      note('character', id, 'data/checkpoints.json', `checkpoint ${row.id}.castState`);
    }
    for (const entry of row.agendaStatus) {
      note('agenda', entry.id, 'data/checkpoints.json', `checkpoint ${row.id}.agendaStatus`);
    }
  }
  for (const row of agendaOutcome.writes) {
    note('session', row.sessionId, 'data/agenda.json', `agenda ${row.id}.sessionId`);
    for (const actor of row.actors) {
      note('character', actor, 'data/agenda.json', `agenda ${row.id}.actors`);
    }
  }
  for (const row of memoryOutcome.writes) {
    note(
      memoryScopeKey(row.scope),
      row.targetId,
      'data/memories.json',
      `memory ${row.id}.targetId`,
    );
    note('message', row.sourceMessageId, 'data/memories.json', `memory ${row.id}.sourceMessageId`);
  }
  for (const row of sessionOutcome.writes) {
    note('world', row.refs.world.id, 'data/session.json', 'session.refs.world');
    note(
      'character',
      row.refs.playerCharacter.id,
      'data/session.json',
      'session.refs.playerCharacter',
    );
    for (const pin of row.refs.cast) {
      note('character', pin.id, 'data/session.json', 'session.refs.cast');
    }
    note(
      'promptPreset',
      row.refs.promptPreset.id,
      'data/session.json',
      'session.refs.promptPreset',
    );
    if (row.refs.rulePack !== undefined) {
      note('rulePack', row.refs.rulePack.id, 'data/session.json', 'session.refs.rulePack');
    }
  }

  /* ── state.json: §6 says it mirrors the newest checkpoint ───────────────── */

  if (input.decoded.state !== undefined) {
    const newest = sortByCreatedAtThenId(input.decoded.checkpoints).at(-1);
    if (newest === undefined) {
      findings.push({
        severity: 'warning',
        code: 'import-state-without-checkpoint',
        path: 'data/state.json',
        detail:
          'the package has state.json but no checkpoint: docs/02 §7 has no sessionStates collection, so live state is only stored inside a checkpoint and this state cannot be persisted',
      });
    } else {
      const written = checkpointOutcome.writes.find((row) => row.id === newest.id) ?? newest;
      const actual = rewriteState(input.decoded.state, {
        characterRemap,
        agendaRemap: agendaOutcome.remap,
      });
      if (!deepEqual(stripImportExtensions(written.state), actual)) {
        findings.push({
          severity: 'warning',
          code: 'import-state-mismatch',
          path: 'data/state.json',
          detail:
            'state.json disagrees with the newest checkpoint; the checkpoint wins (docs/04 §6: a checkpoint carries the full state snapshot)',
        });
      }
    }
  }

  /* ── write, in a fixed collection order, inside the same transaction ─────── */

  for (const collection of WRITABLE_COLLECTIONS) {
    const rows = writes.get(collection);
    if (rows === undefined || rows.length === 0) continue;
    await tx.collection<RowBase>(collection).putMany(rows);
  }

  return { entities, findings };
}

/** The collections an import may write, in a fixed order. `settings` is not one. */
const WRITABLE_COLLECTIONS: readonly CollectionName[] = [
  COLLECTIONS.worlds,
  COLLECTIONS.worldVersions,
  COLLECTIONS.worldbookEntries,
  COLLECTIONS.characters,
  COLLECTIONS.characterVersions,
  COLLECTIONS.promptPresets,
  COLLECTIONS.sessions,
  COLLECTIONS.messages,
  COLLECTIONS.agenda,
  COLLECTIONS.checkpoints,
  COLLECTIONS.memories,
];

/** A total order over version rows: owner id, then version. */
function sortVersions<T extends { version: number }>(
  rows: readonly T[],
  ownerOf: (row: T) => string,
): T[] {
  return [...rows].sort((left, right) => {
    const owner = ownerOf(left) < ownerOf(right) ? -1 : ownerOf(left) > ownerOf(right) ? 1 : 0;
    return owner !== 0 ? owner : left.version - right.version;
  });
}

/** Sort by one string key, ascending — for payloads with no time dimension. */
function byId<T>(keyOf: (row: T) => string): (left: T, right: T) => number {
  return (left, right) => {
    const leftKey = keyOf(left);
    const rightKey = keyOf(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  };
}

/* ─────────────────────── reference rewriting (item 12) ───────────────────── */

/** The local id a package id maps to now; unchanged when nothing was remapped. */
function rewire(id: string, map: ReadonlyMap<string, string>): string {
  return map.get(id) ?? id;
}

function rewirePin<T extends { id: string; version: number }>(
  pin: T,
  map: ReadonlyMap<string, string>,
): T {
  const mapped = map.get(pin.id);
  return mapped === undefined || mapped === pin.id ? pin : { ...pin, id: mapped };
}

/** `docs/04` §12 item 12: a session's refs follow the entities they were remapped to. */
function rewriteSession(
  session: Session,
  maps: {
    readonly worldRemap: ReadonlyMap<string, string>;
    readonly characterRemap: ReadonlyMap<string, string>;
    readonly presetRemap: ReadonlyMap<string, string>;
  },
): Session {
  return {
    ...session,
    refs: {
      ...session.refs,
      world: rewirePin(session.refs.world, maps.worldRemap),
      playerCharacter: rewirePin(session.refs.playerCharacter, maps.characterRemap),
      cast: session.refs.cast.map((pin) => rewirePin(pin, maps.characterRemap)),
      promptPreset: rewirePin(session.refs.promptPreset, maps.presetRemap),
    },
  };
}

interface StateMaps {
  readonly characterRemap: ReadonlyMap<string, string>;
  readonly agendaRemap: ReadonlyMap<string, string>;
}

/** Rename the keys of an id-keyed record; collisions resolve first-wins. */
function rekey<T>(record: Record<string, T>, map: ReadonlyMap<string, string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    out[rewire(key, map)] = value;
  }
  return out;
}

/**
 * The mutable state a checkpoint snapshots. `sheets` is keyed by actor id and
 * `deadlines[].targetId` may name a character or an agenda entry, so both follow
 * their remaps — a clock that survives an import while the cast keys do not would
 * be a half-restored save.
 */
function rewriteState(state: SessionState, maps: StateMaps): SessionState {
  return {
    ...state,
    sheets: rekey(state.sheets, maps.characterRemap),
    deadlines: state.deadlines.map((deadline) => {
      if (deadline.targetId === undefined) return deadline;
      // A countdown may be "about" a character or an agenda entry, so the agenda
      // remap wins when it has an answer and the character remap is the fallback.
      const mapped = maps.agendaRemap.get(deadline.targetId);
      return {
        ...deadline,
        targetId: mapped ?? rewire(deadline.targetId, maps.characterRemap),
      };
    }),
  };
}

interface CheckpointMaps extends StateMaps {
  readonly sessionRemap: ReadonlyMap<string, string>;
  readonly messageRemap: ReadonlyMap<string, string>;
}

function rewriteCheckpoint(checkpoint: Checkpoint, maps: CheckpointMaps): Checkpoint {
  return {
    ...checkpoint,
    sessionId: rewire(checkpoint.sessionId, maps.sessionRemap),
    messageId: rewire(checkpoint.messageId, maps.messageRemap),
    state: rewriteState(checkpoint.state, maps),
    agendaStatus: checkpoint.agendaStatus.map((entry) => ({
      ...entry,
      id: rewire(entry.id, maps.agendaRemap),
    })),
    castState: rekey(checkpoint.castState, maps.characterRemap),
  };
}

function rewriteMemory(
  memory: MemoryEntry,
  maps: {
    readonly worldRemap: ReadonlyMap<string, string>;
    readonly characterRemap: ReadonlyMap<string, string>;
    readonly sessionRemap: ReadonlyMap<string, string>;
    readonly messageRemap: ReadonlyMap<string, string>;
  },
): MemoryEntry {
  const targetMap =
    memory.scope === 'character'
      ? maps.characterRemap
      : memory.scope === 'world'
        ? maps.worldRemap
        : memory.scope === 'session'
          ? maps.sessionRemap
          : // `scope: 'user'` names no entity, so there is nothing to remap.
            undefined;
  return {
    ...memory,
    targetId: targetMap === undefined ? memory.targetId : rewire(memory.targetId, targetMap),
    ...(memory.sourceMessageId === undefined
      ? {}
      : { sourceMessageId: rewire(memory.sourceMessageId, maps.messageRemap) }),
  };
}

/* ──────────────────────── flat entities: one decision each ───────────────── */

/** The local id sets a reference check consults. */
interface KnownIds {
  readonly world: Set<string>;
  readonly character: Set<string>;
  readonly promptPreset: Set<string>;
  readonly session: Set<string>;
  readonly message: Set<string>;
  readonly agenda: Set<string>;
  readonly rulePack: Set<string>;
}

/** Which report kind lands in which id set (entities with no set are not referenced). */
const KNOWN_KEY: Partial<Record<ImportEntityKind, keyof KnownIds>> = {
  world: 'world',
  character: 'character',
  promptPreset: 'promptPreset',
  session: 'session',
  message: 'message',
  agenda: 'agenda',
};

function knownIds(state: LocalState): KnownIds {
  return {
    world: new Set(state.worlds.map((row) => row.id)),
    character: new Set(state.characters.map((row) => row.id)),
    promptPreset: new Set(state.promptPresets.map((row) => row.id)),
    session: new Set(state.sessions.map((row) => row.id)),
    message: new Set(state.messages.map((row) => row.id)),
    agenda: new Set(state.agenda.map((row) => row.id)),
    rulePack: new Set(state.rulePacks.map((row) => row.id)),
  };
}

function memoryScopeKey(scope: string): keyof KnownIds {
  if (scope === 'character') return 'character';
  if (scope === 'world') return 'world';
  return 'session';
}

function skipped(
  entity: ImportEntityKind,
  collection: CollectionName,
  packageId: string,
  name?: string,
  version?: number,
): ImportEntityReport {
  return {
    entity,
    collection,
    action: 'skipped',
    packageId,
    reason: 'not-selected',
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
  };
}

function reused(
  entity: ImportEntityKind,
  collection: CollectionName,
  packageId: string,
  id: string,
  reason: IdentityReason,
  version?: number,
  name?: string,
): ImportEntityReport {
  return {
    entity,
    collection,
    action: 'reused',
    packageId,
    id,
    reason,
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
  };
}

function decided(
  action: 'create' | 'remap',
  entity: ImportEntityKind,
  collection: CollectionName,
  packageId: string,
  id: string,
  reason: IdentityReason,
  version?: number,
  name?: string,
): ImportEntityReport {
  return {
    entity,
    collection,
    action: action === 'create' ? 'created' : 'remapped',
    packageId,
    id,
    reason,
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    ...(action === 'remap' ? { originId: packageId } : {}),
  };
}

interface FlatSpec<TRow extends { id: string; extensions?: Extensions }> {
  readonly entity: ImportEntityKind;
  readonly collection: CollectionName;
  readonly incoming: readonly TRow[];
  readonly identityRows: LocalIdentityRow[];
  readonly selected: boolean;
  readonly packageId: string;
  readonly mintId: () => UuidV7;
  /** Apply the remap table to the row's references BEFORE it is compared or written. */
  readonly rewrite: (row: TRow) => TRow;
  readonly nameOf?: (row: TRow) => string;
}

interface FlatOutcome<TRow> {
  readonly writes: TRow[];
  readonly reports: ImportEntityReport[];
  readonly remap: Map<string, string>;
}

/**
 * Decide every row of one flat entity class against the local library.
 *
 * The incoming row is REWRITTEN FIRST: a reference that was remapped changes the
 * row's content, and deciding identity on the un-rewritten row would call a
 * re-import "different content" and duplicate the whole package on the second run
 * (item 9).
 */
function decideFlat<TRow extends { id: string; extensions?: Extensions }>(
  spec: FlatSpec<TRow>,
): FlatOutcome<TRow> {
  const writes: TRow[] = [];
  const reports: ImportEntityReport[] = [];
  const remap = new Map<string, string>();

  for (const incoming of spec.incoming) {
    const name = spec.nameOf?.(incoming);
    if (!spec.selected) {
      reports.push(skipped(spec.entity, spec.collection, incoming.id, name));
      continue;
    }

    const rewritten = spec.rewrite(incoming);
    const decision = decideIdentity(
      {
        packageId: rewritten.id,
        ...(name === undefined ? {} : { name }),
        content: stripImportExtensions(rewritten),
      },
      spec.identityRows,
    );

    if (decision.action === 'reuse') {
      remap.set(incoming.id, decision.id);
      spec.identityRows.push({ id: decision.id, content: stripImportExtensions(rewritten) });
      reports.push(
        reused(
          spec.entity,
          spec.collection,
          incoming.id,
          decision.id,
          decision.reason,
          undefined,
          name,
        ),
      );
      continue;
    }

    if (decision.action === 'remap') {
      const localId = spec.mintId();
      const row: TRow = {
        ...rewritten,
        id: localId,
        extensions: provenanceExtensions(rewritten.extensions, incoming.id, spec.packageId),
      };
      writes.push(row);
      remap.set(incoming.id, localId);
      spec.identityRows.push({
        id: localId,
        originId: incoming.id,
        content: stripImportExtensions(row),
      });
      reports.push(
        decided(
          'remap',
          spec.entity,
          spec.collection,
          incoming.id,
          localId,
          decision.reason,
          undefined,
          name,
        ),
      );
      continue;
    }

    writes.push(rewritten);
    remap.set(incoming.id, rewritten.id);
    spec.identityRows.push({ id: rewritten.id, content: stripImportExtensions(rewritten) });
    reports.push(
      decided(
        'create',
        spec.entity,
        spec.collection,
        incoming.id,
        rewritten.id,
        decision.reason,
        undefined,
        name,
      ),
    );
  }

  return { writes, reports, remap };
}

/* ─────────────────────────── messages: the tree ──────────────────────────── */

interface MessageSpec {
  readonly incoming: readonly Message[];
  readonly state: LocalState;
  readonly selected: boolean;
  readonly packageId: string;
  readonly mintId: () => UuidV7;
  readonly sessionRemap: ReadonlyMap<string, string>;
  readonly characterRemap: ReadonlyMap<string, string>;
}

/**
 * Decide the message tree.
 *
 * WHY THIS ONE IS NOT `decideFlat`: a message points at its parent, so a message
 * whose parent was just remapped must be COMPARED with the remapped `parentId` —
 * otherwise the children of a remapped message would be created again on every
 * import. Messages whose parent is still undecided are therefore deferred one pass,
 * like a topological sort; a cycle (which a tree should not contain) falls back to
 * "decide with what is known" instead of looping forever.
 */
function decideMessages(spec: MessageSpec): FlatOutcome<Message> {
  const writes: Message[] = [];
  const reports: ImportEntityReport[] = [];
  const remap = new Map<string, string>();
  const identityRows = flatIdentityRows(spec.state.messages);
  const packageIds = new Set(spec.incoming.map((message) => message.id));

  const decideOne = (incoming: Message): void => {
    if (!spec.selected) {
      reports.push(skipped('message', COLLECTIONS.messages, incoming.id));
      return;
    }

    const rewritten: Message = {
      ...incoming,
      sessionId: rewire(incoming.sessionId, spec.sessionRemap),
      ...(incoming.speakerId === undefined
        ? {}
        : { speakerId: rewire(incoming.speakerId, spec.characterRemap) }),
      parentId: incoming.parentId === null ? null : rewire(incoming.parentId, remap),
    };

    const decision = decideIdentity(
      { packageId: rewritten.id, content: stripImportExtensions(rewritten) },
      identityRows,
    );

    if (decision.action === 'reuse') {
      remap.set(incoming.id, decision.id);
      identityRows.push({ id: decision.id, content: stripImportExtensions(rewritten) });
      reports.push(
        reused('message', COLLECTIONS.messages, incoming.id, decision.id, decision.reason),
      );
      return;
    }

    if (decision.action === 'remap') {
      const localId = spec.mintId();
      const row: Message = {
        ...rewritten,
        id: localId,
        extensions: provenanceExtensions(rewritten.extensions, incoming.id, spec.packageId),
      };
      writes.push(row);
      remap.set(incoming.id, localId);
      identityRows.push({
        id: localId,
        originId: incoming.id,
        content: stripImportExtensions(row),
      });
      reports.push(
        decided('remap', 'message', COLLECTIONS.messages, incoming.id, localId, decision.reason),
      );
      return;
    }

    writes.push(rewritten);
    remap.set(incoming.id, rewritten.id);
    identityRows.push({ id: rewritten.id, content: stripImportExtensions(rewritten) });
    reports.push(
      decided(
        'create',
        'message',
        COLLECTIONS.messages,
        incoming.id,
        rewritten.id,
        decision.reason,
      ),
    );
  };

  let pending = sortMessagesForPackage(spec.incoming);
  while (pending.length > 0) {
    const blocked: Message[] = [];
    let progressed = false;
    for (const message of pending) {
      const parent = message.parentId;
      if (spec.selected && parent !== null && packageIds.has(parent) && !remap.has(parent)) {
        blocked.push(message);
        continue;
      }
      decideOne(message);
      progressed = true;
    }
    if (!progressed) {
      for (const message of blocked) decideOne(message);
      pending = [];
    } else {
      pending = blocked;
    }
  }

  return { writes, reports, remap };
}

/* ──────────────────────── dependency check (step 6) ──────────────────────── */

/** `refs[].kind` → the collection a local copy would live in. */
const REF_KIND_COLLECTION: Record<string, CollectionName | undefined> = {
  world: COLLECTIONS.worlds,
  character: COLLECTIONS.characters,
  rulepack: COLLECTIONS.rulePacks,
  'prompt-preset': COLLECTIONS.promptPresets,
  asset: COLLECTIONS.assets,
};

/** `refs[].kind` → the payload file that embeds it. */
const REF_KIND_CATEGORY: Record<string, PayloadCategory | undefined> = {
  world: 'worlds',
  character: 'characters',
  'prompt-preset': 'promptPresets',
};

const REF_KIND_PATH: Record<string, string> = {
  worlds: 'data/worlds.json',
  characters: 'data/characters.json',
  promptPresets: 'data/promptPresets.json',
};

/** Ids a package payload embeds, by entity kind — used by the `embedded` check. */
function embeddedIds(decoded: DecodedPackage): Set<string> {
  return new Set<string>([
    ...decoded.worlds.map((row) => row.worldId),
    ...decoded.characters.map((row) => row.characterId),
    ...decoded.promptPresets.map((row) => row.id),
  ]);
}

/**
 * `docs/04` §7 step 6: a `required` reference that is not here stops the import and
 * says what is missing; an `embedded` reference the package does not actually carry
 * is a broken package. Deliberately run BEFORE anything is written, so a refusal
 * cannot leave a partial import behind.
 */
async function checkReferences(tx: Tx, input: CommitInput): Promise<ImportFinding[]> {
  const findings: ImportFinding[] = [];
  const embedded = embeddedIds(input.decoded);

  for (const ref of input.manifest.refs ?? []) {
    if (ref.requirement === 'required') {
      const collection = REF_KIND_COLLECTION[ref.kind];
      const present =
        collection !== undefined && (await tx.collection(collection).get(ref.id)) !== undefined;
      if (!present) {
        findings.push({
          severity: 'error',
          code: 'import-missing-dependency',
          where: `refs[${ref.kind}:${ref.id}]`,
          detail: `the package requires ${ref.kind} ${ref.id}${
            ref.version === undefined ? '' : ` v${ref.version}`
          }, which is not in the local library`,
        });
      }
      continue;
    }
    if (ref.requirement !== 'embedded') continue;
    const category = REF_KIND_CATEGORY[ref.kind];
    if (category === undefined) continue;
    if (!input.decoded.present.has(category) || !embedded.has(ref.id)) {
      const path = REF_KIND_PATH[category] ?? category;
      findings.push({
        severity: 'error',
        code: 'import-missing-dependency',
        path,
        where: `refs[${ref.kind}:${ref.id}]`,
        detail: `the package declares ${ref.kind} ${ref.id} as embedded, but ${path} does not carry it`,
      });
    }
  }
  return findings;
}
