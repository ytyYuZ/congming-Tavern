/**
 * Storage port — `docs/02-技术架构.md` §6 (`StorageAdapter`) and §7 (the
 * collections + indexes table). This is contract #3 of §13: "换存储实现时的最大
 * 返工点", i.e. the single place where a switch from one database to another
 * would otherwise ripple through the whole codebase.
 *
 * WHY THE COLLECTION NAMES ARE CONSTANTS AND NOT STRINGS
 * §8.4 决定 1: the names and indexes are transcribed from §7 verbatim and centred
 * in one object, "避免字符串散落在各处". So a caller writes
 * `db.transaction((tx) => tx.collection(COLLECTIONS.messages))` and a rename is
 * one edit. The table below is the ONLY place a collection name appears twice
 * (once as a property key, once as the value) — and `COLLECTION_NAMES` derives
 * the value list from the map so even that pair cannot drift.
 *
 * WHY `transaction` IS THE ONLY ENTRY POINT
 * Every write in this app happens inside one transaction, because almost every
 * write is multi-collection (a checkpoint writes clock + agenda status + cast
 * state; a tool call writes the message AND the domain row it changed). §5.3
 * makes that non-negotiable: "所有调用写入消息元数据" — an audit trail that can
 * disagree with the state it audits is worse than none.
 *
 * WHAT IS DELIBERATELY ABSENT
 * - No query language. §7's index table says what must be *found* fast, so the
 *   port exposes exactly index-shaped lookups (`list` with a selector). Adding a
 *   general filter DSL now would freeze a query planner we do not have.
 * - No migrations API. `migrations` is a collection like any other; running the
 *   steps is `packages/storage`'s job and `schema/migrations` owns the table.
 * - No livestream/subscription. Dexie's `liveQuery` (ADR-017) is a UI concern and
 *   would drag a browser type into core.
 */
import type { Id } from '@smarttavern/schema';

/* ──────────────────────────────── 集合名 ───────────────────────────────── */

/**
 * The eighteen collections of §7, verbatim. NOTE: `personas` is NOT here —
 * ADR-010 removed it in v0.2 because identity is a property of the session
 * (`Session.refs.playerCharacter`), not of a card. Anything reaching for a
 * `personas` collection is porting pre-v0.2 code.
 */
export const COLLECTIONS = {
  worlds: 'worlds',
  worldVersions: 'worldVersions',
  characters: 'characters',
  characterVersions: 'characterVersions',
  worldbooks: 'worldbooks',
  worldbookEntries: 'worldbookEntries',
  promptPresets: 'promptPresets',
  rulePacks: 'rulePacks',
  sessions: 'sessions',
  messages: 'messages',
  checkpoints: 'checkpoints',
  agenda: 'agenda',
  turnPlans: 'turnPlans',
  memories: 'memories',
  assets: 'assets',
  jobs: 'jobs',
  providers: 'providers',
  settings: 'settings',
  migrations: 'migrations',
} as const;

/** One collection name, spelled once. */
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** Every collection name, derived so the map above stays the only source. */
export const COLLECTION_NAMES: readonly CollectionName[] = Object.values(COLLECTIONS);

/* ───────────────────────────────── 索引 ────────────────────────────────── */

/**
 * One index, shaped like §7's third column:
 * - `(worldId, version)` → compound, in that order (the leftmost prefix is the
 *   part that makes "all versions of this world" cheap);
 * - `keywords` → a multi-valued lookup, because a worldbook entry matches ANY of
 *   its keywords, not a prefix of a serialised list;
 * - `assets.hash` → the only UNIQUE index in §7 (资源生命周期: two identical
 *   images are one file), which is why `unique` is stated rather than assumed.
 */
export interface CollectionIndex {
  /** Index name, stable and storage-implementation friendly. */
  name: string;
  /** Field path(s) the index covers, in query-significant order. */
  fields: readonly string[];
  /** True when at most one row may exist per key (only `assets.hash` in §7). */
  unique: boolean;
  /** True when a row is indexed under each value of the field, not one key. */
  multiValued?: boolean;
}

/**
 * The index table of §7, one entry per collection that has one. Collections
 * without an index (§7 writes `—`) are absent on purpose; `SETTINGS` is the
 * primary-key-only case and is named here so a reader does not wonder whether it
 * was forgotten.
 */
