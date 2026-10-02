/**
 * The patch engine of AI 共创 (M1-W2), GENERALISED over a card kind so that M1-C2 (角色 AI 生成) and
 * M1-C3 (发言档案自动评估) reuse it instead of forking it.
 *
 * WHAT WAS GENERALISED, AND WHAT STAYED WORLD-SPECIFIC ON PURPOSE
 * The engine M1-W2/M1-W3/M1-W4 built was world-only for one reason: `applyWorldOps` ended in
 * `WorldDataSchema.safeParse` and the field inventory came from `cards/world.ts`. Nothing else in it
 * ever named a world — the verbs, JSON Pointer, the type-equality rule, the multi-operation loop and
 * the plan/scope machinery are all facts about a JSON DOCUMENT.
 *   • GENERALISED: the schema that validates a patch's result became a parameter (`CardTarget.parse`),
 *     the field inventory became a parameter (`CardTarget.paths`), and the step plan, the scope, the
 *     instruction and the proposal reader moved here unchanged in behaviour. `CardKind` travels with a
 *     request so a scope is always stated for a card kind and a stray operation can be named against
 *     it.
 *   • STAYED WORLD-SPECIFIC, in `co-create/proposal.ts`: the world's path table with its human labels,
 *     the world's step list, `customFields` path derivation and `coCreateInstructions`. Those are
 *     facts about a WORLD CARD, and `co-create/character.ts` holds the character's own.
 *
 * WHY THE VERBS AND THE `{op, path, value}` SHAPE ARE RFC 6902'S, BUT NOT ITS WHOLE WIRE FORMAT
 * The three verbs (`add` / `remove` / `replace`) and the JSON-Pointer target are RFC 6902, and the
 * operation is the object the RFC writes. Two details are this app's:
 *   • `add` on a LIST takes an optional `at`. The RFC spells an append as a `-` pointer TOKEN, and a
 *     token whose meaning depends on the verb that carries it is exactly the rule a model gets wrong;
 *     an explicit index keeps the pointer a pure address.
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
 * WHY THE RESULT IS VALIDATED AND NOT ONLY THE OPERATIONS
 * A patch whose every operation is legal can still produce an illegal document (`name: ''` is a legal
 * string and both card schemas say `min(1)`). The result is therefore parsed with the FROZEN SCHEMA
 * the target carries, and a refusal carries the Zod issue's own path — the same path the editor's
 * `worldIssues` / `characterIssues` would report a keystroke later.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { JsonValue } from '@smarttavern/schema';
import type { CardIssue } from '../cards/fields';

/* ─────────────────────────────── the card kinds ───────────────────────────── */

/**
 * The two cards this app co-creates.
 *
 * A discriminator rather than a second store: M1-W2's conversation, M1-W3's step walk, M1-W4's field
 * gestures, accept / reject / undo and the scope gate are one implementation parameterised by this
 * value (`state/co-create-store.ts` records how it is read and where it is checked).
 */
export type CardKind = 'world' | 'character';

/* ────────────────────────────── the request scope ─────────────────────────── */

/**
 * Why one request is being made. The store records it with the request, so the test that proves
 * 「不一次性生成全部」 can read the SHAPE of the flow off the wire rather than off the screen.
 */
export type CoCreateRequestKind =
  /** M1-W2's ordinary turn: the whole card is open for discussion. */
  | 'chat'
  /** M1-W3: one step of a generation plan. `step` names it. */
  | 'generate-step'
  /** M1-W4: one operation over the selected field. `fieldOp` says which gesture. */
  | 'field-op'
  /** M1-C3: the speaking-profile assessment, scoped to the fields it may score. */
  | 'voice-profile';

/** M1-W4's three gestures over a selected field, named by docs/06 §2.5 (重写 / 扩写 / 精简). */
export type FieldOpKind = 'rewrite' | 'expand' | 'condense';

/**
 * The paths one request may write, and why.
 *
 * `paths` is the ALLOW-LIST and nothing else: a path absent from it is refused, which is what makes
 * "the proposal covered only this field" a property of the store rather than of the model's
 * obedience. `excluded` carries the paths the model is told to leave alone, with the sentence half
 * that says why; it is informational and never consulted by the gate.
 *
 * `card` is the KIND this turn is scoped for, and it is what lets one store serve two cards: the gate,
 * the preview, the apply and the instruction all read the target it names (`co-create/plan.ts`'s
 * `patchPathsOf`, `co-create/target.ts`'s `CARD_TARGETS`).
 */
export interface CoCreateScope {
  readonly kind: CoCreateRequestKind;
  /** Which card this turn edits. */
  readonly card: CardKind;
  /** The step this turn belongs to (`generate-step` only). */
  readonly step?: string;
  /** The gesture this turn performs (`field-op` only). */
  readonly fieldOp?: FieldOpKind;
  /** The field this turn is about (`field-op` only) — the path the author selected. */
  readonly fieldPath?: string;
  /** Every pointer this turn may address. */
  readonly paths: readonly string[];
  /** Paths this turn must NOT address, each with the reason the model reads. */
  readonly excluded: readonly { readonly path: string; readonly why: string }[];
  /** The action sentence that opens the instruction, in plain ASCII (see `proposal.ts`). */
  readonly why: string;
}

