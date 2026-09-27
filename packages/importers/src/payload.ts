/**
 * The `data/` payload layout of a `.stpack` (`docs/04` §2, §5, §6) — the file
 * names, their byte form and their Zod validation.
 *
 * WHY THE PATHS AND THE ENTITY TYPES LIVE TOGETHER: a payload path is a claim
 * about what is inside it (`data/worlds.json` is `WorldVersion[]`,
 * `data/session.json` is ONE `Session`, `data/messages.jsonl` is one `Message` per
 * line). Splitting the names from the schemas is how a reader ends up validating
 * the wrong file against the wrong type.
 *
 * VALIDATION IS THIS MODULE'S JOB ON IMPORT: `validatePackage` in
 * `packages/packages` checks the container, the manifest and JSON well-formedness
 * only — entity-level validation is M1's (`docs/06` §8.6, `docs/04` §7 step 3), so
 * the importer is the only place that can say "this file is valid JSON but not a
 * `CharacterVersion`". Problems are COLLECTED, not thrown, so one import attempt
 * can list everything wrong with the package.
 *
 * SERIALISATION: every payload is canonical JSON (`docs/04` §11), written through
 * `canonical-json.ts`; `messages.jsonl` is one canonical object per line, sorted by
 * `(createdAt, id)` with the tie-break §6 fixes.
 */
import type { PackageEntryPayload } from '@smarttavern/core';
import {
  type AgendaEntry,
  AgendaEntrySchema,
  type CharacterVersion,
  CharacterVersionSchema,
  type Checkpoint,
  CheckpointSchema,
  type MemoryEntry,
  MemoryEntrySchema,
  type Message,
  MessageSchema,
  type PromptPreset,
  PromptPresetSchema,
  type Session,
  SessionSchema,
  type SessionState,
  SessionStateSchema,
  type WorldbookEntry,
  WorldbookEntrySchema,
  type WorldVersion,
  WorldVersionSchema,
} from '@smarttavern/schema';
import { canonicalJsonBytes, canonicalJsonStringify } from './canonical-json';

/* ──────────────────────────────── the layout ─────────────────────────────── */

/**
 * Every legal `data/` payload and the category it carries (`docs/04` §2). The
 * category, not the path, is what the importer's selection and the report speak.
 */
export const PAYLOAD_PATH = {
  worlds: 'data/worlds.json',
  worldbooks: 'data/worldbooks.json',
  characters: 'data/characters.json',
  promptPresets: 'data/promptPresets.json',
  session: 'data/session.json',
  messages: 'data/messages.jsonl',
  checkpoints: 'data/checkpoints.json',
  agenda: 'data/agenda.json',
  memories: 'data/memories.json',
  state: 'data/state.json',
} as const;

export type PayloadCategory = keyof typeof PAYLOAD_PATH;

/** Stable order for reporting: the order §2 lists the files in. */
export const PAYLOAD_CATEGORIES: readonly PayloadCategory[] = [
  'worlds',
  'worldbooks',
  'characters',
  'promptPresets',
  'session',
  'messages',
  'checkpoints',
  'agenda',
  'memories',
  'state',
];

/** The two documents every package carries (`docs/04` §2: both are required). */
export const LICENSE_PATH = 'LICENSE.txt';
export const README_PATH = 'README.txt';

/** One file to hand to the writer. */
export interface PayloadFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/* ──────────────────────────── encoding (export) ──────────────────────────── */

function jsonFile(path: string, value: unknown): PayloadFile {
  return { path, bytes: canonicalJsonBytes(value) };
}

/** One canonical JSON object per line, LF-terminated (`messages.jsonl`). */
function jsonlFile(path: string, values: readonly unknown[]): PayloadFile {
  const text = values.map((value) => canonicalJsonStringify(value)).join('\n');
  return { path, bytes: new TextEncoder().encode(values.length === 0 ? '' : `${text}\n`) };
}

