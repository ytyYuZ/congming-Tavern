/**
 * The Dexie database shape — `docs/06-开发任务拆解.md` §9.3 ("集合名与索引逐字取自
 * `core/ports/storage.ts` 的 `COLLECTIONS` / `INDEXES`，不再手写第二份") over the
 * table of `docs/02-技术架构.md` §7.
 *
 * WHAT THIS FILE IS AND IS NOT
 * It is a *translation*, not a second declaration. `core/ports/storage.ts` owns
 * the nineteen collection names and the index table; this module reads both and
 * turns each `CollectionIndex` into Dexie's schema mini-language. There is no
 * list of names here, no list of index names here, and adding a §7 index is a
 * one-line edit in `core/ports/storage.ts` plus nothing at all in this package —
 * `indexeddb/schema.test.ts` asserts exactly that.
 *
 * THE TRANSLATION, IN FULL (the decision `docs/06` §9.3 left open)
 * Dexie's `stores()` map is `tableName -> 'primaryKey,index,index,...'`, where an
 * index entry is `[&][*]keyPath` or `[&][*][a+b]`:
 *   - `unique: true`  -> `&`  (Dexie's only spelling of a unique index);
 *   - `multiValued`   -> `*`  (`worldbookEntries_keywords`: one row, many keys);
 *   - two or more `fields` -> `[a+b]`, a compound index in the declared order
 *     (`IndexSpec.compound` is then true, which the tests assert);
 *   - `name` — the port's index name, e.g. `messages_createdAt` — is DROPPED.
 *     Dexie derives an index's identity from its key path (`messages.createdAt`),
 *     and its schema grammar has no slot for a custom name. Mistranslating the
 *     name into the key path (`&assets_hash`) would index a field that does not
 *     exist and silently turn every range scan into an empty result. The port
 *     still names indexes for callers (`list(query, index)`); the adapter
 *     validates that name and then scans the matching key path.
 *
 * WHY THE PRIMARY KEY IS ALWAYS `id`
 * The port's `RowBase` is `{ id: Id }` and its `Collection<T>` addresses rows by
 * that id, so `id` is the primary key of every table. Two §7 collections are
 * deliberately keyed otherwise — `settings` by `key`, `migrations` by `version`
 * — and the port does not say how they are addressed either; see the adapter's
 * header for how that gap is handled. No primary key is auto-incrementing: this
 * app mints UUIDv7 ids (`docs/04` §4) and a silently generated id would break
 * the "`put(row)` gives back exactly the row you wrote" contract.
 */
import { COLLECTIONS, type CollectionIndex, type CollectionName, INDEXES } from '@smarttavern/core';

/** The primary-key field of a table, in Dexie's schema grammar. */
export const PRIMARY_KEY = 'id';

/** One index, in Dexie's schema mini-language. */
export function indexSpec(index: CollectionIndex): string {
  // A single field is an `&`/`*` prefix on that field; several are bracketed with
  // `+`. Both spellings share this one join, so the two cases cannot diverge.
  const joined = index.fields.join('+');
  const keyPath = joined.includes('+') ? `[${joined}]` : joined;
  return `${index.unique ? '&' : ''}${index.multiValued === true ? `*${keyPath}` : keyPath}`;
}

/**
 * One table's Dexie schema string: the primary key, then the §7 indexes.
 *
 * A bare `id` is enough for the primary key — IndexedDB always declares that one
 * inbound, so `where('id')` accepts a value, a `between()` range and
 * `reverse()`. Only secondary indexes need the `&`/`*` grammar above.
 */
export function tableSchema(name: CollectionName): string {
  return [PRIMARY_KEY, ...INDEXES[name].map(indexSpec)].join(',');
}

/**
 * The whole `stores()` map, derived from the port constants. Exported so tests
 * can assert the derivation (and so a future migration can diff two versions).
 */
export function indexedDbSchema(): Record<string, string> {
  const schema: Record<string, string> = {};
  for (const name of Object.values(COLLECTIONS)) {
    schema[name] = tableSchema(name);
  }
  return schema;
}

/**
 * Schema version of the Dexie database. `docs/06` §9.3: "Dexie 的版本迁移要与
 * `docs/02` §7 的 `migrations` 集合对齐；先落一个 v1 schema 即可" — the `migrations`
 * collection records *payload* migrations, which is a different axis from the
 * on-disk schema, so v1 is the whole story until a table changes shape.
 */
export const DATABASE_VERSION = 1;

/**
 * Default database name. Storage is local-first (`docs/02` §1), so there is one
 * database per browser profile rather than one per entity kind; tests pass a
 * unique name instead of deleting the shared one.
 */
export const DATABASE_NAME = 'smarttavern';

/** Every table of §7, i.e. the set `transaction()` may scope to. */
export const TABLE_NAMES: readonly CollectionName[] = Object.values(COLLECTIONS);
