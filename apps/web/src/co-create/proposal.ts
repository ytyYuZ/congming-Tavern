/**
 * What a proposal IS (M1-W2): the format a model is asked for, the tolerant reader that turns a text
 * answer into it, and the one function `(draft, proposal) -> payload` that the preview and the apply
 * both go through.
 *
 * WHERE THE FORMAT COMES FROM
 * `docs/01` §5.2 states the SHAPE — `AI 每次产出以结构化补丁（JSON Patch）形式呈现` — and the M1-W2 row
 * in `docs/06` §2.2 names the deliverable `对话 + JSON Patch 提案 + 右侧实时预览`. Neither fixes a wire
 * format for the model's answer, so this module chooses one and records why:
 *   • a SINGLE JSON object, asked for through `ChatRequest.responseSchema` (level ② of `docs/02`
 *     §5.3's degradation ladder), so a vendor that supports structured output constrains the answer;
 *   • and a TOLERANT READER on this side, because most OpenAI-compatible endpoints ignore
 *     `response_format` and answer prose, a fenced block, or a JSON object with a sentence before it.
 * The reader is what makes the format a CONTRACT rather than a hope. It never repairs a missing
 * operation and never guesses a path: an answer it cannot read is a REPORTED finding the user can
 * retry from, with the draft untouched (`readProposal`'s refusals).
 *
 * WHY THE INSTRUCTION IS ENGLISH AND NOT IN THE CATALOG
 * The rule `chat/builtin-content.ts` records for the preset: PROMPT TEXT IS CONTENT, NOT UI COPY. It
 * must not follow the interface language (ADR-030) — a user who switches the UI to English must not
 * thereby ask the model a different question — and nobody reads it in the app, so it does not belong
 * in `packages/i18n`. The user's turns, the model's messages and the findings AROUND them are
 * catalogued; the instruction is not.
 *
 * WHY A PROPOSAL IS DATA AND NOT A WRITE
 * This module has no I/O of any kind. `previewWorldProposal` is a pure function of the payload and the
 * operations, and `state/co-create-store.ts` is the only thing that ever persists its answer — which
 * is what makes "generating a proposal touches no row" a property of the architecture rather than a
 * promise in a comment.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { JsonValue, WorldData } from '@smarttavern/schema';
import { labelEntries } from '../app/fields';
import {
  CALENDAR_NUMBER_FIELDS,
  CALENDAR_TEXT_FIELDS,
  NARRATIVE_TEXT_FIELDS,
  REGION_FIELDS,
  RHYTHM_BOOLEAN_FIELDS,
  RHYTHM_NUMBER_FIELDS,
  RULES_FIELDS,
  WORLD_FORM_PATHS,
  WORLD_TEXT_FIELDS,
} from '../cards/world';
import {
  applyWorldOps,
  MAX_WORLD_OPS,
  readWorldOp,
  type WorldOp,
  type WorldOpIssue,
} from './json-patch';

/* ───────────────────────── the assignable field inventory ─────────────────── */

/** One payload path a proposal may write, with the label the editor renders for it. */
export interface WorldPatchPath {
  /** A JSON Pointer into `WorldData` (`/rulesOfNature/taboos`, `/regions`). */
  readonly path: string;
  /** The form's own label for the field — the same key the editor prints beside the control. */
  readonly label: MessageKey;
}

/**
 * One descriptor table as `[dotted path, label]` pairs, scoped by its prefix.
 *
 * The cast is because the tables are typed by their OWN object (`TextFieldSpec<WorldData>`, then
 * `TextFieldSpec<WorldData['rulesOfNature']>`), while `labelEntries` only needs the `key`/`label` pair
 * — which is exactly what it declares (`app/fields.tsx`). `docs/06`'s rule that a message key is the
 * only spelling of a field's name is preserved: the VALUE of every entry is still a `MessageKey`.
 */
function entries(
  scope: string,
  fields: readonly object[],
): readonly (readonly [string, MessageKey])[] {
  return labelEntries(
    scope,
    fields as readonly { readonly key: string; readonly label: MessageKey }[],
  );
}

