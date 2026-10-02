/**
 * The conversation state layer (M0-T8, ADR-017) — sessions, the current
 * transcript, and one in-flight turn.
 *
 * WHAT IS STATE AND WHAT IS NOT
 * `messageChain` is a READ of the persisted tree, kept live by a Dexie `liveQuery`
 * subscription (`db/database.ts`), not an array this store owns. That is the whole
 * ADR-017 decision: a message that lives only in the store does not survive a
 * reload, and the acceptance criterion for M0-T8 is that it does. The one thing
 * this store owns is `draft` — the assistant text that has arrived but is not yet a
 * row — plus `status`, the turn's lifecycle.
 *
 * WHAT M1-T1'S FOLLOW-UP ADDED: THE SESSION'S OWN CALENDAR
 * `calendar` is a READ this store keeps — the `Calendar` of the open session's pinned world
 * version — resolved ONCE in `open` (`pinnedCalendar`) rather than per render, so the clock
 * sentence, the advance arithmetic and the turn's time block cannot disagree about which
 * world's units they are in. A session whose world or version row is gone (or whose row
 * cannot be parsed) still opens on `BUILTIN_CALENDAR`: content may be deleted, the
 * conversation may not.
 *
 * WHY THE PROVIDER CONFIGURATION IS READ AT SEND TIME AND NOT HELD
 * `send()` calls `useSettingsStore.getState()` when the turn starts. A copy held here
 * would go stale the moment the user edits the setup form, and a saved key that the
 * running turn does not use is exactly the kind of bug that looks like "the model
 * ignored my key". Nothing here logs, and the configuration is passed straight into
 * `sendTurn`, which hands it to the adapter and nowhere else (HANDOFF §4.1 invariant 6).
 *
 * WHY THE LOCKED CASE IS CHECKED BEFORE ANYTHING IS SENT (M1-G3)
 * Since the key can be encrypted at rest, "there is a key and this tab cannot read it" is
 * a state a turn can start in. Sending anyway would drop the `Authorization` header and
 * the provider would answer `auth` — the user would be told their key is WRONG when it is
 * only locked, and would go looking in the wrong place. So the turn is refused locally
 * with its own code (`error.keyLocked`) and nothing leaves the device. The check sits
 * AFTER the "not configured" one because a missing endpoint is the more fundamental
 * problem: an unlocked key with no endpoint still cannot send.
 *
 * WHY THE ABORT SIGNAL IS A MODULE VARIABLE
 * `AbortController` is not serialisable and belongs to the running turn, not to
 * renderable state. `abort()` reads it; `send()` replaces it. A component that
 * wanted to watch it should watch `status` instead.
 *
 * WHY `send()` CATCHES
 * `sendTurn` reports provider failures as data, so the only things that can throw
 * out of it are local faults: the database, or a React-free bug in this store. A
 * thrown error here would otherwise reject a fire-and-forget click handler and
 * leave `status` stuck on `'streaming'` — a composer with a permanently disabled
 * send button. So the failure is surfaced as `status: 'error'`.
 *
 * WHY THE SESSION ROW IS RE-READ AFTER A TURN (M1-S6)
 * A turn can write VARIABLES: the composer records every `{{setvar}}` / `{{addvar}}` it
 * performs and `chat/send-turn.ts` applies the log (ADR-031). This store's `session` was
 * read at the START of the turn, so it predates that write — and the status bar renders
 * `session.state.vars`, which would then show the value from before the turn. The row is
 * the only copy that cannot be stale (the `advance` failure path resyncs for the same
 * reason), and the same read refreshes the `headMessageId` the turn just moved.
 *
 * WHAT M1-S2 ADDED TO THIS STORE, AND WHAT IT DELIBERATELY DID NOT
 * The message tree's three mutating acts are here — `regenerate`, `editMessage` and
 * `deleteMessage` — plus `switchBranch`, which is the read-shaped one. Each is a POINTER
 * MOVE or a single row write, because that is all docs/02 §7's tree needs: a sibling is a
 * second child of the same parent, a branch switch is `setHeadMessageId`, and an edit is
 * "write a new sibling, then move the head to it" — never an in-place change of a
 * `Message`, which would break the lineage ADR-010 pins and make a regenerated answer
 * indistinguishable from an edited one. The rules themselves are stated on each action and
 * pinned by `app/routes/routes.test.tsx`.
 *
 * `send()` and `regenerate()` share ONE turn path (`runTurn` below) on purpose: a
 * regeneration must ask the question through the SAME composer and stream through the same
 * adapter as the first answer, or "another answer to this prompt" would mean something
 * different from the answer it replaces.
 *
 * WHERE "ONLY WHILE THE CHAIN IS EMPTY" IS ENFORCED (M1-S3)
 * An opening is a START: it is the chain's first message, the only node whose `parentId` is
 * `null` and the only one that may be written while the session has no head (docs/02 §7).
 * Appending a second one is therefore not a second turn, it is a second ROOT — and the head
 * can only point at one of them, so the other becomes an unreachable row that nothing in the
 * UI can even show. The rule that forbids it lives in ONE place, HERE: `startOpening` and
 * `generateOpening` each re-read the table and refuse unless the session's head is `null` AND
 * it has no root message at all — the second half is what covers a rollback to before the first
 * message, where the head is back at `null` while the opening is still stored (ADR-010), so a
 * second attempt is a no-op in every position. The view does not repeat the rule as a guard:
 * `app/routes/play.tsx`'s `openingChoosing` only decides whether to OFFER the panel, from the
 * two values a render already has, which is why that position still shows the choice and the
 * store is what refuses the click. One rule, one decider; the one that decides the WRITE is
 * this one.
 *
 * WHY THE TWO PATHS NEED A FLAG BESIDES `status`
 * The AI path turns `status` into `'streaming'`, which already refuses a second call. The
 * hand-written one does not stream anything — `status: 'streaming'` would put the transcript
 * into a "generating" state nothing will end — so `opening` is the claim both paths take
 * SYNCHRONOUSLY, before either one's first `await`, and it is the flag that makes two
 * concurrent openings impossible rather than merely unlikely. It is deliberately one field
 * for both paths: they are the same claim ("I am writing the chain's first message") and the
 * two writes it guards are the same row.
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { Calendar, Checkpoint, Id, Message, Session, SessionState } from '@smarttavern/schema';
import { create } from 'zustand';
import { BUILTIN_CALENDAR } from '../chat/builtin-content';
import { advanceState, calendarOf } from '../chat/clock';
import { promptMessageFor, type SiblingView, siblingViewOf } from '../chat/message-tree';
import { sendTurn, type TurnAppend } from '../chat/send-turn';
import {
  deleteVariable as deleteVariableIn,
  setVariable as setVariableIn,
  type VariableValue,
} from '../chat/vars';
import { subscribe } from '../db/database';
import {
  appendMessage,
  createCheckpoint as createCheckpointRow,
  createSession,
  deleteCheckpoint as deleteCheckpointRow,
  deleteLeafMessage,
  getChain,
  getSession,
  getWorldVersion,
  hasChildren,
  listCheckpoints,
  listChildren,
  readChain,
  readSessions,
  restoreCheckpoint as restoreCheckpointRow,
  setHeadMessageId,
  writeSessionState,
} from '../db/repository';
import { KEY_LOCKED_CODE, messageKeyForCode, NOT_CONFIGURED_CODE } from '../i18n/error-keys';
import { translate } from '../i18n/translate';
import { type SessionDraft, sessionPinsOf } from '../session/roster';
import { isProviderReady, useSettingsStore } from './settings-store';
import { writeErrorName } from './write-error';

/** The turn lifecycle: nothing in flight, a stream arriving, or the last turn failed. */
export type ChatStatus = 'idle' | 'streaming' | 'error';

