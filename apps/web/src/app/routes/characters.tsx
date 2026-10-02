/**
 * The world-card library (M1-C1): the list, and 「新建角色卡」.
 *
 * WHY THIS SCREEN EXISTS BEFORE S1 DOES
 * M1-S1's session creation picks cards for the player and the cast, and nothing could pick one
 * while no `Character` row could be created. So this screen is the writer's half of that: it lists
 * the head rows and opens the editor. It deliberately does NOT mark a card as the player's — that
 * is the SESSION's property (ADR-010), chosen in S1 — and it does not delete a card, for the same
 * reason `worlds.tsx` does not delete a world: sessions pin a version of it.
 *
 * WHY CREATING NAVIGATES IMMEDIATELY
 * The id only exists after the write. Creating writes a head row AND version 1
 * (`db/repository.ts`'s `createCharacter`), so the editor always has a published payload to fall
 * back to. The card it creates is blank-but-valid: only `name` carries content, which is the one
 * constraint `CharacterDataSchema` puts on a new card.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n/use-translation';
import { useContentStore } from '../../state/content-store';

export function CharactersRoute() {
  const { t, locale } = useTranslation();
  const characters = useContentStore((state) => state.characters);
  const loadCharacters = useContentStore((state) => state.loadCharacters);
  const createCharacter = useContentStore((state) => state.createCharacter);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void loadCharacters();
  }, [loadCharacters]);

  const onNew = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    try {
      const characterId = await createCharacter(name);
      if (characterId === undefined) return;
      setName('');
      await navigate({ to: '/characters/$characterId', params: { characterId } });
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <h2 className="section-title">{t('character.libraryTitle')}</h2>
      <p className="muted">{t('character.libraryHint')}</p>

      <form className="card-create" onSubmit={onNew}>
        <label className="sr-only" htmlFor="character-name">
          {t('character.createLabel')}
        </label>
        <input
          id="character-name"
          value={name}
          placeholder={t('character.createPlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={creating}>
          {t('character.create')}
        </button>
      </form>

      {characters.length === 0 ? (
        <p className="muted">{t('character.empty')}</p>
      ) : (
        <ul className="session-list">
          {characters.map((character) => (
            <li key={character.id}>
              <Link to="/characters/$characterId" params={{ characterId: character.id }}>
                <strong>{character.name}</strong>
                <div className="muted">
                  {t('common.versionLabel', { version: character.headVersion })} ·{' '}
                  {t('common.updatedAt', {
                    date: new Date(character.updatedAt).toLocaleString(locale),
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
