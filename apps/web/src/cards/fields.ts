/**
 * The two primitives both card editors are built from (M1-W1 / M1-C1): JSON-safe reads
 * for a stored draft, and the list transitions behind every 增删改 control.
 *
 * WHY THE READS ARE DEFENSIVE INSTEAD OF `schema.parse`
 * A draft row is UNVALIDATED BY CONSTRUCTION. It exists so a half-typed form survives a
 * reload, and "the name is still empty" is exactly the state autosave has to keep — so the
 * strict entity schema cannot be the reader (a blank name fails it) while `JSON.parse`
 * cannot be the writer's contract either (a `JsonValue` is not a `WorldData`). Following
 * `db/repository.ts`'s `completeState` precedent, the reader completes the value FIELD BY
 * FIELD: a member with the right type is taken, anything else falls back to the version the
 * draft was based on. Nothing throws, and no value the user typed is discarded for being
 * merely incomplete.
 *
 * WHY PARAMETERISED KEYS EVERYWHERE. `noPropertyAccessFromIndexSignature` rejects
 * `source.name` on an index signature while Biome's `useLiteralKeys` rejects
 * `source['name']`; a parameterised key is the only spelling both accept
 * (`state/write-error.ts` records the same conflict).
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { JsonValue } from '@smarttavern/schema';

/* ──────────────────────────── the field descriptors ─────────────────────── */

/**
 * The members of `S` whose type is (an optional) string / number / boolean / string list.
 *
 * WHY THE DESCRIPTORS ARE TYPED BY KEY AND NOT BY ACCESSOR PAIR: a descriptor is the form's
 * inventory — which fields exist, what each is called, which control edits it — and one
 * table is what lets a test check that the inventory covers the schema
 * (`cards/world.test.ts`). A `read`/`write` closure per field would be the same table with
 * every entry spelled twice, and the type mapping below is what keeps a descriptor from
 * naming a member that does not exist or carries another type.
 */
type Defined<T> = Exclude<T, undefined>;

/*
 * `K extends string` in every mapping below is load-bearing: `keyof S` may contain `symbol`, and a
 * key that cannot be interpolated into a DOM id (or read out of a JSON object) is not a form field.
 */
export type StringKeys<S> = {
  [K in keyof S]-?: K extends string
    ? Defined<S[K]> extends string
      ? S[K] extends string | undefined
        ? K
        : never
      : never
    : never;
}[keyof S];

export type NumberKeys<S> = {
  [K in keyof S]-?: K extends string
    ? Defined<S[K]> extends number
      ? S[K] extends number | undefined
        ? K
        : never
      : never
    : never;
}[keyof S];

export type BooleanKeys<S> = {
  [K in keyof S]-?: K extends string
    ? Defined<S[K]> extends boolean
      ? S[K] extends boolean | undefined
        ? K
        : never
      : never
    : never;
}[keyof S];

export type StringListKeys<S> = {
  [K in keyof S]-?: K extends string
    ? Defined<S[K]> extends readonly string[]
      ? S[K] extends readonly string[] | undefined
        ? K
        : never
      : never
    : never;
}[keyof S];

/** A single-line or multi-line text field. */
export interface TextFieldSpec<S> {
  readonly key: StringKeys<S>;
  /** The catalog key of the field's label; `MessageKey` makes a missing sentence a `tsc` error. */
  readonly label: MessageKey;
  readonly multiline?: boolean;
}

/**
 * A numeric field. `integer` is what the control's `step` says, `optional` is what an empty
 * input means (`CharacterData.sampling`'s knobs override a provider default only when set,
 * while a calendar's `minutesPerHour` is required and an empty input becomes `0`, which the
 * schema then refuses — reported by `worldIssues` rather than silently clamped).
 */