/**
 * One request as it was actually sent. See `CoCreateRequestKind` for why this is recorded.
 *
 * `card` is recorded beside `kind` so a test can assert which CARD a flow was about as well as which
 * step of it, which is the difference M1-C2 adds to the same evidence M1-W3 shipped.
 */
export interface CoCreateRequest {
  readonly kind: CoCreateRequestKind;
  readonly card: CardKind;
  readonly step?: string;
  readonly fieldOp?: FieldOpKind;
  readonly paths: readonly string[];
  readonly instruction: string;
  /** The instruction WITHOUT the card and the path list: the part that says what this turn is. */
  readonly preamble: string;
}

/* ─────────────────────────── the target descriptor ────────────────────────── */

/** One payload path a proposal may write, with the label the editor renders for it. */
export interface PatchPath {
  /** A JSON Pointer into the payload (`/rulesOfNature/taboos`, `/voice/desire`). */
  readonly path: string;
  /** The form's own label for the field — the same key the editor prints beside the control. */
  readonly label: MessageKey;
}

/**
 * A parsed payload kind, as the engine needs it.
 *
 * `validate` is the whole of the schema coupling: it is `cards/world.ts`'s / `cards/character.ts`'s
 * own gate, so a patch over a character cannot be accepted by leaving the world's schema in place.
 * `issues` is the editor's own report, used by the store before it offers a turn whose result could
 * never be published.
 */
export interface PatchTarget {
  readonly kind: CardKind;
  /** Every editable leaf path of the form, in the form's own order. */
  readonly paths: readonly string[];
  /** The publish gate, as `cards/*.ts` computes it. */
  readonly validate: (value: unknown) => { readonly ok: boolean; readonly path: string };
  readonly issues: (value: unknown) => readonly CardIssue[];
}

/** A target whose payload type `P` is known at this call site. */
export interface CardTarget<P> extends PatchTarget {
  /** Parse an untrusted value as this card kind, or `undefined` when it is not one. */
  readonly parse: (value: unknown) => P | undefined;
}

/**
 * The target of each card kind, by kind, for a caller that has only the kind to go on.
 *
 * WHY THE TABLE IS BUILT LAZILY: `co-create/proposal.ts` and `co-create/character.ts` both hold their
 * own target, and this module is below both of them — importing them here would be a cycle. The two
 * registrations are performed by those modules (`registerCardTarget`), which run before any store
 * action can ask for one, and `cardTargetOf` THROWS on an unregistered kind rather than answering
 * `undefined`: an unregistered kind is a wiring mistake, and a silent fallback would preview a
 * character patch against the world's schema.
 */
const CARD_TARGETS = new Map<CardKind, CardTarget<unknown>>();

/** Register one kind's target. Called at module evaluation by the two card modules. */
export function registerCardTarget(target: CardTarget<unknown>): void {
  CARD_TARGETS.set(target.kind, target);
}

/** The target of one card kind, or a throw when the kind was never registered. See the table above. */
export function cardTargetOf(kind: CardKind): CardTarget<unknown> {
  const target = CARD_TARGETS.get(kind);
  if (target === undefined) {
    throw new Error(`co-create: no patch target is registered for the ${kind} card`);
  }
  return target;
}

/* ─────────────────────────────── JSON Pointer ─────────────────────────────── */

/**
 * The tokens of a JSON Pointer, or `undefined` when the string is not one.
 *
 * RFC 6901: `''` is the whole document; otherwise the string starts with `/` and every token is
 * `~1`-then-`~0` unescaped (that order is the RFC's, and reversing it turns `~01` into `/`).
 * The `-` token the RFC reserves for "past the last array element" is REFUSED here — this engine
 * takes an explicit `at` for an append (see `PatchOp`), so `-` would be a second spelling of one
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

/** One dotted form path as a JSON Pointer (`rulesOfNature.taboos` -> `/rulesOfNature/taboos`). */
export function pointerOf(dotted: string): string {
  return `/${dotted.split('.').join('/')}`;
}

/** One pointer as a dotted path, with every token unescaped.
 *
 * The one function that turns a pointer back into the form's own vocabulary, which is what a STEP
 * needs: a step covers a whole GROUP of fields (`calendar.months`), so the gate has to ask whether one
 * path is a prefix of another in form vocabulary rather than in pointer text, where `/calendar/month`
 * would read as a prefix of `/calendar/months`.
 */
export function dottedOf(pointer: string): string {
  if (pointer === '') return '';
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.split('~1').join('/').split('~0').join('~'))
    .join('.');
}

/**
 * One member of a payload, read by its DOTTED path, or `undefined` when there is no such member.
 *
 * WHY THE PATH IS WALKED AS A STRING AND NOT TYPED: a payload has index-free members, so a typed read
 * would need a `keyof` chain the caller cannot express from a runtime path. This is the same shape
 * `cards/fields.ts`'s `memberOf`/`memberValue` use for untrusted data, and it answers `undefined` for a
 * path that does not exist — which `patchPathValue` then prints as absent rather than as an empty
 * string, because "the field is empty" and "there is no such field" are different facts for a model
 * about to write it.
 */
export function readJsonPath(data: unknown, dotted: string): JsonValue | undefined {
  let node: unknown = data;
  for (const token of dotted.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as { [key: string]: unknown })[token];
  }
  return node as JsonValue | undefined;
}

/**
 * One field value as an instruction quotes it: JSON so a list stays legible as a list, and an explicit
 * sentence when the path does not exist yet.
 */