/** The live assistant text of the turn in flight. */
export interface StreamingDraft {
  /** The text received so far; `''` before the first delta. */
  text: string;
  /** True once any text arrived, so the view can drop its "thinking" marker. */
  started: boolean;
}

/** A failure the user can read, plus what they need to try again. */
export interface ChatError {
  /** Stable adapter vocabulary (`LLM_ERROR_CODES`), or `'unknown'`. */
  code: string;
  /** The provider's own sentence. Never the only carrier of the code. */
  message: string;
  /** From `StreamEvent['error']`: worth retrying without changing anything. */
  retryable: boolean;
  /** What the user had typed, so 「重试」 can send it again. */
  turnText: string;
  /**
   * The numbers behind a LOCAL failure — today only the prompt composer's budget
   * report (`chat/send-turn.ts`). Filled into the catalog sentence's `{detail}`
   * placeholder by the banner, so ADR-019's split holds: the store carries facts
   * (code, message, numbers), the catalog carries prose. Absent for a provider
   * failure, whose `message` is the vendor's own text for logs.
   */
  detail?: string;
}

export interface ChatState {
  sessions: Session[];
  session: Session | undefined;
  messageChain: Message[];
  /**
   * The OPEN session's save points, newest first (M1-M1). A plain copy read by
   * `open` and refreshed by every save/restore/delete, NOT a `liveQuery`: the
   * transcript is subscribed because a turn writes it while the user watches, while
   * nothing but this screen writes a checkpoint — and a subscription per collection is
   * a cost this list does not need.
   */
  checkpoints: Checkpoint[];
  /**
   * The `Calendar` the OPEN session plays under (M1-T1 follow-up): the one its pinned world
   * version carries (`Session.refs.world` -> `worldVersions.data.calendar`), or
   * `BUILTIN_CALENDAR` when that row is gone or unreadable.
   *
   * WHY IT IS STORE STATE AND READ ONCE PER `open`: only this layer may reach
   * `db/repository.ts` (ADR-017), so a view cannot resolve the pin itself — and the value has
   * to be the SAME one for the clock sentence on screen, the advance arithmetic and the time
   * block of the turn's prompt, or the date the user reads and the date the model is told
   * could differ. The pin is immutable (ADR-010), so one read per open is the whole story.
   * Before any session is open it is the built-in calendar; that value is never rendered,
   * because the clock is only rendered with a session.
   */
  calendar: Calendar;
  draft: StreamingDraft;
  /**
   * The message a NEW ANSWER is being generated for (M1-S2), or `null`.
   *
   * WHY IT EXISTS AT ALL: a regeneration writes nothing to a branch until the turn ends
   * (the partial-text policy in `chat/send-turn.ts`), so between the click and the first
   * delta the chain still holds the answer being replaced. Without this field the screen
   * cannot tell "the draft at the end belongs to THIS message" from "the user is on
   * another branch and the draft belongs to the head", and the message under
   * regeneration would get no mark at all. It is set by `regenerate` and by the branch
   * switch that gives up on one, and it is cleared the moment the turn settles.
   */
  regenerating: Id | null;
  status: ChatStatus;
  error: ChatError | undefined;
  /**
   * True while an OPENING is being written (M1-S3). Set synchronously, before either path's
   * first `await`, so a second attempt is refused rather than racing the first one into a
   * second root (`startOpening` explains why `status` cannot carry this).
   */
  opening: boolean;

