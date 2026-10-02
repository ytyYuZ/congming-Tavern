/**
 * The patch engine of AI 共创 (M1-W2): RFC 6902-shaped operations over a world payload, and the
 * one function that turns `(draft payload, patch)` into the payload a proposal PROPOSES.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS PURE
 * docs/01 §5.2 fixes the shape of an AI turn: `AI 每次产出以结构化补丁（JSON Patch）形式呈现`,
 * followed by `采纳/编辑/否决`. A proposal is therefore DATA — a list of operations — and the thing
 * that computes its effect must be a pure function of the payload and the operations, or the preview
 * and the apply could disagree about what was proposed. Nothing here reads a row, holds state, or
 * knows that a model wrote the patch: `proposal.ts` is the layer that parses a model's answer into
 * these operations, and `state/co-create-store.ts` is the layer that persists the result.
 *
 * WHY RFC 6902'S VERBS AND `{op, path, value}` SHAPE, BUT NOT ITS WHOLE WIRE FORMAT
 * The three verbs (`add` / `remove` / `replace`) and the JSON-Pointer target are RFC 6902, and the
 * operation is the object the RFC writes (`{op, path, value}`). Two details are this app's:
 *   • `add` on a LIST takes an optional `at`. The RFC spells an append as a `-` pointer TOKEN, and a
 *     token whose meaning depends on the verb that carries it is exactly the rule a model gets
 *     wrong; an explicit index keeps the pointer a pure address.
 *   • a value that is not JSON, and a value that is `null`, are REFUSED rather than dropped. "The
 *     model sent `undefined`" has to be a failure the user can read, not a no-op that looks like an
 *     accepted edit.
 *
 * WHY TYPE EQUALITY IS ENFORCED (docs/01 §F2-2 proposes a *field* change)
 * A patch may change a value, not the shape of the document: setting a string field to an object, or
 * a list member to `null`, would produce a payload the schema refuses — and, worse, a preview that
 * looks like a change while the apply is guaranteed to fail the publish gate. So a new value must
 * have the same JSON kind as the value it replaces (an INTEGER for a whole number: `0.5` months is
 * data corruption, not a creative edit), and a non-empty list's members must all share one kind.
 *
 * WHY `applyWorldOps` VALIDATES THE RESULT AND NOT ONLY THE OPERATIONS
 * A patch whose every operation is legal can still produce an illegal document (`name: ''` is a
 * legal string and `WorldDataSchema.name` is `min(1)`). The result is therefore parsed with the
 * frozen schema, and a refusal carries the Zod issue's own path — the same path
 * `cards/world.ts`'s `worldIssues` would report a keystroke later.
 */
import { type JsonValue, type WorldData, WorldDataSchema } from '@smarttavern/schema';

/* ─────────────────────────────── the operations ───────────────────────────── */

/** The three verbs a proposal may use. See the header for what each one requires. */
export type PatchVerb = 'add' | 'remove' | 'replace';

/**
 * One operation over the payload.
 *
 * `value` is absent for `remove`; `at` is present only for `add` into a list. This is the PARSED
 * form — `proposal.ts` builds it through `readWorldOp`, which checks every member — and never a
 * cast of untrusted JSON.
 */
export interface WorldOp {
  readonly op: PatchVerb;
  /** A JSON Pointer into the payload (`/rulesOfNature/taboos`, `/regions`). */
  readonly path: string;
  /** The value `add` / `replace` writes. JSON by construction; see `readWorldOp`. */
  readonly value?: JsonValue;
  /** `add` only: the index to insert at in the list `path` names. Appends when absent. */
  readonly at?: number;
}

/**
 * Why one operation cannot be applied, in the vocabulary the panel turns into a sentence.
 *
 * A closed union rather than a free string: these are the failures the catalog has sentences for,
 * and the code plus the operation's own pointer is what the user reads (`co-create.opError`).
 */
export type WorldOpFailure =
  /** The pointer is not a JSON Pointer, or it does not address a place in this payload. */
  | 'path-missing'
  /** `add` on an object member that is already there — `replace` is the verb for that. */
  | 'member-exists'
  /** `replace` / `remove` on an object member that is not there. */
  | 'member-absent'
  /** The value's JSON kind differs from the one it would replace, or the value is `null`. */
  | 'type-mismatch'
  /** The pointer names the payload root, which no proposal may replace. */
  | 'root'
  /** The patch carries more operations than `MAX_WORLD_OPS`. */
  | 'too-many-ops';

