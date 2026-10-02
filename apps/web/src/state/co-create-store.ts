/**
 * The co-creation state layer (M1-W2, ADR-017): the conversation about a card, the proposal each answer
 * produced, and the four acts 「生成」 / 「采纳」 / 「否决」 / 「撤销」 — now with M1-W3's stepwise
 * generation, M1-W4's field-scoped edits, M1-C2's character generation and M1-C3's speaking-profile
 * assessment.
 *
 * WHAT IS STATE AND WHAT IS A ROW — AND WHY NOTHING IS PERSISTED HERE
 * The CARD is the row owner's business: the draft lives in `settings` under `draft.world.<id>` or
 * `draft.character.<id>` and `state/content-store.ts` writes it (`cards/draft.ts` records why).
 * Everything THIS store owns is a conversation about that draft, and it is deliberately IN MEMORY:
 *   • a chat about a card is not part of the card, and `docs/02` §7's collections have no place for one
 *     — a nineteenth collection for a scratch conversation would be a schema decision this task has no
 *     mandate to make;
 *   • and persistence is not needed for either acceptance half. 「生成不动草稿」 is strongest when a
 *     proposal is not a row at all, and 「采纳后可撤销」 is satisfied by the snapshot below, which is
 *     taken from the value the draft row and the screen already agree on.
 * The consequence is stated rather than hidden: closing the panel (or reloading) forgets the
 * conversation, the generation in flight and the undo, while the CARD keeps every accepted change —
 * because from the moment it is accepted, a change IS the user's own draft.
 *
 * WHY 「撤销」 RESTORES A SNAPSHOT AND NOT AN INVERSE PATCH
 * An inverse patch would be a second implementation of the patch engine (`co-create/target.ts`), and
 * the acceptance is stated over the DATA: "undo means the user's data is restored, not just a UI flag".
 * `CoCreateUndo` therefore holds the payload the draft row held BEFORE the accepted proposal was
 * applied — the same object the `edit*` action was given — and undo writes it back through that same
 * action. Byte-identical restoration is then a property of "we saved the bytes", not of two engines
 * agreeing about inverses.
 *
 * WHY ACCEPT APPLIES THE SAME PAYLOAD THE PREVIEW RENDERED
 * `previewProposal` is called ONCE in `accept`, against the TARGET of the scope's card kind, and its
 * `data` is both recorded as the undo snapshot's successor and written by that card's own edit action.
 * The panel calls the same function with the same target to RENDER the right-hand preview, so "the
 * preview cannot disagree with the apply" is structural rather than tested-by-luck.
 *
 * HOW ONE STORE SERVES TWO CARDS (M1-C2), AND WHY IT IS NOT A SECOND STORE
 * Every turn carries a `CoCreateScope`, and the scope names the card KIND it is scoped for. This store
 * therefore reads the open draft THROUGH that kind (`openDraft`), previews through that kind's target
 * (`co-create/target.ts`'s registry), and writes back through that kind's own content-store action
 * (`writeDraft`). The conversation, the proposals, the generation walk, the four acts and the request
 * record are ONE implementation; a `kind` field in the store state is what the panel mounts it for, and
 * `ask` refuses a turn whose card does not match it. A second store would have duplicated accept /
 * reject / undo — the exact failure mode M1-C2's brief names.
 *
 * WHAT M1-W3 / M1-W4 / M1-C3 ADD TO THIS STORE
 * One thing: a SCOPE. `co-create/scope.ts` holds the paths a turn may write, the instruction built from
 * them, and the gate that decides whether an answer stayed inside them; `co-create/plan.ts` holds the
 * step lists of both kinds; `co-create/field-ops.ts` builds a single-step plan for one selected field;
 * `co-create/character.ts` holds the speaking-profile assessment's scope and its evidence rule. Every
 * turn — the free conversation, a generation step, a 重写 of one field, an assessment — therefore goes
 * through ONE private `ask` below, which sends through the same `askCoCreate`, parses through the same
 * `readProposal`, previews through the same `previewProposal`, and is accepted / refused / undone by the
 * same three actions.
 *
 * WHY A PROPOSAL OUTSIDE ITS SCOPE IS REFUSED RATHER THAN TRIMMED
 * The acceptance for M1-W4 is that the scoping IS the feature, so the half that matters is the half that
 * says no: a turn about `/premise` that answers with an operation on `/era` is reported as a finding
 * naming the path, and NOTHING is written — not the in-scope operation, and not the stray one.
 * `scopeVerdict` returns both halves so the sentence can say what the model tried to do. The same rule
 * is what makes M1-C3's assessment a proposal about `voice` and nothing else.
 *
 * WHY A REFUSED STEP STOPS AN AUTOMATIC WALK
 * 「从零生成」 asks for the next step when the author accepts one. When they REFUSE one, the plan stops
 * advancing (`reject` puts the walk in `manual`): the author has just said "not this", and starting the
 * next step would be answering a decision they have not made. `generateStep` and `skipStep` are how they
 * resume.
 *
 * WHY REQUEST FAILURES ARE FINDINGS AND NOT CRASHES
 * A model may answer prose, a fenced block, or JSON with a trailing sentence; a transport may refuse, or
 * no key may be configured. Every one of those becomes an entry in the transcript with a catalog key —
 * so 「再试一次」 is a button next to a sentence — and the draft is untouched in all of them.
 *
 * WHY THE REQUESTS ARE RECORDED
 * docs/06 §2.5's acceptance for M1-W3 is 「AI 采用结构化流程，不一次性生成全部」, which is a statement about
 * the SEQUENCE of requests rather than about any one screen. `coCreateRequests()` exposes the recorded
 * list (kind, card, step, scope, preamble) so a test can assert "more than one request, and no request
 * was ever allowed to touch every field" on the wire — for either card kind, which is how M1-C2's
 * 「结构化流程」 is checked without a second store to check it in.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { CharacterData, Extensions, WorldData } from '@smarttavern/schema';
import { create } from 'zustand';
import { askCoCreate } from '../co-create/ask';
import {
  hasVoiceEvidence,
  VOICE_EVALUATED_PATHS,
  voiceEvaluationScope,
} from '../co-create/character';
import { fieldOpRequest, fieldOpScope } from '../co-create/field-ops';
import {
  type CoCreateGenerationPlan,
  type CoCreateStep,
  cardPlan,
  fieldSetPlan,
  patchPathsOf,
  stepScope,
  worldGenerationPlan,
} from '../co-create/plan';
import type { CoCreateProposal } from '../co-create/proposal';
import {
  type CoCreateRequest,
  type CoCreateScope,
  type CoCreateScopeInput,
  type FieldOpKind,
  scopeInstructionFor,
  scopePreambleFor,
  scopeVerdict,
} from '../co-create/scope';
import {
  type CardKind,
  cardTargetOf,
  type MalformedProposalReason,
  type PatchOp,
  previewProposal,
  readProposal,
  sameJson,
} from '../co-create/target';
import { latestWorldVersion, readWorldDraft } from '../db/repository';
import { KEY_LOCKED_CODE, messageKeyForCode, NOT_CONFIGURED_CODE } from '../i18n/error-keys';
import { translate } from '../i18n/translate';
import { useContentStore } from './content-store';
import { isProviderReady, useSettingsStore } from './settings-store';
/** Which half of the conversation wrote one entry. The wire roles of `ChatMessage`. */
export type CoCreateRole = 'user' | 'assistant';