export interface NumberFieldSpec<S> {
  readonly key: NumberKeys<S>;
  readonly label: MessageKey;
  readonly integer?: boolean;
  readonly optional?: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** A checkbox. */
export interface BooleanFieldSpec<S> {
  readonly key: BooleanKeys<S>;
  readonly label: MessageKey;
}

/** A list of strings.
 *
 * `rows` marks a PROSE list: an item may contain line breaks (`alternate_greetings`), so its
 * control is one textarea per item instead of one line per item — a line separator inside a
 * message would be data corruption rather than a second item.
 */
export interface StringListFieldSpec<S> {
  readonly key: StringListKeys<S>;
  readonly label: MessageKey;
  readonly rows?: boolean;
}

/* ─────────────────────────────── validation shape ────────────────────────── */

/**
 * One problem a payload has, as the editor's validation panel shows it.
 *
 * Shared by the two editors rather than declared twice: the panel's shape is what a person reads,
 * and the world and the card must not be able to describe a problem differently. `path` is the
 * dotted payload path the problem belongs to (`calendar.months`, `voice.desire`) and `message` is
 * the schema's or the time engine's own sentence, kept verbatim: the FACT is the path, which the
 * view translates, and the sentence is a diagnostic a paraphrase would only blur (ADR-019's split).
 */
export interface CardIssue {
  readonly path: string;
  readonly message: string;
}

/* ─────────────────────────────── JSON-safe reads ─────────────────────────── */

/**
 * The members of a JSON object, or `undefined` for anything that is not one.
 *
 * Every reader below takes `… | undefined` and goes through this function, because the only
 * sources they ever see are members of an untrusted draft: a nested group that is absent, a
 * number where an object belongs, a half-written row. Accepting `undefined` here is what keeps
 * each reader total instead of pushing a guard onto every call site.
 */
export function jsonObject(value: unknown): { [key: string]: JsonValue } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  // The members of a value that passed the check above are JSON by the type it arrived in:
  // `JsonValue`'s object arm is exactly `{[key: string]: JsonValue}`, so the cast states
  // what the runtime check just proved rather than widening anything.
  return value as { [key: string]: JsonValue };
}

/** A nested object member, or `undefined` when it is absent or not an object. */
export function memberOf(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
): { [key: string]: JsonValue } | undefined {
  return jsonObject(source?.[key]);
}

/**
 * One member of a JSON object, whatever it holds.
 *
 * WHY THIS EXISTS RATHER THAN `source['key']`: a call site that names the member it wants as a
 * LITERAL in brackets trips Biome's `useLiteralKeys`, while the dot form it suggests trips
 * TypeScript's `noPropertyAccessFromIndexSignature` — the conflict `state/write-error.ts` records.
 * A parameterised key is the spelling both accept, so the access happens behind this function.
 */
export function memberValue(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
): JsonValue | undefined {
  return source?.[key];
}

/** A string member, or `fallback`. */
export function asString(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
  fallback: string,
): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : fallback;
}