const GROUP_PATH_ENTRIES: readonly (readonly [string, MessageKey])[] = [
  ...entries('', WORLD_TEXT_FIELDS),
  ...entries('rulesOfNature', RULES_FIELDS),
  ...entries('narrative', NARRATIVE_TEXT_FIELDS),
  ...entries('calendar', CALENDAR_TEXT_FIELDS),
  ...entries('calendar', CALENDAR_NUMBER_FIELDS),
  ...entries('timeRhythm', RHYTHM_BOOLEAN_FIELDS),
  ...entries('timeRhythm', RHYTHM_NUMBER_FIELDS),
  ...entries('regions', REGION_FIELDS),
];

/**
 * The dotted paths the form renders that carry no descriptor of their own — a list, or a group whose
 * members are edited one level down. Their labels are the headings the editor already shows.
 */
const COMPOSITE_PATH_ENTRIES: readonly (readonly [string, MessageKey])[] = [
  ['genre', 'world.genreLabel'],
  ['regions', 'world.regionsLabel'],
  ['factions', 'world.factionsLabel'],
  ['calendar', 'world.calendarNameLabel'],
  ['openingHooks', 'world.openingHooksLabel'],
];

/**
 * Every catalogued field label, by its DOTTED path. Declared before `WORLD_PATCH_PATHS` because that
 * derivation reads it at module evaluation (`labelFor`); a `const` used before its initializer is a
 * `ReferenceError` rather than an `undefined`, which is the loud version of this mistake.
 */
const PATH_LABELS: ReadonlyMap<string, MessageKey> = new Map([
  ...GROUP_PATH_ENTRIES,
  ...COMPOSITE_PATH_ENTRIES,
]);

/**
 * Every payload path a proposal may name, in the order `cards/world.ts` declares the form's fields.
 *
 * WHY IT IS DERIVED FROM `WORLD_FORM_PATHS` AND NOT WRITTEN OUT HERE
 * A second list would be a second opinion about which fields exist, and its failure mode is silent in
 * the direction that reaches the user: the model offers to fill a field this editor does not render,
 * or the editor grows a field no proposal can reach. So the dotted paths are filtered out of the
 * form's own inventory — which `cards/world.test.ts` already pins against the schema — and a path
 * with no descriptor of its own falls back to its group's heading.
 *
 * WHAT IS EXCLUDED: `customFields`. Its KEYS are arbitrary labels the user typed, so a patch into it
 * needs a pointer the model cannot know (see `customFieldPaths`, which offers the ones that exist);
 * and the panel for creating a new field is `app/fields.tsx`'s, not a conversation's.
 */
export const WORLD_PATCH_PATHS: readonly WorldPatchPath[] = WORLD_FORM_PATHS.filter(
  (path) => path !== 'customFields',
).map((path) => ({ path: pointerOf(path), label: labelFor(path) }));

/** One dotted form path as a JSON Pointer (`rulesOfNature.taboos` -> `/rulesOfNature/taboos`). */
function pointerOf(dotted: string): string {
  return `/${dotted.split('.').join('/')}`;
}

/** One pointer as a dotted path, with every token unescaped. */
function dottedOf(pointer: string): string {
  if (pointer === '') return '';
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.split('~1').join('/').split('~0').join('~'))
    .join('.');
}

/** The label for one dotted path: its own descriptor, else its group's heading. */
function labelFor(dotted: string): MessageKey {
  const exact = PATH_LABELS.get(dotted);
  if (exact !== undefined) return exact;
  const parent = dotted.slice(0, Math.max(0, dotted.lastIndexOf('.')));
  return PATH_LABELS.get(parent) ?? 'common.customFieldsTitle';
}

/**
 * The `customFields` keys that already exist, as paths the model may address.
 *
 * WHY THE MODEL NEEDS THESE AT ALL: `customFields` is where a user keeps the fields this schema does
 * not have (「天气」, 「禁忌」), so a co-creation turn that could not fill them would be useless exactly
 * where the user has already said what they want. Each key is ESCAPED (`escapePointerToken`'s rule):
 * a field called `a/b` is ordinary data, and a raw pointer built from it would address another field.
 */