export const COLLECTION_INDEXES: Readonly<Record<string, readonly CollectionIndex[]>> = {
  [COLLECTIONS.worlds]: [{ name: 'worlds_name', fields: ['name'], unique: false }],
  [COLLECTIONS.worldVersions]: [
    { name: 'worldVersions_worldId_version', fields: ['worldId', 'version'], unique: true },
  ],
  [COLLECTIONS.characters]: [{ name: 'characters_name', fields: ['name'], unique: false }],
  [COLLECTIONS.characterVersions]: [
    {
      name: 'characterVersions_characterId_version',
      fields: ['characterId', 'version'],
      unique: true,
    },
  ],
  [COLLECTIONS.worldbooks]: [{ name: 'worldbooks_worldId', fields: ['worldId'], unique: false }],
  [COLLECTIONS.worldbookEntries]: [
    { name: 'worldbookEntries_worldId', fields: ['worldId'], unique: false },
    { name: 'worldbookEntries_keywords', fields: ['keywords'], unique: false, multiValued: true },
  ],
  [COLLECTIONS.promptPresets]: [{ name: 'promptPresets_name', fields: ['name'], unique: false }],
  [COLLECTIONS.rulePacks]: [{ name: 'rulePacks_system', fields: ['system'], unique: false }],
  [COLLECTIONS.sessions]: [{ name: 'sessions_createdAt', fields: ['createdAt'], unique: false }],
  [COLLECTIONS.messages]: [
    { name: 'messages_sessionId_parentId', fields: ['sessionId', 'parentId'], unique: false },
    { name: 'messages_createdAt', fields: ['createdAt'], unique: false },
  ],
  [COLLECTIONS.checkpoints]: [
    { name: 'checkpoints_sessionId_createdAt', fields: ['sessionId', 'createdAt'], unique: false },
  ],
  [COLLECTIONS.agenda]: [
    {
      name: 'agenda_sessionId_atMinute_status',
      fields: ['sessionId', 'atMinute', 'status'],
      unique: false,
    },
  ],
  [COLLECTIONS.turnPlans]: [
    { name: 'turnPlans_sessionId_round', fields: ['sessionId', 'round'], unique: false },
  ],
  [COLLECTIONS.memories]: [
    { name: 'memories_scope_targetId', fields: ['scope', 'targetId'], unique: false },
    { name: 'memories_atMinute', fields: ['atMinute'], unique: false },
  ],
  [COLLECTIONS.assets]: [{ name: 'assets_hash', fields: ['hash'], unique: true }],
  [COLLECTIONS.jobs]: [{ name: 'jobs_status', fields: ['status'], unique: false }],
  [COLLECTIONS.providers]: [{ name: 'providers_kind', fields: ['kind'], unique: false }],
  /** §7: `settings` is keyed by its primary key and indexes nothing else. */
  [COLLECTIONS.settings]: [],
};

/**
 * The index table plus one explicit "no index" entry for every other collection,
 * so `COLLECTION_INDEXES[COLLECTIONS.x]` is never `undefined` under
 * `noUncheckedIndexedAccess` and a missing collection is a compile-time mistake
 * rather than a runtime `.length` crash.
 */
export const INDEXES: Readonly<Record<CollectionName, readonly CollectionIndex[]>> =
  Object.fromEntries(
    COLLECTION_NAMES.map((name) => [name, COLLECTION_INDEXES[name] ?? []]),
  ) as Record<CollectionName, readonly CollectionIndex[]>;

/* ─────────────────────────────── 行与查询 ──────────────────────────────── */

/**
 * The minimum every stored row must have.
 *
 * §7 lists `settings` as `(key, value)` and `migrations` as `(version, appliedAt)`,
 * which reads like a different primary key each. ADR-022 settles it: **their primary
 * key is `id`**, holding the config key and the version number respectively, so the
 * whole port keeps ONE addressing rule. The alternative — a general non-`id`
 * primary-key mechanism — was rejected as changing a global abstraction for two
 * tables that never leave the local database.
 *
 * (An earlier version of this comment promised a `getBy` that does not exist on
 * `Collection`, and missed `migrations` entirely. Both are corrected here.)
 *
 * ONE CONSEQUENCE WORTH SPELLING OUT: `Id` is a string, so `migrations`'s version
 * number is stored as its DECIMAL STRING. Do not order by that key — strings sort
 * lexicographically and `'10' < '9'` — §7 gives `migrations` an `appliedAt` for
 * exactly that question. The same applies to any numeric key parked in `id`.
 */
export interface RowBase {
  id: Id;
}

/**
 * An index-shaped selector. A plain equality map on `where` plus optional bounds
 * on the indexed field(s) — enough for every lookup §7's indexes exist for, and
 * small enough that a new backend can implement it in an afternoon.
 */