  load: () => Promise<void>;
  /**
   * Create a session from the create flow's choices and open it (M1-S1).
   *
   * `draft` is `session/roster.ts`'s form value — the world version, the ticked cards, which
   * card is the player's, and the initial clock. The CAST is derived from it by the pure rule,
   * so no caller can hand this a second roster.
   *
   * Resolves the new session's id, or `undefined` when NOTHING was written: a draft the pure
   * rule refuses, or a storage failure (which also lands in `error`). The refusal is silent
   * because the screen has already rendered the sentence — `sessionIssues` is the same
   * function (`app/routes/new-session.tsx`), so the user is never left guessing.
   */
  create: (draft: SessionDraft) => Promise<Id | undefined>;
  open: (sessionId: Id) => Promise<void>;
  close: () => void;
  send: (text: string) => Promise<void>;
  abort: () => void;
  dismissError: () => void;
  /**
   * Write the chain's FIRST message from text the user typed (M1-S3's 手写).
   *
   * The row is a root (`parentId: null`) and the head moves to it — the two facts that make
   * it an opening rather than an append. Resolves `false`, writing nothing, when this session
   * already has a message or while another opening is in flight: an opening is a start, and a
   * second one would be a second root (`headMessageId` can only name one of them).
   */
  startOpening: (text: string) => Promise<boolean>;
  /**
   * Ask the model for the chain's first message (M1-S3's AI 生成).
   *
   * It goes through the ordinary turn path with `append: {mode: 'none'}`, so the instruction
   * the request carries is NOT written as a user row: the assistant answer is the chain's
   * root, which is the same start state `startOpening` leaves. Resolves `false` when the
   * session already has a message, when another opening is in flight, or when the turn cannot
   * be started at all (no configuration, a locked key) — the banner has already said why.
   */
  generateOpening: () => Promise<boolean>;
  /**
   * The run of siblings `messageId` belongs to, or `undefined` when it has none (M1-S2).
   * A read: the view asks this to decide whether to render a switcher and to label it.
   */
  siblingsOf: (messageId: Id, headMessageId: Id | null) => Promise<SiblingView | undefined>;
  /**
   * Make `messageId` the tip of the active chain (M1-S2) — the whole of "switch branch",
   * because the chain is the walk up `parentId` from `Session.headMessageId`.
   */
  switchBranch: (messageId: Id) => Promise<boolean>;
  /**
   * Write `content` as a NEW SIBLING of `messageId` and move the head to it (M1-S2).
   *
   * THE EDIT RULE: the message being edited is never overwritten. Its replacement is a
   * second child of the same parent, which is the same shape docs/02 §7 gives a
   * regeneration (重生成（同父多子）), so the two acts stay one concept and the tree keeps
   * saying which text produced which reply. The consequence, stated rather than hidden:
   * a message with replies cannot be redirected to its edited text — the replies stay
   * children of the ORIGINAL, and the edited node simply becomes a new branch. Editing
   * that is really "change this and keep everything after it" is a RE-ROLL of the branch,
   * which is what regenerate plus a new turn already is.
   */
  editMessage: (messageId: Id, content: string) => Promise<boolean>;
  /**
   * Delete `messageId` when it is a LEAF, and return whether a row was removed (M1-S2).
   *
   * THE DELETE RULE: a message with replies is REFUSED (see
   * `db/repository.ts`'s `deleteLeafMessage` for why a cascade or a re-parent is the wrong
   * answer). When the deleted leaf WAS the head, the head moves to its parent, so the
   * chain stays a real path — the same repair a rollback performs — and no message is left
   * pointing at a row that does not exist. Deleting a leaf that is OFF the active chain
   * changes nothing about the head, which is the acceptance's "切换分支内容正确" from the
   * other side: removing a rejected answer must not move the branch the user is reading.
   */
  deleteMessage: (messageId: Id) => Promise<boolean>;
  /**
   * Whether any message hangs off `messageId` — the read behind the delete control's
   * affordance (M1-S2). A node with replies is not deletable, and the row says so BEFORE
   * the click rather than after a confirmation (`state/chat-store.ts`'s `deleteMessage`
   * still refuses, and the repository re-checks inside its own transaction).
   */
  hasReplies: (messageId: Id) => Promise<boolean>;
  /**
   * Ask the model again for the answer to `messageId`'s own prompt (M1-S2). The new text
   * is a SIBLING of `messageId` — same `parentId` — and the head moves to it.
   *
   * Resolves to the failure's catalog key, or `undefined` on success. A regenerate is
   * STARTED by the caller and finishes in the store (`void`-ed by the view) so the button
   * does not have to hold the promise; this return value is for the caller that wants to
   * know why it could not start.
   */
  regenerate: (messageId: Id) => Promise<MessageKey | undefined>;
  /**
   * Continue writing from the CURRENT head through the ordinary turn path (M1-S2), with
   * no new user message. Answers `undefined` when the turn started, or the catalog key of
   * the refusal (nothing to continue from, no configuration, a turn already running).
   */
  continueWriting: () => Promise<MessageKey | undefined>;
  /**
   * Move the open session's clock by `delta` minutes (M1-T2). Resolves to the new
   * minute, or `undefined` when there is no session or the delta is not a usable
   * whole number of minutes.
   */
  advance: (delta: number) => Promise<number | undefined>;
  /**
   * Assign one free variable of the open session and persist it (M1-S6, ADR-031).
   * Resolves to `true` only when the row was written; a name no macro can address is
   * refused by the pure transition (`chat/vars.ts`) and answers `false`.
   */
  setVariable: (name: string, value: VariableValue) => Promise<boolean>;
  /** Remove one free variable of the open session and persist it (M1-S6). */
  deleteVariable: (name: string) => Promise<boolean>;
  /** Save the current instant under `label` (M1-M1). Resolves to the stored row. */
  saveCheckpoint: (label: string) => Promise<Checkpoint | undefined>;
  /** Roll the session back to a save point (M1-M1 / M1-T4). */
  restoreCheckpoint: (checkpointId: Id) => Promise<boolean>;
  /** Remove one save point. The live session is untouched. */
  deleteCheckpoint: (checkpointId: Id) => Promise<void>;
}

/**
 * The transport every turn uses. Set once by `mountApp` (or by a test's
 * `configureChat`). There is deliberately no fallback to `globalThis.fetch`: a
 * missing transport in the desktop shell would then look like a CORS failure
 * instead of a wiring mistake. `MountOptions.transport` is how it is supplied.
 */
let transport: FetchLike | undefined;
/** The abort channel of the turn in flight; `undefined` when nothing is running. */
let controller: AbortController | undefined;
/** The `liveQuery` subscription of the open session; `undefined` when closed. */
let unsubscribe: (() => void) | undefined;
/**
 * Which `open` is current. Bumped by every `open` and every `close`, so a read that
 * resolves after its view is gone can tell that it has been superseded and stop.
 */
let openToken = 0;

const IDLE_DRAFT: StreamingDraft = { text: '', started: false };

/** Wire the store to its dependencies. Called once by `mountApp`. */
export function configureChat(next: { transport: FetchLike }): void {
  transport = next.transport;
}

/**
 * `code` -> the sentence the error banner shows.
 *
 * THE SENTENCE MAP MOVED OUT OF THIS MODULE. It used to hold six Chinese strings here,
 * which made a state module the owner of UI prose: translating the app meant editing the
 * state layer, and the checker could only see the literals, not the coupling. The codes
 * are the store's business (`ChatError.code`); the sentence per code is
 * `i18n/error-keys.ts`'s, and the view resolves it through `t(...)`. This helper stays
 * for the one caller with no translator at hand — a test or a log line — and it is
 * deliberately a thin wrapper so there is exactly one code->key table in the app.
 */
export function errorLabel(code: string): string {
  return errorSentence({ code });
}

/**
 * The sentence the banner renders for one failure, with the local `detail` filled in.
 *
 * ONE function for the view and for `errorLabel`, because the banner and a log line
 * must not be able to disagree about what a code says. `detail` is passed as the
 * `{detail}` parameter, so a code whose sentence has no placeholder (`error.auth`)
 * simply ignores it — which is what keeps a provider failure's `message` out of the UI
 * (ADR-019). The parameter set is uniform while only `error.promptBudget` uses it:
 * `translate` leaves an unused parameter alone rather than erroring.
 */
