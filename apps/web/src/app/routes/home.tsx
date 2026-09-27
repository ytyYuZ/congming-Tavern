/**
 * The home view: the session list and 「新建会话」 (M0-T8).
 *
 * WHY THE LIST IS STORE STATE AND NOT A `useLiveQuery` HOOK
 * Dexie's React integration (`dexie-react-hooks`) is NOT installed, and this task may
 * not add dependencies. The store holds the list and `db/database.ts` owns the
 * subscription, which keeps Dexie out of the components entirely (ADR-017).
 *
 * WHY 「新建会话」 NAVIGATES BY HAND
 * The session's id only exists after the write, so the link cannot be rendered ahead
 * of time. `useNavigate` is the router's own answer to that, and it is the only
 * router hook this view needs.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useChatStore } from '../../state/chat-store';

export function HomeRoute() {
  const sessions = useChatStore((state) => state.sessions);
  const load = useChatStore((state) => state.load);
  const create = useChatStore((state) => state.create);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void load();
  }, [load]);

  const onNew = async (): Promise<void> => {
    setCreating(true);
    try {
      const sessionId = await create();
      await navigate({ to: '/play/$sessionId', params: { sessionId } });
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <section className="btn-row">
        <button className="btn btn-primary" type="button" disabled={creating} onClick={onNew}>
          {creating ? '创建中…' : '新建会话'}
        </button>
      </section>

      {sessions.length === 0 ? (
        <p className="muted">还没有会话。先到「设置」填写 API 配置，然后新建一个会话。</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <Link to="/play/$sessionId" params={{ sessionId: session.id }}>
                <strong>{session.title}</strong>
                <div className="muted">
                  {session.headMessageId === null ? '暂无消息' : '已有消息'} ·{' '}
                  {new Date(session.createdAt).toLocaleString('zh-CN')}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