/** One failed operation, with the index and pointer the panel prints. */
export interface WorldOpIssue {
  readonly index: number;
  readonly op: PatchVerb;
  readonly path: string;
  readonly kind: WorldOpFailure;
}

/**
 * The most operations one proposal may carry, and the deepest pointer one path may be.
 *
 * Both guard against an ANSWER, not against a user. A model that echoes a whole payload back as
 * five hundred `replace` operations has not proposed an edit anybody can judge, and no leaf of
 * `WorldData` is deeper than five tokens. A patch over either bound is a reported failure the user
 * can retry — not a hang, and not a silent truncation.
 */
export const MAX_WORLD_OPS = 32;
export const MAX_POINTER_TOKENS = 8;

/* ─────────────────────────────── JSON Pointer ─────────────────────────────── */

/**
 * The tokens of a JSON Pointer, or `undefined` when the string is not one.
 *
 * RFC 6901: `''` is the whole document; otherwise the string starts with `/` and every token is
 * `~1`-then-`~0` unescaped (that order is the RFC's, and reversing it turns `~01` into `/`).
 * The `-` token the RFC reserves for "past the last array element" is REFUSED here — this engine
 * takes an explicit `at` for an append (see `WorldOp`), so `-` would be a second spelling of one
 * thing, and the pointer parser is the one place that can refuse it for every verb at once.
 */
export function pointerTokens(path: string): string[] | undefined {
  if (path === '') return [];
  if (!path.startsWith('/')) return undefined;
  const tokens = path.slice(1).split('/').map(unescapeToken);
  if (tokens.some((token) => token === undefined || token === '-')) return undefined;
  if (tokens.length > MAX_POINTER_TOKENS) return undefined;
  return tokens as string[];
}

/**
 * One token, or `undefined` when it holds a `~` that is not part of `~0` / `~1`.
 *
 * THE VALIDATION RUNS ON THE RAW TOKEN, BEFORE ANY UNESCAPING — and this function had that backwards
 * at first: it unescaped `~0` to `~` and then asked whether the RESULT still held a `~`, so the one
 * character the escape exists to produce was read as proof of a malformed escape and every pointer
 * naming a `~` was refused. `~2` is the thing to reject (RFC 6901 defines exactly two escapes) and it
 * is visible on the raw text; after the substitutions a `~` is DATA and says nothing about validity.
 */
function unescapeToken(raw: string): string | undefined {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '~') continue;
    const next = raw[index + 1];
    if (next === '0' || next === '1') {
      index += 1;
      continue;
    }
    return undefined;
  }
  // `~1` FIRST, then `~0` (RFC 6901 §4): reversing them would turn `~01` into `/` instead of `~1`.
  return raw.split('~1').join('/').split('~0').join('~');
}

/**
 * One pointer token, escaped (RFC 6901: `~` becomes `~0`, then `/` becomes `~1`).
 *
 * The inverse of `unescapeToken`, and the reason the app never builds a pointer by string
 * concatenation alone: `customFields` keys are the LABELS THE USER TYPED (`cards/custom-fields.ts`),
 * so a field called `a/b` or `x~y` is ordinary data and a naive `${path}/${key}` would address a
 * different field — or nothing at all — on the way back through `pointerTokens`.
 *
 * ONE CHARACTER AT A TIME, NOT TWO `split`/`join` PASSES — and that is a bug this function had. Two
 * passes must run in the RFC's order (`~` first), and even then the second pass re-reads the output of
 * the first: mapping `~` to `~0` and then `/` to `~1` turns `x~y` into `x~01y`, which
 * `unescapeToken` reads back as `x~1y`. A single pass cannot see a character it has already emitted,
 * which is exactly the property the RFC's ordering is trying to state.
 */
export function escapePointerToken(token: string): string {
  let escaped = '';
  for (const character of token) {
    if (character === '~') escaped += '~0';
    else if (character === '/') escaped += '~1';
    else escaped += character;
  }
  return escaped;
}

/**
 * A pointer token as an array index.
 *
 * RFC 6901 forbids leading zeros (`01` is not index 1), and this is stricter still: `+1`, ` 1` and
 * `1.0` are refused, because a model that wrote one of them meant something this engine cannot
 * guess — and guessing is how a proposal lands on the wrong row.
 */
export function arrayIndexOf(token: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
  const position = Number(token);
  return Number.isSafeInteger(position) ? position : undefined;
}

/* ─────────────────────────────── JSON values ─────────────────────────────── */

