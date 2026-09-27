/**
 * The play view: transcript, the persistent world clock, the manual time advance
 * (M1-T2), the save-point panel (M1-M1 / M1-T4), the composer, streaming text, stop,
 * and the error banner (M0-T8; the clock is M1-T1's UI half).
 *
 * WHAT RENDERS FROM WHERE
 * - The transcript is `messageChain`, which is a READ of the persisted tree kept live
 *   by a `liveQuery` subscription (`state/chat-store.ts`). Nothing here fetches, so a
 *   message that appears on screen is a message that is in IndexedDB — which is the
 *   acceptance criterion, made structural rather than aspirational.
 * - The streaming bubble is `draft`, the text that has arrived and is NOT yet a row.
 *   It is rendered as a normal assistant bubble so the transcript does not jump when
 *   the row lands.
 * - The error banner reads `error.code`, never the provider's English sentence: the
 *   port's `error.message` is for logs (docs/02 §8.4 决定 3). The code is turned into a
 *   catalog key by `i18n/error-keys.ts` and rendered through the store's own
 *   `errorSentence`, so the banner is in the active language, a local failure's numbers
 *   are filled into its `{detail}`, and an unrecognised code still shows a sentence.
 *
 * WHY THE WORLD CLOCK IS HERE AND NOWHERE ELSE (M1-T1, docs/01 §F11-1
 * 「常驻时钟…界面常驻显示」)
 * A clock shows the time of ONE session's world, so it is visible exactly where a
 * session is open — the play screen — and deliberately absent from the home list and
 * the settings form, which belong to no world. Putting it in the shared header would
 * mean a clock with no session to read a minute from, which is why the absence is a
 * decision rather than an oversight. It reads `session.state.clock` — the session's
 * LIVE minute (ADR-032) — through `chat/clock.ts` (`clockOf`), the same function the
 * prompt's clock comes from, so the date on screen and the date in the request cannot
 * disagree.
 *
 * WHY THE ADVANCE CONTROLS SIT UNDER THE CLOCK AND NOWHERE ELSE (M1-T2)
 * They move that same `session.state.clock`, so they belong to the one screen that
 * shows it — and putting them here, rather than in a settings form, is what makes
 * 「推进立即反映到 UI 与状态」 visible at a glance: the clock sentence and the buttons
 * that move it are one widget. The ARITHMETIC is not here either: each button hands the
 * store a number of minutes and the store calls the engine (`chat/clock.ts`'s
 * `advanceState`), so this screen never computes a date — it only prints the one the
 * engine and the catalog produced.
 *
 * WHY THE SAVE-POINT PANEL DOES NOT RE-READ THE SESSION AFTER A RESTORE
 * `state/chat-store.ts` derives the restored `session` and `messageChain` from the very
 * checkpoint it just wrote, so this view renders the rolled-back position without a
 * second read. A re-read would be a second source of truth for "where are we now", and
 * the point of M1-T4's acceptance is that the clock and the rest of the state move back
 * TOGETHER.
 *
 * WHY THE COMPOSER'S TEXT IS LOCAL STATE AND THE STORE'S IS NOT
 * A half-typed message is not conversation state: it must not survive a session
 * switch, must not be persisted, and must not trigger a store update on every
 * keystroke. React owns it. The same is true of the save-point label, the custom minute
 * amount and the confirmations below: each is one gesture's worth of input, and none of
 * them is conversation state.
 */
import type { Checkpoint, Id, Message, Session } from '@smarttavern/schema';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { BUILTIN_HOURS_PER_DAY, BUILTIN_MINUTES_PER_HOUR } from '../../chat/builtin-content';
import { clockOf, segmentStep, worldClockText } from '../../chat/clock';
import { useTranslation } from '../../i18n/use-translation';
import { errorSentence, useChatStore } from '../../state/chat-store';
import { useSettingsStore } from '../../state/settings-store';

