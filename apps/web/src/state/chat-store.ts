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
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { FetchLike } from '@smarttavern/providers';
import type { Checkpoint, Id, Message, Session } from '@smarttavern/schema';
import { create } from 'zustand';
import { advanceState } from '../chat/clock';
import { sendTurn } from '../chat/send-turn';
import { subscribe } from '../db/database';
import {
  createCheckpoint as createCheckpointRow,
  createSession,
  deleteCheckpoint as deleteCheckpointRow,
  getChain,
  getSession,
  listCheckpoints,
  readChain,
  readSessions,
  restoreCheckpoint as restoreCheckpointRow,
  writeSessionState,
} from '../db/repository';
import { KEY_LOCKED_CODE, messageKeyForCode, NOT_CONFIGURED_CODE } from '../i18n/error-keys';
import { translate } from '../i18n/translate';
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
  draft: StreamingDraft;
  status: ChatStatus;
  error: ChatError | undefined;

  load: () => Promise<void>;
  create: () => Promise<Id>;
  open: (sessionId: Id) => Promise<void>;
  close: () => void;
  send: (text: string) => Promise<void>;
  abort: () => void;
  dismissError: () => void;
  /**
   * Move the open session's clock by `delta` minutes (M1-T2). Resolves to the new
   * minute, or `undefined` when there is no session or the delta is not a usable
   * whole number of minutes.
   */
  advance: (delta: number) => Promise<number | undefined>;
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
  draft: { ...IDLE_DRAFT },
  status: 'idle',
  error: undefined,

  async load(): Promise<void> {
    set({ sessions: await readSessions() });
  },

  async create(): Promise<Id> {
    // The default title is PERSISTED DATA written in the ACTIVE language: `createSession`
    // deliberately does not know about locales (`db/repository.ts` records why), so the
    // sentence is chosen here, where the locale store is reachable.
    const session = await createSession({ title: translate('home.defaultSessionTitle') });
    await get().load();
    await get().open(session.id);
    return session.id;
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
    // Read BEFORE the single `set`, and only then applied: the list is a second async
    // read, and awaiting it inside the `set` argument would let a close or a new `open`
    // run in between and be overwritten by this one's result.
    const checkpoints = await listCheckpoints(sessionId);
    if (token !== openToken) return;
    set({ session, checkpoints, error: undefined, status: 'idle', draft: { ...IDLE_DRAFT } });
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
      draft: { ...IDLE_DRAFT },
      status: 'idle',
      error: undefined,
    });
  },

  async send(text: string): Promise<void> {
    const state = get();
    const session = state.session;
    const trimmed = text.trim();
    if (session === undefined || trimmed === '' || state.status === 'streaming') return;

    /**
     * Record a failure the user must be told about.
     *
     * `message` is the LOG side of `ChatError` (ADR-019 keeps `code` and prose apart).
     * It is normally the catalog sentence, read through the non-React `translate`, so no
     * Chinese literal appears in this module. `cause` is the one exception: a local
     * fault's NAME is the only detail a developer can act on, it is not UI copy, and
     * `describeThrown` in `chat/send-turn.ts` records the same rule for the same reason.
     */
    const fail = (
      code: string,
      messageKey: MessageKey,
      retryable: boolean,
      cause?: unknown,
    ): void => {
      const message =
        cause instanceof Error && cause.name !== '' ? cause.name : translate(messageKey);
      set({
        status: 'error',
        error: { code, message, retryable, turnText: trimmed },
      });
    };

    if (transport === undefined) {
      // A wiring bug, not a provider failure: nothing was configured to send with.
      fail('unknown', 'error.notInitialized', false);
      return;
    }
    const settings = useSettingsStore.getState();
    if (!isProviderReady(settings.provider)) {
      // Its own code so the banner can name the missing settings instead of the
      // catch-all (`i18n/error-keys.ts`).
      fail(NOT_CONFIGURED_CODE, 'error.notConfigured', false);
      return;
    }
    if (settings.locked) {
      // A key EXISTS and cannot be read (M1-G3). The request must not go out: an omitted
      // `Authorization` header would come back as `auth`, telling the user their key is
      // wrong when it is only locked — a wrong explanation of a local fact. Nothing is
      // sent and the banner names the fix.
      fail(KEY_LOCKED_CODE, 'error.keyLocked', false);
      return;
    }
    // The key travels in this object and nowhere else. `settings.key` is absent only for
    // "no key stored", which is the documented way to reach a local Ollama or vLLM:
    // `OpenAICompatibleOptions.apiKey` documents an empty string as "send no
    // `Authorization` header", which is exactly what `''` produces here.
    const config = {
      baseUrl: settings.provider.baseUrl,
      apiKey: settings.key ?? '',
      model: settings.provider.model,
    };

    controller = new AbortController();
    set({ status: 'streaming', error: undefined, draft: { ...IDLE_DRAFT } });

    try {
      const result = await sendTurn(
        {
          config,
          transport,
          // The streaming render: the answer appears as it arrives, because nothing is
          // persisted until the turn ends (see the partial-text policy in `send-turn`).
          onDelta: (text) => set({ draft: { text, started: text !== '' } }),
        },
        { sessionId: session.id, text: trimmed, signal: controller.signal },
      );
      set({
        draft: { ...IDLE_DRAFT },
        status: result.error === undefined ? 'idle' : 'error',
        error:
          result.error === undefined
            ? undefined
            : {
                code: result.error.code,
                message: result.error.message,
                retryable: result.error.retryable,
                turnText: trimmed,
                // Present only for a local failure (the composer's budget report);
                // absent for a provider failure, whose sentence is the vendor's own
                // text for logs and has no numbers to interpolate.
                ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
              },
      });
    } catch (cause) {
      // A local fault (the database, a React-free bug in this store). The catalog
      // sentence is the default; the error's own NAME is the useful log detail and
      // carries no provider prose (see `send-turn.ts`'s `describeThrown`).
      fail('unknown', 'error.localFailure', false, cause);
    } finally {
      // The live query refreshes the chain on its own schedule; this store only
      // resets the turn's own state.
      controller = undefined;
    }
  },

  abort(): void {
    controller?.abort();
  },

  dismissError(): void {
    set({ error: undefined, status: 'idle' });
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
    const nextState = advanceState(session.state, delta);
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
    draft: { ...IDLE_DRAFT },
    status: 'idle',
    error: undefined,
  });
}