/**
 * True when a value is JSON this app may store.
 *
 * `null` is JSON and `JsonValue` declares it, so it passes HERE; refusing it for a `WorldData`
 * field is a rule about that document (`type-mismatch`), not about JSON.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

/** One JSON kind, as the equality rule below compares them. */
type JsonKind = 'string' | 'number-int' | 'number' | 'boolean' | 'array' | 'object' | 'null';

/** The container an operation writes into. Both JSON containers, narrowed for in-place writes. */
type Container = { [key: string]: JsonValue } | JsonValue[];

function kindOf(value: JsonValue): JsonKind {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'number-int' : 'number';
  return 'object';
}

/**
 * Whether `next` may take `current`'s place.
 *
 * A whole number may replace a fractional one (an integer is usable wherever a number is); the
 * reverse is refused, because `stepMinutes: 30.5` is a value `WorldDataSchema`'s `int()` rejects and
 * refusing it here is what keeps the preview and the apply in agreement.
 */
function sameKind(current: JsonValue, next: JsonValue): boolean {
  const currentKind = kindOf(current);
  const nextKind = kindOf(next);
  if (currentKind === nextKind) return true;
  return currentKind === 'number' && nextKind === 'number-int';
}

/* ─────────────────────────── reading untrusted ops ────────────────────────── */

/** Why a JSON value in an operation is unusable — the two reasons `readWorldOp` reports. */
export type WorldOpReadFailure = 'not-json' | 'null-value';

/** One operation, or the reason the value cannot be one. */
export type WorldOpRead =
  | { readonly ok: true; readonly op: WorldOp; readonly warnings: readonly WorldOpReadFailure[] }
  | { readonly ok: false; readonly reason: 'not-an-operation' };

const VERBS: readonly PatchVerb[] = ['add', 'remove', 'replace'];

/**
 * Read one untrusted JSON value as a `WorldOp`.
 *
 * WHY THIS IS A HAND-WRITTEN READER AND NOT A ZOD SCHEMA
 * A proposal's operation is a small, closed record, and the reader has to make two distinctions a
 * schema cannot: `value` must be ABSENT for `remove` (Zod's `optional` accepts `null`, which is what
 * a model sends when it means "no value"), and `at` is only meaningful for `add`. Keeping the reader
 * here also keeps the whole patch format in one file, next to the engine that consumes it.
 *
 * WARNINGS rather than refusals for a non-JSON or `null` value: the operation is still ADDRESSABLE,
 * so the user is better served by the engine's own `type-mismatch` against the field it names than by
 * "the model's third operation was unreadable". One refusal case remains — a value that is not an
 * operation at all — because there is nothing to address.
 */
export function readWorldOp(value: JsonValue): WorldOpRead {
  const record = isPlainObject(value) ? value : undefined;
  if (record === undefined) return { ok: false, reason: 'not-an-operation' };
  const op = readVerb(member(record, 'op'));
  const rawPath = member(record, 'path');
  const path = typeof rawPath === 'string' ? rawPath : undefined;
  if (op === undefined || path === undefined) return { ok: false, reason: 'not-an-operation' };

  const raw = member(record, 'value');
  const warnings: WorldOpReadFailure[] = [];
  let read: JsonValue | undefined;
  if (raw !== undefined) {
    if (!isJsonValue(raw)) warnings.push('not-json');
    else if (raw === null) warnings.push('null-value');
    else read = raw;
  }
  const at = readIndex(member(record, 'at'));
  return {
    ok: true,
    warnings,
    op: {
      op,
      path,
      ...(read === undefined ? {} : { value: read }),
      ...(op === 'add' && at !== undefined ? { at } : {}),
    },
  };
}

/**
 * One member of an untrusted record.
 *
 * A PARAMETERISED key rather than `record.op`: this workspace compiles with
 * `noPropertyAccessFromIndexSignature` (which rejects dot access on an index signature) while
 * Biome's `useLiteralKeys` rejects the literal `record['op']` form. A key passed as an argument is
 * the one spelling both accept — the same conflict `cards/fields.ts` and `db/repository.ts` record.
 */
function member(record: { [key: string]: JsonValue }, key: string): JsonValue | undefined {
  return record[key];
}

/** One verb, or `undefined`. A `value` member that is present but not JSON is read as absent. */
function readVerb(value: JsonValue | undefined): PatchVerb | undefined {
  return typeof value === 'string' && (VERBS as readonly string[]).includes(value)
    ? (value as PatchVerb)
    : undefined;
}