export function PlayRoute({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const session = useChatStore((state) => state.session);
  const messageChain = useChatStore((state) => state.messageChain);
  const checkpoints = useChatStore((state) => state.checkpoints);
  const draft = useChatStore((state) => state.draft);
  const status = useChatStore((state) => state.status);
  const error = useChatStore((state) => state.error);
  const open = useChatStore((state) => state.open);
  const close = useChatStore((state) => state.close);
  const send = useChatStore((state) => state.send);
  const abort = useChatStore((state) => state.abort);
  const dismissError = useChatStore((state) => state.dismissError);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const loadSettings = useSettingsStore((state) => state.load);

  const [text, setText] = useState('');
  const streaming = status === 'streaming';

  // The route owns the subscription's lifetime: opening a different session (or
  // unmounting the view) must not leave a `liveQuery` running against the old one.
  useEffect(() => {
    void open(sessionId);
    return () => close();
  }, [sessionId, open, close]);

  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  const onSend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const value = text;
    setText('');
    await send(value);
  };

  return (
    <>
      <p className="muted">
        <Link to="/">{t('play.backToList')}</Link>
        {session === undefined ? '' : ` · ${session.title}`}
      </p>

      {session === undefined ? null : (
        <>
          <WorldClock session={session} />
          <TimeControls sessionId={session.id} session={session} />
          <CheckpointPanel
            sessionId={session.id}
            checkpoints={checkpoints}
            canSave={messageChain.length > 0}
          />
        </>
      )}

      {error === undefined ? null : (
        <div className="notice notice-error">
          <div>{errorSentence(error)}</div>
          <div className="btn-row">
            {error.retryable && error.turnText !== '' ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  dismissError();
                  void send(error.turnText);
                }}
              >
                {t('common.retry')}
              </button>
            ) : null}
            <button className="btn" type="button" onClick={dismissError}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      <section className="transcript">
        {messageChain.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {streaming ? (
          <div className="bubble bubble-assistant">
            {draft.started ? draft.text : <span className="muted">{t('play.generating')}</span>}
          </div>
        ) : null}
      </section>

      <form className="composer" onSubmit={onSend}>
        <label htmlFor="turn-input" className="muted">
          {t('play.composerLabel')}
        </label>
        <textarea
          id="turn-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={2}
          disabled={streaming}
          placeholder={t('play.composerPlaceholder')}
        />
        <button className="btn btn-primary" type="submit" disabled={streaming}>
          {t('play.send')}
        </button>
        <button className="btn" type="button" disabled={!streaming} onClick={abort}>
          {t('play.stop')}
        </button>
      </form>
    </>
  );
}

/**
 * The persistent clock: the world's date, time and day segment for the open session.
 *
 * The sentence is composed by `worldClockText` — the engine returns parts, the catalog
 * supplies the words, and the month and segment names stay as the world authored them
 * (ADR-030). `aria-label` names the readout for a screen reader in the active language;
 * `role="status"` is deliberately NOT used, because a clock that announced itself on
 * every render would interrupt a transcription for a value that is not news.
 *
 * WHY IT TAKES THE SESSION AS A PROP: `clockOf` is a pure function of it, so the
 * component needs nothing else and cannot subscribe to a store slice it does not use.
 */
function WorldClock({ session }: { session: Session }) {
  const { t } = useTranslation();
  const sentence = worldClockText(clockOf(session), t);
  return (
    // The label is a visually hidden FIRST WORD rather than an `aria-label`: a bare
    // element has no role to attach a name to, `role="group"` would be rejected in
    // favour of `<fieldset>` (form controls), and the clock must not be `role="status"`
    // (see above). This way a screen reader reads "世界时钟 当前 …" and the element stays
    // an ordinary paragraph.
    <p className="world-clock">
      <span className="sr-only">{t('play.clockLabel')} </span>
      {sentence}
    </p>
  );
}

/**
 * A draft value that belongs to ONE session (M1-T2 / M1-M1).
 *
 * WHY THIS IS NOT `key={session.id}` ON THE COMPONENT
 * That is the idiomatic "start fresh per session", and it was tried. React answers TWO
 * SIBLING components keyed with the SAME value with "Encountered two children with the
 * same key" (measured: `TimeControls` and `CheckpointPanel` are siblings, and the warning
 * disappeared the moment the keys did). Distinct composite keys would work but make a
 * pair's identity depend on a string nobody can check.
 *
 * WHY IT IS NOT `useEffect(..., [sessionId])` EITHER
 * Biome's `useExhaustiveDependencies` reports the prop as "an outer scope value … mutating
 * it doesn't re-render" — it is a dependency the effect body never reads, and while that is
 * a false positive for a reset, a suppression is not how this workspace answers one. So the
 * reset happens the way React documents for "adjusting state when a prop changes": compare
 * during RENDER and set state there. React re-runs this component before committing, no
 * effect runs, and a stale confirmation can never paint against the new session's list.
 */
function useSessionDraft<T>(sessionId: Id, initial: T): [T, (next: T) => void] {
  const [draft, setDraft] = useState<{ sessionId: Id; value: T }>({ sessionId, value: initial });
  if (draft.sessionId !== sessionId) setDraft({ sessionId, value: initial });
  return [draft.value, (next: T) => setDraft({ sessionId, value: next })];
}

/**
 * One manual advance, as a number of minutes. The three entries ARE the table of
 * preset steps.
 */
interface AdvanceButton {
  /** The catalog key of the button's label. */
  readonly label: 'play.advanceSegment' | 'play.advanceHour' | 'play.advanceDay';
  /**
   * The minutes to move, or `undefined` for the segment step — which depends on the
   * calendar and on the current minute, so it is computed at click time
   * (`chat/clock.ts`'s `segmentStep`) rather than frozen into this table.
   */
  readonly minutes: number | undefined;
}