export function errorSentence(error: { readonly code: string; readonly detail?: string }): string {
  return translate(messageKeyForCode(error.code), { detail: error.detail ?? '' });
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  session: undefined,
  messageChain: [],
  checkpoints: [],
  calendar: BUILTIN_CALENDAR,
  draft: { ...IDLE_DRAFT },
  regenerating: null,
  status: 'idle',
  error: undefined,
  opening: false,

  async load(): Promise<void> {
    set({ sessions: await readSessions() });
  },

  async create(draft: SessionDraft): Promise<Id | undefined> {
    // THE GATE IS THE PURE RULE, and it runs BEFORE anything is written: `sessionPinsOf`
    // answers `undefined` for exactly the drafts `sessionIssues` refuses, so a half-made choice
    // cannot reach the database and this action has no second opinion to offer.
    const refs = sessionPinsOf(draft);
    if (refs === undefined) return undefined;
    try {
      // The default title is PERSISTED DATA written in the ACTIVE language: `createSession`
      // deliberately does not know about locales (`db/repository.ts` records why), so the
      // sentence is chosen here, where the locale store is reachable.
      const session = await createSession({
        title: translate('home.defaultSessionTitle'),
        refs,
        initialClock: draft.initialClock,
      });
      // The ROW is written first and the in-memory state adopts what it returned: the next
      // gesture (the play screen the caller navigates to) re-reads the row, so a list refreshed
      // from anything but the row would be a second source of truth (`state/content-store.ts`'s
      // publish follows the same order).
      await get().load();
      await get().open(session.id);
      return session.id;
    } catch (cause) {
      // The failure's NAME, not a provider sentence (`write-error.ts`'s rule), carried in the
      // shape the banner already renders — the same one `open`'s live-query failure uses.
      set({
        error: {
          code: 'unknown',
          message: writeErrorName(cause, 'unknown session write failure'),
          retryable: false,
          turnText: '',
        },
      });
      return undefined;
    }
  },

  async open(sessionId: Id): Promise<void> {
    get().close();
    // `open` is async (it reads the session row), so an unmount can beat the read back.
    // Without this token the late continuation below would install a `liveQuery` on a
    // view that is gone and nobody would ever unsubscribe it — the subscription would
    // outlive the component, and closing the database afterwards would reject it into an
    // unhandled error. The token makes "this open is still the current one" checkable.
    openToken += 1;
    const token = openToken;
    const session = await getSession(sessionId);
    if (token !== openToken) return;
    // The calendar follows the SAME token as the session row: a late answer for a session the
    // user has already left must not install its world's month names against the new one.
    const calendar = session === undefined ? BUILTIN_CALENDAR : await pinnedCalendar(session);
    if (token !== openToken) return;
    // Read BEFORE the single `set`, and only then applied: the list is a second async
    // read, and awaiting it inside the `set` argument would let a close or a new `open`
    // run in between and be overwritten by this one's result.
    const checkpoints = await listCheckpoints(sessionId);
    if (token !== openToken) return;
    set({
      session,
      calendar,
      checkpoints,
      error: undefined,
      status: 'idle',
      draft: { ...IDLE_DRAFT },
    });
    // The transcript is a live query, so a message written by this turn OR by
    // another tab lands in the view without anyone re-fetching it by hand.
    unsubscribe = subscribe(
      () => readChain(sessionId),
      (messageChain) => set({ messageChain }),
      // A live query does not throw: it reports. A closed database (a closed tab, or a
      // test that closed it mid-flight) must not become an unhandled rejection — the
      // store turns it into the error state the view already knows how to show.
      (cause) => {
        if (token !== openToken) return;
        set({
          status: 'error',
          error: {
            code: 'unknown',
            message: cause instanceof Error ? cause.name : 'liveQuery failed',
            retryable: false,
            turnText: '',
          },
        });
      },
    );
  },

  close(): void {
    // Bumping the token invalidates any in-flight `open`, so it cannot re-subscribe.
    openToken += 1;
    unsubscribe?.();
    unsubscribe = undefined;
    set({
      session: undefined,
      messageChain: [],
      checkpoints: [],
      // The calendar belonged to the session that just closed; leaving it would let the next
      // session's first frame render this world's month names before `open` resolves.
      calendar: BUILTIN_CALENDAR,
      draft: { ...IDLE_DRAFT },
      regenerating: null,
      status: 'idle',
      error: undefined,
      opening: false,
    });
  },

  async send(text: string): Promise<void> {
    const state = get();
    const session = state.session;
    const trimmed = text.trim();
    if (session === undefined || trimmed === '' || state.status === 'streaming') return;

    // `turnGate` reports the refusal it just recorded; a turn with no gate runs.
    if (turnGate(set, trimmed) !== undefined) return;

    controller = new AbortController();
    set({ status: 'streaming', error: undefined, draft: { ...IDLE_DRAFT }, regenerating: null });

    // One turn, through the store's `runTurn` below — see the header for why `send` and
    // `regenerate` must not each grow their own copy of this path. `userText` is what the
    // banner's 「重试」 resends, and it is the text the user typed.
    await runTurn(set, {
      sessionId: session.id,
      append: undefined,
      userText: trimmed,
      prompt: trimmed,
    });
  },

  abort(): void {
    controller?.abort();
  },

  dismissError(): void {
    set({ error: undefined, status: 'idle' });
  },

  /** See the interface's `startOpening` for the rule this enforces. */
  async startOpening(text: string): Promise<boolean> {
    const state = get();
    const session = state.session;
    const content = text.trim();
    if (session === undefined || content === '') return false;
    // The claim is taken BEFORE the first `await` (see the header): from here on, every other
    // caller sees `opening` and is refused, so the emptiness check below cannot be passed by
    // two callers at the same moment.
    if (state.opening || state.status === 'streaming') return false;
    set({ opening: true });
    try {
      // THE GUARD IS THE ROWS, NOT THE RENDERED CHAIN. `messageChain` is a live view and can be
      // a beat behind the database (a fresh `open`, a write from another tab), so the store
      // asks the table instead: an opening may only be written into a session that has NO
      // message at all and whose head is still `null`. The ROOT check is what handles the
      // position a rollback leaves — the head back at `null` while the opening is still stored
      // (ADR-010: messages are never deleted) — where a second opening would be a second root
      // that no head can reach.
      const stored = await getSession(session.id);
      if (stored === undefined || stored.headMessageId !== null) return false;
      if ((await listChildren(session.id, null)).length > 0) return false;

      const opening = await appendMessage({
        sessionId: session.id,
        // THE EDGE THAT MAKES IT AN OPENING: a root has no parent (docs/02 §7), which is what
        // distinguishes the first message of a session from every message after it.
        parentId: null,
        // `user`: this is text a person typed, and the next turn answers it. The role is the
        // same one the composer writes — a hand-written opening is the first thing the player
        // says, so modelling it as an assistant turn would put words in the model's mouth.
        role: 'user',
        content,
      });
      await setHeadMessageId(session.id, opening.id);
      const messageChain = await getChain(session.id);
      set({
        session: { ...session, headMessageId: opening.id },
        messageChain,
        // The turn's own state is reset: an opening is a fresh transcript, and a banner left
        // over from a previous failure would describe a session that no longer exists.
        error: undefined,
        status: 'idle',
      });
      return true;
    } finally {
      set({ opening: false });
    }
  },

  /** See the interface's `generateOpening` for the rule this enforces. */
  async generateOpening(): Promise<boolean> {
    const state = get();
    const session = state.session;
    if (session === undefined) return false;
    if (state.opening || state.status === 'streaming') return false;
    // Read BEFORE the claim: a refused call must not leave the flag set for the next one. The
    // two facts are the same ones `startOpening` checks — the session has not started (its head
    // is `null`) and no opening is already a root there.
    const stored = await getSession(session.id);
    if (stored === undefined || stored.headMessageId !== null) return false;
    if ((await listChildren(session.id, null)).length > 0) return false;
    // The gate runs before the claim so a missing configuration is reported (`turnGate` puts
    // its sentence in the banner) and leaves nothing latched behind it.
    const gate = turnGate(set, translate('play.openingInstruction'));
    if (gate !== undefined) return false;

    set({ opening: true });
    try {
      controller = new AbortController();
      set({ status: 'streaming', error: undefined, draft: { ...IDLE_DRAFT }, regenerating: null });
      await runTurn(set, {
        sessionId: session.id,
        // NOTHING IS WRITTEN BEFORE THE REQUEST (M1-S2's `'none'`, reused rather than
        // re-invented): the composer is handed the opening instruction as this turn's input,
        // and the ASSISTANT row the model answers with becomes the chain's root, because the
        // head is `null`. The instruction itself is therefore on the wire only — it never
        // becomes a user message the transcript would show and the next turn would quote.
        append: { mode: 'none' },
        userText: translate('play.openingInstruction'),
        prompt: translate('play.openingInstruction'),
      });
      // The answer is the chain's first row only if the turn really wrote one — the
      // partial-text policy in `chat/send-turn.ts` discards an errored turn and leaves the
      // transcript empty. Asking the ROW rather than trusting the call is what keeps `false`
      // honest, so the panel stays on screen beside the banner that explained the failure.
      const written = await getChain(session.id);
      return written.some((message) => message.parentId === null);
    } finally {
      set({ opening: false });
    }
  },

  /**
   * The sibling run `messageId` belongs to (M1-S2) — one read, and one answer.
   *
   * WHY THE STORE READS THE SIBLINGS AND NOT THE VIEW: the table is the only place a
   * sibling that is NOT on the active chain exists, and `db/repository.ts` is the only
   * module that speaks to it (ADR-017). The view therefore asks this question and renders
   * the answer; it never holds a second, possibly staler, copy of the tree.
   *
   * WHY THE HEAD IS AN ARGUMENT: the view already reads the active tip (it needs it to know
   * when to ask again), and a caller that passes a head the store has moved past would be
   * labelling a run with a stale "you are here". The two disagreeing is the ordinary
   * race — another tab, or a rollback — so the honest answer there is `undefined` (render no
   * switcher) rather than a run labelled with a head the database no longer holds. The next
   * render passes the current head and the switcher appears.
   */
  async siblingsOf(messageId: Id, headMessageId: Id | null): Promise<SiblingView | undefined> {
    const session = get().session;
    const current = session?.headMessageId ?? null;
    if (session === undefined || current !== headMessageId) return undefined;
    const message = get().messageChain.find((candidate) => candidate.id === messageId);
    if (message === undefined) return undefined;
    const siblings = await listChildren(session.id, message.parentId);
    return siblingViewOf(siblings, messageId, headMessageId);
  },

  /**
   * Move the transcript tip to `messageId` (M1-S2).
   *
   * WHY THE CHAIN IS RE-READ HERE AND NOT LEFT TO THE SUBSCRIPTION: this is the action the
   * milestone's acceptance is stated over ("切换分支内容正确"), and a caller — a person, or
   * the test that pins it — must be able to observe the other branch the moment this
   * resolves. The `liveQuery` subscription will emit the same chain a moment later; a
   * screen that showed BOTH chains in between would be the one visible failure of "just
   * move the pointer", so the re-read is what removes it.
   *
   * WHAT IS *NOT* CHECKED HERE, AND WHY THAT IS THE DESIGN
   * The target is a member of a run of siblings the caller read from the TABLE
   * (`siblingsOf`), and an off-chain sibling is the whole point of the act — requiring it to
   * be on the CURRENT chain would refuse exactly the switch this control exists for. What
   * the write must not do is name a row of another session or a row that does not exist, and
   * that is checked where the id comes from a stranger: `siblingsOf` reads the children of
   * THIS session, and a view it refused is never rendered (so no arrow can hold such an id).
   * If the row is nevertheless gone by the time the click lands, the head points at a
   * missing row and `getChain` answers a shorter chain — the same recoverable position a
   * delete of the head produces, and `deleteMessage` repairs that one by construction.
   */
  async switchBranch(messageId: Id): Promise<boolean> {
    const session = get().session;
    if (session === undefined) return false;
    await setHeadMessageId(session.id, messageId);
    const messageChain = await getChain(session.id);
    set({
      session: { ...session, headMessageId: messageId },
      messageChain,
      // A branch switch gives up on any regeneration the previous branch was waiting for.
      regenerating: null,
    });
    return true;
  },

  /** See the interface's `editMessage` for the rule, and for what it costs. */
  async editMessage(messageId: Id, content: string): Promise<boolean> {
    const session = get().session;
    const edited = content.trim();
    if (session === undefined || edited === '') return false;
    const target = get().messageChain.find((message) => message.id === messageId);
    if (target === undefined) return false;

    const sibling = await appendMessage({
      sessionId: session.id,
      // THE EDGE IS REUSED, NOT REPLACED: the replacement hangs off the same parent, which
      // is what makes the two versions a run of siblings rather than a chain.
      parentId: target.parentId,
      role: target.role,
      content: edited,
      // The presentation fields travel WITH the text: an edited narration must not become
      // ordinary dialogue, and a card's line must not lose the card that spoke it. The
      // debug trail (`meta`, `extensions`) deliberately does NOT: it describes how THESE
      // bytes were generated, and this text was typed by a person, so inheriting
      // `meta.model`/`promptSnapshotId` would be a false record.
      kind: target.kind,
      ...(target.speakerId === undefined ? {} : { speakerId: target.speakerId }),
    });
    await setHeadMessageId(session.id, sibling.id);
    const messageChain = await getChain(session.id);
    set({ session: { ...session, headMessageId: sibling.id }, messageChain, regenerating: null });
    return true;
  },

  /** See the interface's `deleteMessage` for the rule. */
  async deleteMessage(messageId: Id): Promise<boolean> {
    const session = get().session;
    if (session === undefined) return false;
    const target = get().messageChain.find((message) => message.id === messageId);
    if (target === undefined) return false;

    const removed = await deleteLeafMessage(session.id, messageId);
    if (!removed) return false;

    // The head moves ONLY when it named the row that just went, and it moves to that
    // row's parent — the position the deleted message was generated from.
    const headMessageId =
      session.headMessageId === messageId ? target.parentId : session.headMessageId;
    if (headMessageId !== session.headMessageId) {
      await setHeadMessageId(session.id, headMessageId);
    }
    const messageChain = await getChain(session.id);
    set({ session: { ...session, headMessageId }, messageChain });
    return true;
  },

  /**
   * Whether any message hangs off `messageId` (M1-S2) — the read behind the delete control's
   * affordance. A node with replies cannot be deleted, and the row says so BEFORE the click
   * instead of after a confirmation. Nothing about the write depends on this value: the
   * repository re-checks the rule inside the delete's own transaction.
   */
  async hasReplies(messageId: Id): Promise<boolean> {
    const session = get().session;
    if (session === undefined) return false;
    return hasChildren(session.id, messageId);
  },

  /**
   * Ask again for the answer to `messageId`'s prompt (M1-S2).
   *
   * WHAT MAKES IT A SIBLING AND NOT A CHILD: `sendTurn` appends the user turn it is given
   * as a child of the CURRENT head. So the head is first moved to `target.parentId` (the
   * user message the answer being regenerated replies to) and `sendTurn` is given that
   * user text again — and the new pair lands as another child of the same parent, which is
   * exactly 「同父多子」 (docs/02 §7). The old answer is untouched and stays the previous
   * member of the run, so the switcher can go back to it.
   *
   * WHY THE ANSWER IS LOCATED BY ROLE AND POSITION RATHER THAN BY THE CLICKED ID: the
   * clicked message IS the answer, and `promptMessageFor` is what turns it into the
   * question. A message with no earlier user turn (or one that is not on the active chain,
   * i.e. a stale click after another tab moved the branch) cannot be regenerated, and the
   * caller is told why through the banner and the returned catalog key.
   */
  async regenerate(messageId: Id): Promise<MessageKey | undefined> {
    const session = get().session;
    if (session === undefined) return 'error.messageMissing';
    const target = get().messageChain.find((message) => message.id === messageId);
    const prompt =
      target === undefined ? undefined : promptMessageFor(get().messageChain, messageId);
    if (target === undefined || prompt === undefined) return 'error.messageMissing';

    // The refusal key is handed back so a caller that shows its own sentence can; the
    // banner shows it either way (see `turnGate`).
    const gate = turnGate(set, prompt.content);
    if (gate !== undefined) return gate;

    // THE HEAD MOVES FIRST, AND IT IS THE WHOLE MECHANISM: with the tip on the answer's own
    // parent, the turn's assistant row is written as ANOTHER CHILD of that parent — a
    // sibling (docs/02 §7's 同父多子) — and the request is composed from the chain up to that
    // parent, i.e. the same history the answer being replaced was given.
    await setHeadMessageId(session.id, target.parentId);
    const messageChain = await getChain(session.id);
    set({
      session: { ...session, headMessageId: target.parentId },
      messageChain,
      status: 'streaming',
      error: undefined,
      draft: { ...IDLE_DRAFT },
      regenerating: messageId,
    });

    controller = new AbortController();
    await runTurn(set, {
      sessionId: session.id,
      // The question is already in the chain: this turn appends the ANSWER only, under the
      // head the store just moved to the answer's own parent — which is what makes the two
      // answers siblings rather than a second exchange.
      append: { mode: 'assistant' },
      userText: prompt.content,
      prompt: prompt.content,
    });
    return undefined;
  },

  /** See the interface's `continueWriting`. */
  async continueWriting(): Promise<MessageKey | undefined> {
    const session = get().session;
    const chain = get().messageChain;
    const head = chain[chain.length - 1];
    if (session === undefined) return 'error.messageMissing';
    // The refusals, in the order a reader would check them. Only an ASSISTANT turn is
    // continued: a continuation means "keep going from the model's own last sentence",
    // while a head the USER wrote has nothing to continue (the composer is the way forward)
    // and an empty transcript has nothing to continue FROM.
    if (head === undefined || head.id !== session.headMessageId) return 'play.nothingToContinue';
    if (head.role !== 'assistant') return 'play.continueNeedsAssistant';
    // A turn already in flight is normally unreachable (the control is disabled while
    // `status` is `streaming`); this branch covers a programmatic second caller, and it
    // reports the same "nothing to continue" fact rather than starting a second stream.
    if (get().status === 'streaming') return 'play.nothingToContinue';
    // A refusal here has already been recorded in `error` for the banner.
    const gate = turnGate(set, promptMessageFor(chain, head.id)?.content ?? '');
    if (gate !== undefined) return gate;

    // THE CONTINUATION IS `sendTurn` WITH THE HEAD UNMOVED: it asks the same question again
    // with no new user turn, which is exactly the path a second "继续" already took before
    // this milestone (`send-turn.test.ts` chains onto the stored head).
    controller = new AbortController();
    set({ status: 'streaming', error: undefined, draft: { ...IDLE_DRAFT }, regenerating: null });
    await runTurn(set, {
      sessionId: session.id,
      // Nothing is written before the request: the head is the slice of chain to continue,
      // and the answer lands under it — a CHILD of the current tip.
      append: { mode: 'none' },
      userText: promptMessageFor(chain, head.id)?.content ?? '',
      prompt: '',
    });
    return undefined;
  },

  /**
   * Move the clock by `delta` minutes and persist the whole state (M1-T2).
   *
   * WHY THE STORE OWNS THE `await`, NOT THE VIEW: the view's button handler is
   * fire-and-forget, and an unhandled rejection there is a click that did nothing and
   * said nothing. This action never rejects — the same rule every settings store
   * follows (`state/write-error.ts`).
   *
   * WHY THE STATE CHANGES BEFORE THE WRITE: the acceptance sentence is 推进立即反映到 UI
   * 与状态 ("the advance shows up immediately in the UI and in the state"), and
   * `await writeSessionState(...)` first would leave the on-screen clock at the old
   * minute until IndexedDB answered. The store's `session` IS the value the view
   * renders, so setting it here is what "immediately" means; the row follows.
   *
   * WHY A FAILED WRITE RESYNCS INSTEAD OF GUESSING: the in-memory minute is not on
   * disk, so the two disagree. Rolling back to the value this action read would be
   * wrong too — the user may have pressed a second button while the first write was in
   * flight — so the state is re-read from the repository, which is the only copy that
   * cannot be stale. `error` carries the failure's NAME (`writeErrorName`'s rule: a
   * storage message can quote the value that failed to store).
   *
   * A delta that is not a whole, non-zero number of minutes is REFUSED rather than
   * rounded: the engine throws on a fractional delta, and "+0 minutes" is a button that
   * cannot do anything.
   */
  async advance(delta: number): Promise<number | undefined> {
    const session = get().session;
    if (session === undefined || !Number.isInteger(delta) || delta === 0) return undefined;
    // The calendar this session plays under, not the built-in face: the engine walks in the
    // world's own units (a 100-minute hour is legal data), and the same value is what the
    // clock above the buttons renders from.
    const nextState = advanceState(get().calendar, session.state, delta);
    set({ session: { ...session, state: nextState } });
    try {
      await writeSessionState(session.id, nextState);
      set({ error: undefined });
    } catch (cause) {
      set({ error: localFailure(cause, 'unknown clock write failure') });
      // The persisted state is re-read so the view cannot claim a minute the database
      // does not hold. `getSession` completes a legacy row the same way every reader
      // does (ADR-032).
      const stored = await getSession(session.id);
      if (stored !== undefined) set({ session: stored });
      return undefined;
    }
    return nextState.clock;
  },

  /**
   * Write one variable through the pure transition and persist it (M1-S6, ADR-031).
   *
   * WHY THE WRITE IS AWAITED BEFORE THE STATE MOVES — THE OPPOSITE OF `advance`
   * An advance is a request whose result the user watches, so the screen leads and the row
   * follows. A variable edit is a form submission, and the save point the user may take
   * next reads the ROW inside its own transaction (`createCheckpoint`): if the store
   * claimed a value the row did not hold yet, a checkpoint taken immediately afterwards
   * would snapshot the old variables, and the milestone's acceptance sentence ("variables
   * are saved and restored with the save point") would fail on a race rather than on a
   * design. So the row is written first and the in-memory session is derived from the very
   * value that was written — never re-read, which is also what removes the race with the
   * live query.
   *
   * WHAT A REFUSAL IS: `chat/vars.ts` answers `undefined` for a name no macro can address
   * (blank after trimming) or for a delete of something that is not there. That is a
   * `false` here and nothing is written — the view says so instead of reporting a save
   * that did not happen. A STORAGE failure is reported through the banner with the error's
   * NAME only (`writeErrorName`'s rule) after the state is resynced from the row.
   */
  async setVariable(name: string, value: VariableValue): Promise<boolean> {
    const session = get().session;
    if (session === undefined) return false;
    const next = setVariableIn(session.state, name, value);
    if (next === undefined) return false;
    return commitState(set, session, next, 'unknown variable write failure');
  },

  async deleteVariable(name: string): Promise<boolean> {
    const session = get().session;
    if (session === undefined) return false;
    const next = deleteVariableIn(session.state, name);
    if (next === undefined) return false;
    return commitState(set, session, next, 'unknown variable write failure');
  },

  /**
   * Save the current instant under `label` (M1-M1).
   *
   * THE SNAPSHOT IS TAKEN BY THE REPOSITORY, not from `get().session`: `createCheckpoint`
   * reads the session row inside its own transaction, which is what makes
   * state + `headMessageId` ONE instant. Handing it the store's copy would reintroduce
   * exactly the split the repository avoids — the store's copy can be a turn behind the
   * head the turn just wrote. The label is chosen here because a default label is
   * PERSISTED copy and therefore has to be translated where the locale store is
   * reachable (`createSession`'s title records the same argument).
   *
   * The new row is put at the FRONT of `checkpoints`: the list is newest-first, the row
   * was just minted, and re-reading the whole list to learn that would be a round trip
   * for a fact this call already holds.
   */
  async saveCheckpoint(label: string): Promise<Checkpoint | undefined> {
    const session = get().session;
    if (session === undefined) return undefined;
    const stored = await createCheckpointRow({ sessionId: session.id, label });
    if (stored === undefined) return undefined;
    set({ checkpoints: [stored, ...get().checkpoints] });
    return stored;
  },

  /**
   * Roll the session back to a save point (M1-M1 / M1-T4).
   *
   * WHY THE WRITE IS AWAITED BEFORE THE STATE MOVES, UNLIKE `advance`
   * An advance is a request whose result the user is watching, so the screen leads and
   * the row follows. A restore is the opposite: its whole value is that the clock, the
   * vars, the scene and the transcript tip move back TOGETHER, and a screen that showed
   * the rollback while the row still held the new position would be exactly the
   * inconsistency this milestone exists to remove. So the row is written first, and the
   * in-memory state is derived from the SAME checkpoint object that was written — never
   * re-read, which is also what removes the race with the live query.
   *
   * The message chain is re-read by hand: the `liveQuery` subscription will emit the
   * restored chain on its own schedule, but a caller (and the test) must be able to see
   * the rollback the moment this resolves. Messages are never deleted (ADR-010) — the
   * rows after the save point stay in the database and are simply no longer on the
   * active chain, so re-loading the save or taking the other branch again still works.
   */
  async restoreCheckpoint(checkpointId: Id): Promise<boolean> {
    const session = get().session;
    if (session === undefined) return false;
    const checkpoint = get().checkpoints.find((candidate) => candidate.id === checkpointId);
    // A checkpoint that is not in this session's list belongs to another session's
    // transcript: restoring it would move THIS session's head to a message id that is
    // not in its tree, leaving an empty chain and a head that points nowhere.
    if (checkpoint === undefined || checkpoint.sessionId !== session.id) return false;
    const restored = await restoreCheckpointRow(checkpointId);
    if (restored === undefined) return false;
    const messageChain = await getChain(session.id);
    set({
      session: {
        ...session,
        state: { ...checkpoint.state },
        headMessageId: restored.headMessageId,
      },
      messageChain,
    });
    return true;
  },

  /** Remove one save point. The live position is deliberately untouched. */
  async deleteCheckpoint(checkpointId: Id): Promise<void> {
    await deleteCheckpointRow(checkpointId);
    set({
      checkpoints: get().checkpoints.filter((candidate) => candidate.id !== checkpointId),
    });
  },
}));

