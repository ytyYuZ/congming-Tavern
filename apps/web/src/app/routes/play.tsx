/**
 * The play view: transcript, composer, streaming text, stop, and the error banner
 * (M0-T8) — the screen the whole milestone exists to prove.
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
 *   catalog key by `i18n/error-keys.ts` and rendered through `t(...)`, so the banner is
 *   in the active language and an unrecognised code still shows a sentence.
 *
 * WHY THE COMPOSER'S TEXT IS LOCAL STATE AND THE STORE'S IS NOT
 * A half-typed message is not conversation state: it must not survive a session
 * switch, must not be persisted, and must not trigger a store update on every
 * keystroke. React owns it.
 */

import type { Message } from '@smarttavern/schema';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { messageKeyForCode } from '../../i18n/error-keys';
import { useTranslation } from '../../i18n/use-translation';
import { useChatStore } from '../../state/chat-store';
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

      {error === undefined ? null : (
        <div className="notice notice-error">
          <div>{t(messageKeyForCode(error.code))}</div>
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

/** One stored node. `role` is the frozen wire vocabulary, so the switch is total. */
function MessageBubble({ message }: { message: Message }) {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  return <div className={`bubble bubble-${role}`}>{message.content}</div>;
}
