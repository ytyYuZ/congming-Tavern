/**
 * The co-creation state layer (M1-W2, ADR-017): the conversation about a card, the proposal each
 * answer produced, and the four acts 「生成」 / 「采纳」 / 「否决」 / 「撤销」 — now with M1-W3's stepwise
 * generation and M1-W4's field-scoped edits.
 *
 * WHAT IS STATE AND WHAT IS A ROW — AND WHY NOTHING IS PERSISTED HERE
 * The CARD is the row owner's business: the draft lives in `settings` under
 * `draft.world.<id>` and `state/content-store.ts` writes it (`cards/draft.ts` records why).
 * Everything THIS store owns is a conversation about that draft, and it is deliberately IN MEMORY:
 *   • a chat about a card is not part of the card, and `docs/02` §7's collections have no place for
 *     one — a nineteenth collection for a scratch conversation would be a schema decision this task
 *     has no mandate to make;
 *   • and persistence is not needed for either acceptance half. 「生成不动草稿」 is strongest when a
 *     proposal is not a row at all, and 「采纳后可撤销」 is satisfied by the snapshot below, which is
 *     taken from the value the draft row and the screen already agree on.
 * The consequence is stated rather than hidden: closing the panel (or reloading) forgets the
 * conversation, the generation in flight and the undo, while the CARD keeps every accepted change —
 * because from the moment it is accepted, a change IS the user's own draft.
 *
 * WHY 「撤销」 RESTORES A SNAPSHOT AND NOT AN INVERSE PATCH
 * An inverse patch would be a second implementation of the patch engine (`co-create/json-patch.ts`),
 * and the acceptance is stated over the DATA: "undo means the user's data is restored, not just a UI
 * flag". `CoCreateUndo` therefore holds the payload the draft row held BEFORE the accepted proposal
 * was applied — the same object `editWorld` was given — and undo writes it back through that same
 * action. Byte-identical restoration is then a property of "we saved the bytes", not of two engines
 * agreeing about inverses.
 *
 * WHY ACCEPT APPLIES THE SAME PAYLOAD THE PREVIEW RENDERED
 * `previewWorldProposal` is called ONCE in `accept`, and its `data` is both recorded as the undo
 * snapshot's successor and written by `editWorld`. The panel calls the same function to RENDER the
 * right-hand preview, so "the preview cannot disagree with the apply" is structural rather than
 * tested-by-luck (`co-create/proposal.ts` records the pairing).
 *
 * WHAT M1-W3 / M1-W4 ADD TO THIS STORE, AND WHY IT IS NOT A SECOND ENGINE
 * One thing: a SCOPE. `co-create/scope.ts` holds the paths a turn may write, the instruction built
 * from them, and the gate that decides whether an answer stayed inside them; `co-create/plan.ts` holds
 * the step list; `co-create/field-ops.ts` builds a single-step plan for one selected field. Every turn
 * — the free conversation, a generation step, a 重写 of one field — therefore goes through ONE private
 * `ask` below, which sends through the same `askCoCreate`, parses through the same `readProposal`,
 * previews through the same `previewWorldProposal`, and is accepted / refused / undone by the same
 * three actions. 「从零生成」 walks every step of the plan; 「逐字段生成」 walks the steps the author's
 * chosen fields belong to; a field operation walks a one-step plan over the selected field. They differ
 * in the LIST and in whether the next step starts by itself (`CoCreateGeneration.mode`) — not in
 * machinery.
 *
 * WHY A PROPOSAL OUTSIDE ITS SCOPE IS REFUSED RATHER THAN TRIMMED
 * The acceptance for M1-W4 is that the scoping IS the feature, so the half that matters is the half
 * that says no: a turn about `/premise` that answers with an operation on `/era` is reported as a
 * finding naming the path, and NOTHING is written — not the in-scope operation, and not the stray one.
 * `scopeVerdict` returns both halves so the sentence can say what the model tried to do.
 *
 * WHY A REFUSED STEP STOPS AN AUTOMATIC WALK
 * 「从零生成」 asks for the next step when the author accepts one. When they REFUSE one, the plan stops
 * advancing (`reject` puts the walk in `manual`): the author has just said "not this", and starting
 * the next step would be answering a decision they have not made. `generateStep` and `skipStep` are
 * how they resume.
 *
 * WHY REQUEST FAILURES ARE FINDINGS AND NOT CRASHES
 * A model may answer prose, a fenced block, or JSON with a trailing sentence; a transport may refuse,
 * or no key may be configured. Every one of those becomes an entry in the transcript with a catalog
 * key — so 「再试一次」 is a button next to a sentence — and the draft is untouched in all of them.
 *
 * WHY THE REQUESTS ARE RECORDED
 * docs/06 §2.5's acceptance for M1-W3 is 「AI 采用结构化流程，不一次性生成全部」, which is a statement
 * about the SEQUENCE of requests rather than about any one screen. `coCreateRequests()` exposes the
 * recorded list (kind, step, scope, preamble) so a test can assert "more than one request, and no
 * request was ever allowed to touch every field" on the wire. It is a test seam in the sense
 * `resetCoCreate` already is: nothing in the app reads it, and it holds no user data.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { Extensions, WorldData } from '@smarttavern/schema';
import { create } from 'zustand';
import { askCoCreate } from '../co-create/ask';
import { fieldOpRequest, fieldOpScope } from '../co-create/field-ops';
import {
  type CoCreateGenerationPlan,
  type CoCreateStep,
  fieldSetPlan,
  stepScope,
  worldGenerationPlan,
} from '../co-create/plan';
import {
  type CoCreateProposal,
  type MalformedProposalReason,
  previewWorldProposal,
  readProposal,
  sameWorldData,
  WORLD_PATCH_PATHS,
} from '../co-create/proposal';
import {
  type CoCreateRequest,
  type CoCreateScope,
  type FieldOpKind,
  scopeInstruction,
  scopePreamble,
  scopeVerdict,
} from '../co-create/scope';
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
 * language the reader uses, and it renders once per locale. `detail` carries the local facts a
 * sentence may have a placeholder for (a schema path, a provider's own message for a log).
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
 */