/**
 * A finding: something the USER must read, as a catalog key plus the facts to fill it with.
 *
 * The key travels instead of the sentence, `chat/providers.ts`'s rule: this module cannot know which
 * language the reader uses, and it renders once per locale. `detail` carries the local facts a sentence
 * may have a placeholder for (a schema path, a provider's own message for a log).
 */
export interface CoCreateFinding {
  readonly code: MessageKey;
  readonly detail?: string;
}

/** One entry of the transcript. */
export interface CoCreateMessage {
  readonly id: string;
  readonly role: CoCreateRole;
  /** What the user typed, or the model's own answer VERBATIM — the next turn is composed from it. */
  readonly text: string;
  /** The proposal this answer produced, when it produced one. */
  readonly proposalId?: string;
  /** Why there is no proposal, when the answer could not be read as one. */
  readonly finding?: CoCreateFinding;
}

/** What the author did with one proposal. `pending` is "offered and not yet answered". */
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/** One proposal, and what became of it. */
export interface CoCreateProposalState {
  readonly proposal: CoCreateProposal;
  status: ProposalStatus;
}

/**
 * The data 「撤销」 restores: the draft payload and its plugin bag as they were immediately before the
 * accepted proposal was applied. See the header for why this is a snapshot and not an inverse patch.
 *
 * WHY `data` IS TYPED FOR A WORLD: `WorldData` and `CharacterData` are both "an object with a `name` and
 * a bag of other fields", so TypeScript accepts a character payload for this member and callers that
 * assert on a world field keep working (M1-W2's test reads `undoable.data.premise`). The `card` member is
 * what actually decides which content-store action the restore uses — `undoAccept` writes through
 * `card`, never through the payload's shape — so the type is documentation and the discriminator is
 * behaviour.
 */
export interface CoCreateUndo {
  readonly proposalId: string;
  readonly card: CardKind;
  readonly data: WorldData;
  readonly extensions: Extensions;
}

/** The two ways M1-W3 walks its step list. See `CoCreateGeneration.mode`. */
export type GenerationMode =
  /** 「从零生成」: every step of the plan, and the next one starts when this one is accepted. */
  | 'from-empty'
  /** 「逐字段生成」 and M1-W4: only the steps the author chose, one request per gesture. */
  | 'manual';

/** What became of one step. `pending` is "not generated yet". */
export type GenerationStepState = 'pending' | 'accepted' | 'rejected' | 'skipped';

/** One step's progress, kept beside the plan so 「哪一个步骤是下一个」 is data rather than an index. */
export interface GenerationStepProgress {
  readonly id: string;
  state: GenerationStepState;
}

/**
 * The generation in flight: WHICH steps, WHICH mode, and how far it has come.
 *
 * `current` is an index into `plan.steps` and is what the UI highlights — a plan the panel could not
 * point a step of would leave 「下一个」 a guess. `status` is separate from `current` because a plan that
 * reached its last step and is waiting for the author is not finished, and a UI that confused the two
 * would stop offering the step it is on.
 */
export interface CoCreateGeneration {
  readonly plan: CoCreateGenerationPlan;
  readonly mode: GenerationMode;
  readonly status: 'running' | 'done' | 'cancelled';
  current: number;
  readonly steps: readonly GenerationStepProgress[];
}

/** The last field operation, so the preview pane can say WHICH gesture and field it is about. */
export interface CoCreateFieldOpState {
  readonly path: string;
  readonly fieldOp: FieldOpKind;
}

/**
 * M1-C3's assessment, as the panel renders it beside the pending proposal.
 *
 * `reason` is the model's own `rationale` when it gave one, and the deterministic sentence the
 * instruction asked with otherwise — 「并给出理由」 has to hold even for an answer that forgot the field,
 * and the sentence already says which evidence was read.
 */
export interface VoiceEvaluationState {
  readonly proposalId: string;
  readonly card: CardKind;
  readonly fields: readonly string[];
  readonly reason: string;
}

export interface CoCreateState {
  /**
   * Which card this conversation is about (M1-C2).
   *
   * `openFor` sets it from the panel's own prop, so the field records what the MOUNTED panel is about —
   * and `applyOutcome` uses it to label a pending assessment. Every action that touches a draft reads the
   * card through `openKind()` instead: `state/content-store.ts` guarantees that only one card is open, so
   * the open draft IS the card in front of the user, and a store action called without a panel then does
   * the right thing rather than reporting 「另一种卡片」 at a caller that never spoke to a panel.
   */
  readonly kind: CardKind;
  readonly turns: readonly CoCreateMessage[];
  readonly proposals: readonly CoCreateProposalState[];
  /** The proposal waiting for 采纳 / 否决, or `undefined`. At most one is ever pending. */
  readonly pendingId: string | undefined;
  /**
   * The accepted change that can still be taken back, or `undefined`.
   *
   * Named for the DATA rather than for the gesture (`undoAccept` below) because the two are different
   * facts: this field is what a snapshot restore has to write, and the action is a user pressing a
   * button. One name for both would make `state.undo` ambiguous at every call site.
   */
  readonly undoable: CoCreateUndo | undefined;
  /** True while an answer is in flight. The panel disables its controls on this, not on `input`. */
  readonly busy: boolean;
  /** The last local failure, as a finding the panel renders beside the transcript. */
  readonly finding: CoCreateFinding | undefined;
  /** The stepwise generation in flight, or `undefined` (M1-W3). */
  readonly generation: CoCreateGeneration | undefined;
  /**
   * The paths the PLAN has already written, so a step's instruction can say what is settled.
   *
   * Read from the plan's own progress rather than from the payload's contents — an author may fill a
   * field by hand, and 「这个步骤已经采纳过」 is a fact about the flow, not about the JSON.
   */
  readonly acceptedPaths: readonly string[];
  /** The field operation the pending proposal is, when it is one (M1-W4). */
  readonly fieldOp: CoCreateFieldOpState | undefined;
  /** M1-C3's assessment of the pending proposal, when it is one. */
  readonly voiceEvaluation: VoiceEvaluationState | undefined;
  /**
   * The WORLD a character is being generated INTO (M1-C2's 「基于所选世界的生成」), or `undefined`.
   *
   * WHY IT IS A SEPARATE FIELD FROM `useContentStore`'s open world: opening a character CLOSES the world
   * (`content-store.ts`'s `close`), so "the world the author was just looking at" is gone by the time a
   * character step is sent. The panel therefore offers a world to generate against, `loadWorld` reads it
   * by id (`db/repository.ts`), and its PAYLOAD is kept here — it is the setting the instruction quotes,
   * never a path a proposal may write (`co-create/plan.ts`'s `worldContext`).
   */
  readonly worldId: string | undefined;
  readonly worldData: WorldData | undefined;