export function customFieldPaths(data: WorldData): WorldPatchPath[] {
  return Object.keys(data.customFields).map((key) => ({
    path: `/customFields/${key.split('~').join('~0').split('/').join('~1')}`,
    label: 'common.customFieldsTitle',
  }));
}

/* ──────────────────────────── what the model is asked ─────────────────────── */

/**
 * The JSON Schema a vendor is asked to constrain its answer with (`ChatRequest.responseSchema`).
 *
 * Deliberately LOOSE about the operation objects (`additionalProperties: true`, no per-verb
 * `required`): a vendor that enforces it should refuse a sentence, not refuse a proposal because this
 * schema is stricter than the reader. `readWorldOp` is the reader that decides, and the adapter leaves
 * `strict` off for the same reason (`openai-compatible.ts` records it).
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
 * The system instruction for one co-creation turn.
 *
 * BUILT FROM THE DRAFT, NOT FROM A CONSTANT, so the model edits what the user is actually looking at:
 * the paths the form renders, the payload itself, and the rules of the operation format. `data` is the
 * PAYLOAD only — `cards/draft.ts`'s `extensions` bag is the plugin channel, and an AI turn has no
 * business reading or writing it.
 *
 * WHY THIS TEXT USES ASCII PUNCTUATION ONLY (`-`, never an em dash)
 * ADR-030's rule for the built-in preset applies here — prompt text is CONTENT and must not follow the
 * interface language — but `tools/scripts/check-i18n-literals.mjs` cannot tell a prompt from a label:
 * R1 flags any literal containing a Han character OR one of the CJK punctuation marks this project
 * writes (`，。、：；！？（）「」『』…—`). The honest reading of that rule for an instruction nobody in
 * the app ever reads is that the text should not LOOK like interface copy, which for an English
 * instruction means writing it in plain ASCII. Nothing about it is translated, and it stays inline
 * here for the reason the header records: `chat/builtin-content.ts` is the file that carries the
 * documented exemption because it holds Chinese CONTENT, and this text needs no exemption at all.
 */
export function coCreateInstructions(data: WorldData): string {
  const paths = [...WORLD_PATCH_PATHS, ...customFieldPaths(data)];
  return [
    'You are co-writing a WORLD CARD for a role-playing app with its author, one turn at a time.',
    'You are NOT the game master here and this is NOT the role-play transcript: you discuss the world',
    'and propose concrete edits to the card.',
    '',
    'HOW TO EDIT: answer with ONE JSON object and nothing else - no prose around it, no markdown fence:',
    '{"message": "<your reply to the author>", "rationale": "<why these edits>", "ops": [<operation>]}',
    '',
    'An operation is an RFC 6902 style object addressed at the CURRENT card below:',
    '- {"op":"replace","path":"/era","value":"..."}   change a value that already exists',
    '- {"op":"add","path":"/regions","value":{...}}    insert a new item into a list (optional "at": n,',
    '                                                  default is the end of the list)',
    '- {"op":"add","path":"/customFields/Weather","value":"..."}  create a NEW key',
    '- {"op":"remove","path":"/openingHooks/0"}        delete a value',
    'Rules: a path is a JSON Pointer; "add" only creates (use "replace" to change something); a number',
    'must be an integer where the card has an integer; never write null; keep the JSON types the card',
    'already uses. The result must still be a valid world card, or the proposal is refused.',
    'If nothing should change yet, answer with "ops": [] and ask your question in "message".',
    '',
    'PATHS YOU MAY EDIT:',
    ...paths.map((entry) => `- ${entry.path}  (${entry.label})`),
    '',
    'THE CURRENT CARD (JSON - the payload the author is editing):',
    JSON.stringify(data, null, 2),
  ].join('\n');
}

/* ──────────────────────────── reading the answer ──────────────────────────── */