export interface CoCreateUndo {
  readonly proposalId: string;
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

export interface CoCreateState {
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
  | 'turns'
  | 'proposals'
  | 'pendingId'
  | 'undoable'
  | 'busy'
  | 'finding'
  | 'generation'
  | 'acceptedPaths'
  | 'fieldOp'
> {
  return {
    turns: [],
    proposals: [],
    pendingId: undefined,
    undoable: undefined,
    busy: false,
    finding: undefined,
    generation: undefined,
    acceptedPaths: [],
    fieldOp: undefined,
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
function chatScope(): CoCreateScope {
  return {
    kind: 'chat',
    paths: WORLD_PATCH_PATHS.map((entry) => entry.path),
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
 * A union rather than a sequence of `set` calls inside `ask`: every branch below writes the SAME
 * fields (a transcript entry, perhaps a proposal, perhaps a finding), and doing it once at the end is
 * what makes "the draft did not move" a property of one code path instead of six.
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

export const useCoCreateStore = create<CoCreateState>((set, get) => {
  /**
   * Send one turn and install its answer. THE ONE PATH every co-creation request takes.
   *
   * `scope` decides what the model may write, what it is told, and what the answer is judged against.
   * The gate runs BEFORE anything is sent (`chat-store.ts`'s codes: "nothing configured" and "a key is
   * stored and this tab cannot read it" are different facts, and telling an author their key is wrong
   * when it is only locked sends them looking in the wrong place). The sentence for a local refusal is
   * rendered HERE rather than by the panel because the refusal IS this turn's answer, and the
   * transcript is where the answer goes.
   */
  async function ask(prompt: string, scope: CoCreateScope): Promise<void> {
    const text = prompt.trim();
    if (text === '') return;
    const content = useContentStore.getState();
    const draft = content.worldDraft;
    // No open card, or a turn already running: `send` is a form submit, and the panel has already
    // disabled the control — this is the store's own backstop, reported rather than thrown.
    if (content.world === undefined || draft === undefined) {
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

    const instruction = scopeInstruction(draft.data, scope);
    requests.push({
      kind: scope.kind,
      ...(scope.step === undefined ? {} : { step: scope.step }),
      ...(scope.fieldOp === undefined ? {} : { fieldOp: scope.fieldOp }),
      paths: [...scope.paths],
      instruction,
      preamble: scopePreamble(scope).join('\n'),
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
    applyOutcome(set, get, judge(answer, asked, draft.data, scope));
  }

  /** The world the store is editing, or `undefined` — the guard every action starts with. */
  function openDraft(): WorldData | undefined {
    const content = useContentStore.getState();
    return content.world === undefined ? undefined : content.worldDraft?.data;
  }

  return {
    ...emptyState(),

    async send(text: string): Promise<void> {
      // A free turn is an UNSCOPED turn (M1-W2's conversation), and it is the only one that is: a
      // generation step and a field operation both carry a scope, and the panel reaches them through
      // their own actions rather than through the composer.
      await ask(text, chatScope());
    },

    async startGeneration(): Promise<void> {
      const data = openDraft();
      if (data === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      // 「从零生成」 STARTS FROM WHAT THE CARD ALREADY SAYS, not from nothing: a card with no seed at
      // all leaves the model inventing a genre, an era and a magic system that the author then has to
      // throw away, step by step. The genre list is this app's own field for exactly that seed
      // (`cards/world.ts` renders it in 基本), so its being empty is the one precondition this flow
      // states — as a readable finding, and with the draft untouched.
      if (data.genre.length === 0) {
        set({ finding: { code: 'co-create.genreFirst' } });
        return;
      }
      const plan = worldGenerationPlan();
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
        finding: undefined,
      });
      await askNextStep(get, ask);
    },

    async startFieldGeneration(paths: readonly string[]): Promise<void> {
      if (paths.length === 0) {
        set({ finding: { code: 'co-create.nothingSelected' } });
        return;
      }
      const plan = fieldSetPlan(paths);
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
      const data = openDraft();
      if (data === undefined) {
        set({ finding: { code: 'co-create.notConfigured' } });
        return;
      }
      const request = fieldOpRequest([path]);
      set({
        fieldOp: { path, fieldOp },
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
          WORLD_PATCH_PATHS.map((entry) => entry.path).filter((entry) => entry !== path),
        ),
      );
    },

    async accept(proposalId: string): Promise<boolean> {
      const entry = get().proposals.find((candidate) => candidate.proposal.id === proposalId);
      const content = useContentStore.getState();
      const draft = content.worldDraft;
      if (entry === undefined || content.world === undefined || draft === undefined) return false;

      // THE SAME FUNCTION THE PREVIEW CALLED. One `(payload, proposal) -> payload`, so what is written
      // is exactly what the right-hand pane showed.
      const preview = previewWorldProposal(draft.data, entry.proposal);
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
      if (sameWorldData(draft.data, preview.data)) return false;

      const applied = await useContentStore.getState().editWorld(preview.data, draft.extensions);
      if (!applied) return false;

      set({
        proposals: withStatus(get().proposals, proposalId, 'accepted'),
        pendingId: undefined,
        undoable: { proposalId, data: draft.data, extensions: draft.extensions },
        finding: undefined,
      });
      await advanceAfterAccept(set, get, ask);
      return true;
    },

    async reject(proposalId: string): Promise<boolean> {
      const entry = get().proposals.find((candidate) => candidate.proposal.id === proposalId);
      if (entry === undefined) return false;
      const { pendingId, generation } = get();
      // NOTHING IS WRITTEN — that is the refusal's whole meaning, and the test that pins it compares
      // the draft ROW's bytes across the call.
      set({
        proposals: withStatus(get().proposals, proposalId, 'rejected'),
        ...(pendingId === proposalId ? { pendingId: undefined } : {}),
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
      const restored = await useContentStore
        .getState()
        .editWorld(undoable.data, undoable.extensions);
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
 * Every refusal below leaves the draft untouched by construction: none of them calls `editWorld`, and
 * `previewWorldProposal` is a pure function of the payload (`proposal.ts` records that).
 */
function judge(
  answer: Awaited<ReturnType<typeof askCoCreate>>,
  asked: readonly CoCreateMessage[],
  data: WorldData,
  scope: CoCreateScope,
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
  const proposal = read.proposal;
  // A proposal is only OFFERED when it would change something. `docs/01` §5.2's turns include "ask me
  // more first", and an empty patch is that turn: the model's message is shown and no 采纳 / 否决 pair
  // is offered, because there is nothing to accept.
  if (proposal.empty) return { kind: 'talk', asked, text: proposal.message };
  const preview = previewWorldProposal(data, proposal);
  if (preview.ok && sameWorldData(data, preview.data)) {
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
 * True while a request must NOT be started: one turn is in flight, one proposal is unanswered, or a
 * plan is still waiting for a step.
 *
 * A plan that has settled does NOT block the author (`settled`): after the last field of 「逐字段生成」
 * is accepted, working on a single field by hand is exactly what they would do next, and a guard that
 * read only `status === 'running'` would refuse it with 「生成流程正在进行」 that is no longer true.
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
 * The whole 「从零生成」 loop is here: `accept` calls it after applying a step, so a plan walks itself
 * one request at a time — which is exactly the structure M1-W3's acceptance is about, and why it is a
 * loop over STEPS rather than one request for the whole card.
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
 * ask for, and the store is written through `setState` so a step's index is on screen before the
 * answer arrives). Carrying an unused reader would suggest it decides something about the state.
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
    stepScope(generation.plan, step, accepted),
  );
}

/**
 * What an accepted proposal does to the generation it belongs to.
 *
 * The three endings, in one place: a FIELD OPERATION finishes its one-step plan and clears the
 * gesture; a plan with no pending step left is finished; and an automatic walk asks for the next step.
 * A manual walk stops asking by design — see the header — but it is still FINISHED once nothing is
 * left, which is what keeps 「从零生成」 from being offered again on a card it has already written.
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
    // A field operation is a one-step plan whose gesture is spent the moment it is applied.
    ...(generation.plan.id === 'world-card-field-op' ? { fieldOp: undefined } : {}),
  });
  // 「逐字段生成」 AND A FIELD OPERATION STOP ASKING HERE: the author chose those fields, and generating
  // one they did not ask for would be the "all at once" this milestone exists to prevent. Whether that
  // was the LAST chosen step is decided above, by whether a pending step was left.
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