/**
 * The calendar of the session's PINNED world version, or the built-in one (M1-T1 follow-up).
 *
 * TWO FAILURES, ONE ANSWER. `session.refs.world` names `{id, version}`, and the row carrying
 * the calendar is the `worldVersions` row `getWorldVersion` reads: it answers `undefined` when
 * no such row exists (the world was deleted, or the pin names a version nobody published) and
 * it THROWS when a row is there but cannot be parsed (`WorldVersionSchema.parse`) — which is
 * how "its calendar is unreadable" reaches this function. Both are the same fact to a session
 * that only wants to open: there is no calendar to read, so the built-in face is used and the
 * session plays on. Rejecting here would take the whole play screen — the transcript included
 * — down with a content row, which is the failure `db/repository.ts`'s `completeState` exists
 * to avoid one layer down.
 *
 * The read happens ONCE, in `open`, and is guarded by that action's token: `calendarOf` owns
 * WHICH calendar an absent row means, and this function owns only the two ways a row can fail
 * to arrive.
 */
async function pinnedCalendar(session: Session): Promise<Calendar> {
  try {
    return calendarOf(await getWorldVersion(session.refs.world.id, session.refs.world.version));
  } catch {
    return calendarOf(undefined);
  }
}

/**
 * Refuse a turn when the app cannot send one, and report which fact is missing.
 *
 * Returns the CATALOG KEY of the refusal (so `regenerate` and `continueWriting` can hand
 * it back) or `undefined` when the turn may start, and it puts the failure in `error` so
 * the banner shows it either way. `turnText` is what 「重试」 resends.
 *
 * WHY THE KEY AND NOT THE SENTENCE: `ChatError.message` is the LOG side of the error
 * (ADR-019 keeps code and prose apart), and this module must not hold UI copy — the key is
 * resolved through `translate` for the log and through the catalog for the banner.
 */