export function patchPathValue(data: unknown, dotted: string): string {
  const value = readJsonPath(data, dotted);
  if (value === undefined) return '(this field does not exist in the card yet)';
  return JSON.stringify(value);
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

/**
 * True when `path` is `root` itself or something inside it, compared TOKEN BY TOKEN.
 *
 * WHY TOKENS AND NOT TEXT (M1-W3's acceptance for 字段级 AI 操作): a scope on `/narrative/style` must not
 * authorise a write to `/narrative/styles`, and a text prefix cannot tell them apart. NaN-free and
 * total: a path that is not a pointer addresses nothing, so it is never inside a scope — and `applyOps`
 * reports it as `path-missing` a moment later, which is where that belongs.
 */
export function isPathWithin(root: string, path: string): boolean {
  const rootTokens = pointerTokens(root);
  const pathTokens = pointerTokens(path);
  if (rootTokens === undefined || pathTokens === undefined) return false;
  if (pathTokens.length < rootTokens.length) return false;
  return rootTokens.every((token, index) => pathTokens[index] === token);
}

/**
 * Why one path is not offerable in a turn, in the sentence the model reads.
 *
 * One sentence, one meaning, because the model reads it beside a path list and a longer explanation is
 * a longer thing to disobey: the path is not wrong, it is simply not this turn's.
 */
export function excludedWhyFor(kind: 'later-step' | 'app-setting' | 'not-offered'): string {
  switch (kind) {
    case 'later-step':
      return 'reserved for a later step of this generation';
    case 'app-setting':
      return 'a calendar or pacing setting the author keeps by hand';
    default:
      return 'not offered for editing';
  }
}

/* ─────────────────────────────── JSON values ─────────────────────────────── */

/**
 * True when a value is JSON this app may store.
 *
 * `null` is JSON and `JsonValue` declares it, so it passes HERE; refusing it for a card field is a
 * rule about that document (`type-mismatch`), not about JSON.
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
 * reverse is refused, because `stepMinutes: 30.5` is a value an `int()` schema rejects and refusing it
 * here is what keeps the preview and the apply in agreement.
 */
function sameKind(current: JsonValue, next: JsonValue): boolean {
  const currentKind = kindOf(current);
  const nextKind = kindOf(next);
  if (currentKind === nextKind) return true;
  return currentKind === 'number' && nextKind === 'number-int';
}

/* ─────────────────────────────── the operations ───────────────────────────── */

/** The three verbs a proposal may use. See the header for what each one requires. */
export type PatchVerb = 'add' | 'remove' | 'replace';

/**
 * One operation over the payload.
 *
 * `value` is absent for `remove`; `at` is present only for `add` into a list. This is the PARSED
 * form — `readPatchOp` builds it, and it checks every member — and never a cast of untrusted JSON.
 */
export interface PatchOp {
  readonly op: PatchVerb;
  /** A JSON Pointer into the payload (`/rulesOfNature/taboos`, `/voice/desire`). */
  readonly path: string;
  /** The value `add` / `replace` writes. JSON by construction; see `readPatchOp`. */
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
export type PatchOpFailure =
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
  /** The patch carries more operations than `MAX_PROPOSAL_OPS`. */
  | 'too-many-ops';

/** One failed operation, with the index and pointer the panel prints. */
export interface PatchOpIssue {
  readonly index: number;
  readonly op: PatchVerb;
  readonly path: string;
  readonly kind: PatchOpFailure;
}

/**
 * The most operations one proposal may carry, and the deepest pointer one path may be.
 *
 * Both guard against an ANSWER, not against a user. A model that echoes a whole payload back as
 * five hundred `replace` operations has not proposed an edit anybody can judge, and no leaf of either
 * card is deeper than five tokens. A patch over either bound is a reported failure the user can
 * retry — not a hang, and not a silent truncation.
 */
export const MAX_PROPOSAL_OPS = 32;
export const MAX_POINTER_TOKENS = 8;

/** Why a JSON value in an operation is unusable — the two reasons `readPatchOp` reports. */
export type PatchOpReadFailure = 'not-json' | 'null-value';

/** One operation, or the reason the value cannot be one. */
export type PatchOpRead =
  | { readonly ok: true; readonly op: PatchOp; readonly warnings: readonly PatchOpReadFailure[] }
  | { readonly ok: false; readonly reason: 'not-an-operation' };

const VERBS: readonly PatchVerb[] = ['add', 'remove', 'replace'];

/**
 * The JSON Schema a vendor is asked to constrain its answer with (`ChatRequest.responseSchema`).
 *
 * Deliberately LOOSE about the operation objects (`additionalProperties: true`, no per-verb
 * `required`): a vendor that enforces it should refuse a sentence, not refuse a proposal because this
 * schema is stricter than the reader. `readPatchOp` is the reader that decides, and the adapter leaves
 * `strict` off for the same reason (`openai-compatible.ts` records it).
 *
 * CARD-KIND FREE and therefore shared: the wire format of a proposal is the same object whichever
 * card it edits, and a second schema per kind would be a second thing to keep in step with
 * `readProposal`.
 */
export const PROPOSAL_RESPONSE_SCHEMA: JsonValue = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    rationale: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'remove', 'replace'] },
          path: { type: 'string' },
          value: {},
          at: { type: 'integer' },
        },
        required: ['op', 'path'],
        additionalProperties: true,
      },
    },
  },
  required: ['message', 'ops'],
  additionalProperties: true,
};

