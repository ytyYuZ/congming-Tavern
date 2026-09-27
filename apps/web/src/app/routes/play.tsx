/**
 * The play view: transcript, the persistent world clock, composer, streaming text,
 * stop, and the error banner (M0-T8; the clock is M1-T1's UI half).
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
 * decision rather than an oversight. It reads `session.initialClock` through
 * `chat/clock.ts` (`clockOf`), the same function the prompt's clock comes from, so the
 * date on screen and the date in the request cannot disagree.
 *
 * WHY THE COMPOSER'S TEXT IS LOCAL STATE AND THE STORE'S IS NOT
 * A half-typed message is not conversation state: it must not survive a session
 * switch, must not be persisted, and must not trigger a store update on every
 * keystroke. React owns it.
 */
import type { Message, Session } from '@smarttavern/schema';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { clockOf, worldClockText } from '../../chat/clock';
import { useTranslation } from '../../i18n/use-translation';
import { errorSentence, useChatStore } from '../../state/chat-store';
import { useSettingsStore } from '../../state/settings-store';

export function PlayRoute({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const session = useChatStore((state) => state.session);
  const messageChain = useChatStore((state) => state.messageChain);
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

      {session === undefined ? null : <WorldClock session={session} />}

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

/** One stored node. `role` is the frozen wire vocabulary, so the switch is total. */
function MessageBubble({ message }: { message: Message }) {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  return <div className={`bubble bubble-${role}`}>{message.content}</div>;
}