function turnGate(
  set: (partial: Partial<ChatState>) => void,
  turnText: string,
): MessageKey | undefined {
  const fail = (code: string, messageKey: MessageKey): MessageKey => {
    set({
      status: 'error',
      error: { code, message: translate(messageKey), retryable: false, turnText },
    });
    return messageKey;
  };
  if (transport === undefined) {
    // A wiring bug, not a provider failure: nothing was configured to send with.
    return fail('unknown', 'error.notInitialized');
  }
  const settings = useSettingsStore.getState();
  if (!isProviderReady(settings.provider)) {
    // Its own code so the banner can name the missing settings instead of the catch-all
    // (`i18n/error-keys.ts`).
    return fail(NOT_CONFIGURED_CODE, 'error.notConfigured');
  }
  if (settings.locked) {
    // A key EXISTS and cannot be read (M1-G3). The request must not go out: an omitted
    // `Authorization` header would come back as `auth`, telling the user their key is
    // wrong when it is only locked — a wrong explanation of a local fact. Nothing is sent
    // and the banner names the fix.
    return fail(KEY_LOCKED_CODE, 'error.keyLocked');
  }
  return undefined;
}

/**
 * One turn through `chat/send-turn.ts`, from the store that owns the turn's lifecycle.
 *
 * WHY THIS IS ONE HELPER FOR THREE GESTURES (M1-S2)
 * `send`, `regenerate` and `continueWriting` differ only in WHERE the turn attaches and
 * what prompt text it composes from — the transcript tip before the turn is the same for
 * all three, because each has already moved the head to the position it means. Everything
 * after that is identical: gate, stream, report deltas, re-read the row the composer may
 * have written variables into, and put the store back into a settled state. Three copies of
 * that would be three chances for 「停止」 or the error banner to behave differently
 * depending on which button started the turn.
 *
 * `params.append` is `undefined` for a REGENERATION or a CONTINUATION, where the question
 * is already stored and the head is already where it should be; `params.prompt` is the
 * text the composer is asked about. A continuation passes `''`, which is exactly the
 * request that asks the model to keep going from the history it is given.
 */