  /**
   * Tell the store which card the panel that just mounted is about.
   *
   * Called on mount and on a card change, so the conversation cannot outlive its card: a proposal
   * computed against one card must never be 采纳-able against another. Switching kinds also clears the
   * conversation, which is the same rule the panel's unmount effect follows for an id change.
   */
  openFor: (kind: CardKind) => void;
  /**
   * Choose the world a character is generated against (M1-C2), or clear it with `undefined`.
   *
   * Reads the world's newest published version and keeps its PAYLOAD as `worldData`. A read that fails
   * (or a world with no version) leaves both fields `undefined`, so the next character step simply has no
   * setting to fit — the honest answer, and better than quoting a stale one.
   */
  loadWorld: (worldId: string | undefined) => Promise<void>;
  /** The free-conversation turn: what the author typed, against the whole card. */
  send: (text: string) => Promise<void>;
  /** 「从零生成」: walk every step of the card's plan, one request per step. */
  startGeneration: () => Promise<void>;
  /** 「逐字段生成」: walk the steps the chosen fields belong to, in the plan's own order. */
  startFieldGeneration: (paths: readonly string[]) => Promise<void>;
  /** Generate the step the plan is on, after a refusal or a stop. */
  generateStep: () => Promise<void>;
  /** Leave the current step ungenerated and move to the next one. */
  skipStep: () => void;
  /** Stop walking the plan. Nothing already accepted is touched. */
  cancelGeneration: () => void;
  /** M1-W4: 重写 / 扩写 / 精简 of one selected field. */
  askFieldOp: (path: string, fieldOp: FieldOpKind) => Promise<void>;
  /** M1-C3: assess the speaking profile from the card's own content, as a proposal. */
  askVoiceEvaluation: () => Promise<void>;
  /** Apply the pending proposal to the draft, and remember how to take it back. */
  accept: (proposalId: string) => Promise<boolean>;
  /** Refuse it. Nothing is written anywhere — the draft row stays byte-identical. */
  reject: (proposalId: string) => Promise<boolean>;
  /** Put the draft payload back the way it was before the accepted proposal. */
  undoAccept: () => Promise<boolean>;
  /** Forget the conversation. Nothing in the database is touched. */
  reset: () => void;
}

/**
 * The transport every co-creation turn uses, set once by `mountApp`.
 *
 * A module variable rather than a field, for `state/chat-store.ts`'s reason: a `FetchLike` is not
 * renderable state. There is deliberately no fallback to `globalThis.fetch` — a missing transport in
 * the desktop shell would otherwise look like a CORS failure instead of a wiring mistake.
 */
let transport: FetchLike | undefined;

/** The abort channel of the turn in flight; `undefined` when nothing is running. */
let controller: AbortController | undefined;

/**
 * Which turn is current. Bumped by every `ask` and every `reset`, so an answer that arrives after the
 * conversation was cleared (or after a newer question) cannot install a proposal into it.
 */
let askToken = 0;

/** Entry ids: a counter, because `mintUuidV7` is for PERSISTED entities (`docs/04` §4). */
let turnSequence = 0;

/**
 * Every request this session has sent, in order. See the header for why this is recorded.
 *
 * Module-level rather than a store field on purpose: it is not renderable, and putting it in the store
 * would re-render the panel on every turn for a list nothing displays.
 */
const requests: CoCreateRequest[] = [];

/** The recorded requests, oldest first. A read-only view; `resetCoCreate` clears it. */
export function coCreateRequests(): readonly CoCreateRequest[] {
  return requests;
}

function nextTurnId(): string {
  turnSequence += 1;
  return `co-create-turn-${turnSequence}`;
}

/** Wire the store to its dependencies. Called once by `mountApp`. */
export function configureCoCreate(next: { transport: FetchLike }): void {
  transport = next.transport;
}

/** The conversation so far, in the wire roles the provider expects. See `CoCreateTurnDeps.history`. */
function wireHistory(turns: readonly CoCreateMessage[]): {
  role: CoCreateRole;
  content: string;
}[] {
  return turns.map((turn) => ({ role: turn.role, content: turn.text }));
}

/** The catalog key for a malformed answer. One case, one sentence. */
const MALFORMED_KEYS: Readonly<Record<MalformedProposalReason, MessageKey>> = {
  'no-json': 'co-create.malformedNoJson',
  'no-ops': 'co-create.malformedNoOps',
  'not-an-operation': 'co-create.malformedNotAnOperation',
  'too-many-ops': 'co-create.malformedTooManyOps',
};

/** Everything a closed panel starts from. One shape, so a reset cannot half-clear. */
function emptyState(): Pick<
  CoCreateState,
  | 'kind'
  | 'turns'
  | 'proposals'
  | 'pendingId'
  | 'undoable'
  | 'busy'
  | 'finding'
  | 'generation'
  | 'acceptedPaths'
  | 'fieldOp'
  | 'voiceEvaluation'
  | 'worldId'
  | 'worldData'
> {
  return {
    kind: 'world',
    turns: [],
    proposals: [],
    pendingId: undefined,
    undoable: undefined,
    busy: false,
    finding: undefined,
    generation: undefined,
    acceptedPaths: [],
    fieldOp: undefined,
    voiceEvaluation: undefined,
    worldId: undefined,
    worldData: undefined,
  };
}

/** The replacement for one proposal's state, by id, leaving every other entry untouched. */
function withStatus(
  proposals: readonly CoCreateProposalState[],
  proposalId: string,
  status: ProposalStatus,
): CoCreateProposalState[] {
  return proposals.map((entry) =>
    entry.proposal.id === proposalId ? { ...entry, status } : entry,
  );
}

/** The step at `index`, or `undefined` when the index has run past the list. */
function stepAt(generation: CoCreateGeneration, index: number): CoCreateStep | undefined {
  return generation.plan.steps[index];
}

/** The first index at or after `from` whose step is still pending, or `undefined` at the end. */
function nextIndex(steps: readonly GenerationStepProgress[], from: number): number | undefined {
  for (let index = from; index < steps.length; index += 1) {
    if (steps[index]?.state === 'pending') return index;
  }
  return undefined;
}

