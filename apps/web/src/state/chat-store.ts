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
 * `send()` calls `useSettingsStore.getState().provider` when the turn starts. A copy
 * held here would go stale the moment the user edits the setup form, and a saved key
 * that the running turn does not use is exactly the kind of bug that looks like "the
 * model ignored my key". Nothing here logs, and the configuration is passed straight
 * into `sendTurn`, which hands it to the adapter and nowhere else (HANDOFF §4.1
 * invariant 6).
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
import { type FetchLike, LLM_ERROR_CODES } from '@smarttavern/providers';
import type { Id, Message, Session } from '@smarttavern/schema';
import { create } from 'zustand';
import { sendTurn } from '../chat/send-turn';
import { subscribe } from '../db/database';
import { createSession, getSession, readChain, readSessions } from '../db/repository';
import { isProviderReady, type ProviderSettings, useSettingsStore } from './settings-store';

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
}

export interface ChatState {
  sessions: Session[];
  session: Session | undefined;
  messageChain: Message[];
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
 * Human-readable label per adapter error code. The code is what code branches on;
 * the label is what a person reads (docs/02 §8.4 决定 3).
 */
const ERROR_LABELS: Record<string, string> = {
  [LLM_ERROR_CODES.auth]: 'API Key 被拒绝，请在「设置」中检查',
  [LLM_ERROR_CODES.rateLimit]: '请求过于频繁，请稍后重试',
  [LLM_ERROR_CODES.network]: '无法连接到服务，请检查地址与网络',
  [LLM_ERROR_CODES.contentFilter]: '请求被内容审核拦截',
  [LLM_ERROR_CODES.invalidRequest]: '请求被服务端拒绝，请检查模型名',
  [LLM_ERROR_CODES.invalidResponse]: '服务端返回了无法解析的内容',
};

/** `code` -> the sentence the error banner shows. */
export function errorLabel(code: string): string {
  return ERROR_LABELS[code] ?? '发生未知错误';
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  session: undefined,
  messageChain: [],
  draft: { ...IDLE_DRAFT },
  status: 'idle',
  error: undefined,

  async load(): Promise<void> {
    set({ sessions: await readSessions() });
  },

  async create(): Promise<Id> {
    const session = await createSession();
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
    set({ session, error: undefined, status: 'idle', draft: { ...IDLE_DRAFT } });
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

    const fail = (code: string, message: string, retryable: boolean): void => {
      set({
        status: 'error',
        error: { code, message, retryable, turnText: trimmed },
      });
    };

    if (transport === undefined) {
      fail('unknown', '应用尚未完成初始化', false);
      return;
    }
    const config: ProviderSettings = useSettingsStore.getState().provider;
    if (!isProviderReady(config)) {
      fail('unknown', '请先在「设置」中填写服务地址与模型名', false);
      return;
    }

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
              },
      });
    } catch (cause) {
      fail('unknown', cause instanceof Error ? cause.name : '未知的本地错误', false);
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
}));

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
    draft: { ...IDLE_DRAFT },
    status: 'idle',
    error: undefined,
  });
}