interface TurnParams {
  readonly sessionId: Id;
  /** What the turn writes before its request; omitted for an ordinary composer turn. */
  readonly append: TurnAppend | undefined;
  /** What 「重试」 resends when this turn fails. */
  readonly userText: string;
  /** The prompt the composer is asked about; `''` continues from the history. */
  readonly prompt: string;
}

async function runTurn(
  set: (partial: Partial<ChatState>) => void,
  params: TurnParams,
): Promise<void> {
  const session = await getSession(params.sessionId);
  if (session === undefined) {
    set({ status: 'error', error: localFailure(new Error('session'), 'unknown turn failure') });
    return;
  }
  const settings = useSettingsStore.getState();
  // The key travels in this object and nowhere else. `settings.key` is absent only for
  // "no key stored", which is the documented way to reach a local Ollama or vLLM:
  // `OpenAICompatibleOptions.apiKey` documents an empty string as "send no
  // `Authorization` header", which is exactly what `''` produces here.
  const config = {
    baseUrl: settings.provider.baseUrl,
    apiKey: settings.key ?? '',
    model: settings.provider.model,
  };
  const signal = controller?.signal ?? new AbortController().signal;
  try {
    const result = await sendTurn(
      {
        config,
        // The session's calendar, so the time block the model is sent is in the world's own
        // month names and hours — the SAME value the clock on screen renders from
        // (`WorldClock`), which is the point of reading it once in `open`.
        calendar: useChatStore.getState().calendar,
        ...(transport === undefined ? {} : { transport }),
        // The streaming render: the answer appears as it arrives, because nothing is
        // persisted until the turn ends (see the partial-text policy in `send-turn`).
        onDelta: (text) => set({ draft: { text, started: text !== '' } }),
      },
      {
        sessionId: params.sessionId,
        text: params.prompt,
        signal,
        ...(params.append === undefined ? {} : { append: params.append }),
      },
    );
    // See the header: the composer may have written variables, and this store's copy of
    // the session predates that write. Read BEFORE the `set` below so the status bar and
    // the turn's own status land in one render.
    const stored = await getSession(params.sessionId);
    set({
      draft: { ...IDLE_DRAFT },
      regenerating: null,
      ...(stored === undefined ? {} : { session: stored }),
      status: result.error === undefined ? 'idle' : 'error',
      error:
        result.error === undefined
          ? undefined
          : {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
              turnText: params.userText,
              // Present only for a local failure (the composer's budget report); absent for
              // a provider failure, whose sentence is the vendor's own text for logs and
              // has no numbers to interpolate.
              ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
            },
    });
  } catch (cause) {
    // A local fault (the database, a React-free bug in the store). The error's own NAME is
    // the useful log detail and carries no provider prose (`send-turn.ts`'s `describeThrown`).
    set({
      draft: { ...IDLE_DRAFT },
      regenerating: null,
      status: 'error',
      error: {
        code: 'unknown',
        message: writeErrorName(cause, 'error.localFailure'),
        retryable: false,
        turnText: params.userText,
      },
    });
  } finally {
    // The live query refreshes the chain on its own schedule; this store only resets the
    // turn's own state.
    controller = undefined;
  }
}