/** A proposal the model produced, as data. Nothing here has been written anywhere. */
export interface CoCreateProposal {
  readonly id: string;
  /** The operations, in the order the model wrote them. */
  readonly ops: readonly WorldOp[];
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
  /** More operations than the engine accepts (`MAX_WORLD_OPS`). */
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
 * THREE TOLERANCES, EACH BECAUSE THE ALTERNATIVE IS A DEAD END FOR THE USER:
 *   1. the JSON may be wrapped in a ``` fence, which chat models emit even when asked not to;
 *   2. it may be surrounded by prose (`Sure, here is the patch:`), so the object is located by
 *      balanced braces rather than required to be the whole answer;
 *   3. a non-JSON `value` inside an operation is left to the ENGINE's verdict (`readWorldOp` records
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
  const rawMessage = member(record, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  const reject = (reason: MalformedProposalReason): ProposalRead => ({
    ok: false,
    malformed: { reason, message, text: raw },
  });
  const ops = member(record, 'ops');
  if (!Array.isArray(ops)) return reject('no-ops');

  const read: WorldOp[] = [];
  for (const entry of ops) {
    const outcome = readWorldOp(entry as JsonValue);
    if (!outcome.ok) return reject('not-an-operation');
    read.push(outcome.op);
  }
  if (read.length > MAX_WORLD_OPS) return reject('too-many-ops');

  const rawRationale = member(record, 'rationale');
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
function member(record: { [key: string]: unknown }, key: string): unknown {
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
  | { readonly kind: 'ops'; readonly issues: readonly WorldOpIssue[] }
  /** The operations applied, but the result is not a valid world card. */
  | { readonly kind: 'schema'; readonly path: string };

/** What a proposal would do to a payload. */
export type ProposalPreview =
  | { readonly ok: true; readonly data: WorldData }
  | { readonly ok: false; readonly refusal: ProposalRefusal };

/**
 * The ONE function that turns `(draft payload, proposal)` into the payload the proposal proposes.
 *
 * WHY THIS EXISTS, AND WHY IT IS ONE FUNCTION
 * The right-hand live preview must be computed from the PROPOSED payload, not from the applied one —
 * that is the entire point of previewing. If the panel computed the preview one way and the store
 * applied it another, a user could accept a change they never saw. So both call THIS:
 * `co-create/panel.tsx` renders `preview.data`, `state/co-create-store.ts` persists it, and inside
 * both sits `applyWorldOps` — there is no second spelling of "what this proposal does" for the two to
 * drift apart into.
 *
 * A proposal whose result EQUALS the draft is not refused here: equality is a fact about the author's
 * card rather than a defect in the patch, and the store reports it as its own answer. This function's
 * contract is only "what would the payload become".
 */
export function previewWorldProposal(
  data: WorldData,
  proposal: Pick<CoCreateProposal, 'ops'>,
): ProposalPreview {
  const result = applyWorldOps(data, proposal.ops);
  if (result.ok) return { ok: true, data: result.data };
  const issue = result.issues[0];
  if (issue === undefined) {
    return { ok: false, refusal: { kind: 'schema', path: result.schemaPath ?? '' } };
  }
  return { ok: false, refusal: { kind: 'ops', issues: [issue] } };
}

/** True when two payloads are the same document, compared as JSON text. */
export function sameWorldData(left: WorldData, right: WorldData): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/* ───────────────────────────── display helpers ────────────────────────────── */

/**
 * The catalog key of the form's own label for an operation's target, when the form has one.
 *
 * It comes from the descriptor tables the editor renders, so a preview can never name a control that
 * has been renamed or removed. `undefined` is the honest answer for a path with no label of its own —
 * a `customFields` key, a list member — and `opPathText` is what a caller prints in that case.
 */
export function opTargetLabel(op: WorldOp): MessageKey | undefined {
  return PATH_LABELS.get(dottedOf(op.path));
}

/** The target as a dotted path, for a caller whose operation has no catalogued label. */
export function opPathText(op: WorldOp): string {
  return dottedOf(op.path);
}
