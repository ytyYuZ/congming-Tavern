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
 */
import type { MessageKey } from '@smarttavern/i18n';
import type { Checkpoint, Id, Message, Session } from '@smarttavern/schema';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { BUILTIN_HOURS_PER_DAY, BUILTIN_MINUTES_PER_HOUR } from '../../chat/builtin-content';
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
import { useTranslation } from '../../i18n/use-translation';
import { errorSentence, useChatStore } from '../../state/chat-store';
import { useSettingsStore } from '../../state/settings-store';

export function PlayRoute({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const session = useChatStore((state) => state.session);
  const messageChain = useChatStore((state) => state.messageChain);
  const checkpoints = useChatStore((state) => state.checkpoints);
  const draft = useChatStore((state) => state.draft);
  const regenerating = useChatStore((state) => state.regenerating);
  const status = useChatStore((state) => state.status);
  const error = useChatStore((state) => state.error);
  const open = useChatStore((state) => state.open);
  const close = useChatStore((state) => state.close);
  const send = useChatStore((state) => state.send);
  const abort = useChatStore((state) => state.abort);
  const dismissError = useChatStore((state) => state.dismissError);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const loadSettings = useSettingsStore((state) => state.load);
  const opening = useChatStore((state) => state.opening);

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

      {session === undefined ? null : (
        <>
          <WorldClock session={session} />
          <TimeControls sessionId={session.id} session={session} />
          <StatusBar sessionId={session.id} session={session} />
          <CheckpointPanel sessionId={session.id} checkpoints={checkpoints} />
          {/* The opening choice is offered exactly while the session has not started (M1-S3);
              see `OpeningPanel` for why the head and the chain are both consulted, and why
              跳过 is the one choice that writes nothing. `skipped` is this screen's own
              answer, not store state, so a session switch resets it. */}
          {skipped === session.id ? (
            <p className="opening-status">{t('play.openingSkipped')}</p>
          ) : openingChoosing(session, messageChain) ? (
            <OpeningPanel
              sessionId={session.id}
              busy={opening || streaming}
              onSkip={() => setSkipped(session.id)}
            />
          ) : null}
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
 * route's (`openingChoosing`, because `skipped` and the panel are one render decision), and
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
      <h2 className="section-title">{t('play.openingTitle')}</h2>
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
      <h2 className="section-title">{t('play.variablesTitle')}</h2>
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