export const encodeWorlds = (rows: readonly WorldVersion[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.worlds, rows);
export const encodeWorldbooks = (rows: readonly WorldbookEntry[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.worldbooks, rows);
export const encodeCharacters = (rows: readonly CharacterVersion[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.characters, rows);
export const encodePromptPresets = (rows: readonly PromptPreset[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.promptPresets, rows);
export const encodeSession = (row: Session): PayloadFile => jsonFile(PAYLOAD_PATH.session, row);
export const encodeMessages = (rows: readonly Message[]): PayloadFile =>
  jsonlFile(PAYLOAD_PATH.messages, rows);
export const encodeCheckpoints = (rows: readonly Checkpoint[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.checkpoints, rows);
export const encodeAgenda = (rows: readonly AgendaEntry[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.agenda, rows);
export const encodeMemories = (rows: readonly MemoryEntry[]): PayloadFile =>
  jsonFile(PAYLOAD_PATH.memories, rows);
export const encodeState = (state: SessionState): PayloadFile =>
  jsonFile(PAYLOAD_PATH.state, state);

/** UTF-8 text document (`LICENSE.txt`, `README.txt`). */
export function textFile(path: string, text: string): PayloadFile {
  return { path, bytes: new TextEncoder().encode(text) };
}

/* ───────────────────────────── ordering (§6) ────────────────────────────── */

/** Compare by a numeric key ascending, then by id ascending — a total order. */
function byNumberThenId<T>(
  rows: readonly T[],
  key: (row: T) => number,
  idOf: (row: T) => string,
): T[] {
  return [...rows].sort((left, right) => {
    const delta = key(left) - key(right);
    if (delta !== 0) return delta;
    const leftId = idOf(left);
    const rightId = idOf(right);
    if (leftId < rightId) return -1;
    return leftId > rightId ? 1 : 0;
  });
}

/**
 * Message order inside the package: `createdAt` ascending, ties broken by `id`
 * (`docs/04` §6 fixes the tie-break because regeneration and swipes produce
 * several messages in the same millisecond, and without it the byte output — and
 * therefore the package hash — would be arbitrary).
 */
export function sortMessagesForPackage(rows: readonly Message[]): Message[] {
  return byNumberThenId(
    rows,
    (row) => row.createdAt,
    (row) => row.id,
  );
}

/** `(createdAt, id)` order for checkpoints; §6 does not fix one, determinism needs one. */
export function sortByCreatedAtThenId<T extends { createdAt: number; id: string }>(
  rows: readonly T[],
): T[] {
  return byNumberThenId(
    rows,
    (row) => row.createdAt,
    (row) => row.id,
  );
}

/** `(atMinute, id)` order for agenda entries and memories — story order. */
export function sortByAtMinuteThenId<T extends { atMinute: number; id: string }>(
  rows: readonly T[],
): T[] {
  return byNumberThenId(
    rows,
    (row) => row.atMinute,
    (row) => row.id,
  );
}

/** `id` order for the payloads that have no time dimension (worlds, characters, …). */
export function sortById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/* ──────────────────────────── decoding (import) ──────────────────────────── */

/**
 * The slice of a Zod schema this module uses. Structural on purpose: importing
 * `zod` here would add a dependency this workspace does not declare (`zod` reaches
 * it through `@smarttavern/schema`, which owns the schemas).
 */
interface SchemaLike<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly SchemaIssueLike[] };
      };
}

interface SchemaIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** One payload that is present but unusable. */
export interface PayloadProblem {
  readonly path: string;
  readonly where?: string;
  readonly detail: string;
}

/** Everything a package's `data/` files hold, after validation. */
export interface DecodedPackage {
  readonly worlds: readonly WorldVersion[];
  readonly worldbooks: readonly WorldbookEntry[];
  readonly characters: readonly CharacterVersion[];
  readonly promptPresets: readonly PromptPreset[];
  readonly session?: Session;
  readonly messages: readonly Message[];
  readonly checkpoints: readonly Checkpoint[];
  readonly agenda: readonly AgendaEntry[];
  readonly memories: readonly MemoryEntry[];
  readonly state?: SessionState;
  /** Categories the package actually carries — drives "what was skipped". */
  readonly present: ReadonlySet<PayloadCategory>;
  readonly problems: readonly PayloadProblem[];
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function issuesOf(path: string, issues: readonly SchemaIssueLike[]): PayloadProblem[] {
  return issues.map((issue) => ({
    path,
    where: issue.path.map((segment) => String(segment)).join('.'),
    detail: issue.message,
  }));
}

/** Parse a `.json` payload against its schema, collecting problems instead of throwing. */
function decodeJson<T>(
  path: string,
  bytes: Uint8Array | undefined,
  schema: SchemaLike<T>,
  problems: PayloadProblem[],
): T | undefined {
  if (bytes === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(UTF8.decode(bytes));
  } catch (cause) {
    problems.push({ path, detail: `is not valid UTF-8 JSON: ${String(cause)}` });
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    problems.push(...issuesOf(path, parsed.error.issues));
    return undefined;
  }
  return parsed.data;
}

/** Parse a `.jsonl` payload: one object per non-empty line, each validated. */
function decodeJsonl<T>(
  path: string,
  bytes: Uint8Array | undefined,
  schema: SchemaLike<T>,
  problems: PayloadProblem[],
): T[] {
  if (bytes === undefined) return [];
  const rows: T[] = [];
  const lines = UTF8.decode(bytes).split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const where = `line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      problems.push({ path, where, detail: `is not valid JSON: ${String(cause)}` });
      return;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const problem of issuesOf(path, parsed.error.issues)) {
        problems.push({
          path,
          where: `${where}${problem.where === '' ? '' : `.${problem.where}`}`,
          detail: problem.detail,
        });
      }
      return;
    }
    rows.push(parsed.data);
  });
  return rows;
}

/**
 * Read every payload the package carries. Absent categories are empty and absent
 * from `present` — a world package legitimately has no `messages.jsonl`
 * (`docs/04` §2 "按包类型裁剪").
 */
export function decodePackage(entries: readonly PackageEntryPayload[]): DecodedPackage {
  const byPath = new Map<string, Uint8Array>(entries.map((entry) => [entry.path, entry.bytes]));
  const problems: PayloadProblem[] = [];
  const present = new Set<PayloadCategory>();
  for (const category of PAYLOAD_CATEGORIES) {
    if (byPath.has(PAYLOAD_PATH[category])) present.add(category);
  }

  const worlds =
    decodeJson(
      PAYLOAD_PATH.worlds,
      byPath.get(PAYLOAD_PATH.worlds),
      WorldVersionSchema.array(),
      problems,
    ) ?? [];
  const worldbooks =
    decodeJson(
      PAYLOAD_PATH.worldbooks,
      byPath.get(PAYLOAD_PATH.worldbooks),
      WorldbookEntrySchema.array(),
      problems,
    ) ?? [];
  const characters =
    decodeJson(
      PAYLOAD_PATH.characters,
      byPath.get(PAYLOAD_PATH.characters),
      CharacterVersionSchema.array(),
      problems,
    ) ?? [];
  const promptPresets =
    decodeJson(
      PAYLOAD_PATH.promptPresets,
      byPath.get(PAYLOAD_PATH.promptPresets),
      PromptPresetSchema.array(),
      problems,
    ) ?? [];
  const session = decodeJson(
    PAYLOAD_PATH.session,
    byPath.get(PAYLOAD_PATH.session),
    SessionSchema,
    problems,
  );
  const messages = decodeJsonl(
    PAYLOAD_PATH.messages,
    byPath.get(PAYLOAD_PATH.messages),
    MessageSchema,
    problems,
  );
  const checkpoints =
    decodeJson(
      PAYLOAD_PATH.checkpoints,
      byPath.get(PAYLOAD_PATH.checkpoints),
      CheckpointSchema.array(),
      problems,
    ) ?? [];
  const agenda =
    decodeJson(
      PAYLOAD_PATH.agenda,
      byPath.get(PAYLOAD_PATH.agenda),
      AgendaEntrySchema.array(),
      problems,
    ) ?? [];
  const memories =
    decodeJson(
      PAYLOAD_PATH.memories,
      byPath.get(PAYLOAD_PATH.memories),
      MemoryEntrySchema.array(),
      problems,
    ) ?? [];
  const state = decodeJson(
    PAYLOAD_PATH.state,
    byPath.get(PAYLOAD_PATH.state),
    SessionStateSchema,
    problems,
  );

  return {
    worlds,
    worldbooks,
    characters,
    promptPresets,
    ...(session === undefined ? {} : { session }),
    messages,
    checkpoints,
    agenda,
    memories,
    ...(state === undefined ? {} : { state }),
    present,
    problems,
  };
}