/** A string member, or `undefined` when the key is absent or holds another type. */
export function asOptionalString(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A finite number member, or `fallback`.
 *
 * `NaN` and `Infinity` are refused like any other type: arithmetic on them poisons every
 * later comparison (the `completeState` clock check makes the same point), and a stored
 * `null` must not become `0` — that would turn a damaged field into a legal-looking number.
 */
export function asNumber(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
  fallback: number,
): number {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A finite number member, or `undefined`.
 *
 * The optional twin of `asNumber`, for the fields whose ABSENCE is meaningful
 * (`CharacterData.sampling`'s knobs override a provider default only when they are set).
 */
export function asOptionalNumber(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A boolean member, or `fallback`. Only a real boolean counts: `'yes'` is not `true`. */
export function asBoolean(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** A list of strings, or `fallback`. Non-string members are dropped, not coerced. */
export function asStringList(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
  fallback: readonly string[],
): string[] {
  const value = source?.[key];
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((member): member is string => typeof member === 'string');
}

/** A string -> string record, or `fallback`. Used for the payload's own `customFields`. */
export function asStringRecord(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
  fallback: Readonly<Record<string, string>>,
): Record<string, string> {
  const members = jsonObject(source?.[key]);
  if (members === undefined) return { ...fallback };
  const record: Record<string, string> = {};
  for (const [name, value] of Object.entries(members)) {
    if (typeof value === 'string') record[name] = value;
  }
  return record;
}

/**
 * A list of composite members, each completed by `hydrate`.
 *
 * An element that `hydrate` refuses (it is not an object at all) is DROPPED rather than
 * replaced with a blank: a blank would be content nobody wrote, while the remaining
 * elements are rows the user can still see and fix. A `hydrate` that completes a damaged
 * object is the normal path and never refuses.
 *
 * A member that is not an array AT ALL falls back to `fallback`: an absent key means the
 * draft never carried the list, which is a different fact from "the user removed every row"
 * (an empty array) and must not silently delete the version's rows.
 */
export function asList<T>(
  source: { [key: string]: JsonValue } | undefined,
  key: string,
  hydrate: (member: unknown) => T | undefined,
  fallback: readonly T[] = [],
): T[] {
  const value = source?.[key];
  if (!Array.isArray(value)) return [...fallback];
  const items: T[] = [];
  for (const member of value) {
    const completed = hydrate(member);
    if (completed !== undefined) items.push(completed);
  }
  return items;
}

/* ─────────────────────────────── 增 / 删 / 改 ────────────────────────────── */

/**
 * Replace the item at `index`. An out-of-range index is a NO-OP rather than a throw:
 * every caller is a form control, and a stale click after another tab changed the list
 * must not take the editor down (`play.tsx`'s sibling arrows answer the same way).
 */
export function withItem<T>(items: readonly T[], index: number, value: T): readonly T[] {
  if (index < 0 || index >= items.length) return items;
  return items.map((current, position) => (position === index ? value : current));
}

/** Append one item. The 增 half of every list control. */
export function appendItem<T>(items: readonly T[], item: T): readonly T[] {
  return [...items, item];
}

/** Remove the item at `index`. Out of range is a no-op, like `withItem`. */
export function removeItem<T>(items: readonly T[], index: number): readonly T[] {
  if (index < 0 || index >= items.length) return items;
  return items.filter((_current, position) => position !== index);
}

/**
 * Swap the item at `index` with the one `offset` places away (上移 / 下移).
 *
 * A move past either end changes nothing, which is what makes the two buttons total: the
 * first row's 上移 and the last row's 下移 are refused by the same rule that would refuse a
 * click from a stale render.
 */
export function moveItem<T>(items: readonly T[], index: number, offset: number): readonly T[] {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const left = items[index];
  const right = items[target];
  if (left === undefined || right === undefined) return items;
  return items.map((current, position) => {
    if (position === index) return right;
    if (position === target) return left;
    return current;
  });
}

/* ────────────────────────── the line-oriented lists ──────────────────────── */

/**
 * A list of strings as the ONE value a textarea edits, one item per line.
 *
 * WHY A TEXTAREA AND NOT A ROW PER ITEM: `z.array(z.string())` gives an item no identity,
 * and React needs one per row (`noArrayIndexKey` is on, and a key derived from the value
 * would remount the input on every keystroke — i.e. it would drop the caret). A textarea
 * makes the list a single value with a single caret, which is what the data actually is.
 * Multi-line PROSE lists (`alternate_greetings`) are the exception and have rows of their
 * own, because a line separator inside a message would be data corruption.
 *
 * The round trip is exact for both the empty list and a trailing empty line, which is what
 * keeps a half-typed list from fighting the caret: `''` is `[]`, and `'a\n'` is `['a', '']`
 * — the blank line the user just opened, visible and deletable.
 */
export function linesOf(items: readonly string[]): string {
  return items.join('\n');
}

/** The inverse of `linesOf`; an empty field is an empty list, not one empty item. */
export function itemsOfLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/* ──────────────────────────── the JSON boundary ─────────────────────────── */

/**
 * Put a value through the JSON boundary, producing the `JsonValue` a row may hold.
 *
 * WHY `JSON.parse(JSON.stringify(...))` AND NOT A HAND-WRITTEN CONVERTER: the payloads are
 * JSON-shaped by their schemas and differ only in OPTIONAL members, whose `undefined` is
 * not a member of `JsonValue`. Going through JSON drops exactly those keys (and turns an
 * `undefined` array hole into `null`, which the readers then fall back on), which is the
 * documented storage contract of an `extensions` bag rather than a lossy step to be
 * guessed at. It is the same boundary `docs/02` §7 draws ("`data` 字段可 JSON 序列化").
 */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
