/**
 * The create-session screen (M1-S1): choose a world VERSION, the cards that take part, which one
 * is the player's, the preset, and the initial clock — then create the session and open it.
 *
 * THE CAST IS DERIVED, AND THIS SCREEN IS WHERE THAT IS VISIBLE
 * The user ticks cards and designates one of them; the resulting `cast` is the ticked cards minus
 * that one, computed by `session/roster.ts` (whose header cites docs/01 §5.4 开局步骤 2–4 and
 * §9's criterion 5). Nothing here asks for the cast a second time, and the ledger of what the
 * session will pin is printed under the list (`data-status="session-cast"`), so "the rest became
 * the cast automatically" is something the user can see BEFORE pressing the button. The
 * designation is a radio among the TICKED cards, because a card that is not taking part cannot be
 * the one you play: unticking the player's card clears the designation rather than leaving an
 * unspellable state behind (the pure rule still refuses `playerNotChosen`, since a programmatic
 * caller can spell it).
 *
 * WHY A WORLD VERSION IS PICKED AND NOT JUST THE WORLD
 * docs/06 §2.5's first step is 「选世界版本」, and `Session.refs.world` is a pinned
 * `{id, version}` (ADR-010) — so publishing a new version of a world must not change a session
 * that already pinned one. The list is `state/content-store.ts`'s `worldVersions` (newest first),
 * the newest is preselected, and the sentence `session.pinning` states which version THIS session
 * will pin next to what the newest one is, so "defaulting to the latest" is never silent.
 *
 * WHY 「选预设/规则包」 IS A STATED VALUE AND NOT A CONTROL WITH ONE OPTION
 * There is no `promptPresets` row to choose from yet (the preset is the built-in constant,
 * `chat/builtin-content.ts`) and no rule pack at all, so the step renders what EXISTS: the
 * built-in preset's own name, plus one sentence saying why it is the only one, and a second
 * saying that no rule pack is bound. A `<select>` with a single option would look like a choice
 * the app cannot honour; a preset editor and a rule-pack picker replace both lines.
 *
 * WHY THE CLOCK IS A NUMBER AND NOT A DATE
 * `initialClock` is the chosen world version's own `startMinute` (docs/01 §5.4 step 6), copied
 * into the session so the session owns its origin (ADR-012). It is shown as MINUTES because the
 * app's date mapping still runs on the built-in calendar (`chat/clock.ts`, M1-T1's boundary):
 * printing a date here would render a world's minute with another world's month names. The field
 * is prefilled with that default and re-prefilled whenever the chosen version changes — a minute
 * typed for one world's era means nothing in another's — and emptying it means "use the default",
 * which is what the hint says.
 *
 * WHY THE FORM'S VALUE IS BUILT ON EVERY RENDER
 * `cards`, `cast` and `draft` are pure functions of the state above them, so there is no second
 * copy of the selection to keep in step; and the two awkward cases (untick the player's card,
 * switch the world) have exactly one place to be handled.
 */
import type { Id, VersionNumber } from '@smarttavern/schema';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n/use-translation';
import {
  BUILTIN_PRESET_CHOICE,
  type CardChoice,
  castOf,
  defaultClockOf,
  type SessionDraft,
  sessionIssues,
} from '../../session/roster';
import { useChatStore } from '../../state/chat-store';
import { useContentStore } from '../../state/content-store';