/** The scope of a free-conversation turn: every editable field of the card (M1-W2's behaviour). */
function chatScope(kind: CardKind): CoCreateScope {
  return {
    kind: 'chat',
    card: kind,
    paths: patchPathsOf(kind).map((entry) => entry.path),
    excluded: [],
    why: [
      'THIS TURN IS A CONVERSATION ABOUT THE WHOLE CARD. The author said something; answer it with',
      'the edits it asks for, or with a question when the card is not decided enough to write. Every',
      'field below may be edited in this turn.',
    ].join('\n'),
  };
}

/* ─────────────────────────── the one turn every mode takes ────────────────── */

/**
 * One turn's answer, as the state transition it implies.
 *
 * A union rather than a sequence of `set` calls inside `ask`: every branch below writes the SAME fields
 * (a transcript entry, perhaps a proposal, perhaps a finding), and doing it once at the end is what
 * makes "the draft did not move" a property of one code path instead of six.
 */
type AskOutcome =
  /** Not sent, for a local reason. `finding` is absent when the store was simply busy. */
  | { readonly kind: 'local'; readonly finding?: CoCreateFinding }
  /** A usable proposal, now pending. */
  | {
      readonly kind: 'pending';
      readonly asked: readonly CoCreateMessage[];
      readonly proposal: CoCreateProposal;
    }
  /** The model answered, and there was nothing to accept. */
  | { readonly kind: 'talk'; readonly asked: readonly CoCreateMessage[]; readonly text: string }
  /**
   * M1-C3's third answer: the model judged the card too thin to score and proposed nothing.
   *
   * Its own branch rather than `talk`, because 「生成欲望/能力值并给出理由」 owes the author a REASON for
   * the absence — an unassessed card has to read as "not judged yet", never as "judged, and it is 50".
   */
  | {
      readonly kind: 'voice-none';
      readonly asked: readonly CoCreateMessage[];
      readonly text: string;
      readonly reason: string;
    }
  /** The answer could not be read as a proposal (including a transport failure). */
  | {
      readonly kind: 'malformed';
      readonly asked: readonly CoCreateMessage[];
      readonly text: string;
      readonly finding: CoCreateFinding;
    }
  /** The answer was a proposal that left this turn's scope. Nothing is applied. */
  | {
      readonly kind: 'out-of-scope';
      readonly asked: readonly CoCreateMessage[];
      readonly detail: string;
    }
  /** The answer was a proposal the engine or the schema refuses. */
  | {
      readonly kind: 'refused';
      readonly asked: readonly CoCreateMessage[];
      readonly finding: CoCreateFinding;
    };

/* ───────────────────── reading and writing the open card ──────────────────── */

/** The open draft payload of one card kind, or `undefined`. */
function openDraft(kind: CardKind): WorldData | CharacterData | undefined {
  const content = useContentStore.getState();
  return kind === 'world' ? content.worldDraft?.data : content.characterDraft?.data;
}

/** The open draft's plugin bag, so a write preserves it. */
function openExtensions(kind: CardKind): Extensions | undefined {
  const content = useContentStore.getState();
  return kind === 'world' ? content.worldDraft?.extensions : content.characterDraft?.extensions;
}

/**
 * Write one payload back through the card kind's OWN edit action.
 *
 * WHY THE BRANCH IS HERE AND NOT IN `state/content-store.ts`: the two actions are already typed
 * (`editWorld` takes a `WorldData`, `editCharacter` a `CharacterData`) and each enforces its own gate.
 * A union-typed `editCard` would have to widen that gate to `unknown`, which is exactly the loss of
 * type safety the two signatures exist for.
 */
async function writeDraft(
  kind: CardKind,
  data: WorldData | CharacterData,
  extensions: Extensions,
): Promise<boolean> {
  const content = useContentStore.getState();
  return kind === 'world'
    ? content.editWorld(data as WorldData, extensions)
    : content.editCharacter(data as CharacterData, extensions);
}

/** True when the card of `kind` is open in the editor. */
function isOpen(kind: CardKind): boolean {
  const content = useContentStore.getState();
  return kind === 'world' ? content.world !== undefined : content.character !== undefined;
}

/**
 * The card kind the EDITOR currently has open.
 *
 * WHY THIS IS READ FROM THE CONTENT STORE AND NOT FROM THE PANEL'S `kind` STATE: `state/content-store.ts`
 * already guarantees that at most ONE card is open (`openToken` abandons the other's read), so "which
 * draft exists" is the same fact as "which card the user is looking at" — and a store action called
 * without a panel (a test, a future command palette) then does the right thing by construction instead of
 * reporting 「另一种卡片」 at a caller that simply never told it. The panel's `openFor` still sets
 * `state.kind`, which is what a free-conversation turn and the mismatch check below read.
 */
function openKind(): CardKind | undefined {
  const content = useContentStore.getState();
  if (content.character !== undefined && content.characterDraft !== undefined) return 'character';
  if (content.world !== undefined && content.worldDraft !== undefined) return 'world';
  return undefined;
}

