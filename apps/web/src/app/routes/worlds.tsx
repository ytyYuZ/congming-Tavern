/**
 * The world-card library (M1-W1): the list, and 「新建世界卡」.
 *
 * WHY THIS SCREEN EXISTS BEFORE S1 DOES
 * M1-S1's session creation picks a world VERSION, and nothing could pick one while no `World` row
 * could be created. So this screen is the writer's half of that: it lists the head rows (name,
 * `headVersion`, `updatedAt`) and opens the editor. It deliberately does NOT choose a world for
 * anybody — that is S1's act — and it does not delete one: a world row is referenced by sessions
 * that pin a version, so removing it is a decision with consequences (the `versions` rows must
 * stay for those sessions to render), and no milestone has asked for it yet.
 *
 * WHY CREATING NAVIGATES IMMEDIATELY
 * The id only exists after the write, so the link cannot be rendered ahead of time
 * (`app/routes/home.tsx` does the same for a new session). Creating writes a head row AND version
 * 1 (`db/repository.ts`'s `createWorld`), so the editor it navigates to always has a published
 * payload to show — which is what makes 「放弃草稿」 meaningful from the very first visit.
 *
 * WHY THE DATE FOLLOWS THE ACTIVE LOCALE
 * `toLocaleString(locale)` with the locale from `useTranslation`, never a hardcoded tag: a date
 * format is interface copy, and the same rule `home.tsx` records applies here.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n/use-translation';
import { useContentStore } from '../../state/content-store';

export function WorldsRoute() {
  const { t, locale } = useTranslation();
  const worlds = useContentStore((state) => state.worlds);
  const loadWorlds = useContentStore((state) => state.loadWorlds);
  const createWorld = useContentStore((state) => state.createWorld);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void loadWorlds();
  }, [loadWorlds]);

  const onNew = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    try {
      // A blank name is refused by the store (nothing is written), so the screen simply does not
      // navigate — the button is inert rather than claiming a world that does not exist.
      const worldId = await createWorld(name);
      if (worldId === undefined) return;
      setName('');
      await navigate({ to: '/worlds/$worldId', params: { worldId } });
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <h2 className="section-title">{t('world.libraryTitle')}</h2>
      <p className="muted">{t('world.libraryHint')}</p>

      <form className="card-create" onSubmit={onNew}>
        <label className="sr-only" htmlFor="world-name">
          {t('world.createLabel')}
        </label>
        <input
          id="world-name"
          value={name}
          placeholder={t('world.createPlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={creating}>
          {t('world.create')}
        </button>
      </form>

      {worlds.length === 0 ? (
        <p className="muted">{t('world.empty')}</p>
      ) : (
        <ul className="session-list">
          {worlds.map((world) => (
            <li key={world.id}>
              <Link to="/worlds/$worldId" params={{ worldId: world.id }}>
                <strong>{world.name}</strong>
                <div className="muted">
                  {t('common.versionLabel', { version: world.headVersion })} ·{' '}
                  {t('common.updatedAt', {
                    date: new Date(world.updatedAt).toLocaleString(locale),
                  })}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
