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
 * The minimum every stored row must have. §7's collections are not all
 * primary-key-only (`settings` uses `key`), but every one of them has an `id`
 * except `settings`, which this port therefore handles through `getBy`.
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
   * being scanned. Explicit because a bound without a field is ambiguous: §7 has
   * collections whose first indexed field is not the range one (`messages` is
   * `(sessionId, parentId)` but its useful range is `createdAt`).
   */
  field?: keyof TRow & string;
  /** Inclusive lower bound on `field` (range scans). */
  from?: unknown;
  /** Inclusive upper bound on `field`. */
  to?: unknown;
  /** Descending when `'desc'`. Default ascending. */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

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