/**
 * Read one untrusted JSON value as a `PatchOp`.
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
export function readPatchOp(value: JsonValue): PatchOpRead {
  const record = isPlainObject(value) ? value : undefined;
  if (record === undefined) return { ok: false, reason: 'not-an-operation' };
  const op = readVerb(member(record, 'op'));
  const rawPath = member(record, 'path');
  const path = typeof rawPath === 'string' ? rawPath : undefined;
  if (op === undefined || path === undefined) return { ok: false, reason: 'not-an-operation' };

  const raw = member(record, 'value');
  const warnings: PatchOpReadFailure[] = [];
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
 * `noPropertyAccessFromIndexSignature` (which rejects dot access on an index signature) while Biome's
 * `useLiteralKeys` rejects the literal `record['op']` form. A key passed as an argument is the one
 * spelling both accept — the same conflict `cards/fields.ts` and `db/repository.ts` record.
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
  // a list (`/openingHooks` on a world, `/voice/roles` on a character), which is what `list` reports.
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
 * An EMPTY list accepts anything: there is no sample to compare against, and the card's schema is the
 * judge of whether the item belongs (a region row without an id is refused by `applyOps`, with the
 * id's own path).
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
export function opIssues(payload: JsonValue, ops: readonly PatchOp[]): PatchOpIssue[] {
  if (ops.length > MAX_PROPOSAL_OPS) {
    // One issue, not one per operation: the patch is over the bound as a whole, and thirty copies of
    // one sentence would bury the fact the user can act on.
    return [{ index: 0, op: 'add', path: '', kind: 'too-many-ops' }];
  }
  const issues: PatchOpIssue[] = [];
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
type OneOutcome = { readonly document: JsonValue } | { readonly failure: PatchOpFailure };

function applyOne(document: JsonValue, op: PatchOp): OneOutcome {
  const tokens = pointerTokens(op.path);
  if (tokens === undefined) return { failure: 'path-missing' };
  if (tokens.length === 0) return { failure: 'root' };
  const located = targetOf(document, tokens, op.op === 'add');
  if (located.kind === 'missing') return { failure: 'path-missing' };
  const { list, keys, previous, current } = located.target;
  // The list an `add` writes into: either the container itself (the parent was a list) or the member
  // that holds it (`/openingHooks` on a world, `/voice/roles` on a character). `list` says one of the
  // two is a list.
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
      // or `roles` wholesale — while a member keeps the kind it had.
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

/* ───────────────────────────── applying a patch ───────────────────────────── */

/** The answer of `applyOps`: the payload a patch produces, or why it cannot be produced. */
export interface ApplyOpsResult<P> {
  readonly ok: true;
  readonly data: P;
}
/** The refusal half, kept separate so a caller can narrow on `ok` alone. */
export interface ApplyOpsRefusal {
  readonly ok: false;
  /** Why each operation failed. Empty when the operations applied but the result is not a card. */
  readonly issues: readonly PatchOpIssue[];
  /**
   * The schema's own path when the patch APPLIED but its result is not a card (`name` emptied, a
   * calendar month blanked). Absent when an operation itself failed.
   */
  readonly schemaPath?: string;
}

/**
 * The one function that turns `(payload, operations)` into the payload they produce.
 *
 * THE PREVIEW AND THE APPLY CALL THIS AND NOTHING ELSE. The panel renders `result.data` and
 * `state/co-create-store.ts` persists it, so the two cannot disagree about what a proposal does —
 * which is the property that makes previewing a patch meaningful at all. A refusal carries no data,
 * so a caller has nothing to render and nothing to write.
 *
 * The document is handled as `JsonValue` and only the RESULT is judged by the target's schema, which
 * is what makes this one implementation serve two card kinds: nothing in the loop above knows what a
 * card is.
 */
export function applyOps<P>(
  target: CardTarget<P>,
  payload: P,
  ops: readonly PatchOp[],
): ApplyOpsResult<P> | ApplyOpsRefusal {
  const issues = opIssues(payload as JsonValue, ops);
  if (issues.length > 0) return { ok: false, issues };

  let working: JsonValue = payload as JsonValue;
  for (const op of ops) {
    const outcome = applyOne(working, op);
    if ('failure' in outcome) {
      // `opIssues` already proved every operation applies, so reaching here is a bug in this
      // module. It is reported rather than thrown because this runs inside a render — the preview.
      return { ok: false, issues: [{ index: 0, op: op.op, path: op.path, kind: outcome.failure }] };
    }
    working = outcome.document;
  }

  // THE TARGET'S OWN PARSER, not a schema named here: this is the line that made the engine
  // world-specific before M1-C2, and it is now the parameter that makes it a card engine.
  const parsed = target.parse(working);
  if (parsed === undefined) {
    const issue = target.issues(working)[0];
    return { ok: false, issues: [], schemaPath: issue?.path ?? '' };
  }
  return { ok: true, data: parsed };
}

/** True when two payloads are the same document, compared as JSON text. */
export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/* ──────────────────────────── reading the answer ──────────────────────────── */