/** An `at` member: a non-negative whole number, or `undefined` for "absent or unusable". */
function readIndex(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ───────────────────────────── navigating the payload ─────────────────────── */

/**
 * An array container, narrowed so an in-place write is typed.
 *
 * `value` is `JsonValue | undefined` because the question is asked at the two places an absent value
 * is ordinary — a pointer that names nothing yet (`add` creating a member) and an object member that
 * is not there — and `undefined` is not an array, so the guard answers `false` rather than needing a
 * second check at every call site.
 */
function isMutableArray(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where an operation writes: the container the last token addresses, and what that token names. */
interface Target {
  /** The value the last token names, or `undefined` when it names nothing yet (`add`). */
  readonly current: JsonValue | undefined;
  /** The container the last token addresses. */
  readonly container: Container;
  /**
   * True when `current` is a LIST — the operation targets that list (an append, an insert at `at`),
   * not the member that holds it.
   *
   * THIS IS THE CASE A POINTER ENDING AT A LIST IS, and it is not the same as the container being a
   * list: `/openingHooks` names the ARRAY inside an object, while `/openingHooks/0` names one of its
   * ITEMS. The two need telling apart because `add` means "append to the list" for the first and
   * "insert into the list" for the second — and `remove` / `replace` mean "one item" for both.
   */
  readonly list: boolean;
  /**
   * True when the last token names an EXISTING member the operation may address: a key of the object
   * `container`, or an index inside it. `false` for a position that does not exist yet — the only
   * thing `add` may create.
   */
  readonly keys: boolean;
  /** The value the last token addressed BEFORE this operation, for the type check. */
  readonly previous: JsonValue | undefined;
}

/**
 * Walk every token but the last, then describe the last one.
 *
 * `allowNew` is what separates `add` from the other two verbs: with it, a last token that names no
 * member of an object is a legal position (that is the member `add` creates), and a list index equal
 * to the list's length is the append position. Without it, the member must already exist.
 *
 * A MISSING POSITION AND AN ABSENT MEMBER ARE DIFFERENT ANSWERS — hence the union rather than
 * `Target | undefined`: one PATH is unusable (no such parent), while one MEMBER is simply not there
 * yet, and an `add` may create the second but never resurrect the first.
 */
function targetOf(
  document: JsonValue,
  tokens: readonly string[],
  allowNew: boolean,
): { readonly kind: 'missing' } | { readonly kind: 'found'; readonly target: Target } {
  const missing = { kind: 'missing' } as const;
  if (tokens.length === 0) return missing;
  let node: JsonValue = document;
  for (let depth = 0; depth < tokens.length - 1; depth += 1) {
    const token = tokens[depth];
    if (token === undefined) return missing;
    const step = isMutableArray(node)
      ? elementAt(node, token)
      : isJsonObject(node)
        ? node[token]
        : undefined;
    if (step === undefined) return missing;
    node = step;
  }
  const key = tokens[tokens.length - 1];
  if (key === undefined) return missing;

  // THE PARENT IS A LIST: the last token is one of its indices, or the whole list.
  if (isMutableArray(node)) {
    const index = arrayIndexOf(key);
    if (index === undefined) {
      // Not an index, so the token names the LIST itself: `add` appends or inserts, and `remove` /
      // `replace` have no member to address (`keys: false`).
      return {
        kind: 'found',
        target: { current: node, container: node, list: true, keys: false, previous: undefined },
      };
    }
    const bound = allowNew ? node.length : node.length - 1;
    if (index > bound) return missing;
    return {
      kind: 'found',
      target: {
        current: node[index],
        container: node,
        list: false,
        keys: true,
        previous: node[index],
      },
    };
  }
  if (!isJsonObject(node)) return missing;
  const current = node[key];
  if (current === undefined && !allowNew) return missing;
  // The token names a MEMBER of the parent object — and the member being compared above may itself be
  // a list (`/openingHooks` on a world), which is what `list` reports.
  return {
    kind: 'found',
    target: {
      current,
      container: node,
      list: isMutableArray(current),
      keys: current !== undefined,
      previous: current,
    },
  };
}

function elementAt(array: readonly JsonValue[], token: string): JsonValue | undefined {
  const index = arrayIndexOf(token);
  return index === undefined ? undefined : array[index];
}

/**
 * A copy of `document` with `mutate` applied to the container at `tokens`.
 *
 * Every container along the path is shallow-copied and the document is rebuilt outward, so the input
 * payload is never touched. That is what lets the preview of a patch be computed for a proposal the
 * user then REJECTS: the draft they are looking at cannot have been mutated by rendering its preview.
 *
 * The last copy is handed to `mutate` WITH its runtime shape — the list index when it is a list, the
 * member name when it is an object — because the token alone cannot say which one the operation means
 * (`/openingHooks` addresses a list; `/premise` addresses a member).
 */
function withAt(
  node: JsonValue,
  tokens: readonly string[],
  mutate: (container: Container, key: string, index: number | undefined) => void,
): JsonValue {
  const token = tokens[0];
  if (token === undefined) return node;
  if (tokens.length > 1) {
    const rest = tokens.slice(1);
    const child = isMutableArray(node)
      ? elementAt(node, token)
      : isJsonObject(node)
        ? node[token]
        : undefined;
    if (child === undefined) return node;
    const next = withAt(child, rest, mutate);
    const copy = shallowCopy(node);
    if (isMutableArray(copy)) {
      const index = arrayIndexOf(token);
      if (index !== undefined) copy[index] = next;
    } else if (isJsonObject(copy)) {
      copy[token] = next;
    }
    return copy;
  }
  const copy = shallowCopy(node);
  mutate(copy, token, isMutableArray(copy) ? arrayIndexOf(token) : undefined);
  return copy;
}

function shallowCopy(container: JsonValue): Container {
  return isMutableArray(container)
    ? [...container]
    : { ...(container as { [key: string]: JsonValue }) };
}

/**
 * Whether `next` may join the list `container`.
 *
 * An EMPTY list accepts anything: there is no sample to compare against, and `WorldDataSchema` is the
 * judge of whether the item belongs (a region row without an id is refused by `applyWorldOps`, with
 * the id's own path).
 */
function listAccepts(container: JsonValue | undefined, next: JsonValue): boolean {
  if (!isMutableArray(container)) return true;
  const sample = container[0];
  return sample === undefined ? true : sameKind(sample, next);
}

/* ─────────────────────────── validating operations ────────────────────────── */

/**
 * Why `ops` cannot be applied to `payload` — the list the preview and the apply both report.
 *
 * Pure and TOTAL: an empty array means "applying these operations produces a payload", and every
 * entry names the operation that failed and why. Each operation is checked against the result of the
 * ones before it, so `add` of a list row followed by a `replace` inside that row is checked in the
 * order it will be applied. Nothing mutates `payload`, so a refused patch leaves every caller's
 * value exactly as it was — the draft included.
 */
export function worldOpIssues(payload: WorldData, ops: readonly WorldOp[]): WorldOpIssue[] {
  if (ops.length > MAX_WORLD_OPS) {
    // One issue, not one per operation: the patch is over the bound as a whole, and thirty copies of
    // one sentence would bury the fact the user can act on.
    return [{ index: 0, op: 'add', path: '', kind: 'too-many-ops' }];
  }
  const issues: WorldOpIssue[] = [];
  let working: JsonValue = payload;
  for (const [index, op] of ops.entries()) {
    const outcome = applyOne(working, op);
    if ('failure' in outcome) {
      issues.push({ index, op: op.op, path: op.path, kind: outcome.failure });
      // Later operations would be checked against a document this one never produced, so their
      // verdict would be a guess. The FIRST failure is also what the panel prints.
      break;
    }
    working = outcome.document;
  }
  return issues;
}

/** One operation's outcome: the document it produced, or why it could not be produced. */
type OneOutcome = { readonly document: JsonValue } | { readonly failure: WorldOpFailure };

function applyOne(document: JsonValue, op: WorldOp): OneOutcome {
  const tokens = pointerTokens(op.path);
  if (tokens === undefined) return { failure: 'path-missing' };
  if (tokens.length === 0) return { failure: 'root' };
  const located = targetOf(document, tokens, op.op === 'add');
  if (located.kind === 'missing') return { failure: 'path-missing' };
  const { list, keys, previous, current } = located.target;
  // The list an `add` writes into: either the container itself (the parent was a list) or the member
  // that holds it (`/openingHooks` on a world). `list` says one of the two is a list.
  const listValue = isMutableArray(current) ? current : undefined;
  const length = listValue === undefined ? undefined : listValue.length;

  switch (op.op) {
    case 'remove': {
      if (!keys) return { failure: 'member-absent' };
      return {
        document: withAt(document, tokens, (copy, ownKey, ownIndex) => {
          if (isMutableArray(copy) && ownIndex !== undefined) copy.splice(ownIndex, 1);
          else if (!isMutableArray(copy)) delete copy[ownKey];
        }),
      };
    }
    case 'replace': {
      if (!keys || previous === undefined) return { failure: 'member-absent' };
      const next = op.value;
      if (next === undefined || next === null) return { failure: 'type-mismatch' };
      // A whole list may be replaced by another list — that is how a model rewrites `openingHooks`
      // wholesale — while a member keeps the kind it had.
      if (!list && !sameKind(previous, next)) return { failure: 'type-mismatch' };
      return {
        document: withAt(document, tokens, (copy, ownKey, ownIndex) => {
          if (isMutableArray(copy) && ownIndex !== undefined) copy[ownIndex] = next;
          else if (!isMutableArray(copy)) copy[ownKey] = next;
        }),
      };
    }
    case 'add': {
      // A LIST: append, or insert at `at`.
      if (list) {
        const next = op.value;
        if (next === undefined || next === null) return { failure: 'type-mismatch' };
        if (!listAccepts(current, next)) return { failure: 'type-mismatch' };
        const end = length ?? 0;
        const position = op.at ?? end;
        if (!Number.isSafeInteger(position) || position < 0 || position > end) {
          return { failure: 'path-missing' };
        }
        return {
          document: withAt(document, tokens, (copy, ownKey, ownIndex) => {
            // The container is the list itself, or the object member that holds it.
            if (isMutableArray(copy) && ownIndex === undefined) copy.splice(position, 0, next);
            else if (!isMutableArray(copy)) copy[ownKey] = insertInto(copy[ownKey], position, next);
          }),
        };
      }
      // A MEMBER: `add` only CREATES, so an existing member is `replace`'s business.
      if (keys) return { failure: 'member-exists' };
      const next = op.value;
      if (next === undefined || next === null) return { failure: 'type-mismatch' };
      return {
        document: withAt(document, tokens, (copy, ownKey) => {
          if (!isMutableArray(copy)) copy[ownKey] = next;
        }),
      };
    }
    default: {
      // Unreachable: `PatchVerb` has three members and each is handled above, so `op.op` is `never`
      // here. The branch keeps the switch total for a caller that assembled an op object by hand (a
      // test fixture) rather than returning `undefined` from a function typed to return an outcome.
      return { failure: 'path-missing' };
    }
  }
}

/** `list` with `value` inserted at `position`, as a NEW array (the input is never moved). */
function insertInto(list: JsonValue | undefined, position: number, value: JsonValue): JsonValue[] {
  const next = isMutableArray(list) ? [...list] : [];
  next.splice(position, 0, value);
  return next;
}

/** A list target's items, for the element-kind check. See `targetOf`'s `list` flag. */

/* ───────────────────────────── applying a patch ───────────────────────────── */

/** The answer of `applyWorldOps`: the payload a patch produces, or why it cannot be produced. */
export type ApplyWorldOpsResult =
  | { readonly ok: true; readonly data: WorldData }
  | {
      readonly ok: false;
      /** Why each operation failed. Empty when the operations applied but the result is not a world. */
      readonly issues: readonly WorldOpIssue[];
      /**
       * The schema's own path when the patch APPLIED but its result is not a `WorldData` (`name`
       * emptied, a calendar month blanked). Absent when an operation itself failed.
       */
      readonly schemaPath?: string;
    };

/**
 * The one function that turns `(payload, operations)` into the payload they produce.
 *
 * THE PREVIEW AND THE APPLY CALL THIS AND NOTHING ELSE. The panel renders `result.data` and
 * `state/co-create-store.ts` persists it, so the two cannot disagree about what a proposal does —
 * which is the property that makes previewing a patch meaningful at all. A refusal carries no data,
 * so a caller has nothing to render and nothing to write.
 */
export function applyWorldOps(payload: WorldData, ops: readonly WorldOp[]): ApplyWorldOpsResult {
  const issues = worldOpIssues(payload, ops);
  if (issues.length > 0) return { ok: false, issues };

  let working: JsonValue = payload;
  for (const op of ops) {
    const outcome = applyOne(working, op);
    if ('failure' in outcome) {
      // `worldOpIssues` already proved every operation applies, so reaching here is a bug in this
      // module. It is reported rather than thrown because this runs inside a render — the preview.
      return { ok: false, issues: [{ index: 0, op: op.op, path: op.path, kind: outcome.failure }] };
    }
    working = outcome.document;
  }

  const parsed = WorldDataSchema.safeParse(working);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, issues: [], schemaPath: issue === undefined ? '' : issue.path.join('.') };
  }
  return { ok: true, data: parsed.data };
}