export const useCoCreateStore = create<CoCreateState>((set, get) => {
  /**
   * Send one turn and install its answer. THE ONE PATH every co-creation request takes.
   *
   * `scope` decides what the model may write, what it is told, and what the answer is judged against —
   * and, through its `card`, WHICH DRAFT the answer is about. The gate runs BEFORE anything is sent
   * (`chat-store.ts`'s codes: "nothing configured" and "a key is stored and this tab cannot read it" are
   * different facts, and telling an author their key is wrong when it is only locked sends them looking
   * in the wrong place). The sentence for a local refusal is rendered HERE rather than by the panel
   * because the refusal IS this turn's answer, and the transcript is where the answer goes.
   */
  async function ask(prompt: string, scope: CoCreateScope): Promise<void> {
    const text = prompt.trim();
    if (text === '') return;
    // THE CARD KIND CROSS-CHECK, against the card the EDITOR has open rather than against the panel's
    // own flag: a scope assembled for the other card must not reach this draft, and a caller that never
    // mounted a panel (a test, a future command palette) must still be refused with a readable sentence
    // instead of writing into whichever draft happens to be there.
    //
    // NOT REACHABLE THROUGH THE SCREEN TODAY, and kept on purpose: `kind` is a panel prop, the two routes
    // set it to their own card, `openFor` follows it, and `state/content-store.ts` keeps at most one card
    // open — so this branch exists for the caller that assembles a scope BY HAND (the M1-C3 assessment is
    // one such scope), which is exactly where a silent write into the wrong draft would be hardest to see.
    const open = openKind();
    if (open === undefined) {
      set({ finding: { code: 'co-create.notConfigured' } });
      return;
    }
    if (scope.card !== open) {
      set({ finding: { code: 'co-create.wrongCard' } });
      return;
    }
    const data = openDraft(scope.card);
    // No open card, or a turn already running: `send` is a form submit, and the panel has already
    // disabled the control — this is the store's own backstop, reported rather than thrown.
    if (!isOpen(scope.card) || data === undefined) {
      set({ finding: { code: 'co-create.notConfigured' } });
      return;
    }
    if (get().busy) return;

    askToken += 1;
    const token = askToken;
    const asked = [...get().turns, { id: nextTurnId(), role: 'user' as const, text }];
    set({ turns: asked, busy: true, finding: undefined, pendingId: undefined });

    const settings = useSettingsStore.getState();
    const refusal =
      transport === undefined || !isProviderReady(settings.provider)
        ? NOT_CONFIGURED_CODE
        : settings.locked
          ? KEY_LOCKED_CODE
          : undefined;
    if (refusal !== undefined) {
      const key = messageKeyForCode(refusal);
      set({ busy: false, finding: { code: key, detail: translate(key) } });
      return;
    }

    const instruction = instructionFor(scope, data);
    requests.push({
      kind: scope.kind,
      card: scope.card,
      ...(scope.step === undefined ? {} : { step: scope.step }),
      ...(scope.fieldOp === undefined ? {} : { fieldOp: scope.fieldOp }),
      paths: [...scope.paths],
      instruction,
      preamble: scopePreambleFor(scope.card, scope).join('\n'),
    });

    controller = new AbortController();
    const answer = await askCoCreate(
      {
        config: {
          baseUrl: settings.provider.baseUrl,
          apiKey: settings.key ?? '',
          model: settings.provider.model,
        },
        ...(transport === undefined ? {} : { transport }),
        instruction,
        history: wireHistory(asked),
      },
      { signal: controller.signal },
    );

    // The conversation this answer belongs to may be gone (a `reset`, or a newer question).
    if (token !== askToken) return;
    applyOutcome(set, get, judge(answer, asked, scope, data));
  }

  /** The instruction for one turn: the scope's own words plus the draft it is scoped over. */
  function instructionFor(scope: CoCreateScope, data: WorldData | CharacterData): string {
    const input: CoCreateScopeInput = {
      kind: scope.kind,
      card: scope.card,
      paths: scope.paths,
      excluded: scope.excluded,
      why: scope.why,
    };
    return scopeInstructionFor(scope.card, data, input, patchPathsOf(scope.card));
  }

  return {
    ...emptyState(),

    openFor(kind: CardKind): void {
      // Bumping the token invalidates an answer in flight for the OTHER card, so it cannot install a
      // proposal into a conversation that is no longer about it.
      askToken += 1;
      if (get().kind === kind) return;
      set({ ...emptyState(), kind });
    },

    async loadWorld(worldId: string | undefined): Promise<void> {
      if (worldId === undefined) {
        set({ worldId: undefined, worldData: undefined });
        return;
      }
      // The id moves FIRST, so the picker shows the author's choice while the read is in flight.
      set({ worldId });
      try {
        const version = await latestWorldVersion(worldId);
        // THE DRAFT WINS OVER THE PUBLISHED VERSION, for `state/content-store.ts`'s reason: the draft is
        // what the author is working on, and generating a character against a world they have already
        // changed — but not published — would fit it to a setting that is not theirs any more.
        const draft = version === undefined ? undefined : await readWorldDraft(worldId, version);
        if (get().worldId !== worldId) return;
        set({ worldData: draft?.data ?? version?.data });
      } catch {
        // A read that failed is NOT a finding the author has to dismiss: the next character step simply
        // has no world to fit, which the instruction already reads as "no setting quoted".
        if (get().worldId === worldId) set({ worldData: undefined });
      }
    },

    async send(text: string): Promise<void> {
      // A free turn is an UNSCOPED turn (M1-W2's conversation) over the card the editor has open.
      const kind = openKind();
      if (kind === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      await ask(text, chatScope(kind));
    },

    async startGeneration(): Promise<void> {
      const kind = openKind();
      const data = kind === undefined ? undefined : openDraft(kind);
      if (kind === undefined || data === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      // 「从零生成」 STARTS FROM WHAT THE CARD ALREADY SAYS, not from nothing: a card with no seed at all
      // leaves the model inventing a setting the author then has to throw away, step by step. Each kind
      // states its own seed as a readable finding, with the draft untouched:
      //   • a world needs a GENRE (`cards/world.ts` renders it in 基本);
      //   • a character needs one line the described person can be read from — the same evidence
      //     M1-C3's assessment needs (`co-create/character.ts`'s `voiceEvidence`), because a character
      //     generated from nothing is exactly the invented direction this guard exists to prevent.
      if (kind === 'world') {
        if ((data as WorldData).genre.length === 0) {
          set({ finding: { code: 'co-create.genreFirst' } });
          return;
        }
      } else if (!hasVoiceEvidence(data as CharacterData)) {
        set({ finding: { code: 'co-create.characterFirst' } });
        return;
      }
      const plan = kind === 'world' ? worldGenerationPlan() : cardPlan('character');
      set({
        generation: {
          plan,
          mode: 'from-empty',
          status: 'running',
          current: 0,
          steps: plan.steps.map((step) => ({ id: step.id, state: 'pending' as const })),
        },
        acceptedPaths: [],
        fieldOp: undefined,
        voiceEvaluation: undefined,
        finding: undefined,
      });
      await askNextStep(get, ask);
    },

    async startFieldGeneration(paths: readonly string[]): Promise<void> {
      if (paths.length === 0) {
        set({ finding: { code: 'co-create.nothingSelected' } });
        return;
      }
      const kind = openKind();
      if (kind === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      const plan = fieldSetPlan(paths, kind);
      if (plan.steps.length === 0) {
        set({ finding: { code: 'co-create.nothingSelected' } });
        return;
      }
      set({
        generation: {
          // THE PLAN IS NARROWED TO THE STEPS THE AUTHOR CHOSE. `generation.steps` is the progress of
          // `plan.steps` by index, so a plan that kept all seven while the walk covered two would point
          // every later request at the wrong step — the ids are the same strings, and only the list
          // they are read against tells them apart.
          plan,
          mode: 'manual',
          status: 'running',
          current: 0,
          steps: plan.steps.map((step) => ({ id: step.id, state: 'pending' as const })),
        },
        acceptedPaths: [],
        fieldOp: undefined,
        voiceEvaluation: undefined,
        finding: undefined,
      });
      await askNextStep(get, ask);
    },

    async generateStep(): Promise<void> {
      const { generation, busy, pendingId } = get();
      if (generation === undefined || generation.status !== 'running') {
        set({ finding: { code: 'co-create.noGeneration' } });
        return;
      }
      if (busy || pendingId !== undefined) return;
      await askStep(ask, generation, generation.current);
    },

    skipStep(): void {
      const { generation } = get();
      if (generation === undefined || generation.status !== 'running') return;
      // A skipped step is DECIDED but not written: it advances the plan like an accepted one, and its
      // paths stay out of `acceptedPaths` because nothing of it is in the card.
      const steps = generation.steps.map((entry, index) =>
        index === generation.current ? { ...entry, state: 'skipped' as const } : entry,
      );
      const next = nextIndex(steps, generation.current + 1);
      if (next === undefined) {
        set({ generation: { ...generation, steps, status: 'done' } });
        return;
      }
      set({ generation: { ...generation, steps, current: next } });
    },

    cancelGeneration(): void {
      const { generation } = get();
      if (generation === undefined) return;
      // A stopped walk forgets its progress MARKERS but not its plan: 「从零生成」 can be started again,
      // and the paths this walk already wrote stay in the card as the author's own data.
      set({
        generation: {
          ...generation,
          status: 'cancelled',
          steps: generation.steps.map((entry) => ({ ...entry, state: 'pending' as const })),
        },
        acceptedPaths: [],
      });
    },

    async askFieldOp(path: string, fieldOp: FieldOpKind): Promise<void> {
      const state = get();
      if (state.busy) return;
      if (state.pendingId !== undefined) {
        set({ finding: { code: 'co-create.finishFirst' } });
        return;
      }
      if (blocked(state)) {
        set({ finding: { code: 'co-create.generationBusy' } });
        return;
      }
      const kind = openKind();
      const data = kind === undefined ? undefined : openDraft(kind);
      if (kind === undefined || data === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      const request = fieldOpRequest([path], kind);
      set({
        fieldOp: { path, fieldOp },
        voiceEvaluation: undefined,
        finding: undefined,
        generation: {
          plan: request.plan,
          mode: 'manual',
          status: 'running',
          current: 0,
          steps: [{ id: request.step.id, state: 'pending' }],
        },
      });
      await ask(
        FIELD_OP_PROMPTS[fieldOp],
        fieldOpScope(
          data,
          path,
          fieldOp,
          patchPathsOf(kind).map((entry) => entry.path),
          kind,
        ),
      );
    },

    async askVoiceEvaluation(): Promise<void> {
      const state = get();
      if (state.busy) return;
      if (state.pendingId !== undefined) {
        set({ finding: { code: 'co-create.finishFirst' } });
        return;
      }
      if (blocked(state)) {
        set({ finding: { code: 'co-create.generationBusy' } });
        return;
      }
      // THE ASSESSMENT IS A CHARACTER CARD'S TURN: a world has no `voice` field set to assess, so a
      // world editor (or a store nobody has opened a character in) is told which card this is about.
      const kind = openKind();
      if (kind !== 'character') {
        set({ finding: { code: 'co-create.wrongCard' } });
        return;
      }
      const data = openDraft('character');
      if (data === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      // THE LOCAL PRECONDITION (see `co-create/character.ts`): a card whose description, personality and
      // scenario are all blank has nothing to judge, so the turn is a finding and NO request is sent.
      // The second layer — a card that says something but not enough — is the model's own `"ops": []`,
      // reported as `voice-none` below; the two are different facts and are kept apart.
      if (!hasVoiceEvidence(data as CharacterData)) {
        set({ finding: { code: 'co-create.voiceTooThin' } });
        return;
      }
      const scope = voiceEvaluationScope(data as CharacterData);
      set({
        fieldOp: undefined,
        generation: undefined,
        voiceEvaluation: {
          // The proposal id is not known until the answer arrives; `applyOutcome` replaces this entry
          // with one that names it. Until then the pane shows the scope's own sentence, which is the
          // deterministic half of 「并给出理由」.
          proposalId: '',
          card: 'character',
          fields: VOICE_EVALUATED_PATHS,
          reason: scope.why,
        },
        finding: undefined,
      });
      await ask('Evaluate this character speaking profile from the card content.', scope);
    },

    async accept(proposalId: string): Promise<boolean> {
      const entry = get().proposals.find((candidate) => candidate.proposal.id === proposalId);
      const kind = openKind();
      const draft = kind === undefined ? undefined : openDraft(kind);
      const extensions = kind === undefined ? undefined : openExtensions(kind);
      if (kind === undefined || entry === undefined || draft === undefined) return false;
      if (extensions === undefined) return false;

      // THE SAME FUNCTION THE PREVIEW CALLED, against the same card's target. One
      // `(payload, proposal) -> payload`, so what is written is exactly what the right-hand pane showed.
      const preview = previewProposal(cardTargetOf(kind), draft, entry.proposal);
      if (!preview.ok) {
        set({
          finding: {
            code:
              preview.refusal.kind === 'schema' ? 'co-create.refusedSchema' : 'co-create.refusedOp',
            detail: preview.refusal.kind === 'schema' ? preview.refusal.path : undefined,
          },
        });
        return false;
      }
      // A proposal that produces the payload that is already there is not applied. The panel never
      // offers 采纳 for one, but a programmatic caller can reach here, and writing a draft row that
      // differs from the current one in no way is a change the user did not ask for.
      if (sameJson(draft, preview.data)) return false;

      const applied = await writeDraft(kind, preview.data as WorldData | CharacterData, extensions);
      if (!applied) return false;

      set({
        proposals: withStatus(get().proposals, proposalId, 'accepted'),
        pendingId: undefined,
        // The cast is the ONE place the union is narrowed, and it is honest: `kind` says which card this
        // snapshot is, `undoAccept` writes it back through that same kind, and `CoCreateUndo`'s own
        // comment records why its `data` member is typed for a world (M1-W2's test reads a world field).
        undoable: { proposalId, card: kind, data: draft as WorldData, extensions },
        fieldOp: undefined,
        voiceEvaluation: undefined,
        finding: undefined,
      });
      await advanceAfterAccept(set, get, ask);
      return true;
    },

    async reject(proposalId: string): Promise<boolean> {
      const entry = get().proposals.find((candidate) => candidate.proposal.id === proposalId);
      if (entry === undefined) return false;
      const { pendingId, generation } = get();
      // NOTHING IS WRITTEN — that is the refusal's whole meaning, and the test that pins it compares the
      // draft ROW's bytes across the call.
      set({
        proposals: withStatus(get().proposals, proposalId, 'rejected'),
        ...(pendingId === proposalId ? { pendingId: undefined } : {}),
        // An assessment that was refused leaves no reason on screen: the reason belongs to a proposal
        // the author can still act on, and keeping it would read as an opinion that was accepted.
        ...(get().voiceEvaluation?.proposalId === proposalId ? { voiceEvaluation: undefined } : {}),
        // THE STEP IS MARKED, and the automatic walk stops: the author has just said "not this", and
        // starting the next step would be answering a decision they have not made (`generateStep` and
        // `skipStep` are how they resume). See the header.
        ...(generation === undefined
          ? {}
          : {
              generation: {
                ...generation,
                mode: generation.mode === 'from-empty' ? ('manual' as const) : generation.mode,
                steps: generation.steps.map((step, index) =>
                  index === generation.current ? { ...step, state: 'rejected' as const } : step,
                ),
              },
            }),
      });
      return true;
    },

    async undoAccept(): Promise<boolean> {
      const { undoable } = get();
      if (undoable === undefined) return false;
      const restored = await writeDraft(undoable.card, undoable.data, undoable.extensions);
      // The snapshot is cleared ONLY when the row was written. A failed write leaves it in place, so the
      // button still offers the one thing it promises instead of silently becoming a no-op.
      if (restored) set({ undoable: undefined, finding: undefined });
      return restored;
    },

    reset(): void {
      askToken += 1;
      controller?.abort();
      controller = undefined;
      set({ ...emptyState() });
    },
  };
});
/* ─────────────────────────────── one turn's plumbing ─────────────────────── */

/** The author's turn for each gesture. A sentence rather than a field, because it is what they read. */
const FIELD_OP_PROMPTS: Readonly<Record<FieldOpKind, string>> = {
  rewrite: 'Rewrite this field.',
  expand: 'Expand this field.',
  condense: 'Condense this field.',
};

/**
 * The verdict for one answer, as the transition `applyOutcome` writes.
 *
 * Every refusal below leaves the draft untouched by construction: none of them calls `writeDraft`, and
 * `previewProposal` is a pure function of the payload (`target.ts` records that).
 */
function judge(
  answer: Awaited<ReturnType<typeof askCoCreate>>,
  asked: readonly CoCreateMessage[],
  scope: CoCreateScope,
  data: WorldData | CharacterData,
): AskOutcome {
  if (!answer.ok) {
    // The provider's own sentence is deliberately NOT carried: it is written for a developer, and
    // `detail` is a placeholder for local facts (a schema path), not a channel for vendor prose.
    return {
      kind: 'malformed',
      asked,
      text: '',
      finding: { code: messageKeyForCode(answer.error.code) },
    };
  }
  const read = readProposal(answer.text, nextTurnId());
  if (!read.ok) {
    return {
      kind: 'malformed',
      asked,
      text: read.malformed.text,
      finding: {
        code: MALFORMED_KEYS[read.malformed.reason],
        // The raw answer goes into the finding's `{detail}` slot, so the sentence about the SHAPE and
        // the answer itself are read together.
        detail: read.malformed.text,
      },
    };
  }
  const proposal: CoCreateProposal = read.proposal;
  // A proposal is only OFFERED when it would change something. `docs/01` §5.2's turns include "ask me
  // more first", and an empty patch is that turn: the model's message is shown and no 采纳 / 否决 pair is
  // offered, because there is nothing to accept.
  if (proposal.empty) {
    // ...and for M1-C3 an empty patch has its OWN reading: the model was asked to score the profile and
    // answered that the card is too thin to score. That is a finding with the model's reason, not the
    // generic "it only talked".
    if (scope.kind === 'voice-profile') {
      return {
        kind: 'voice-none',
        asked,
        text: proposal.message,
        reason: proposal.rationale ?? proposal.message,
      };
    }
    return { kind: 'talk', asked, text: proposal.message };
  }
  const preview = previewProposal(cardTargetOf(scope.card), data, proposal);
  if (preview.ok && sameJson(data, preview.data)) {
    return { kind: 'talk', asked, text: proposal.message };
  }
  // THE SCOPE GATE, before anything is offered: a proposal that wrote outside this turn's paths is
  // refused as a whole, and the sentence names the path it aimed at.
  const verdict = scopeVerdict(proposal.ops, scope);
  if (verdict.outOfScope.length > 0) {
    const stray = verdict.outOfScope[0];
    return { kind: 'out-of-scope', asked, detail: stray === undefined ? '' : stray.path };
  }
  if (!preview.ok) {
    return {
      kind: 'refused',
      asked,
      finding: {
        code: preview.refusal.kind === 'schema' ? 'co-create.refusedSchema' : 'co-create.refusedOp',
        detail: preview.refusal.kind === 'schema' ? preview.refusal.path : undefined,
      },
    };
  }
  return { kind: 'pending', asked, proposal };
}

/** Install one outcome into the store. See `AskOutcome` for why there is one place that does this. */
function applyOutcome(
  set: (partial: Partial<CoCreateState>) => void,
  get: () => CoCreateState,
  outcome: AskOutcome,
): void {
  switch (outcome.kind) {
    case 'local':
      set({
        busy: false,
        ...(outcome.finding === undefined ? {} : { finding: outcome.finding }),
      });
      return;
    case 'pending':
      set({
        busy: false,
        pendingId: outcome.proposal.id,
        proposals: [...get().proposals, { proposal: outcome.proposal, status: 'pending' }],
        // M1-C3's reason travels with the proposal it belongs to: the pane renders it while the
        // 采纳 / 否决 pair is offered, and `reject` clears it.
        ...(get().voiceEvaluation === undefined
          ? {}
          : {
              voiceEvaluation: {
                proposalId: outcome.proposal.id,
                card: get().kind,
                fields: VOICE_EVALUATED_PATHS,
                reason: outcome.proposal.rationale ?? get().voiceEvaluation?.reason ?? '',
              },
            }),
        turns: [
          ...outcome.asked,
          {
            id: nextTurnId(),
            role: 'assistant',
            text: outcome.proposal.message,
            proposalId: outcome.proposal.id,
          },
        ],
      });
      return;
    case 'talk':
      set({
        busy: false,
        turns: [...outcome.asked, { id: nextTurnId(), role: 'assistant', text: outcome.text }],
      });
      return;
    case 'voice-none':
      set({
        busy: false,
        voiceEvaluation: undefined,
        turns: [
          ...outcome.asked,
          {
            id: nextTurnId(),
            role: 'assistant',
            text: outcome.text,
            finding: { code: 'co-create.voiceNoSignal', detail: outcome.reason },
          },
        ],
      });
      return;
    case 'malformed':
      set({
        busy: false,
        turns: [
          ...outcome.asked,
          // The model's own text is kept: the author can see what it did say, which is what makes
          // 「再试一次」 an informed decision rather than a gamble.
          { id: nextTurnId(), role: 'assistant', text: outcome.text, finding: outcome.finding },
        ],
      });
      return;
    case 'out-of-scope':
      set({
        busy: false,
        voiceEvaluation: undefined,
        turns: [
          ...outcome.asked,
          {
            id: nextTurnId(),
            role: 'assistant',
            text: '',
            finding: { code: 'co-create.outOfScope', detail: outcome.detail },
          },
        ],
      });
      return;
    default:
      set({ busy: false, finding: outcome.finding });
  }
}

/* ───────────────────────── the generation walk (M1-W3) ───────────────────── */

/** The signature of the private turn function, so the walk can be written outside the store. */
type Ask = (prompt: string, scope: CoCreateScope) => Promise<void>;

/** A plan's accepted path set, with one more step in it. */
function withStep(paths: readonly string[], step: CoCreateStep): string[] {
  return [...paths, ...step.paths];
}

/** True when no step of a plan is still waiting to be generated. */
function settled(steps: readonly GenerationStepProgress[]): boolean {
  return nextIndex(steps, 0) === undefined;
}

/**
 * True while a request must NOT be started: one turn is in flight, one proposal is unanswered, or a plan
 * is still waiting for a step.
 *
 * A plan that has settled does NOT block the author (`settled`): after the last field of 「逐字段生成」 is
 * accepted, working on a single field by hand is exactly what they would do next, and a guard that read
 * only `status === 'running'` would refuse it with 「生成流程正在进行」 that is no longer true.
 */
function blocked(state: {
  readonly busy: boolean;
  readonly pendingId: string | undefined;
  readonly generation: CoCreateGeneration | undefined;
}): boolean {
  if (state.busy || state.pendingId !== undefined) return true;
  const generation = state.generation;
  return generation !== undefined && generation.status === 'running' && !settled(generation.steps);
}

/**
 * Ask for the next pending step, marking the plan done when there is none.
 *
 * The whole 「从零生成」 loop is here: `accept` calls it after applying a step, so a plan walks itself one
 * request at a time — which is exactly the structure M1-W3's acceptance is about, and why it is a loop
 * over STEPS rather than one request for the whole card.
 */
async function askNextStep(get: () => CoCreateState, ask: Ask): Promise<void> {
  const { generation, busy, pendingId } = get();
  if (generation === undefined || generation.status !== 'running') return;
  if (busy || pendingId !== undefined) return;
  const index = nextIndex(generation.steps, 0);
  if (index === undefined) {
    useCoCreateStore.setState({
      generation: { ...generation, status: 'done' },
      fieldOp: undefined,
    });
    return;
  }
  await askStep(ask, generation, index);
}

/**
 * Ask for one step, and make the plan point at it before the request goes out.
 *
 * NO `get` PARAMETER: this function reads nothing from the store (it is handed the generation it must
 * ask for, and the store is written through `setState` so a step's index is on screen before the answer
 * arrives). Carrying an unused reader would suggest it decides something about the state.
 */
async function askStep(ask: Ask, generation: CoCreateGeneration, index: number): Promise<void> {
  const step = stepAt(generation, index);
  if (step === undefined) {
    useCoCreateStore.setState({
      generation: { ...generation, status: 'done' },
      fieldOp: undefined,
    });
    return;
  }
  const accepted = generation.steps
    .filter((entry) => entry.state === 'accepted')
    .map((entry) => entry.id);
  useCoCreateStore.setState({ generation: { ...generation, current: index } });
  await ask(
    `Generate the "${step.id}" step of this card.`,
    stepScope(
      generation.plan,
      step,
      accepted,
      // M1-C2's 「基于所选世界的生成」: the world the author chose to generate INTO travels into every
      // character step. A world plan gets `undefined`, because a world is not written against another.
      generation.plan.kind === 'character' ? useCoCreateStore.getState().worldData : undefined,
    ),
  );
}

/**
 * What an accepted proposal does to the generation it belongs to.
 *
 * The three endings, in one place: a FIELD OPERATION finishes its one-step plan and clears the gesture;
 * a plan with no pending step left is finished; and an automatic walk asks for the next step. A manual
 * walk stops asking by design — see the header — but it is still FINISHED once nothing is left, which is
 * what keeps 「从零生成」 from being offered again on a card it has already written.
 */
async function advanceAfterAccept(
  set: (partial: Partial<CoCreateState>) => void,
  get: () => CoCreateState,
  ask: Ask,
): Promise<void> {
  const { generation, acceptedPaths } = get();
  if (generation === undefined) return;
  const current = stepAt(generation, generation.current);
  if (current === undefined) {
    set({ generation: { ...generation, status: 'done' }, fieldOp: undefined });
    return;
  }
  const steps = generation.steps.map((entry) =>
    entry.id === current.id ? { ...entry, state: 'accepted' as const } : entry,
  );
  // THE PLAN MOVES TO THE NEXT PENDING STEP — for BOTH modes. A manual walk does not ASK for it (that
  // is the author's click), but it must still be able to say which step is next: the panel highlights
  // `current`, and 「哪一个步骤是下一个」 is the fact M1-W3's acceptance is stated over.
  const next = nextIndex(steps, generation.current + 1);
  set({
    generation: {
      ...generation,
      steps,
      current: next ?? generation.current,
      ...(next === undefined ? { status: 'done' as const } : {}),
    },
    acceptedPaths: withStep(acceptedPaths, current),
    // A field operation is a one-step plan whose gesture is spent the moment it is applied. The check is
    // by step ID rather than by plan ID so it holds for EITHER card kind (M1-C2).
    ...(current.id === 'field-op' ? { fieldOp: undefined } : {}),
  });
  // 「逐字段生成」 AND A FIELD OPERATION STOP ASKING HERE: the author chose those fields, and generating one
  // they did not ask for would be the "all at once" this milestone exists to prevent. Whether that was
  // the LAST chosen step is decided above, by whether a pending step was left.
  if (next === undefined || generation.mode !== 'from-empty') return;
  await askStep(ask, { ...generation, steps }, next);
}

/**
 * Test seam: forget the configured transport, the running turn, the conversation and the record.
 *
 * The counter is bumped so an answer still in flight cannot install a proposal into the next test's
 * empty conversation.
 */
export function resetCoCreate(): void {
  askToken += 1;
  controller?.abort();
  controller = undefined;
  transport = undefined;
  requests.length = 0;
  useCoCreateStore.setState({ ...emptyState() });
}

/** Every operation a proposal carries, for a caller that wants to assert the set (a test seam). */
export function proposalOps(proposal: CoCreateProposal): readonly PatchOp[] {
  return proposal.ops;
}

/** The recorded request kinds of one card, so a test can read a flow without the whole record. */
export function coCreateRequestSteps(card: CardKind): readonly (string | undefined)[] {
  return requests.filter((request) => request.card === card).map((request) => request.step);
}