export function NewSessionRoute() {
  const { t } = useTranslation();
  const worlds = useContentStore((state) => state.worlds);
  const characters = useContentStore((state) => state.characters);
  const worldVersions = useContentStore((state) => state.worldVersions);
  const loadWorlds = useContentStore((state) => state.loadWorlds);
  const loadCharacters = useContentStore((state) => state.loadCharacters);
  const loadWorldVersions = useContentStore((state) => state.loadWorldVersions);
  const create = useChatStore((state) => state.create);
  const navigate = useNavigate();

  const [worldId, setWorldId] = useState<Id | undefined>(undefined);
  const [version, setVersion] = useState<VersionNumber | undefined>(undefined);
  const [ticked, setTicked] = useState<readonly Id[]>([]);
  const [playerId, setPlayerId] = useState<Id | undefined>(undefined);
  const [clockText, setClockText] = useState('');
  const [clockSelection, setClockSelection] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void loadWorlds();
    void loadCharacters();
  }, [loadWorlds, loadCharacters]);

  useEffect(() => {
    if (worldId !== undefined) void loadWorldVersions(worldId);
  }, [worldId, loadWorldVersions]);

  // The versions list belongs to ONE world, and a read for a world the user has left is dropped
  // by the store; filtering here means a list that has not arrived yet simply offers nothing.
  const versions = worldVersions.filter((row) => row.worldId === worldId);
  const latest = versions[0];
  const chosen = versions.find((row) => row.version === version) ?? latest;
  // The default the clock field starts from, and the selection it belongs to.
  const defaultClock = defaultClockOf(chosen);
  const clockSelectionNow = `${worldId ?? ''}:${chosen?.version ?? ''}`;
  if (clockSelectionNow !== clockSelection) {
    // React's documented "adjust state when a prop changes", during render: a minute typed for
    // one world version must not silently become the origin of another. An effect would paint the
    // stale minute once, and Biome reports the values below as dependencies the effect never reads.
    setClockSelection(clockSelectionNow);
    setClockText(String(defaultClock));
  }

  const cards: readonly CardChoice[] = characters
    .filter((character) => ticked.includes(character.id))
    .map((character) => ({
      id: character.id,
      name: character.name,
      version: character.headVersion,
    }));
  const cast = castOf(cards, playerId);
  const draft: SessionDraft = {
    world: chosen === undefined ? undefined : { id: chosen.worldId, version: chosen.version },
    cards,
    playerId,
    // An empty field means the default the hint names; anything else is what the user typed, and
    // a value that is not a minute is refused by `sessionIssues` with its own sentence.
    initialClock: clockText.trim() === '' ? defaultClock : Number(clockText.trim()),
  };
  const issues = submitted ? sessionIssues(draft) : [];

  const onWorld = (next: string): void => {
    setWorldId(next === '' ? undefined : next);
    // The version belongs to the world it was chosen in, so it starts again from that world's
    // newest. The tick list is deliberately KEPT: which cards take part is not a fact about the
    // world (nothing scopes a card to a world yet), and clearing it would discard a real choice.
    setVersion(undefined);
  };

  const onVersion = (next: string): void => {
    const parsed = Number(next);
    if (Number.isSafeInteger(parsed) && parsed > 0) setVersion(parsed);
  };

  const toggleCard = (cardId: Id): void => {
    setTicked((current) =>
      current.includes(cardId)
        ? current.filter((candidate) => candidate !== cardId)
        : [...current, cardId],
    );
    // A card that stops taking part cannot be the one the user plays (see the header).
    if (playerId === cardId) setPlayerId(undefined);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    setFailed(false);
    // The gate is the pure rule, so what this screen SHOWS and what the store REFUSES cannot
    // disagree (`state/chat-store.ts`'s `create` runs the same function).
    if (sessionIssues(draft).length > 0) return;
    setCreating(true);
    try {
      const sessionId = await create(draft);
      if (sessionId === undefined) {
        setFailed(true);
        return;
      }
      // The play screen is where the opening flow takes over: a brand-new session has no
      // messages, so the route offers 手写 / AI 生成 / 跳过 (M1-S3).
      await navigate({ to: '/play/$sessionId', params: { sessionId } });
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <h2 className="section-title">{t('session.title')}</h2>
      <p className="muted">{t('session.hint')}</p>
      <p className="muted">
        <Link to="/">{t('session.backToHome')}</Link>
      </p>

      <form className="session-create" onSubmit={onSubmit}>
        <section className="field-group">
          <label htmlFor="session-world">{t('session.worldLabel')}</label>
          <select
            id="session-world"
            value={worldId ?? ''}
            onChange={(event) => onWorld(event.target.value)}
          >
            <option value="">{t('session.worldPlaceholder')}</option>
            {worlds.map((world) => (
              <option key={world.id} value={world.id}>
                {world.name}
              </option>
            ))}
          </select>
          {worlds.length === 0 ? <p className="muted">{t('session.worldEmpty')}</p> : null}

          <label htmlFor="session-world-version">{t('session.worldVersionLabel')}</label>
          <select
            id="session-world-version"
            value={chosen === undefined ? '' : String(chosen.version)}
            disabled={versions.length === 0}
            onChange={(event) => onVersion(event.target.value)}
          >
            {versions.map((row) => (
              <option key={row.id} value={String(row.version)}>
                {t('common.versionLabel', { version: row.version })}
              </option>
            ))}
          </select>
          {chosen === undefined ? null : (
            <p className="muted" data-status="session-pinning">
              {t('session.pinning', {
                version: String(chosen.version),
                latest: String(latest?.version ?? chosen.version),
              })}
            </p>
          )}
        </section>

        <section className="field-group">
          <h3 className="row-list-title">{t('session.cardsLabel')}</h3>
          {characters.length === 0 ? (
            <p className="muted">{t('session.cardsEmpty')}</p>
          ) : (
            <ul className="card-choices">
              {characters.map((character) => {
                const isTicked = ticked.includes(character.id);
                return (
                  <li key={character.id} className="field-check" data-row={character.id}>
                    <label>
                      <input
                        type="checkbox"
                        data-field={`session-card-${character.id}`}
                        checked={isTicked}
                        onChange={() => toggleCard(character.id)}
                      />
                      <span>{character.name}</span>
                    </label>
                    <label className="muted">
                      <input
                        type="radio"
                        name="session-player"
                        data-field={`session-player-${character.id}`}
                        value={character.id}
                        checked={playerId === character.id}
                        disabled={!isTicked}
                        aria-label={t('session.playerOf', { name: character.name })}
                        onChange={() => setPlayerId(character.id)}
                      />
                      {t('session.playerLabel')}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted">{t('session.playerHint')}</p>
          {/* The derived cast, printed BEFORE the button: "the rest became the cast" is the
              milestone's first acceptance half, so it must be visible rather than inferred. It is
              shown only once a player is designated, because until then "the rest" has no answer —
              the pure rule would call every ticked card cast, which is not the roster yet. */}
          {playerId === undefined ? null : (
            <p className="muted" data-status="session-cast">
              {cast.length === 0
                ? t('session.castEmpty')
                : `${t('session.castLabel')}: ${cast.map((card) => card.name).join(', ')}`}
            </p>
          )}
        </section>

        <section className="field-group">
          <p className="muted" data-choice="preset">
            {t('session.presetLabel')}: {BUILTIN_PRESET_CHOICE.name}
          </p>
          <p className="muted">{t('session.presetHint')}</p>
          <p className="muted" data-choice="rule-pack">
            {t('session.rulePackLabel')}: {t('session.rulePackNone')}
          </p>
        </section>

        <section className="field-group">
          <label htmlFor="session-clock">{t('session.clockLabel')}</label>
          <input
            id="session-clock"
            value={clockText}
            inputMode="numeric"
            onChange={(event) => setClockText(event.target.value)}
          />
          <p className="muted">{t('session.clockHint', { minute: String(defaultClock) })}</p>
        </section>

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={creating}>
            {creating ? t('session.creating') : t('session.create')}
          </button>
        </div>
      </form>

      {issues.length === 0 && !failed ? null : (
        <section className="issues">
          <h2 className="section-title">{t('common.issuesTitle')}</h2>
          <ul className="issue-list">
            {issues.map((key) => (
              <li key={key} className="issue">
                {t(key)}
              </li>
            ))}
            {failed ? <li className="issue">{t('session.createFailed')}</li> : null}
          </ul>
        </section>
      )}
    </>
  );
}
