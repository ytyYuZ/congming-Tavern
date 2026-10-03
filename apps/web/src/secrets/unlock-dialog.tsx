/**
 * The ONE unlock dialog (Phase A2, docs/06-开发任务拆解.md §2.1): the action every surface that
 * reports `key_locked` offers.
 *
 * WHY THIS EXISTS AT ALL
 * The first manual acceptance test found the failure it fixes: the derived key lives "this tab,
 * until locked or reloaded", and the only passphrase field was on `/setup`. A user who never
 * opens Settings could therefore not use the key they had already saved — every turn was refused
 * with `key_locked` and a sentence that said "go to Settings", which is not an answer to a
 * refusal that happened on the screen they were reading. So the act moves to where the refusal
 * is: the play screen's banner and the co-creation panel's finding mount this dialog, and a
 * successful unlock clears their error without a reload (the store's `locked` flag is what they
 * render from, and `state/settings-store.ts`'s `unlock` re-reads it).
 *
 * WHY IT IS A DIALOG AND NOT A SECOND INLINE FORM
 * The setup screen keeps its own field because that screen is ABOUT the key (`app/routes/setup
 * .tsx`). Everywhere else the passphrase is a detour from what the user was doing, so it is a
 * modal that can be dismissed, and it is ONE component: a second inline copy would be a second
 * place for the failure sentences to drift.
 *
 * WHAT IT REUSES, DELIBERATELY
 * - `useSettingsStore.unlock` — the existing action, including its re-read of the rows.
 * - `SecretSaveFailureKind` -> `SECRET_FAILURE_KEYS` is NOT imported from the setup route (that
 *   would couple a play-screen component to a settings view): the mapping below is the same
 *   table of catalog keys, and `i18n` enforces that every one of them exists.
 * - `secrets/unlock-memory.ts` owns what "remember on this device" stores; this component only
 *   passes the checkbox's state through, and the CHECKBOX DEFAULTS TO OFF (invariant: without
 *   the opt-in a reload starts locked exactly as today).
 *
 * WHY THE PASSPHRASE LIVES ONLY IN THIS COMPONENT'S STATE
 * Exactly like the setup form's, and for the reason `secrets/provider-secret.ts` records: it is
 * an argument that is encoded and dropped. It is cleared when the dialog closes and on every
 * submit, and it is never written to the store, a log, or an error message.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/use-translation';
import { type SecretSaveFailureKind, useSettingsStore } from '../state/settings-store';

/**
 * The sentence for each way an unlock can be refused.
 *
 * A total `Record` over the failure union, so a new failure kind is a compile error until
 * someone decides what it says — the same guarantee the setup route's table gives, kept in step
 * with it by the type rather than by a comment.
 */
const UNLOCK_FAILURE_KEYS: Readonly<Record<SecretSaveFailureKind, MessageKey>> = {
  'wrong-passphrase': 'setup.passphraseWrong',
  'passphrase-too-short': 'setup.passphraseTooShort',
  'crypto-unavailable': 'setup.passphraseUnavailable',
  'malformed-envelope': 'setup.secretUnreadable',
  locked: 'setup.secretNoSession',
  storage: 'setup.secretStorageFailed',
};

export interface UnlockDialogProps {
  /**
   * Called after a successful unlock, BEFORE `onClose`.
   *
   * It exists for the surface that MOUNTED the dialog: a refusal it is rendering
   * (`state/chat-store.ts`'s `key_locked`, the co-creation panel's finding) is now stale, and
   * only that surface can clear it. The store cannot: it holds the fact (the row is unlocked),
   * not the sentence a screen decided to show about it.
   */
  readonly onUnlocked?: () => void;
  /** Close the dialog. Called on cancel and after a successful unlock. */
  readonly onClose: () => void;
}

/**
 * The passphrase dialog. Renders nothing until it is open, because its parent decides when the
 * user asked for it (an unlock is never something this app starts on its own).
 */
export function UnlockDialog({ onUnlocked, onClose }: UnlockDialogProps) {
  const { t } = useTranslation();
  const unlock = useSettingsStore((state) => state.unlock);
  const activeId = useSettingsStore((state) => state.activeId);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const [failure, setFailure] = useState<SecretSaveFailureKind | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // Focus the field the dialog exists for. `focus()` on a ref rather than an `autoFocus`
  // attribute: the dialog is mounted by a click, and React's `autoFocus` would also fire for a
  // future render that kept it mounted.
  useEffect(() => {
    field.current?.focus();
  }, []);

  const close = (): void => {
    // The passphrase does not outlive the dialog, and neither does the failure sentence for it.
    setPassphrase('');
    setFailure(undefined);
    onClose();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (passphrase === '' || busy) return;
    setBusy(true);
    const answer = await unlock(passphrase, { remember });
    setBusy(false);
    setPassphrase('');
    setFailure(answer);
    // A successful unlock closes the dialog; the surface behind it re-renders unlocked, which is
    // the "no reload required" half of the acceptance.
    if (answer === undefined) {
      onUnlocked?.();
      onClose();
    }
  };

  return (
    <div className="unlock-backdrop" data-dialog="unlock">
      <form className="unlock-dialog" onSubmit={onSubmit} noValidate>
        <h2 id="unlock-title">{t('setup.unlockTitle')}</h2>
        <p className="muted">{t('setup.unlockHint')}</p>

        <div className="field">
          <label htmlFor="unlock-passphrase">{t('setup.passphraseLabel')}</label>
          <input
            id="unlock-passphrase"
            ref={field}
            type="password"
            autoComplete="off"
            placeholder={t('setup.passphrasePlaceholder')}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </div>

        {/* The opt-in. `checked` is bound to LOCAL state initialised to false, so a dialog that
            opens without the user touching it can never store anything. */}
        <label className="unlock-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          {t('setup.rememberLabel')}
        </label>
        <span className="muted">{t('setup.rememberHint')}</span>

        {failure === undefined ? null : (
          <p className="notice notice-error" data-status="unlock-failure">
            {t(UNLOCK_FAILURE_KEYS[failure])}
          </p>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy || passphrase === ''}>
            {t('setup.passphraseUnlock')}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={close}>
            {t('common.cancel')}
          </button>
        </div>
        {/* Named so a screen reader knows which row this opens; absent for a single-provider
            database, where a row id would be noise. */}
        {activeId === undefined ? null : (
          <p className="muted unlock-target">{t('setup.unlockTarget', { provider: activeId })}</p>
        )}
      </form>
    </div>
  );
}

/**
 * The button + dialog pair a refused surface mounts.
 *
 * WHY ONE COMPONENT AND NOT TWO EXPORTS: every caller needs both halves (the action and the
 * thing it opens), and a caller that mounted the button without the dialog would be a control
 * that does nothing. The open/closed state belongs to this component because nothing outside it
 * reads it.
 */
export interface UnlockActionProps {
  /** Run when the unlock succeeds, so the surface can clear the refusal it is showing. */
  readonly onUnlocked?: () => void;
}

export function UnlockAction({ onUnlocked }: UnlockActionProps = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="btn" type="button" onClick={() => setOpen(true)}>
        {t('setup.passphraseUnlock')}
      </button>
      {open ? <UnlockDialog onUnlocked={onUnlocked} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
