/**
 * The home view: the session list and the way to create one (M0-T8, M1-S1).
 *
 * WHY THE LIST IS STORE STATE AND NOT A `useLiveQuery` HOOK
 * Dexie's React integration (`dexie-react-hooks`) is NOT installed, and this task may
 * not add dependencies. The store holds the list and `db/database.ts` owns the
 * subscription, which keeps Dexie out of the components entirely (ADR-017).
 *
 * WHY 「新建会话」 IS NOW A LINK AND NOT A BUTTON THAT WRITES
 * M0 created the session here because there was nothing to choose: the row carried placeholder
 * pins (`db/repository.ts`). M1-S1 replaces those pins with real, versioned ones — a world
 * version, a card set, a designation, an initial clock — so the write has moved to the screen
 * that collects them (`app/routes/new-session.tsx`), and this view only points at it. That also
 * removes the intermediate state a button needed: there is no longer a moment in which a session
 * exists but the user has not finished describing it.
 *
 * WHY THE DATE FORMATTER FOLLOWS THE ACTIVE LOCALE (M1-G1)
 * `toLocaleString('zh-CN')` was a hardcoded language choice spelled in ASCII, so the
 * character-based checker could not see it: an English interface would have shown
 * zh-CN dates under English copy. `useTranslation` exposes the locale for exactly this,
 * so the timestamp is formatted with the same language as the sentence next to it.
 */
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from '../../i18n/use-translation';
import { useChatStore } from '../../state/chat-store';

export function HomeRoute() {
  const { t, locale } = useTranslation();
  const sessions = useChatStore((state) => state.sessions);
  const load = useChatStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <section className="btn-row">
        <Link className="btn btn-primary" to="/sessions/new">
          {t('home.newSession')}
        </Link>
      </section>

      {sessions.length === 0 ? (
        <p className="muted">{t('home.empty')}</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link to="/play/$sessionId" params={{ sessionId: session.id }}>
                <strong>{session.title}</strong>
                <div className="muted">
                  {session.headMessageId === null ? t('home.noMessages') : t('home.hasMessages')} ·{' '}
                  {new Date(session.createdAt).toLocaleString(locale)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