/** A proposal the model produced, as data. Nothing here has been written anywhere. */
export interface CoCreateProposal {
  readonly id: string;
  /** The operations, in the order the model wrote them. */
  readonly ops: readonly PatchOp[];
  /** The conversational half of the answer — what the author reads in the transcript. */
  readonly message: string;
  /** Why these edits, when the model said. */
  readonly rationale?: string;
  /** True when the answer carried no operations (a turn that only talked). */
  readonly empty: boolean;
}

/** Why an answer could not be read as a proposal. One case, one catalog sentence. */
export type MalformedProposalReason =
  /** No JSON object in the answer at all (prose, a rejected request, a truncated stream). */
  | 'no-json'
  /** A JSON object, but not one carrying an `ops` array. */
  | 'no-ops'
  /** An entry of `ops` was not an operation. */
  | 'not-an-operation'
  /** More operations than the engine accepts (`MAX_PROPOSAL_OPS`). */
  | 'too-many-ops';

/** An answer that is not a usable proposal — the finding the user reads, and retries from. */
export interface MalformedProposal {
  readonly reason: MalformedProposalReason;
  /** Whatever text came with it, so the panel can still show the model's own reply. */
  readonly message: string;
  /**
   * The model's answer VERBATIM, whatever shape it was in.
   *
   * It is what the user needs to decide whether 「再试一次」 is worth pressing — a reader that threw
   * the answer away would leave them staring at "that was not a proposal" with no idea whether the
   * model answered something useful in the wrong shape or nothing at all.
   */
  readonly text: string;
}

/** The reader's answer: a proposal, or the reason there is none. */
export type ProposalRead =
  | { readonly ok: true; readonly proposal: CoCreateProposal }
  | { readonly ok: false; readonly malformed: MalformedProposal };

/**
 * Read a model's text into a proposal.
 *
 * CARD-KIND FREE ON PURPOSE: the wire format is the same JSON object for a world and a character, and
 * the operations are judged later against the scope (which IS kind-specific) and against the target's
 * schema. A second reader per kind would be a second answer to "what is a proposal".
 *
 * THREE TOLERANCES, EACH BECAUSE THE ALTERNATIVE IS A DEAD END FOR THE USER:
 *   1. the JSON may be wrapped in a ``` fence, which chat models emit even when asked not to;
 *   2. it may be surrounded by prose (`Sure, here is the patch:`), so the object is located by
 *      balanced braces rather than required to be the whole answer;
 *   3. a non-JSON `value` inside an operation is left to the ENGINE's verdict (`readPatchOp` records
 *      the op with a warning), so the author reads "that value does not fit the field it names" — a
 *      sentence about their card — instead of "the model sent something odd".
 * What is NOT tolerated is a missing `ops` array or an entry that is not an operation: there is
 * nothing to preview then, and inventing one would be editing the author's card on a guess.
 */
export function readProposal(text: string, id: string): ProposalRead {
  const raw = text.trim();
  const found = firstJsonObject(text);
  if (found === undefined) {
    return { ok: false, malformed: { reason: 'no-json', message: raw, text: raw } };
  }
  const record = isRecord(found) ? found : {};
  const rawMessage = member2(record, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  const reject = (reason: MalformedProposalReason): ProposalRead => ({
    ok: false,
    malformed: { reason, message, text: raw },
  });
  const ops = member2(record, 'ops');
  if (!Array.isArray(ops)) return reject('no-ops');

  const read: PatchOp[] = [];
  for (const entry of ops) {
    const outcome = readPatchOp(entry as JsonValue);
    if (!outcome.ok) return reject('not-an-operation');
    read.push(outcome.op);
  }
  if (read.length > MAX_PROPOSAL_OPS) return reject('too-many-ops');

  const rawRationale = member2(record, 'rationale');
  const rationale = typeof rawRationale === 'string' ? rawRationale : undefined;
  return {
    ok: true,
    proposal: {
      id,
      ops: read,
      message,
      ...(rationale === undefined ? {} : { rationale }),
      // An EMPTY `ops` is a VALID answer: "not enough is decided yet, here is my question". It is the
      // shape the conversation needs, and treating it as malformed would stop the model asking
      // anything at all.
      empty: read.length === 0,
    },
  };
}

/**
 * One member of the parsed answer.
 *
 * A PARAMETERISED key rather than `record.message`: this workspace compiles with
 * `noPropertyAccessFromIndexSignature` (which rejects dot access on an index signature) while Biome's
 * `useLiteralKeys` rejects the literal `record['message']` form. A key passed as an argument is the
 * one spelling both accept — the conflict `cards/fields.ts` records.
 */
function member2(record: { [key: string]: unknown }, key: string): unknown {
  return record[key];
}

/**
 * The first balanced JSON object in a text answer.
 *
 * Bracket-counting rather than a regex, and string-aware: a `}` inside a quoted value (`"a } b"`) or
 * an escaped quote must not end the scan early, or the reader would hand back a truncated object and
 * report a plausible-looking failure about the model's JSON. A fenced block needs no special case —
 * the object inside it is simply the first balanced one.
 */
function firstJsonObject(text: string): unknown {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    const slice = balancedObjectAt(text, start);
    if (slice === undefined) continue;
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      // Not JSON after all (a prose `{`); keep looking for the next candidate.
    }
  }
  return undefined;
}

/** The slice from `start` through the `}` that closes it, or `undefined` when it never closes. */
function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ──────────────────── the ONE path from (draft, proposal) ─────────────────── */