/**
 * The three preset advances. `undefined` is the segment step (see `AdvanceButton`).
 *
 * The hour and the day come from the built-in calendar's own constants rather than from
 * literals: a world with a 100-minute hour or a 26-hour day is legal data (ADR-012), and
 * writing `60` / `1440` here would make this file the third place that fact is spelled.
 */
const ADVANCE_BUTTONS: readonly AdvanceButton[] = [
  { label: 'play.advanceSegment', minutes: undefined },
  { label: 'play.advanceHour', minutes: BUILTIN_MINUTES_PER_HOUR },
  { label: 'play.advanceDay', minutes: BUILTIN_HOURS_PER_DAY * BUILTIN_MINUTES_PER_HOUR },
];

/**
 * The manual time controls (M1-T2) — three presets and a custom amount, next to the
 * clock they move.
 *
 * WHY THE CONFIRMATION SENTENCE IS LOCAL STATE AND NOT A STORE FIELD: it reports what
 * the last press did. It is not conversation state (it must not survive a session switch —
 * the effect below is what makes that true), it is not persisted, and nothing else reads
 * it — the same argument the composer's text has. The CLOCK is not local: it comes from
 * `session.state.clock` through the store, so a successful advance re-renders the sentence
 * above these buttons, which is this task's acceptance criterion.
 *
 * WHY A REFUSED CUSTOM AMOUNT WRITES NOTHING: the store's `advance` answers
 * `undefined` for a delta that is not a whole, non-zero number of minutes — a fractional
 * minute is a caller bug the engine throws on, and 0 is a control that cannot do
 * anything — so the view says so rather than silently doing nothing.
 *
 * Both local values go through `useSessionDraft`, so a session switch clears them (see
 * that hook for why the reset is not a `key` and not an effect).
 */
function TimeControls({ sessionId, session }: { sessionId: Id; session: Session }) {
  const { t } = useTranslation();
  const advance = useChatStore((state) => state.advance);
  const [custom, setCustom] = useSessionDraft(sessionId, '');
  const [status, setStatus] = useSessionDraft(sessionId, '');

  /** Run one advance and report it. `delta` is `undefined` for the segment step. */
  const run = async (delta: number | undefined): Promise<void> => {
    const minutes = delta ?? segmentStep(session.state);
    const clock = await advance(minutes);
    if (clock === undefined) return;
    setStatus(
      t('play.advanceDone', {
        minutes: String(minutes),
        // Built from the state the advance RETURNED, not from a re-read: the store has
        // already applied this minute, so the sentence and the clock above it are the
        // same value by construction.
        date: worldClockText(clockOf({ ...session, state: { ...session.state, clock } }), t),
      }),
    );
  };

  const onCustom = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = custom.trim();
    const minutes = Number(trimmed);
    if (trimmed === '' || !Number.isSafeInteger(minutes) || minutes === 0) {
      setStatus(t('play.advanceInvalid'));
      return;
    }
    await run(minutes);
  };

  return (
    <section className="time-controls">
      <h2 className="section-title">{t('play.advanceTitle')}</h2>
      <div className="btn-row">
        {ADVANCE_BUTTONS.map((button) => (
          <button
            key={button.label}
            className="btn"
            type="button"
            onClick={() => {
              void run(button.minutes);
            }}
          >
            {t(button.label)}
          </button>
        ))}
        <form className="advance-custom" onSubmit={onCustom}>
          <label htmlFor="advance-minutes" className="sr-only">
            {t('play.advanceCustomLabel')}
          </label>
          <input
            id="advance-minutes"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder={t('play.advanceCustomPlaceholder')}
            inputMode="numeric"
          />
          <button className="btn" type="submit">
            {t('play.advanceCustom')}
          </button>
        </form>
      </div>
      {status === '' ? null : <p className="time-status">{status}</p>}
    </section>
  );
}

/**
 * The fixed-point save panel (M1-M1) — save with a label, list, restore, delete.
 *
 * WHY RESTORING AND DELETING ARE TWO STEPS
 * A restore DISCARDS the live position: the messages after the save point stay stored
 * (ADR-010) but leave the active chain, and any advance, variable change or scene edit
 * since the save is gone. That is exactly the act that must not be one mis-aimed click,
 * so the row offers 「读档」 first and only then 「确认回滚」. Deleting gets the same shape
 * for the same reason — it removes the save point itself, the one thing nobody can
 * reconstruct. Both confirmations are in place (a second button on the same row) rather
 * than in a modal: the fact being confirmed is WHICH save point, and the row is what
 * names it.
 *
 * WHY THE PANEL READS `checkpoints` FROM THE STORE RATHER THAN FETCHING ITS OWN: the
 * list is per session, so it has to be cleared and re-read when the session changes,
 * which is already `open`'s job. A component that fetched for itself would render the
 * previous session's save points for the duration of a read.
 *
 * WHY THE HALF-FINISHED GESTURES ARE CLEARED BY `useSessionDraft`: a `key={session.id}`
 * would collide with the sibling's identical key, and a confirmation aimed at another
 * session's save point must not be confirmable against this one's list.
 */