export interface Query<TRow> {
  /** Equality constraints, matched against the indexed fields. */
  where?: Partial<Record<keyof TRow & string, unknown>>;
  /**
   * Field the `from`/`to` bounds apply to, i.e. the leftmost field of the index
   * being scanned. Optional ONLY while no bounds are given: a bound without a field
   * is ambiguous — §7 has collections whose first indexed field is not the range one
   * (`messages` is `(sessionId, parentId)` but its useful range is `createdAt`) — so
   * supplying `from`/`to` without `field` MUST throw `StorageQueryError` rather than
   * guess. Guessing is what made `{where: {createdAt: 10}, from: 1, to: 5}` answer an
   * empty array, and a wrong answer pinned by a test becomes a compatibility promise
   * (ADR-023).
   */
  field?: keyof TRow & string;
  /**
   * Inclusive lower bound on `field` (range scans). Scalar on purpose (ADR-024):
   * a `Date` or any other object used to compare as "equal" and match every row,
   * and the runtime refuses one with `RANGE_BOUND_NOT_COMPARABLE_MESSAGE` even
   * though the type already forbids it — a cast or a plain JS caller can still
   * produce one.
   */
  from?: number | string;
  /** Inclusive upper bound on `field` — see `from`. */
  to?: number | string;
  /** Descending when `'desc'`. Default ascending. */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * A query the port REFUSES to interpret rather than answering it wrongly. The one
 * case in M0 is bounds without a `field`; the port owns this error so that every
 * implementation and every test agrees on what "ambiguous" means (ADR-023).
 *
 * Generic in the row type so a thrower keeps its own `Query<T>` (a `Query<unknown>`
 * parameter would reject every real query: `field` collapses to `never`).
 */
export class StorageQueryError<TRow = unknown> extends Error {
  constructor(
    message: string,
    readonly query: Query<TRow>,
  ) {
    super(message);
    this.name = 'StorageQueryError';
  }
}

/**
 * The refusal sentence for a range query without a `field`, exported so the mock,
 * every adapter and every test say the SAME thing. A message typed out by hand in
 * two packages drifts, and this one is asserted verbatim — owning the string here
 * makes "cannot drift" structural instead of a comment asking nicely (ADR-023).
 */
export const RANGE_FIELD_REQUIRED_MESSAGE =
  'a range query must name `field`: bounds without it are ambiguous (ADR-023)';

/**
 * The refusal sentence for a range bound that cannot be compared, exported for the
 * same reason as the one above: one string, three packages (ADR-024).
 *
 * A bound that is not a `number` or a `string` used to compare as "equal" — so a
 * `Date` bound matched EVERY row and the query quietly answered the whole table,
 * which is the same class of silent wrong answer ADR-023 outlawed. `docs/02` §7
 * already fixes the unit ("timestamps are milliseconds"), so a `Date` here is a
 * caller error, not a missing feature.
 */
export const RANGE_BOUND_NOT_COMPARABLE_MESSAGE =
  'range bounds must be a number or a string: anything else compares as equal and would match every row (ADR-024)';

/** Write shape: `id` may be omitted only when the store mints it (`put`). */
export type RowPatch<T> = Partial<T>;

/**
 * The per-collection CRUD surface a transaction exposes.
 *
 * Every method is `async` even where an implementation can answer synchronously:
 * IndexedDB and SQLite both cannot, and a port that pretends otherwise would
 * have to change when the first real backend lands.
 */
export interface Collection<T> {
  get(id: Id): Promise<T | undefined>;

  /**
   * Index-shaped read. `index` names an entry of `INDEXES[collection]`; passing
   * `undefined` means "full scan" and is honest about its cost.
   */
  list(query?: Query<T>, index?: string): Promise<T[]>;

  /** Insert or replace by id. Returns the stored row (the store may fill fields). */
  put(row: T): Promise<T>;

  /** Insert or replace many rows in one shot (import path). */
  putMany(rows: readonly T[]): Promise<T[]>;

  /** Targeted update of an existing row; rejects when the id is absent. */
  update(id: Id, patch: RowPatch<T>): Promise<T>;

  /** Remove by id; idempotent by design, so a rollback cannot need a lookup. */
  remove(id: Id): Promise<void>;

  /** Rows in the collection, after `where` when given. */
  count(query?: Query<T>): Promise<number>;
}

/**
 * A transaction. It is a CALLBACK and not an object with `begin`/`commit`
 * because a transaction that can be left open is a transaction that leaks: the
 * adapter commits when `fn` resolves and ROLLS BACK when it throws.
 */
export interface Tx {
  collection<T extends RowBase>(name: CollectionName): Collection<T>;
}

/**
 * §6's `StorageAdapter`, verbatim. `transaction<T>` is the whole surface: read
 * only transactions and compound read-modify-write are both expressed as the
 * same callback with a different `T`.
 */
export interface StorageAdapter {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