/** Why a proposal cannot become a payload — the preview's and the apply's shared verdict. */
export type ProposalRefusal =
  /** An operation could not be applied; `issues` names the first one that failed. */
  | { readonly kind: 'ops'; readonly issues: readonly PatchOpIssue[] }
  /** The operations applied, but the result is not a valid card of this kind. */
  | { readonly kind: 'schema'; readonly path: string };

/** What a proposal would do to a payload. */
export type ProposalPreview<P> =
  | { readonly ok: true; readonly data: P }
  | { readonly ok: false; readonly refusal: ProposalRefusal };

/**
 * The ONE function that turns `(draft payload, proposal)` into the payload the proposal proposes.
 *
 * WHY THIS EXISTS, AND WHY IT IS ONE FUNCTION
 * The right-hand live preview must be computed from the PROPOSED payload, not from the applied one —
 * that is the entire point of previewing. If the panel computed the preview one way and the store
 * applied it another, a user could accept a change they never saw. So both call THIS:
 * `co-create/panel.tsx` renders `preview.data`, `state/co-create-store.ts` persists it, and inside
 * both sits `applyOps` — there is no second spelling of "what this proposal does" for the two to
 * drift apart into.
 *
 * A proposal whose result EQUALS the draft is not refused here: equality is a fact about the author's
 * card rather than a defect in the patch, and the store reports it as its own answer. This function's
 * contract is only "what would the payload become".
 */
export function previewProposal<P>(
  target: CardTarget<P>,
  data: P,
  proposal: Pick<CoCreateProposal, 'ops'>,
): ProposalPreview<P> {
  const result = applyOps(target, data, proposal.ops);
  if (result.ok) return { ok: true, data: result.data };
  const issue = result.issues[0];
  if (issue === undefined) {
    return { ok: false, refusal: { kind: 'schema', path: result.schemaPath ?? '' } };
  }
  return { ok: false, refusal: { kind: 'ops', issues: [issue] } };
}

/* ───────────────────────────── display helpers ────────────────────────────── */

/**
 * The catalogued labels of a form, by the DOTTED path a proposal addresses.
 *
 * A table built from the editor's own descriptor tables (`labelEntries`), plus the GROUP headings for
 * paths that carry no descriptor — a list, or a group edited one level down. Both kinds build one:
 * `proposal.ts` for the world, `character.ts` for the character.
 */
export class PathLabels {
  private readonly table: ReadonlyMap<string, MessageKey>;
  private readonly groups: ReadonlyMap<string, MessageKey>;

  /**
   * `entries` are the descriptor tables; `composite` are the paths a form renders as a GROUP or a
   * LIST with a heading of their own (`calendar`, `regions`, `visual.outfits`) — the previous
   * hard-coded list in `proposal.ts`, now a parameter so the character's own headings can be stated
   * without a second labeler.
   */
  constructor(
    entries: readonly (readonly [string, MessageKey])[],
    composite: readonly (readonly [string, MessageKey])[] = [],
  ) {
    this.table = new Map([...entries, ...composite]);
    this.groups = groupLabels(entries, composite);
  }

  /**
   * The label for one dotted path: its own descriptor, else the nearest GROUP heading that HAS one.
   *
   * WHY IT WALKS UP INSTEAD OF CHECKING THE IMMEDIATE PARENT: a form's descriptors are as deep as
   * `visual.style.preset`, so the parent of a path without one of its own is often a group with no
   * label either (`visual.style`, `narrative`) — and the one-token version answered the generic
   * fallback for `/narrative/themes`, which is a WRONG label rather than a missing one, printed beside
   * the control the field belongs to. The walk stops at a path with a descriptor or at a composite
   * heading, and the generic fallback is reached only when the path is under no named group at all — a
   * `customFields` key, which has no heading by design.
   */
  labelFor(dotted: string): MessageKey {
    const keys = candidateKeys(dotted);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      const label = this.table.get(labelKey(key)) ?? this.groups.get(key);
      if (label !== undefined) return label;
    }
    return 'common.customFieldsTitle';
  }

  /** The label of an operation's target, or `undefined` when the form has none of its own. */
  labelOf(pointer: string): MessageKey | undefined {
    return this.table.get(dottedOf(pointer));
  }
}

/** The `/a`, `/a/b` prefixes of one dotted path, longest first (`a.b.c` -> `/a/b/c`, `/a/b`, `/a`). */
function candidateKeys(dotted: string): string[] {
  const parts = dotted.split('.');
  let pointer = '';
  const keys: string[] = [];
  for (const part of parts) {
    pointer = `${pointer}/${part}`;
    keys.push(pointer);
  }
  return keys;
}

/** The shortest `/`-prefix of a path: its TOP-LEVEL group (`a.b.c` -> `/a`, `name` -> `/name`). */
function rootKey(dotted: string): string {
  return candidateKeys(dotted)[0] ?? '';
}

/** One `/`-prefix as the dotted spelling `PathLabels` is keyed by (`/rulesOfNature/taboos`). */
function labelKey(pointer: string): string {
  return dottedOf(pointer);
}

/**
 * Every group heading a form's descriptors introduce.
 *
 * The prefixes are walked LONGEST FIRST so that a two-token group wins over its own parent: the group
 * `visual.style` must be read before `visual`, or every style field would be labelled with the visual
 * bible's heading instead of its own.
 */