/**
 * Persist one pure session-state transition and mirror it in the store (M1-S6).
 *
 * Shared by the two variable actions because they differ only in the transition they
 * computed: both write the row BEFORE the store claims the new value (see `setVariable`
 * for why that order matters here) and both recover from a storage failure the same way.
 * Returns `true` only when the row was written, so a caller can tell a save from a
 * refusal without inspecting state.
 *
 * `set` is typed as the narrow slice this helper uses rather than as Zustand's whole
 * setter: the store's `setState` accepts `Partial<ChatState>`, so it is assignable, and
 * this signature documents that the helper only ever merges fields.
 */
async function commitState(
  set: (partial: Partial<ChatState>) => void,
  session: Session,
  next: SessionState,
  whenUnknown: string,
): Promise<boolean> {
  try {
    await writeSessionState(session.id, next);
    set({ session: { ...session, state: next }, error: undefined });
    return true;
  } catch (cause) {
    set({ error: localFailure(cause, whenUnknown) });
    // The in-memory value is not on disk, so the two disagree; the row is the copy that
    // cannot be stale (`advance`'s failure path resyncs for the same reason). No rollback
    // to the value this action read: another write may have landed while this one failed.
    const stored = await getSession(session.id);
    if (stored !== undefined) set({ session: stored });
    return false;
  }
}

/**
 * A storage failure as a `ChatError`.
 *
 * `code: 'unknown'` is the code that already means "a local fault" to the banner
 * (`i18n/error-keys.ts`), and `message` is the error's NAME only, through the same
 * helper the settings stores use: a storage message can quote the value that failed to
 * store. `retryable` is false and `turnText` empty, so the banner does not offer
 * 「重试」 for a clock write the user cannot re-send as a turn.
 */
function localFailure(cause: unknown, whenUnknown: string): ChatError {
  return {
    code: 'unknown',
    message: writeErrorName(cause, whenUnknown),
    retryable: false,
    turnText: '',
  };
}

/** Test seam: forget the configured transport, the subscription and the state. */
export function resetChat(): void {
  openToken += 1;
  unsubscribe?.();
  unsubscribe = undefined;
  controller = undefined;
  transport = undefined;
  useChatStore.setState({
    sessions: [],
    session: undefined,
    messageChain: [],
    checkpoints: [],
    calendar: BUILTIN_CALENDAR,
    draft: { ...IDLE_DRAFT },
    regenerating: null,
    status: 'idle',
    error: undefined,
    opening: false,
  });
}