function CheckpointPanel({
  sessionId,
  checkpoints,
  canSave,
}: {
  sessionId: Id;
  checkpoints: readonly Checkpoint[];
  /**
   * True when the transcript has at least one message, i.e. when there is a message
   * position for a save point to name. The panel does not decide this itself: the
   * transcript is the store's `messageChain`, and the reason an empty one cannot be saved
   * is a schema fact (`play.checkpointNeedsMessage` records it).
   */
  canSave: boolean;
}) {
  const { t } = useTranslation();
  const saveCheckpoint = useChatStore((state) => state.saveCheckpoint);
  const restoreCheckpoint = useChatStore((state) => state.restoreCheckpoint);
  const deleteCheckpoint = useChatStore((state) => state.deleteCheckpoint);
  const [label, setLabel] = useSessionDraft(sessionId, '');
  /** The save point whose 「读档」 was pressed, i.e. waiting for its confirmation. */
  const [confirmRestore, setConfirmRestore] = useSessionDraft(sessionId, '');
  /** The save point whose 「删除」 was pressed. */
  const [confirmDelete, setConfirmDelete] = useSessionDraft(sessionId, '');
  const [status, setStatus] = useSessionDraft(sessionId, '');

  const onSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = label.trim();
    // An empty label is refused by `CheckpointSchema` (`label: z.string().min(1)`), and
    // a save point with no name is one nobody can recognise in the list, so the button
    // does nothing until the user types one.
    if (name === '') return;
    const stored = await saveCheckpoint(name);
    if (stored === undefined) return;
    setLabel('');
    setStatus(t('play.checkpointSaved'));
  };
  const onRestore = async (checkpointId: Id): Promise<void> => {
    setConfirmRestore('');
    if (await restoreCheckpoint(checkpointId)) setStatus(t('play.checkpointRestored'));
  };

  const onDelete = async (checkpointId: Id): Promise<void> => {
    setConfirmDelete('');
    await deleteCheckpoint(checkpointId);
  };

  return (
    <section className="checkpoints">
      <h2 className="section-title">{t('play.checkpointTitle')}</h2>
      <p className="muted">{t('play.checkpointHint')}</p>

      <form className="checkpoint-save" onSubmit={onSave}>
        <label htmlFor="checkpoint-label" className="sr-only">
          {t('play.checkpointLabelPlaceholder')}
        </label>
        <input
          id="checkpoint-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t('play.checkpointLabelPlaceholder')}
          disabled={!canSave}
        />
        <button className="btn btn-primary" type="submit" disabled={!canSave}>
          {t('play.checkpointSave')}
        </button>
      </form>

      {canSave ? null : <p className="muted">{t('play.checkpointNeedsMessage')}</p>}

      {status === '' ? null : <p className="checkpoint-status">{status}</p>}

      {checkpoints.length === 0 ? (
        <p className="muted">{t('play.checkpointEmpty')}</p>
      ) : (
        <ul className="checkpoint-list">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint.id} className="checkpoint-row">
              <span className="checkpoint-label">{checkpoint.label}</span>
              {/* When the save was TAKEN (`createdAt`), formatted by the browser's own
                  locale: a timestamp is data, not a catalog string, and inventing a date
                  format here would be a second calendar. */}
              <span className="muted">{new Date(checkpoint.createdAt).toLocaleString()}</span>
              {confirmRestore === checkpoint.id ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => {
                    void onRestore(checkpoint.id);
                  }}
                >
                  {t('play.checkpointRestoreConfirm')}
                </button>
              ) : (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setConfirmDelete('');
                    setConfirmRestore(checkpoint.id);
                  }}
                >
                  {t('play.checkpointRestore')}
                </button>
              )}
              {confirmDelete === checkpoint.id ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void onDelete(checkpoint.id);
                  }}
                >
                  {t('play.checkpointDeleteConfirm')}
                </button>
              ) : (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setConfirmRestore('');
                    setConfirmDelete(checkpoint.id);
                  }}
                >
                  {t('play.checkpointDelete')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One stored node. `role` is the frozen wire vocabulary, so the switch is total. */
function MessageBubble({ message }: { message: Message }) {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  return <div className={`bubble bubble-${role}`}>{message.content}</div>;
}