function groupLabels(
  entries: readonly (readonly [string, MessageKey])[],
  composite: readonly (readonly [string, MessageKey])[],
): ReadonlyMap<string, MessageKey> {
  const found = new Map<string, MessageKey>();
  for (const [dotted, label] of entries) {
    // The last token is the FIELD's own name; the prefix before it names the group it lives in.
    const keys = candidateKeys(dotted);
    const group = keys[keys.length - 2];
    if (group !== undefined && !found.has(group)) found.set(group, label);
  }
  for (const [dotted, label] of composite) {
    const key = rootKey(dotted);
    if (key !== '' && !found.has(key)) found.set(key, label);
  }
  return found;
}

/**
 * The `customFields` keys that already exist, as paths the model may address.
 *
 * WHY THE MODEL NEEDS THESE AT ALL: `customFields` is where a user keeps the fields this schema does
 * not have (「天气」, 「禁忌」), so a co-creation turn that could not fill them would be useless exactly
 * where the user has already said what they want. Each key is ESCAPED (`escapePointerToken`'s rule):
 * a field called `a/b` is ordinary data, and a raw pointer built from it would address another field.
 *
 * SHARED BY BOTH KINDS: `customFields` is `Record<string, string>` on a world AND on a character
 * (`docs/02` §4), so the derivation is one function and not one per card.
 */
export function customFieldPaths(data: {
  readonly customFields?: { [key: string]: string };
}): PatchPath[] {
  return Object.keys(data.customFields ?? {}).map((key) => ({
    path: `/customFields/${escapePointerToken(key)}`,
    label: 'common.customFieldsTitle',
  }));
}

/* ──────────────────────────── what the model is asked ─────────────────────── */

/**
 * The part of an instruction that never varies between cards: the role, the answer format and the
 * rules of the operation format.
 *
 * WHY THIS TEXT USES ASCII PUNCTUATION ONLY (`-`, never an em dash)
 * ADR-030's rule for the built-in preset applies here — prompt text is CONTENT and must not follow
 * the interface language — but `tools/scripts/check-i18n-literals.mjs` cannot tell a prompt from a
 * label: it flags any literal containing a Han character OR one of the CJK punctuation marks this
 * project writes. The honest reading of that rule for an instruction nobody in the app ever reads is
 * that the text should not LOOK like interface copy, which for an English instruction means writing
 * it in plain ASCII. Nothing about it is translated, and it stays inline here for the reason
 * `chat/builtin-content.ts` records: that file is the one carrying a documented exemption because it
 * holds Chinese CONTENT, and this text needs no exemption at all.
 *
 * WHY THE CARD NOUN IS A PARAMETER: `co-create/character.ts` asks about a CHARACTER CARD and
 * `proposal.ts` about a WORLD CARD, and a shared constant that said "world" for both would tell a
 * model editing a character that it is world-building.
 */
function instructionFormat(cardNoun: string): string[] {
  return [
    `You are co-writing a ${cardNoun} for a role-playing app with its author, one turn at a time.`,
    'You are NOT the game master here and this is NOT the role-play transcript: you discuss the card',
    'and propose concrete edits to it.',
    '',
    'HOW TO EDIT: answer with ONE JSON object and nothing else - no prose around it, no markdown fence:',
    '{"message": "<your reply to the author>", "rationale": "<why these edits>", "ops": [<operation>]}',
    '',
    'An operation is an RFC 6902 style object addressed at the CURRENT card below:',
    '- {"op":"replace","path":"/era","value":"..."}   change a value that already exists',
    '- {"op":"add","path":"/regions","value":{...}}    insert a new item into a list (optional "at": n,',
    '                                                  default is the end of the list)',
    '- {"op":"remove","path":"/openingHooks/0"}        delete a value',
    'Rules: a path is a JSON Pointer; "add" only creates (use "replace" to change something); a number',
    'must be an integer where the card has an integer; never write null; keep the JSON types the card',
    `already uses. The result must still be a valid ${cardNoun}, or the proposal is refused.`,
    'If nothing should change yet, answer with "ops": [] and ask your question in "message".',
  ];
}

/**
 * The "PATHS YOU MAY EDIT" block, as the lines a model reads.
 *
 * The LABEL is the form's own catalog key and is printed as its key rather than as a translated
 * sentence, because prompt text must not follow the interface language (`instructionFormat`). It is
 * still useful to the model: it is the editor's own name for the field, in one word.
 */
export function patchPathLines(paths: readonly PatchPath[]): string[] {
  return paths.map((entry) => `- ${entry.path}  (${entry.label})`);
}

/**
 * The system instruction for one UNSCOPED co-creation turn over a card.
 *
 * BUILT FROM THE DRAFT, NOT FROM A CONSTANT, so the model edits what the user is actually looking at:
 * the paths the form renders, the payload itself, and the rules of the operation format. `data` is the
 * PAYLOAD only — `cards/draft.ts`'s `extensions` bag is the plugin channel, and an AI turn has no
 * business reading or writing it.
 *
 * WHY THE CARD NOUN IS A PARAMETER: `co-create/character.ts` asks about a CHARACTER CARD and
 * `proposal.ts` about a WORLD CARD, and a shared constant that said "world" for both would tell a
 * model editing a character that it is world-building.
 */
