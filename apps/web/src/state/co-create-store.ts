/**
 * The co-creation state layer (M1-W2, ADR-017): the conversation about a card, the proposal each
 * answer produced, and the four acts 「生成」 / 「采纳」 / 「否决」 / 「撤销」.
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
 * conversation and the undo, while the CARD keeps every accepted change — because from the moment it
 * is accepted, a change IS the user's own draft.
 *
 * WHY 「撤销」 RESTORES A SNAPSHOT AND NOT AN INVERSE PATCH
 * An inverse patch would be a second implementation of the patch engine (`co-create/json-patch.ts`),
 * and the acceptance is stated over the DATA: "undo means the user's data is restored, not just a UI
 * flag". `CoCreateUndo` therefore holds the payload the draft row held BEFORE the accepted proposal
 * was applied — the same object `editWorld` was given — and undo writes it back through that same
 * action. Byte-identical restoration is then a property of "we saved the bytes", not of two engines
 * agreeing about inverses: `co-create-store.test.ts` applies, undoes and compares the JSON.
 *
 * WHY ACCEPT APPLIES THE SAME PAYLOAD THE PREVIEW RENDERED
 * `previewWorldProposal` is called ONCE in `accept`, and its `data` is both recorded as the undo
 * snapshot's successor and written by `editWorld`. The panel calls the same function to RENDER the
 * right-hand preview, so "the preview cannot disagree with the apply" is structural rather than
 * tested-by-luck (`co-create/proposal.ts` records the pairing).
 *
 * WHY A MALFORMED ANSWER IS A TURN AND NOT AN EXCEPTION
 * The model is a text model: it answers prose, or a fenced block, or JSON with a trailing sentence.
 * `readProposal` refuses what it cannot read, and this store turns that refusal into an entry in the
 * transcript with a catalog key — so 「再试一次」 is a button next to a sentence, the draft is
 * untouched, and nothing about the user's card depends on the model behaving.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { Extensions, WorldData } from '@smarttavern/schema';
import { create } from 'zustand';
import { askCoCreate } from '../co-create/ask';
import {
  type CoCreateProposal,
  coCreateInstructions,
  type MalformedProposalReason,
  previewWorldProposal,
  readProposal,
  sameWorldData,
} from '../co-create/proposal';
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

  /** Write the author's turn and ask the model; the answer becomes a proposal or a finding. */
  send: (text: string) => Promise<void>;
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
 * Which turn is current. Bumped by every `send` and every `reset`, so an answer that arrives after
 * the conversation was cleared (or after a newer question) cannot install a proposal into it.
 */
let askToken = 0;

/** Entry ids: a counter, because `mintUuidV7` is for PERSISTED entities (`docs/04` §4). */
let turnSequence = 0;

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
  'turns' | 'proposals' | 'pendingId' | 'undoable' | 'busy' | 'finding'
> {
  return {
    turns: [],
    proposals: [],
    pendingId: undefined,
    undoable: undefined,
    busy: false,
    finding: undefined,
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

export const useCoCreateStore = create<CoCreateState>((set, get) => ({
  ...emptyState(),

  async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (prompt === '') return;
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
    const id = nextTurnId();
    const asked = [...get().turns, { id, role: 'user' as const, text: prompt }];
    set({ turns: asked, busy: true, finding: undefined, pendingId: undefined });

    // THE GATE RUNS BEFORE ANYTHING IS SENT, with `chat-store.ts`'s codes: "nothing configured" and
    // "a key is stored and this tab cannot read it" are different facts, and telling an author their
    // key is wrong when it is only locked sends them looking in the wrong place. The sentence is
    // rendered HERE rather than by the panel because the refusal IS this turn's answer, and the
    // transcript is where the answer goes.
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

    controller = new AbortController();
    const answer = await askCoCreate(
      {
        config: {
          baseUrl: settings.provider.baseUrl,
          apiKey: settings.key ?? '',
          model: settings.provider.model,
        },
        ...(transport === undefined ? {} : { transport }),
        instruction: coCreateInstructions(draft.data),
        history: wireHistory(asked),
      },
      { signal: controller.signal },
    );

    // The conversation this answer belongs to may be gone (a `reset`, or a newer question).
    if (token !== askToken) return;

    if (!answer.ok) {
      // The code is resolved to a KEY here and the sentence is rendered by the panel, so a language
      // switch re-renders a failure the same way it re-renders everything else. The provider's own
      // sentence is deliberately NOT carried: it is written for a developer, and `detail` is a
      // placeholder for local facts (a schema path), not a channel for vendor prose.
      set({
        busy: false,
        turns: [
          ...asked,
          {
            id: nextTurnId(),
            role: 'assistant',
            text: '',
            finding: { code: messageKeyForCode(answer.error.code) },
          },
        ],
      });
      return;
    }

    const read = readProposal(answer.text, nextTurnId());
    if (!read.ok) {
      set({
        busy: false,
        turns: [
          ...asked,
          {
            id: nextTurnId(),
            role: 'assistant',
            // The model's own text is kept: the author can see what it did say, which is what makes
            // 「再试一次」 an informed decision rather than a gamble.
            text: read.malformed.text,
            finding: {
              code: MALFORMED_KEYS[read.malformed.reason],
              // The raw answer goes into the finding's `{detail}` slot, so the sentence about the
              // SHAPE and the answer itself are read together.
              detail: read.malformed.text,
            },
          },
        ],
      });
      return;
    }

    const proposal = read.proposal;
    // A proposal is only OFFERED when it would change something. `docs/01` §5.2's turns include
    // "ask me more first", and an empty patch is that turn: the model's message is shown and no
    // 采纳 / 否决 pair is offered, because there is nothing to accept.
    const preview = previewWorldProposal(draft.data, proposal);
    if (proposal.empty || (preview.ok && sameWorldData(draft.data, preview.data))) {
      set({
        busy: false,
        turns: [...asked, { id: nextTurnId(), role: 'assistant', text: proposal.message }],
      });
      return;
    }

    set({
      busy: false,
      pendingId: proposal.id,
      proposals: [...get().proposals, { proposal, status: 'pending' }],
      turns: [
        ...asked,
        {
          id: nextTurnId(),
          role: 'assistant',
          text: proposal.message,
          proposalId: proposal.id,
        },
      ],
    });
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
    return true;
  },

  async reject(proposalId: string): Promise<boolean> {
    const entry = get().proposals.find((candidate) => candidate.proposal.id === proposalId);
    if (entry === undefined) return false;
    // NOTHING IS WRITTEN — that is the refusal's whole meaning, and the test that pins it compares
    // the draft ROW's bytes across the call.
    set({
      proposals: withStatus(get().proposals, proposalId, 'rejected'),
      ...(get().pendingId === proposalId ? { pendingId: undefined } : {}),
    });
    return true;
  },

  async undoAccept(): Promise<boolean> {
    const { undoable } = get();
    if (undoable === undefined) return false;
    const restored = await useContentStore.getState().editWorld(undoable.data, undoable.extensions);
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
}));

/**
 * Test seam: forget the configured transport, the running turn and the conversation.
 *
 * The counter is bumped so an answer still in flight cannot install a proposal into the next test's
 * empty conversation.
 */
export function resetCoCreate(): void {
  askToken += 1;
  controller?.abort();
  controller = undefined;
  transport = undefined;
  useCoCreateStore.setState({ ...emptyState() });
}
