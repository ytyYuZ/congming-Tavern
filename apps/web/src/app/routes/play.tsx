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
 * disagree. `clockOf` is asked with the SESSION'S OWN calendar (M1-T1 follow-up) — the
 * store resolves it from the pinned world version once per open — so the month names, the
 * hours-per-day and the steps below belong to the world being played rather than to the
 * built-in face, which is another world's.
 *
 * WHY THE ADVANCE CONTROLS SIT UNDER THE CLOCK AND NOWHERE ELSE (M1-T2)
 * They move that same `session.state.clock`, so they belong to the one screen that
 * shows it — and putting them here, rather than in a settings form, is what makes
 * 「推进立即反映到 UI 与状态」 visible at a glance: the clock sentence and the buttons
 * that move it are one widget. The ARITHMETIC is not here either: each button hands the
 * store a number of minutes and the store calls the engine (`chat/clock.ts`'s
 * `advanceState`), so this screen never computes a date — it only prints the one the
 * engine and the catalog produced. The three preset AMOUNTS are derived from the same
 * calendar (`advanceButtons`), or 「+1 小时」 would move 60 minutes in a 100-minute world.
 *
 * WHY THE SAVE-POINT PANEL DOES NOT RE-READ THE SESSION AFTER A RESTORE
 * `state/chat-store.ts` derives the restored `session` and `messageChain` from the very
 * checkpoint it just wrote, so this view renders the rolled-back position without a
 * second read. A re-read would be a second source of truth for "where are we now", and
 * the point of M1-T4's acceptance is that the clock and the rest of the state move back
 * TOGETHER.
 *
 * WHY THE STATUS BAR EDITS THE SAME STATE THE SAVE POINT SNAPSHOTS (M1-S6, ADR-031)
 * `state.vars` is a field of the LIVE session row (ADR-032), so the panel below shows the
 * value a checkpoint would capture — and a restore brings it back with the clock, in one
 * write, because there is only one state value to move. The panel itself computes no
 * transition: the pure function is `chat/vars.ts` and the write is the store's
 * `setVariable` / `deleteVariable`, which is what keeps an edit from ever mutating a
 * state a checkpoint already holds (ADR-010) and what a deferred AI writer will have to
 * pass through as well.
 *
 * WHY THE COMPOSER'S TEXT IS LOCAL STATE AND THE STORE'S IS NOT
 * A half-typed message is not conversation state: it must not survive a session
 * switch, must not be persisted, and must not trigger a store update on every
 * keystroke. React owns it. The same is true of the save-point label, the custom minute
 * amount and the confirmations below: each is one gesture's worth of input, and none of
 * them is conversation state.
 *
 * THE MESSAGE TREE'S CONTROLS (M1-S2)
 * A row is one node, and the four acts docs/06 §2.5 asks for are actions on THAT node:
 * 编辑 and 删除 replace its text or remove it, 重新生成 asks the model again for the same
 * prompt (writing a SIBLING, so the answer being replaced stays one arrow away), and 继续写
 * sits on the last row because a continuation is about the tip of the chain rather than
 * about a node. Every one of them is a call into `state/chat-store.ts`, which owns the
 * rules (the tree's shape, which node a regenerate attaches to, what a delete may remove)
 * and the database; this file decides where the buttons are and what the catalog says.
 *
 * WHY THE SIBLING COUNT AND THE ARROWS COME FROM A READ AND NOT FROM THE CHAIN
 * A branch is a child of a node that the active path does NOT run through, so the chain
 * literally cannot show that a second answer exists — `db/repository.ts`'s `listChildren`
 * is the only place those rows are, and `chat/message-tree.ts` turns them into what the
 * switcher renders. The switch itself is one `setHeadMessageId`: the chain is the walk up
 * `parentId` from the head, so the other answer (and everything after it) appears without
 * a single message being copied or rewritten.
 *
 * THE CAST INTERVENTION PANEL (M1-S4)
 * 禁言 and 移出当前场景 are the user's own edit of their session, so the controls sit beside the
 * cast list they act on and each row says what the intervention did, before and after the click.
 * This file decides nothing about what an intervention MEANS: the transition is
 * `session/cast.ts` (pure), the write is `state/chat-store.ts`'s `interveneCast`, and the
 * scheduler's answer to it is `session/scheduler.ts`'s `muted` / `absent` reasons — all of which
 * this panel renders. The undo it offers is the value that call returned, so it restores exactly
 * what the user replaced rather than a value this screen re-derived.
 */
import type { MessageKey, Translator } from '@smarttavern/i18n';
import type { Calendar, Checkpoint, Id, Message, Session } from '@smarttavern/schema';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { clockOf, segmentStep, worldClockText } from '../../chat/clock';
import type { SiblingView } from '../../chat/message-tree';
import {
  isVariableKind,
  parseVariableInput,
  VARIABLE_KINDS,
  type VariableKind,
  type VariableValue,
  variableKindOf,
  variableText,
} from '../../chat/vars';
import { KEY_LOCKED_CODE } from '../../i18n/error-keys';
import { useTranslation } from '../../i18n/use-translation';
import { UnlockAction } from '../../secrets/unlock-dialog';
import { type CastIntervention, interventionOf } from '../../session/cast';
import type { ForkPoint } from '../../session/fork';
import { MAX_SPEAKERS_PER_ROUND, type TurnSchedule } from '../../session/scheduler';
import {
  exclusionReasonText,
  type ReasonText,
  refusalReasonText,
  speakerReasonText,
} from '../../session/scheduler-text';
import { renameIssueOf } from '../../session/title';
import { errorSentence, useChatStore } from '../../state/chat-store';
import { useFeatureStore } from '../../state/feature-store';
import { useSettingsStore } from '../../state/settings-store';
import {
  CollapsibleSection,
  isSectionOpen,
  jumpToSection,
  type SectionDefinition,
  SectionToc,
  useSectionOpen,
  withSectionToggled,
} from '../collapsible-section';

/**
 * The play screen's nine folds, in the order the screen presents them (B2).
 *
 * WHY THE SCREEN'S CONTROLS ARE FOLDED AT ALL
 * The manual acceptance test's complaint was the same one the card editors got: the screen a user
 * plays on opened with nine panels between the transcript and nothing, so the conversation — the
 * thing the screen is FOR — was pushed below them. The layout is now: transcript, composer, error
 * banner, and then these folds. 常驻 is therefore two things: the transcript (the messages, which
 * `docs/06` §2.5's acceptance is about) and the composer (the only way to take a turn).
 *
 * WHY THE OPENING SECTION IS OPEN AND THE OTHER EIGHT ARE NOT
 * A session that has not started offers three ways to start it and nothing else, so that choice is
 * the screen's whole content while it exists — folding it would hide the only action available. The
 * other eight are about a session already under way, and their headings plus the table of contents
 * are enough to reach them (`openByDefault` is the layout, and `PlaySections` opens the opening one
 * regardless of the user's own fold, because a session with no first message has no other move).
 *
 * `play.clockLabel` is deliberately NOT reused as a heading here: `play.clockTitle` names the fold,
 * while `clockLabel` is the accessible name of the reading inside it.
 */
const PLAY_SECTIONS: readonly SectionDefinition[] = [
  { id: 'session', title: 'play.sessionTitle', openByDefault: true },
  { id: 'clock', title: 'play.clockTitle', openByDefault: false },
  { id: 'advance', title: 'play.advanceTitle', openByDefault: false },
  { id: 'status', title: 'play.variablesTitle', openByDefault: false },
  { id: 'checkpoints', title: 'play.checkpointTitle', openByDefault: false },
  { id: 'forks', title: 'play.forkTitle', openByDefault: false },
  { id: 'scheduler', title: 'play.schedulerTitle', openByDefault: false },
  { id: 'cast', title: 'play.castInterventionTitle', openByDefault: false },
  { id: 'opening', title: 'play.openingTitle', openByDefault: false },
];

/**
 * The three sections ADR-037's switch owns: 时间推进, 发言调度 and 卡司干预.
 *
 * WHY THEY ARE NAMED HERE AND NOT INLINE AT THE FILTER BELOW: the same list has to decide both the
 * folds that render and the headings the table of contents offers, because those two must agree —
 * a directory entry whose section does not render is exactly the bug B2 left behind for the opening
 * panel. One list, read once, is what keeps them from drifting apart.
 */
const SCHEDULING_SECTIONS: readonly string[] = ['advance', 'scheduler', 'cast'];

/**
 * One section of `PLAY_SECTIONS` by id.
 *
 * The list is the screen's single source of order — the table of contents and the folds both read it
 * — so the panels below look their section up by id rather than repeating it. A miss is a coding
 * error, not a runtime position, so it throws instead of rendering a heading nobody named.
 */
function playSection(id: string): SectionDefinition {
  const section = PLAY_SECTIONS.find((candidate) => candidate.id === id);
  if (section === undefined) throw new Error(`no play section ${id}`);
  return section;
}

export function PlayRoute({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const session = useChatStore((state) => state.session);
  const checkpoints = useChatStore((state) => state.checkpoints);
  const calendar = useChatStore((state) => state.calendar);
  const draft = useChatStore((state) => state.draft);
  const regenerating = useChatStore((state) => state.regenerating);
  const status = useChatStore((state) => state.status);
  const error = useChatStore((state) => state.error);
  const open = useChatStore((state) => state.open);
  const close = useChatStore((state) => state.close);
  /**
   * The chain the transcript renders, oldest first — a READ of the persisted tree (`state/
   * chat-store.ts`'s `liveQuery`), so a message on screen is a message in IndexedDB.
   *
   * It is read HERE for the TRANSCRIPT — the one panel that did not fold, so the conversation stays in
   * the always-visible part of the screen. `PlaySections` reads the same field for a different
   * question (whether the opening choice is still live); both are subscriptions the store dedupes.
   */
  const messageChain = useChatStore((state) => state.messageChain);
  const send = useChatStore((state) => state.send);
  const abort = useChatStore((state) => state.abort);
  const dismissError = useChatStore((state) => state.dismissError);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const loadSettings = useSettingsStore((state) => state.load);

  const [text, setText] = useState('');
  const streaming = status === 'streaming';
  /**
   * The session whose opening choice the user declined (M1-S3).
   *
   * WHY THIS IS HERE AND NOT IN THE STORE: 跳过 writes nothing at all — that is the whole
   * point of it — so there is no row to remember it in, and "this screen stopped offering the
   * choice" is not a fact about the conversation. Holding the SESSION ID rather than a boolean
   * is what makes a switch reset it, the same shape `useSessionDraft` gives the panels below;
   * and the consequence is stated rather than hidden: reloading a session with no first
   * message offers the choice again, which is correct for a session that has not started.
   */
  const [skipped, setSkipped] = useState<string | undefined>(undefined);
  if (skipped !== undefined && skipped !== sessionId) setSkipped(undefined);

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

      <section className="transcript">
        {messageChain.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            isHead={message.id === session?.headMessageId}
            isLast={message.id === messageChain[messageChain.length - 1]?.id}
            streaming={streaming}
            regenerating={regenerating === message.id}
          />
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

      {error === undefined ? null : (
        <div className="notice notice-error">
          <div>{errorSentence(error)}</div>
          <div className="btn-row">
            {/*
              THE ONE ACTION THE LOCK REFUSAL OFFERS (Phase A2). `key_locked` is not a provider
              failure: the configuration is complete and this tab simply has not opened its key,
              so the fix belongs on the screen that reported it rather than on `/setup`. Unlocking
              re-reads the row (`state/settings-store.ts`), so this banner disappears without a
              reload — `error` is cleared with it because a refusal that no longer applies must
              not stay on screen.
            */}
            {error.code === KEY_LOCKED_CODE ? <UnlockAction onUnlocked={dismissError} /> : null}
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

      {/*
        THE FOLDS COME LAST (B2), after the conversation, the composer and the refusal banner. The
        screen's first position is the exchange itself — read it, answer it — and everything that is
        ABOUT the session rather than part of it (its name, the clock, the advance controls, the
        variables, the checkpoints, the branches, the scheduler, the cast, and the opening choice)
        follows underneath, where a user goes when they mean to look.

        The banner stays unfolded and outside every section: a refusal is about the turn that just
        failed, so it has to be readable, and its `UnlockAction` clickable, without opening anything.
      */}
      {session === undefined ? null : (
        <PlaySections
          session={session}
          calendar={calendar}
          checkpoints={checkpoints}
          skipped={skipped === session.id}
          onSkip={() => setSkipped(session.id)}
        />
      )}
    </>
  );
}

/**
 * Everything the play screen shows BESIDE the conversation: the folds `PLAY_SECTIONS` names, plus the
 * table of contents that reaches them (B2).
 *
 * WHY THIS IS ITS OWN COMPONENT AND NOT NINE ELEMENTS IN `PlayRoute`'s JSX
 * `useSectionOpen` is a hook, and the fold state belongs to the SESSION this screen has open — but
 * the panels must not render at all until `open(sessionId)` has produced a session (the panels read
 * `session.state`). A component of its own is what keeps the hook unconditional (it is called on
 * every render of THIS component, which only exists once the session does) while the ROUTE keeps its
 * own early `session === undefined` branch. The open/closed map is reset by `sessionId`, the same
 * key the other per-session drafts use, so opening another session produces the uniform layout
 * instead of inheriting what the previous one had folded.
 *
 * WHY THE TABLE OF CONTENTS COMES FIRST
 * It is the answer to "where is the panel I want": eight headings a user cannot see yet are not a
 * directory. Each entry opens its section and scrolls to it (`jumpToSection`), which is why the list
 * is the first thing in the folded part of the screen rather than a decoration at its end.
 *
 * WHY THE DIRECTORY FOLLOWS WHAT ACTUALLY RENDERS
 * The list below names the sections THIS render has, not the nine the module constant names: a
 * heading that jumps to a section nobody rendered is worse than no heading, and the screen has two
 * such cases — ADR-037's switch off (no 时间推进, 发言调度 or 卡司干预 section at all) and a session
 * whose opening choice is already gone (no 开场 section, the case B2 left open). `sections` is
 * therefore the one list the table of contents and the folds are both read from.
 *
 * WHY THE CLOCK'S SENTENCE IS A SECTION SUMMARY
 * The clock has to stay readable while it is folded (「常驻」, docs/01 §F11-1), so the reading — the
 * same `worldClockText` sentence the panel used to print, not a second date format — travels in the
 * 时间 heading, where it is visible in both states. The panel's own reading is kept as well: a
 * screen reader reads the labelled sentence inside the body, and a user who opens the section sees
 * it where the clock has always been.
 */
function PlaySections({
  session,
  calendar,
  checkpoints,
  skipped,
  onSkip,
}: {
  session: Session;
  calendar: Calendar;
  checkpoints: readonly Checkpoint[];
  /** Whether THIS session's opening choice was declined (see `PlayRoute`'s `skipped`). */
  skipped: boolean;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const messageChain = useChatStore((state) => state.messageChain);
  const streaming = useChatStore((state) => state.status) === 'streaming';
  const opening = useChatStore((state) => state.opening);
  const [folds, setFolds] = useSectionOpen(PLAY_SECTIONS, session.id);
  const toggle = (id: string): void => {
    setFolds((current) => withSectionToggled(current, id));
  };
  const openingOffered = !skipped && openingChoosing(session, messageChain);
  const clockSummary = worldClockText(clockOf(calendar, session), t);
  // ADR-037 (docs/05-决策记录.md §757-774): with the switch off the screen offers no way to advance
  // time and no scheduler, so those three sections do not exist here — and a section that does not
  // render is not in the table of contents either, the same rule the opening panel follows below.
  // The switch's constructed value is OFF (`state/feature-store.ts`), so the enabled layout is never
  // flashed while the row is still being read; the world clock KEEPS its fold, because it is a
  // reading of `SessionState.clock` rather than a way to move it and it injects nothing.
  const timeAndScheduling = useFeatureStore((state) => state.timeAndScheduling);
  const sections = PLAY_SECTIONS.filter(
    (section) =>
      (timeAndScheduling || !SCHEDULING_SECTIONS.includes(section.id)) &&
      (section.id !== 'opening' || openingOffered),
  );
  const renderedIds = new Set(sections.map((section) => section.id));

  /**
   * One fold per panel, in the order the screen and the table of contents present them.
   *
   * The clock's line is the only summary — see the component note — and the opening panel is
   * deliberately NOT in this table: whether it exists and whether it is open are decided by the
   * session's own start state, one block below. The list is filtered against the sections that
   * render, so a panel can never outlive its heading.
   */
  const panels: readonly {
    readonly id: string;
    readonly summary?: string;
    readonly body: ReactNode;
  }[] = [
    { id: 'session', body: <SessionNameForm session={session} /> },
    {
      id: 'clock',
      body: <WorldClock session={session} calendar={calendar} />,
      summary: clockSummary,
    },
    {
      id: 'advance',
      body: <TimeControls sessionId={session.id} session={session} calendar={calendar} />,
    },
    { id: 'status', body: <StatusBar sessionId={session.id} session={session} /> },
    {
      id: 'checkpoints',
      body: <CheckpointPanel sessionId={session.id} checkpoints={checkpoints} />,
    },
    { id: 'forks', body: <ForkPanel sessionId={session.id} checkpoints={checkpoints} /> },
    { id: 'scheduler', body: <SchedulerPanel /> },
    { id: 'cast', body: <CastInterventionPanel sessionId={session.id} session={session} /> },
  ].filter((panel) => renderedIds.has(panel.id));

  return (
    <>
      <SectionToc sections={sections} onJump={(id) => jumpToSection(id, setFolds)} />
      {panels.map(({ id, summary, body }) => (
        <CollapsibleSection
          key={id}
          section={playSection(id)}
          open={isSectionOpen(folds, id)}
          onToggle={toggle}
          summary={summary}
        >
          {body}
        </CollapsibleSection>
      ))}
      {/*
        The opening panel exists only while the session has no first message, AND it is open
        regardless of the user's own fold: a session that has not started has no other action, so
        the one control that starts it must not be hidden behind a heading. Because the section
        definition is a module constant, that "ignore the map" belongs here rather than in
        `openByDefault` (see `PLAY_SECTIONS`).
      */}
      {openingOffered ? (
        <CollapsibleSection section={playSection('opening')} open onToggle={toggle}>
          <OpeningPanel sessionId={session.id} busy={opening || streaming} onSkip={onSkip} />
        </CollapsibleSection>
      ) : null}
      {skipped ? <p className="opening-status">{t('play.openingSkipped')}</p> : null}
    </>
  );
}

/**
 * The one rename entry point (M1-T1): the session's own screen, above everything it names.
 *
 * WHY HERE AND NOWHERE ELSE: the name belongs to the session this screen is already showing, and
 * the breadcrumb above the form is where it is read. A form on the home screen's rows would make
 * two places decide the same title — and a second answer for what a failed rename leaves on
 * screen.
 *
 * WHY A FORM AND NOT AN ALWAYS-EDITABLE FIELD: the name is persisted data, so saving it is an act
 * the user performs, the same shape as `CheckpointPanel` below. The field starts from the row's
 * title and is re-seeded whenever the open session changes (`useSessionDraft`), so half-typed text
 * cannot leak into the next session.
 *
 * A BLANK NAME IS REFUSED IN THE CATALOG'S WORDS rather than silently trimmed away: `renameIssueOf`
 * is the same rule the store re-checks before the write, so the sentence on screen is the one the
 * refusal is about. The status line reports the OUTCOME of the write, not the intent — `rename`
 * answers `false` when nothing was stored, and a success sentence over an unchanged row would be a
 * lie about what the database holds.
 */
function SessionNameForm({ session }: { session: Session }) {
  const { t } = useTranslation();
  const rename = useChatStore((state) => state.rename);
  const [name, setName] = useSessionDraft(session.id, session.title);
  const [status, setStatus] = useState('');
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const issue = renameIssueOf(name);
    if (issue !== undefined) {
      setStatus(t(issue));
      return;
    }
    void (async () => {
      const saved = await rename(name);
      setStatus(saved ? t('play.nameChanged', { name: name.trim() }) : t('play.nameFailed'));
    })();
  };
  return (
    <section className="session-rename">
      <form className="session-rename" onSubmit={onSubmit}>
        {/* Visually hidden for the same reason the clock's label is a hidden word: the submit
            button already says what the action is, and a visible label would repeat it. */}
        <label htmlFor="session-rename-name" className="sr-only">
          {t('session.nameLabel')}
        </label>
        <input
          id="session-rename-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('session.namePlaceholder')}
        />
        <button className="btn btn-primary" type="submit" data-field="session-rename">
          {t('play.nameSubmit')}
        </button>
      </form>
      {status === '' ? null : <p className="session-rename-status">{status}</p>}
    </section>
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
 * WHY IT TAKES THE SESSION AS A PROP: `clockOf` is a pure function of it and of the calendar,
 * so the component needs nothing else and cannot subscribe to a store slice it does not use —
 * the route reads both and passes them down. `calendar` is the session's PINNED world's face
 * (M1-T1 follow-up, `state/chat-store.ts`), so the month names and the hours-per-day on screen
 * are the world's own and not another world's.
 */
function WorldClock({ session, calendar }: { session: Session; calendar: Calendar }) {
  const { t } = useTranslation();
  const sentence = worldClockText(clockOf(calendar, session), t);
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
 * The three preset advances, in the units of `calendar` — the session's PINNED world's face
 * (M1-T1 follow-up). `undefined` is the segment step (see `AdvanceButton`), which is computed
 * at click time from the same calendar.
 *
 * WHY THE STEPS ARE DERIVED AND NOT A MODULE CONSTANT: an hour and a day are the CALENDAR's
 * quantities. A world with a 100-minute hour or a 26-hour day is legal data (ADR-012), so a
 * table frozen from the built-in constants would silently move 60 and 1440 minutes in a world
 * that has no such units — the wrong-calendar bug the clock reading had, one button over. This
 * is also what the comment above always claimed: the numbers come from a calendar, and the
 * calendar that matters is the session's.
 */
function advanceButtons(calendar: Calendar): readonly AdvanceButton[] {
  return [
    { label: 'play.advanceSegment', minutes: undefined },
    { label: 'play.advanceHour', minutes: calendar.minutesPerHour },
    { label: 'play.advanceDay', minutes: calendar.hoursPerDay * calendar.minutesPerHour },
  ];
}

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
function TimeControls({
  sessionId,
  session,
  calendar,
}: {
  sessionId: Id;
  session: Session;
  calendar: Calendar;
}) {
  const { t } = useTranslation();
  const advance = useChatStore((state) => state.advance);
  const [custom, setCustom] = useSessionDraft(sessionId, '');
  const [status, setStatus] = useSessionDraft(sessionId, '');

  /** Run one advance and report it. `delta` is `undefined` for the segment step. */
  const run = async (delta: number | undefined): Promise<void> => {
    const minutes = delta ?? segmentStep(calendar, session.state);
    const clock = await advance(minutes);
    if (clock === undefined) return;
    setStatus(
      t('play.advanceDone', {
        minutes: String(minutes),
        // Built from the state the advance RETURNED, not from a re-read: the store has
        // already applied this minute, so the sentence and the clock above it are the
        // same value by construction. The calendar is the session's own, so the
        // confirmation names the date the world's face produces.
        date: worldClockText(
          clockOf(calendar, { ...session, state: { ...session.state, clock } }),
          t,
        ),
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
      {/* No heading of its own: the fold's heading names this panel (see `PlaySections`). */}
      <div className="btn-row">
        {advanceButtons(calendar).map((button) => (
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
 *
 * WHY THERE IS NO "SEND A MESSAGE FIRST" GATE ANY MORE: `CheckpointSchema.messageId` is
 * `IdSchema.nullable()` and mirrors `Session.headMessageId` (ADR-032), so a save point
 * taken before the first message is a position — `null` — rather than an act the schema
 * cannot spell. The control is therefore always offered; the label is still what the
 * schema requires (`label: z.string().min(1)`), and an empty one is refused here.
 */
function CheckpointPanel({
  sessionId,
  checkpoints,
}: {
  sessionId: Id;
  checkpoints: readonly Checkpoint[];
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
        />
        <button className="btn btn-primary" type="submit">
          {t('play.checkpointSave')}
        </button>
      </form>

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

/** The fork point key of the live position; the save points key themselves by their own id. */
const HEAD_FORK = 'head';

/**
 * The timeline fork panel (M1-M2) - starting a NEW timeline from a save point, or from now.
 *
 * WHAT THE ROW SAYS, AND WHY THE PANEL OFFERS EXACTLY TWO KINDS OF FORK POINT
 * docs/06 section 2.6: 「从任意存档点创建新时间线」, accepted by 「原时间线不受影响；新线引用一致」. A save
 * point is what knows a POSITION AND A STATE (clock, vars, cast: `Checkpoint.state`), so it is
 * the canonical fork point; 「在当前进度分叉」 is the same act with the state the session holds right
 * now - the pair a save point taken this instant would snapshot, minus the write to the origin
 * that taking one would perform. An arbitrary message is deliberately NOT offered: it carries no
 * state, so a fork at one would have to invent the clock it starts from. A user who wants to cut
 * at a particular message has 回溯 - `switchBranch` moves the head without writing a message -
 * and the head fork then cuts exactly there.
 *
 * WHY THE PANEL WRITES NOTHING ITSELF
 * `state/chat-store.ts`'s `fork` owns the act and `db/repository.ts`'s `forkSession` writes the
 * rows in one transaction; this component decides where the controls are and what the catalog
 * says. It offers the two-step confirmation every other row on this screen uses (see
 * `ForkControl`), and it NAVIGATES to the new session once one exists, because a fork the user
 * cannot see would look like a button that did nothing.
 *
 * WHY IT LISTS THE SAVE POINTS FROM THE STORE AND NOT FROM A READ OF ITS OWN: the list is per
 * session and is already kept live by `open` for `CheckpointPanel` (`state/chat-store.ts`'s
 * `checkpoints`), so a second read here would be a second, possibly staler, copy of the same
 * rows - and the fork point the user picks must be one the repository can still resolve.
 */
function ForkPanel({
  sessionId,
  checkpoints,
}: {
  sessionId: Id;
  checkpoints: readonly Checkpoint[];
}) {
  const { t } = useTranslation();
  const fork = useChatStore((state) => state.fork);
  const navigate = useNavigate();
  /** The fork point whose confirmation is on screen, or `''` when none is armed. */
  const [confirm, setConfirm] = useSessionDraft(sessionId, '');
  const [busy, setBusy] = useSessionDraft(sessionId, false);
  const [status, setStatus] = useSessionDraft(sessionId, '');

  const onFork = async (forkPoint: ForkPoint): Promise<void> => {
    setConfirm('');
    setBusy(true);
    try {
      const forked = await fork(forkPoint);
      // A refusal that is not a storage failure (the save point went away in another tab) is
      // said out loud: the banner only carries the failures the store can name.
      if (forked === undefined) {
        setStatus(t('play.forkRefused'));
        return;
      }
      await navigate({ to: '/play/$sessionId', params: { sessionId: forked } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="forks">
      <p className="muted">{t('play.forkHint')}</p>

      <div className="btn-row">
        {/* The live position is a fork point whether or not a save point exists, so this control
            is always offered - including for a session whose chain is still empty. */}
        <ForkControl
          field="head"
          label={t('play.forkAtHead')}
          armed={confirm === HEAD_FORK}
          busy={busy}
          onArm={() => setConfirm(HEAD_FORK)}
          onFork={() => {
            void onFork({ kind: 'head' });
          }}
        />
      </div>

      {checkpoints.length === 0 ? (
        <p className="muted">{t('play.forkNoSavePoints')}</p>
      ) : (
        <ul className="fork-list">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint.id} className="fork-row">
              <span className="checkpoint-label">{checkpoint.label}</span>
              <ForkControl
                field={checkpoint.id}
                label={t('play.forkAtCheckpoint')}
                armed={confirm === checkpoint.id}
                busy={busy}
                onArm={() => setConfirm(checkpoint.id)}
                onFork={() => {
                  void onFork({ kind: 'checkpoint', checkpointId: checkpoint.id });
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {status === '' ? null : <p className="fork-status">{status}</p>}
    </section>
  );
}

/**
 * One two-step fork control: the first click ARMS the act, the second one performs it (M1-M2).
 *
 * WHY TWO STEPS, LIKE THE RESTORE AND THE DELETE BESIDE IT
 * A fork writes a whole new session - a transcript, its save points and its own row - and it is
 * reached from a row a user may have scrolled to by accident. The confirmation is a different
 * label on the SAME row rather than a modal, because the fact being confirmed is WHICH fork point
 * (this save point, or right now) and the row is what names it. The `data-field` names the fork
 * point, so the two controls of a long list are distinguishable without reading their labels.
 *
 * `busy` disables both steps while the write is in flight: a second click during a fork would be
 * a second copy of the same timeline.
 */
function ForkControl({
  field,
  label,
  armed,
  busy,
  onArm,
  onFork,
}: {
  field: string;
  label: string;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onFork: () => void;
}) {
  const { t } = useTranslation();
  return armed ? (
    <button
      className="btn btn-primary"
      type="button"
      data-field={`fork-confirm-${field}`}
      disabled={busy}
      onClick={onFork}
    >
      {t('play.forkConfirm')}
    </button>
  ) : (
    <button
      className="btn"
      type="button"
      data-field={`fork-${field}`}
      disabled={busy}
      onClick={onArm}
    >
      {label}
    </button>
  );
}

/**
 * The turn scheduler (M1-S5): who speaks next and WHY, who cannot speak and why, and the two
 * ways a person acts on it - accept the proposal, or hand the turn to somebody else.
 *
 * WHY THE REASON IS ON SCREEN AND NOT ONLY IN THE PLAN ROW
 * docs/02 §5.6 requires a `TurnPlan` whose reasons explain every placement, and docs/01 §9's
 * MVP list requires the scheduling result to be VISIBLE ("who speaks, and why"). A panel that
 * showed a name without the reason would be a black box with a nice font, and the row it
 * stored would be the only place the answer lived - which is the wrong place for something
 * the user is deciding about. So the sentence is rendered from the SAME structured reason the
 * plan stores, through the catalog (`session/scheduler-text.ts`); nothing is parsed back.
 *
 * WHY THE PANEL DOES NOT COMPUTE A SINGLE ELIGIBILITY ITSELF, NOR ASK FOR ONE
 * The limits are facts about the TRANSCRIPT, and the only layer that reads the transcript is
 * the store (`state/chat-store.ts`, ADR-017) - which is also where the proposal is kept live:
 * `open`'s `liveQuery` subscription recomputes it on every emit, so this component renders
 * `schedule` and nothing else. Its disabled controls are therefore a CONSEQUENCE of that value
 * rather than a second opinion about it, and an effect here would only be a third opinion -
 * one whose dependencies (`sessionId`, the transcript) the effect body would never read, which
 * is exactly the shape Biome's `useExhaustiveDependencies` is right to reject.
 *
 * The write refuses a stale click for the same reason the button looks disabled:
 * `speakNextTurn` re-runs the pure rule and answers `not-selectable`.
 */
function SchedulerPanel() {
  const { t } = useTranslation();
  const schedule = useChatStore((state) => state.schedule);
  const speakNextTurn = useChatStore((state) => state.speakNextTurn);
  const streaming = useChatStore((state) => state.status) === 'streaming';

  return (
    <section className="scheduler">
      <p className="muted">
        {t('play.schedulerHint', {
          speakers: String(schedule?.maxSpeakersPerRound ?? MAX_SPEAKERS_PER_ROUND),
        })}
      </p>

      {schedule === undefined ? null : (
        <>
          <p className="scheduler-next">{nextSentence(schedule, t)}</p>
          <div className="btn-row">
            <button
              className="btn btn-primary"
              type="button"
              // A turn cannot start while one is streaming, and there is nothing to start when
              // nobody is selectable - in which case the sentence above already says why.
              disabled={streaming || schedule.next.kind !== 'speaker'}
              onClick={() => {
                // The store owns the `await` (a rejection here would be an unhandled one), and
                // a refusal is already rendered: the exclusion list below is the reason, and an
                // app-level refusal goes to the banner.
                void speakNextTurn();
              }}
            >
              {t('play.schedulerSpeak')}
            </button>
          </div>

          <h3 className="section-title">{t('play.schedulerCastTitle')}</h3>
          <ul className="scheduler-cast">
            {schedule.entries.map((entry) => (
              <li key={entry.characterId} className="scheduler-row" data-cast={entry.characterId}>
                <span className="scheduler-name">{nameOf(entry.name, t)}</span>
                <span className="muted">{t('play.schedulerSelectable')}</span>
                <button
                  className="btn btn-small"
                  type="button"
                  disabled={streaming}
                  aria-label={t('play.schedulerAssignLabel', { name: nameOf(entry.name, t) })}
                  onClick={() => {
                    void speakNextTurn(entry.characterId);
                  }}
                >
                  {t('play.schedulerAssign')}
                </button>
              </li>
            ))}
            {schedule.excluded.map((excluded) => {
              const sentence = sentenceOf(t, exclusionReasonText(excluded.reason));
              return (
                <li
                  key={excluded.characterId}
                  className="scheduler-row"
                  data-cast={excluded.characterId}
                >
                  <span className="scheduler-name">{nameOf(excluded.name, t)}</span>
                  {/* The sentence is both the visible reason and the control's tooltip: a
                      disabled button whose refusal is only discoverable by clicking is the
                      thing this panel exists to avoid (the same shape M1-S2's delete uses). */}
                  <span className="muted">{sentence}</span>
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled
                    title={sentence}
                    aria-label={t('play.schedulerAssignLabel', { name: nameOf(excluded.name, t) })}
                  >
                    {t('play.schedulerAssign')}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The character's name, or the catalog's sentence for a card that cannot be read.
 *
 * The fallback is reachable: a session pins `{id, version}` pairs, and the row behind one can
 * be gone (M1-M3 records that a deleted card leaves dangling pins rather than refusing the
 * import). The scheduler reports that character as `card-missing` with this same sentence, so
 * a nameless row is labelled and explained rather than shown as a bare id.
 */
function nameOf(name: string | undefined, t: Translator['t']): string {
  return name ?? t('play.schedulerUnknownCard');
}

/* ──────────────────────── M1-S4: the cast intervention ────────────────────── */

/**
 * The cast intervention panel (M1-S4, docs/01 §5.4 用户对卡司的干预): ONE row per pinned cast
 * member, with the two acts that keep a character out of the scheduler's round.
 *
 * WHY IT LISTS `Session.refs.cast` AND NOT THE SCHEDULE'S ENTRIES
 * The roster is who is IN the session; the schedule is what the rule decided about them THIS
 * round. Deriving the list from the schedule would make a character disappear from the panel the
 * moment they were muted (they leave `entries`), which is exactly backwards: the control that
 * muting is undone with would vanish with the mute. So the list is the roster, and the schedule
 * is asked only for the NAME it resolved (`nameFor`), since a card that cannot be read has no
 * name in the session row either.
 *
 * WHY THE ROW IS BUILT FROM THE LIVE STATE, THE PURE MODULE AND THE STORE - AND NOTHING OF ITS OWN
 * `interventionOf` is the one place that decides what a missing entry means
 * (`session/cast.ts`), `interveneCast` is the one writer, and the scheduler's own reason
 * vocabulary (`scheduler.ts`'s `muted` / `absent`) is what the schedule panel renders. This
 * component therefore renders a value and offers an edit; it never re-derives eligibility, which
 * is what keeps its "can speak" label from disagreeing with the reason beside the next speaker.
 *
 * WHY ONE UNDO AND NOT A HISTORY
 * `interveneCast` answers the record it replaced, and this panel holds that ONE value: a history
 * would be a second place where the cast's past lives, and a save point already is the durable
 * way back (the intervention is part of the state it snapshots). The undo is offered exactly
 * while a value is held, so it cannot claim to undo something that was not done here.
 */
function CastInterventionPanel({ sessionId, session }: { sessionId: Id; session: Session }) {
  const { t } = useTranslation();
  const schedule = useChatStore((state) => state.schedule);
  const interveneCast = useChatStore((state) => state.interveneCast);
  const restoreCast = useChatStore((state) => state.restoreCast);
  const [busy, setBusy] = useSessionDraft(sessionId, false);
  const [status, setStatus] = useSessionDraft(sessionId, '');
  /**
   * The standing the last intervention replaced, plus WHICH member it was about, or `null` when
   * there is nothing to undo.
   *
   * WHY THE ID TRAVELS WITH THE VALUE: the undo is the same transition as an intervention and it
   * is addressed to one member, so restoring "the cast" needs both halves. The pair is what the
   * store's `interveneCast` answered with, so the row it writes is derived from the value that
   * was just replaced - which is also what the row-level test asserts byte for byte.
   * `useSessionDraft` keys it to the session, so a switch cannot offer an undo for another
   * session's cast.
   */
  const [previous, setPrevious] = useSessionDraft<{
    characterId: Id;
    standing: CastIntervention;
  } | null>(sessionId, null);

  const castState = session.state.cast;
  const ids = session.refs.cast.map((pin) => pin.id);

  /** Ask for one member's standing and remember what it replaced. */
  const change = async (characterId: Id, next: CastIntervention): Promise<void> => {
    const name = nameFor(schedule, characterId, t);
    setBusy(true);
    try {
      const standing = await interveneCast(characterId, next);
      if (standing === undefined) return;
      setPrevious({ characterId, standing });
      setStatus(t('play.castIntervened', { name }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cast-intervention">
      <p className="muted">{t('play.castInterventionHint')}</p>

      {ids.length === 0 ? (
        <p className="muted">{t('play.schedulerEmptyCast')}</p>
      ) : (
        <ul className="cast-rows">
          {ids.map((characterId) => (
            <CastInterventionRow
              key={characterId}
              characterId={characterId}
              name={nameFor(schedule, characterId, t)}
              standing={interventionOf(castState, characterId)}
              // Nothing is written while a write is in flight, so a double click cannot race two
              // interventions into one row (the store serialises them, but the second one would
              // be landing on a value the user has not seen yet).
              disabled={busy}
              onChange={change}
            />
          ))}
        </ul>
      )}

      {status === '' ? null : <p className="cast-status">{status}</p>}
      {previous === null ? null : (
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                if (await restoreCast(previous.characterId, previous.standing)) {
                  setStatus(t('play.castRestored'));
                  setPrevious(null);
                }
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {t('play.castRestore')}
        </button>
      )}
    </section>
  );
}

/**
 * One member's row: who they are, where they stand, and the two acts.
 *
 * WHY EACH CONTROL IS A TWO-STEP CONFIRM (the save-point panel's precedent)
 * Muting or taking a character off stage changes who the model may speak for on the next turn,
 * and the user is mid-scene - so the first click ARMS the act and the row says what it will do
 * (`play.castMuteHint`), and the second one performs it. The confirmation is a different label
 * on the same row rather than a modal, because the fact being confirmed is WHICH character, and
 * the row is what names them. Restoring is one click: it puts back a value the user just had, so
 * it is the one act in this panel that needs no confirmation to be safe.
 *
 * WHY THE STATE SENTENCE IS `play.castStateNone` AND NOT THE SCHEDULER'S "CAN SPEAK": this row
 * reports the INTERVENTION, and a character with no intervention may still be blocked this round
 * by a cap or a cooldown - the scheduler panel says that, in the scheduler's own terms. Claiming
 * "can speak" here would be a second opinion about eligibility, which is the thing this panel is
 * built not to have.
 */
function CastInterventionRow({
  characterId,
  name,
  standing,
  disabled,
  onChange,
}: {
  characterId: Id;
  name: string;
  standing: CastIntervention;
  disabled: boolean;
  onChange: (characterId: Id, next: CastIntervention) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [armed, setArmed] = useSessionDraft<'none' | 'mute' | 'absent'>(characterId, 'none');

  const standingText = !standing.present
    ? t('play.castStateAbsent')
    : standing.muted
      ? t('play.castStateMuted')
      : t('play.castStateNone');

  return (
    <li className="cast-row" data-cast-intervention={characterId}>
      <span className="cast-name">{name}</span>
      <span className="muted">{standingText}</span>

      {standing.muted ? (
        <button
          className="btn btn-small"
          type="button"
          disabled={disabled}
          aria-label={t('play.castUnmuteLabel', { name })}
          onClick={() => {
            void onChange(characterId, { present: true, muted: false });
          }}
        >
          {t('play.castUnmute')}
        </button>
      ) : armed === 'mute' ? (
        <button
          className="btn btn-small btn-primary"
          type="button"
          disabled={disabled}
          aria-label={t('play.castMuteLabel', { name })}
          onClick={() => {
            setArmed('none');
            // The OTHER flag is carried across unchanged: muting somebody must not put them back
            // on stage, and the transition preserves it even so - this is the value the user is
            // asking for, spelled out rather than inferred.
            void onChange(characterId, { present: standing.present, muted: true });
          }}
        >
          {t('play.castMuteConfirm')}
        </button>
      ) : (
        <button
          className="btn btn-small"
          type="button"
          disabled={disabled}
          title={t('play.castMuteHint')}
          aria-label={t('play.castMuteLabel', { name })}
          onClick={() => {
            setArmed('mute');
          }}
        >
          {t('play.castMute')}
        </button>
      )}

      {standing.present ? (
        armed === 'absent' ? (
          <button
            className="btn btn-small btn-primary"
            type="button"
            disabled={disabled}
            aria-label={t('play.castAbsentLabel', { name })}
            onClick={() => {
              setArmed('none');
              // Off stage, and NOT unmuted: the transition writes `present` and leaves `muted`
              // as it was, so bringing the character back cannot silently undo a mute.
              void onChange(characterId, { present: false, muted: standing.muted });
            }}
          >
            {t('play.castAbsentConfirm')}
          </button>
        ) : (
          <button
            className="btn btn-small"
            type="button"
            disabled={disabled}
            title={t('play.castAbsentHint')}
            aria-label={t('play.castAbsentLabel', { name })}
            onClick={() => {
              setArmed('absent');
            }}
          >
            {t('play.castAbsent')}
          </button>
        )
      ) : (
        <button
          className="btn btn-small"
          type="button"
          disabled={disabled}
          aria-label={t('play.castPresentLabel', { name })}
          onClick={() => {
            void onChange(characterId, { present: true, muted: standing.muted });
          }}
        >
          {t('play.castPresent')}
        </button>
      )}
    </li>
  );
}

/**
 * The name of one cast member, as the SCHEDULE resolved it, or the catalog's sentence for a card
 * that cannot be read.
 *
 * WHY THE SCHEDULE IS ASKED AND NOT A SECOND READ: resolving a pin to a name is
 * `state/chat-store.ts`'s job (it is the only layer that reaches the card rows, ADR-017), and the
 * schedule the panel already renders is that resolution for every member - the ones in the round
 * AND the ones it left out. A second lookup here would be a second place where a pin becomes a
 * name, and it would go stale the moment the roster changed.
 */
function nameFor(schedule: TurnSchedule | undefined, characterId: Id, t: Translator['t']): string {
  const named = schedule?.entries.find((entry) => entry.characterId === characterId);
  const excluded = schedule?.excluded.find((entry) => entry.characterId === characterId);
  return nameOf(named?.name ?? excluded?.name, t);
}

/** One reason, in the active language: the catalog owns the sentence, the core the facts. */
function sentenceOf(t: Translator['t'], text: ReasonText): string {
  return t(text.key, text.params);
}

/**
 * The one line that says what will happen: the next speaker and why, the refusal of a named
 * assignment, or the fact that nobody can speak.
 *
 * WHY THE NOBODY CASE HAS TWO SENTENCES AND NOT ONE: an empty cast and a fully blocked cast
 * are different facts with different fixes (add cards, or wait a round). Collapsing them into
 * "nobody can speak" would leave the user unable to tell which one they are looking at.
 */
function nextSentence(schedule: TurnSchedule, t: Translator['t']): string {
  const next = schedule.next;
  if (next.kind === 'speaker') {
    return t('play.schedulerNext', {
      name: nameOf(next.speaker.name, t),
      reason: sentenceOf(t, speakerReasonText(next.speaker.reason)),
    });
  }
  if (next.kind === 'refused') {
    return t('play.schedulerRefused', {
      name: nameOf(next.name, t),
      // The named-assignment refusal has one reason a cast LISTING cannot produce
      // (`not-in-cast`), which is why the mapping is the refusal one and not the exclusion one.
      reason: sentenceOf(t, refusalReasonText(next.reason)),
    });
  }
  return next.reason.kind === 'empty-cast'
    ? t('play.schedulerEmptyCast')
    : t('play.schedulerNobody');
}

/**
 * Whether the opening choice is still open for this session (M1-S3).
 *
 * WHY BOTH THE HEAD AND THE CHAIN ARE CONSULTED, AND WHY THAT IS NOT REDUNDANT
 * The two fields disagree in two real positions, and each disagreement is a decision:
 * - a chain that is still EMPTY while the head is SET: `open` clears `messageChain` before its
 *   read resolves, so on the first frame of a session with messages the transcript is empty
 *   while the head already says where it ends. Without the head check the panel would flash on
 *   every reload — and 手写 clicked in that frame would be refused by the store, which reads
 *   the row rather than this view.
 * - a head that is NULL while the chain is empty and the opening is still STORED: a rollback to
 *   a save point taken before the first message sets the head back to `null` without deleting
 *   anything (ADR-010), so the live position really is "no transcript". The panel IS offered
 *   there, because that is what the live position is, and the write is what the store refuses
 *   — a second opening would be a second ROOT that no head can reach. Recorded rather than
 *   hidden: at that position the offer is a control that cannot succeed, and the honest fix
 *   (re-offering the opening after a rollback) would need the store's guard to change too.
 *
 * WHAT THIS IS NOT: the guard on the write. `state/chat-store.ts`'s `startOpening` and
 * `generateOpening` re-read the session's head and its roots and refuse unless it has NONE, so
 * a stale render, a second tab, a programmatic caller or the rollback position above cannot
 * append a second opening. This function decides only whether to OFFER the choice, from the two
 * values a render already holds — which is why a synchronous check is possible here and the
 * store's is not.
 */
function openingChoosing(session: Session, chain: readonly Message[]): boolean {
  return session.headMessageId === null && chain.length === 0;
}

/**
 * The opening panel (M1-S3) — 手写 / AI 生成 / 跳过, offered while the session has no first
 * message.
 *
 * WHY THIS IS A PANEL AND NOT A COMPOSER MODE: an opening is a START (the chain's only root,
 * written while the head is `null`), so it is a choice about the session rather than a turn
 * in it. Both writing paths go through the store's own opening actions, and both leave the
 * same start state — the hand-written one writes a user row at the root, the AI one writes
 * the model's answer at the root with `append: {mode: 'none'}`, i.e. with NO user row, which
 * is why the instruction it sends is on the wire and nowhere in the transcript.
 *
 * WHAT THIS COMPONENT DOES AND DOES NOT DECIDE
 * It decides where the controls are, which sentence each one reads, and that a blank opening
 * is refused before the store is called. The decision that the choice is still OPEN is the
 * route's — `PlaySections` mounts this panel exactly when `openingChoosing` holds and the user has
 * not skipped, because `skipped` and the panel are one render decision — and
 * the decision that an opening may be WRITTEN is the store's: `state/chat-store.ts`'s two
 * actions re-read the session row and refuse unless `headMessageId` is `null`, so a stale
 * render, a second tab or a programmatic caller cannot append one.
 *
 * WHY 跳过 IS THE ONLY CHOICE THAT TOUCHES NOTHING: it writes no row and moves no pointer —
 * the session is already usable with no messages (`Session.headMessageId` is nullable, and
 * the next turn starts a chain from it, docs/02 §7). There is no store action for it either:
 * "the user declined to start" is one screen's fact, not session state, so the route owns it
 * (`onSkip`) and the confirmation that the click did something sits with it.
 */
function OpeningPanel({
  sessionId,
  busy,
  onSkip,
}: {
  sessionId: Id;
  busy: boolean;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const startOpening = useChatStore((state) => state.startOpening);
  const generateOpening = useChatStore((state) => state.generateOpening);
  const opening = useChatStore((state) => state.opening);
  const [text, setText] = useSessionDraft(sessionId, '');
  const [refused, setRefused] = useSessionDraft(sessionId, false);

  const onWrite = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const value = text.trim();
    // A blank opening cannot be a message: `MessageSchema` allows an empty `content` but the
    // transcript could not show it and the composer drops it from every later request
    // (`chat/clock.ts`'s `toWireMessages`). So the refusal is said here instead.
    if (value === '') {
      setRefused(true);
      return;
    }
    setRefused(false);
    if (await startOpening(value)) setText('');
  };

  return (
    <section className="opening">
      <p className="muted">{t('play.openingHint')}</p>

      <form className="opening-write" onSubmit={onWrite}>
        <label htmlFor="opening-text" className="sr-only">
          {t('play.openingLabel')}
        </label>
        <textarea
          id="opening-text"
          className="opening-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          disabled={busy}
          placeholder={t('play.openingPlaceholder')}
        />
        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('play.openingWrite')}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              // The store owns the `await`: a rejection here would be an unhandled one, and a
              // refusal is reported through the banner rather than returned to be printed
              // twice (the same rule `ContinueButton` follows).
              void generateOpening();
            }}
          >
            {opening ? t('play.generating') : t('play.openingGenerate')}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={onSkip}>
            {t('play.openingSkip')}
          </button>
        </div>
      </form>

      {refused ? <p className="opening-status">{t('play.openingWriteEmpty')}</p> : null}
    </section>
  );
}

/** The catalog key of each value kind, so the dropdown cannot drift from the type. */
const VARIABLE_KIND_LABELS: Record<VariableKind, MessageKey> = {
  string: 'play.variableKindString',
  number: 'play.variableKindNumber',
  boolean: 'play.variableKindBoolean',
};

/**
 * The status bar (M1-S6, ADR-031): the open session's free variables, with a typed editor.
 *
 * WHY IT RENDERS THE STATE THE STORE ALREADY HOLDS: `vars` is a field of the session row
 * (ADR-032) and the store's `session` IS that row, so the value on screen is the value a
 * checkpoint would snapshot. A panel that read the row again could show a different one,
 * and "the variables move with the save point" would stop being visible.
 *
 * WHY NO TRANSITION IS COMPUTED HERE: the pure function lives in `chat/vars.ts` and the
 * write in `state/chat-store.ts`, so this component only decides what the user typed. That
 * is the split ADR-031 asks for — `old state + change -> new state`, never an in-place
 * edit — and it is the same door a future AI-written value has to come through (deferred
 * to M2+; nothing here implements it).
 *
 * WHY A DELETE IS ONE CLICK HERE AND TWO IN THE SAVE-POINT PANEL: a save point is the one
 * thing nobody can reconstruct, so it is confirmed. A variable is a name and a primitive
 * the user can retype in a second, and spending the same confirmation on it would train
 * the user to confirm without reading.
 *
 * WHY THE ADD FORM'S VALUES ARE LOCAL STATE: like the composer's text, a half-typed row is
 * one gesture's worth of input — it must not survive a session switch and must not be
 * persisted, so `useSessionDraft` owns it and React does not re-render a store for it.
 */
function StatusBar({ sessionId, session }: { sessionId: Id; session: Session }) {
  const { t } = useTranslation();
  const setVariable = useChatStore((state) => state.setVariable);
  const [name, setName] = useSessionDraft(sessionId, '');
  const [kind, setKind] = useSessionDraft<VariableKind>(sessionId, 'string');
  const [value, setValue] = useSessionDraft(sessionId, '');
  const [status, setStatus] = useSessionDraft(sessionId, '');

  const onAdd = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const key = name.trim();
    // Two refusals, one sentence: a blank name cannot be addressed by `{{getvar::}}` or by
    // the panel (the pure transition refuses it too), and text the chosen kind cannot hold
    // would otherwise be coerced (`Number('')` is 0).
    const parsed = key === '' ? undefined : parseVariableInput(kind, value);
    if (parsed === undefined) {
      setStatus(t('play.variableInvalid'));
      return;
    }
    if (!(await setVariable(key, parsed))) return;
    // The name is cleared, the kind and the value are kept: a user entering several numbers
    // types the kind once. Nothing is reported unless the ROW was written.
    setName('');
    setStatus(t('play.variableAdded'));
  };

  const entries = Object.entries(session.state.vars);

  return (
    <section className="variables">
      <p className="muted">{t('play.variablesHint')}</p>

      <form className="variable-add" onSubmit={onAdd}>
        <label className="muted" htmlFor="variable-name">
          {t('play.variableNameLabel')}
        </label>
        <input
          id="variable-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('play.variableNamePlaceholder')}
        />
        <label className="muted" htmlFor="variable-kind">
          {t('play.variableKindLabel')}
        </label>
        <select
          id="variable-kind"
          value={kind}
          onChange={(event) => {
            const next = event.target.value;
            // Narrowed rather than cast: `isVariableKind` is checkable, and the option's own
            // value is the only thing that makes a cast true.
            if (isVariableKind(next)) setKind(next);
          }}
        >
          {VARIABLE_KINDS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {t(VARIABLE_KIND_LABELS[candidate])}
            </option>
          ))}
        </select>
        <label className="muted" htmlFor="variable-value">
          {t('play.variableValueLabel')}
        </label>
        <input
          id="variable-value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('play.variableValuePlaceholder')}
        />
        <button className="btn btn-primary" type="submit">
          {t('play.variableAdd')}
        </button>
      </form>

      {status === '' ? null : <p className="variable-status">{status}</p>}

      {entries.length === 0 ? (
        <p className="muted">{t('play.variablesEmpty')}</p>
      ) : (
        <ul className="variable-list">
          {entries.map(([variableName, variableValue]) => (
            <VariableRow key={variableName} name={variableName} value={variableValue} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The row editor's own value: the kind it is being read as, plus the text being typed. */
interface VariableDraft {
  readonly kind: VariableKind;
  readonly text: string;
}

/** The editor state a stored value starts from. */
function draftOf(value: VariableValue): VariableDraft {
  return { kind: variableKindOf(value), text: variableText(value) };
}

/**
 * One variable, editable in place.
 *
 * WHY THE NAME IS NOT EDITABLE: the name IS the row's identity (a React key and the key of
 * the `vars` table), so renaming is a delete plus an add — two acts the user already has.
 * An editable name would have to decide what happens to a half-typed duplicate, which is a
 * rule nobody needs.
 *
 * WHY THE DRAFT IS RESET WHEN THE STORED VALUE CHANGES, DURING RENDER: a restore or a turn
 * can change `vars` under an open editor, and an input still showing the old value would
 * contradict the panel around it. This is React's documented "adjust state when a prop
 * changes" (the same pattern `useSessionDraft` uses, and for the same reason: an effect
 * would paint the stale value once, and Biome reports the prop as an unread dependency).
 */
function VariableRow({ name, value }: { name: string; value: VariableValue }) {
  const { t } = useTranslation();
  const setVariable = useChatStore((state) => state.setVariable);
  const deleteVariable = useChatStore((state) => state.deleteVariable);
  const [draft, setDraft] = useState<VariableDraft>(() => draftOf(value));
  const [saved, setSaved] = useState<VariableValue>(value);
  const [status, setStatus] = useState('');

  if (!Object.is(saved, value)) {
    setSaved(value);
    setDraft(draftOf(value));
  }

  const onSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const parsed = parseVariableInput(draft.kind, draft.text);
    if (parsed === undefined) {
      setStatus(t('play.variableInvalid'));
      return;
    }
    // A `false` here is a refusal or a storage failure; the storage case has already put
    // its own sentence in the banner above, so nothing is claimed on this row.
    setStatus((await setVariable(name, parsed)) ? t('play.variableSaved') : '');
  };

  return (
    <li className="variable-row" data-variable={name}>
      <form className="variable-edit" onSubmit={onSave}>
        <span className="variable-name">{name}</span>
        <label className="sr-only">
          {t('play.variableKindLabel')}
          <select
            className="variable-kind"
            value={draft.kind}
            onChange={(event) => {
              const next = event.target.value;
              if (!isVariableKind(next)) return;
              // The TYPED TEXT is kept across a kind switch, which is what makes "the value
              // I typed as text is really the number 10" a two-click edit.
              setDraft((current) => ({ ...current, kind: next }));
            }}
          >
            {VARIABLE_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(VARIABLE_KIND_LABELS[candidate])}
              </option>
            ))}
          </select>
        </label>
        <label className="sr-only">
          {t('play.variableValueLabel')}
          <input
            className="variable-value"
            value={draft.text}
            onChange={(event) => {
              const text = event.target.value;
              setDraft((current) => ({ ...current, text }));
            }}
            placeholder={t('play.variableValuePlaceholder')}
          />
        </label>
        <button className="btn" type="submit">
          {t('common.save')}
        </button>
      </form>
      <button
        className="btn"
        type="button"
        onClick={() => {
          void deleteVariable(name);
        }}
      >
        {t('play.variableDelete')}
      </button>
      {status === '' ? null : <span className="muted variable-status">{status}</span>}
    </li>
  );
}

/**
 * One stored node, with the four acts M1-S2 adds to it (docs/06 §2.5: 流式渲染、swipe
 * 重生成、编辑、删除、继续写).
 *
 * WHY THE ROW IS THE UNIT: every act in the milestone is an act on ONE message — another
 * answer to it (regenerate), another version of it (edit), or its removal (delete) — and
 * each one needs the same header (the count of answers, the arrows between them) to say
 * which node it is about. A floating toolbar somewhere else on the screen would have to
 * name its target in words; the row already is that name.
 *
 * WHY DELETING IS THE ONLY ACT WITH A CONFIRMATION: an edit and a regenerate both ADD a
 * sibling, so the deleted-looking old text is still one arrow away — undoing either is a
 * click. A delete removes a row from the database and nothing anywhere can bring it back,
 * so it takes the save-point panel's two-step shape (arm, then confirm) rather than one
 * mis-aimed click. The refusal path is the third state: a node with replies cannot be
 * deleted at all, and the row says so instead of failing silently.
 */
function MessageBubble({
  message,
  isHead,
  isLast,
  streaming,
  regenerating,
}: {
  message: Message;
  isHead: boolean;
  isLast: boolean;
  streaming: boolean;
  regenerating: boolean;
}) {
  const { t } = useTranslation();
  const editMessage = useChatStore((state) => state.editMessage);
  const deleteMessage = useChatStore((state) => state.deleteMessage);
  const regenerate = useChatStore((state) => state.regenerate);
  const switchBranch = useChatStore((state) => state.switchBranch);
  const [view, setView] = useState<SiblingView | undefined>(undefined);
  /**
   * Whether a message hangs off this one, which is what makes the delete refused (M1-S2's
   * rule). Read up front rather than discovered after a confirmation, so the row can LABEL
   * the control instead of failing after two clicks — the write still re-checks it inside
   * its own transaction, so a value from a moment ago cannot make the delete unsafe. It is
   * re-read whenever the transcript changes, i.e. whenever a reply could have appeared.
   */
  const [hasReplies, setHasReplies] = useState(false);
  const [editing, setEditing] = useSessionDraft(message.id, false);
  /** The draft the editor starts from and the user types in; see the render body. */
  const [draft, setDraft] = useSessionDraft(message.id, message.content);
  /** Which confirm step the row is in: none, the delete, or the refusal it just reported. */
  const [pending, setPending] = useSessionDraft<'none' | 'delete' | 'refused'>(message.id, 'none');
  const [failed, setFailed] = useSessionDraft(message.id, false);

  // A sibling run is a fact about the TABLE, which the chain cannot answer (the branch
  // that is not active is exactly the one missing from the chain), so it is read through
  // the state layer (ADR-017 — the view never imports `db/repository.ts`). It is re-read
  // when the ACTIVE TIP changes, because that is what a branch switch moves: the run itself
  // is unchanged, but which member the chain runs through (and therefore which arrows are
  // live) is not. The head is passed to the store rather than compared here, so the view can
  // never label a run from a head the store has already moved past.
  const headMessageId = useChatStore((state) => state.session?.headMessageId ?? null);
  useEffect(() => {
    let current = true;
    void useChatStore
      .getState()
      .siblingsOf(message.id, headMessageId)
      .then((next) => {
        if (current) setView(next);
      });
    void useChatStore
      .getState()
      .hasReplies(message.id)
      .then((next) => {
        if (current) setHasReplies(next);
      });
    return () => {
      current = false;
    };
  }, [message.id, headMessageId]);

  // Seed the editor from the row when it OPENS. React's documented "adjust state when a
  // prop changes" rather than an effect: the row can change under a closed editor (a
  // rollback, another tab's turn), and a textarea that opened with last render's text
  // would show something the database does not hold. An OPEN editor is never overwritten —
  // that would delete what the user is typing.
  if (!editing && draft !== message.content) setDraft(message.content);

  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const onSave = async (): Promise<void> => {
    if (await editMessage(message.id, draft)) {
      setEditing(false);
      setFailed(false);
    } else {
      setFailed(true);
    }
  };

  const onDelete = async (): Promise<void> => {
    setPending('none');
    if (!(await deleteMessage(message.id))) setPending('refused');
  };

  return (
    <div
      className={`bubble bubble-${role}${isHead ? ' bubble-active' : ''}${
        regenerating ? ' bubble-regenerating' : ''
      }`}
      data-message={message.id}
    >
      {view === undefined ? null : (
        <SiblingSwitcher
          view={view}
          streaming={streaming}
          onPick={(siblingId) => {
            void switchBranch(siblingId);
          }}
        />
      )}

      {editing ? (
        <MessageEditor
          messageId={message.id}
          value={draft}
          onChange={setDraft}
          onSave={() => {
            void onSave();
          }}
          onCancel={() => {
            setDraft(message.content);
            setEditing(false);
          }}
        />
      ) : (
        <div className="bubble-text">{message.content}</div>
      )}

      <div className="bubble-actions">
        <button
          className="btn btn-small"
          type="button"
          disabled={streaming || editing}
          onClick={() => setEditing(true)}
        >
          {t('play.edit')}
        </button>
        {role === 'assistant' && !editing ? (
          <button
            className="btn btn-small"
            type="button"
            disabled={streaming}
            onClick={() => {
              void regenerate(message.id);
            }}
          >
            {t('play.regenerate')}
          </button>
        ) : null}
        {pending === 'delete' ? (
          <button
            className="btn btn-small"
            type="button"
            onClick={() => {
              void onDelete();
            }}
          >
            {t('play.deleteConfirm')}
          </button>
        ) : (
          <button
            className="btn btn-small"
            type="button"
            // A node with replies is not deletable (M1-S2's rule), so its control is refused
            // with the REASON as its tooltip: a button that could only fail after a
            // confirmation would train the user to confirm without reading.
            disabled={streaming || hasReplies}
            title={hasReplies ? t('play.deleteRefused') : undefined}
            // The label names WHICH message: the row also offers an edit and a regenerate,
            // so a bare 「删除」 read aloud is the same control on every message in the
            // transcript. The visible text stays short (`play.delete`); the accessible name
            // carries the message's own text.
            aria-label={t('play.deleteLabel', { target: message.content })}
            onClick={() => setPending('delete')}
          >
            {t('play.delete')}
          </button>
        )}
        {isLast && role === 'assistant' && !streaming ? <ContinueButton /> : null}
      </div>

      {pending === 'refused' ? <p className="bubble-status">{t('play.deleteRefused')}</p> : null}
      {failed ? <p className="bubble-status">{t('play.editFailed')}</p> : null}
    </div>
  );
}

/**
 * Move between the answers to one prompt (docs/02 §7's 重生成（同父多子）).
 *
 * WHY THE SWITCHER REPLACES THE BUBBLE TEXT IN PLACE: every member of a run is an answer
 * to the SAME question, so showing them side by side would invent a sequence that does not
 * exist — they are alternatives, not turns. The count (`第 2 / 3 条`) is what tells the
 * user that the alternatives exist at all; a pair of arrows with no count is a control that
 * could equally mean "previous message".
 *
 * WHY A SWITCH IS ONE `setHeadMessageId` AND NOTHING ELSE: the rendered chain IS the walk
 * up `parentId` from `Session.headMessageId` (`db/repository.ts`'s `getChain`), so pointing
 * the head at another member of the run re-renders the other answer — and everything after
 * it — with no message copied, re-parented or rewritten. That is the milestone's 「切换分支
 * 内容正确」, and it is why this control needs no confirm: the answer it leaves is one
 * arrow away.
 */
function SiblingSwitcher({
  view,
  streaming,
  onPick,
}: {
  view: SiblingView;
  streaming: boolean;
  onPick: (siblingId: Id) => void;
}) {
  const { t, locale } = useTranslation();
  // `Intl.NumberFormat` rather than string concatenation: a locale that does not write
  // Latin digits would otherwise show Arabic numerals beside a translated sentence.
  const format = new Intl.NumberFormat(locale);
  /**
   * Move to the neighbour `offset` places away in the run, or do nothing.
   *
   * WHY THE TARGET IS DERIVED HERE AND NOT TAKEN FROM A STORED `previousId`/`nextId`: the
   * run is read from the table asynchronously, so a value that named its neighbours when the
   * read resolved can outlive the head move that made it wrong (another tab, a rollback, or
   * this very screen's own switch). Resolving the neighbour from the run ON EVERY RENDER
   * means the arrow can only ever name a member of the run the screen is showing; an
   * out-of-range offset simply does nothing instead of asking the store to point the
   * transcript at a row that is not in it.
   */
  const choose = (offset: number): void => {
    const target = view.choices[view.index + offset];
    if (target === undefined) return;
    onPick(target.id);
  };

  return (
    <div className="sibling-switcher">
      <button
        className="btn btn-small"
        type="button"
        disabled={streaming || view.index === 0}
        aria-label={t('play.siblingPrevious')}
        onClick={() => choose(-1)}
      >
        ‹
      </button>
      <span className="sibling-counter" title={t('play.siblingLabel')}>
        {t('play.siblingCounter', {
          position: format.format(view.index + 1),
          total: format.format(view.choices.length),
        })}
      </span>
      <button
        className="btn btn-small"
        type="button"
        disabled={streaming || view.index === view.choices.length - 1}
        aria-label={t('play.siblingNext')}
        onClick={() => choose(1)}
      >
        ›
      </button>
    </div>
  );
}

/**
 * The in-place editor for one message.
 *
 * WHY THE DRAFT IS THE COMPONENT'S OWN STATE AND IS SEEDED WHEN THE EDITOR OPENS: a
 * half-typed edit is one gesture's worth of input (like the composer's text), so it must
 * not be persisted and must not be a store field. It IS seeded from the row rather than
 * from React's first render because the row can change under an open editor — a rollback
 * or another tab's turn — and the same `message.id`-keyed draft that clears a stale edit
 * on a branch switch must not keep a stale starting text.
 */
function MessageEditor({
  messageId,
  value,
  onChange,
  onSave,
  onCancel,
}: {
  messageId: Id;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="bubble-editor">
      <textarea
        className="bubble-editor-input"
        data-edit={messageId}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="btn-row">
        <button className="btn btn-small btn-primary" type="button" onClick={onSave}>
          {t('play.editSave')}
        </button>
        <button className="btn btn-small" type="button" onClick={onCancel}>
          {t('play.editCancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * 继续写: ask the model to keep going from the head, with no new user turn.
 *
 * WHY IT GOES THROUGH THE EXISTING CONTINUATION PATH AND NOT A NEW WRITE: continuing is
 * `sendTurn` with the head UNMOVED and an empty input — the same path a second turn already
 * took (`send-turn.test.ts`'s "chains a continuation onto the stored head"). The store's
 * `continueWriting` is that call; this component only decides when the control is offered
 * (the head is an assistant turn, nothing is streaming, and it is the last row on screen)
 * and renders the banner the store filled when the turn could not start. The `error`
 * sentence comes from the catalog by code (ADR-019), so this button holds no prose.
 */
function ContinueButton() {
  const { t } = useTranslation();
  const continueWriting = useChatStore((state) => state.continueWriting);
  return (
    <button
      className="btn btn-small"
      type="button"
      onClick={() => {
        // The store owns the `await`: a rejection here would be an unhandled one, and a
        // refusal is reported through `error` rather than returned to be printed twice.
        void continueWriting();
      }}
    >
      {t('play.continue')}
    </button>
  );
}