export function cardInstructions(
  cardNoun: string,
  paths: readonly PatchPath[],
  data: unknown,
): string {
  return [
    ...instructionFormat(cardNoun),
    '',
    'PATHS YOU MAY EDIT:',
    ...patchPathLines(paths),
    '',
    'THE CURRENT CARD (JSON - the payload the author is editing):',
    JSON.stringify(data, null, 2),
  ].join('\n');
}

/** The two words an instruction calls each card kind, so one sentence serves both without lying. */
export function cardNounOf(kind: CardKind): string {
  return kind === 'world' ? 'WORLD CARD' : 'CHARACTER CARD';
}

/** One step: a name, the heading the UI prints, and the inventory paths it covers. */
export interface StepDefinition {
  /** Stable id, also the `CoCreateRequest.step` the wire record and the tests read. */
  readonly id: string;
  /** The heading the UI prints for the step. */
  readonly label: MessageKey;
  /** Inventory paths (pointers) this step covers. Checked against the inventory at module load. */
  readonly paths: readonly string[];
}

/** One step of a plan as the store and the UI use it. */
export interface CoCreateStep {
  readonly id: string;
  readonly label: MessageKey;
  readonly paths: readonly string[];
}

/**
 * One generation plan: the steps, plus the two path sets every request is built from.
 *
 * `contentPaths` is the CONTENT fields of the form — the ones a plan may cover at all. It is what lets
 * a step's instruction name the reserved block (a world's clock, a character's generation parameters)
 * as the author's own without the plan having to know which of those paths exist: it is the difference
 * between the two sets.
 */
export interface CoCreateGenerationPlan {
  /** Which card this plan writes, so a request built from it can state the kind it is scoped for. */
  readonly kind: CardKind;
  /** A plan id, so a request record names the plan it belongs to. */
  readonly id: string;
  readonly steps: readonly CoCreateStep[];
  /** Every path the plan covers. */
  readonly paths: readonly string[];
  /** Every editable content path of the form. See the header for what is not one. */
  readonly contentPaths: readonly string[];
  /** The paths of the form that no plan covers. Rendered as the author's own. */
  readonly reservedPaths: readonly string[];
}

/** The inventory a plan is checked against: the form's paths and the ones it deliberately excludes. */
export interface PlanInventory {
  readonly kind: CardKind;
  readonly paths: readonly string[];
  readonly reservedPaths: readonly string[];
}

/**
 * Refuse to load when the step definitions and the form's own inventory disagree.
 *
 * WHY THIS THROWS AT MODULE EVALUATION RATHER THAN SOMEWHERE IN A UI: the invariant is about SOURCE,
 * not about a user's card — a field in no step is a field nobody can generate, and it would be
 * discovered by a reviewer reading two lists rather than by the program. Throwing here turns that into a
 * failing import, which every test and every dev-server reload sees immediately.
 *
 * `coverage` separates the two kinds of plan the app builds, because only one of them can promise full
 * coverage:
 *   • `'whole-card'` — 「从零生成」. EVERY editable content field must be in exactly one step, which is
 *     the assertion M1-W3's 「不一次性生成全部」 rests on: the plan is what makes the flow structured, and
 *     a field no step owns could never be generated at all.
 *   • `'subset'` — 「逐字段生成」 and M1-W4's single-field gesture. The step list is deliberately a
 *     SUBSET, so demanding full coverage would make those modes impossible. The half that still holds is
 *     the one above: every path a step claims is a path the form renders, is not reserved, and is claimed
 *     by no other step. Full coverage is still asserted for the world and character inventories at module
 *     evaluation by `co-create/plan.ts`'s first whole-card plan.
 */
export function buildPlan(
  inventory: PlanInventory,
  id: string,
  definitions: readonly StepDefinition[],
  coverage: 'whole-card' | 'subset' = 'whole-card',
): CoCreateGenerationPlan {
  const offered = new Set(inventory.paths);
  const reserved = new Set(inventory.reservedPaths);
  const content = inventory.paths.filter((path) => !reserved.has(path));
  const contentSet = new Set(content);
  const covered = new Map<string, string>();
  for (const step of definitions) {
    for (const path of step.paths) {
      if (!offered.has(path)) {
        throw new Error(
          `co-create plan: step ${step.id} claims ${path}, which the form does not offer`,
        );
      }
      if (!contentSet.has(path)) {
        throw new Error(`co-create plan: step ${step.id} claims ${path}, which is reserved`);
      }
      const owner = covered.get(path);
      if (owner !== undefined) {
        throw new Error(`co-create plan: ${path} is in both ${owner} and ${step.id}`);
      }
      covered.set(path, step.id);
    }
  }
  // THE COVERAGE HALF APPLIES TO A WHOLE-CARD PLAN ONLY. A field operation is a one-step plan over the
  // ONE field the author selected, so "every content field is generated" is false BY CONSTRUCTION — and
  // demanding it would make M1-W4 impossible. What still holds for it is the half above: every path it
  // claims is a path the form renders and no other step owns.
  if (coverage === 'whole-card') {
    const missing = content.filter((path) => !covered.has(path));
    if (missing.length > 0) {
      throw new Error(`co-create plan: no step generates ${missing.join(', ')}`);
    }
  }
  return {
    kind: inventory.kind,
    id,
    steps: definitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      paths: definition.paths,
    })),
    paths: definitions.flatMap((definition) => definition.paths),
    contentPaths: content,
    reservedPaths: inventory.reservedPaths,
  };
}
