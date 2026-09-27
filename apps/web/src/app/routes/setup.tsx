/**
 * The BYO-Key setup view: endpoint, key, model, and 「测试连接」 (M0-T8), plus the model
 * list and the local key encryption section (M1-G3), plus the appearance section — theme,
 * font scale, message width — added by M1-G2.
 *
 * WHY react-hook-form + zodResolver
 * ADR-017 fixes the state layer, and this is the one screen with real input
 * validation. The rules live in `chat/providers.ts` so the form and 「测试连接」 agree
 * about what "configured" means; the resolver is the bridge, and the form owns
 * nothing but transient UI state (dirty, submitting, the test result).
 *
 * WHY 「测试连接」 DOES NOT TRUST `listModels()`
 * `listModels()` never throws and answers the vendor's well-known ids when
 * `GET /models` fails, so on its own it reports success for an unreachable gateway.
 * `testConnection` therefore also reads the probe's STATUS, and this view says
 * explicitly when the list it shows is the adapter's offline fallback.
 *
 * WHY THE FORM IS A SEPARATE COMPONENT WITH A PRE-FILLED `defaultValues`
 * react-hook-form treats `defaultValues` as the initial values ONLY. When the stored
 * settings arrive later, the fields would stay empty and a save would write blanks
 * over the user's configuration. So the route waits for the settings row and mounts
 * the form once, with the stored values in hand.
 *
 * WHERE THE KEY IS SHOWN
 * In the password field, because the user owns it and has no other way to check what
 * they saved. It is not echoed anywhere else, never logged, and never attached to a
 * message (HANDOFF §4.1 invariant 6). WHEN THE ROW'S KEY IS ENCRYPTED AND LOCKED there
 * is nothing to show, so the field is DISABLED rather than empty-and-editable: an empty
 * editable field would invite the user to save a blank over a key they never read, and
 * `secretIntent` below turns "the field cannot express a key" into `keep` for exactly
 * that reason.
 *
 * WHY THE RESOLVER IS REBUILT FROM THE ACTIVE LOCALE (M1-G1)
 * Zod embeds each validation message in the schema, so the resolver is created from
 * `t` and memoised on it: a language switch rebuilds the RULES (with their sentences in
 * the new language) while react-hook-form keeps the values the user typed. A
 * module-level schema would have frozen the validation copy into one language.
 *
 * WHY THE APPEARANCE SECTION IS HERE AND NOT ON A ROUTE OF ITS OWN (M1-G2)
 * This is the only settings screen the app has, and appearance is a setting: a second
 * route would need a second link in the header for three controls. It is a SIBLING of
 * the form rather than a field inside it, because the two are independent — the
 * appearance store is a different store, and its controls must work on a first run where
 * the provider row does not exist yet (the form's own loading gate is deliberately not
 * applied to them). It therefore has its own `<section>` and its own heading.
 *
 * WHY THE MODEL PICKER WRITES THE ROW IMMEDIATELY, AND WHAT IT KEEPS (M1-G3)
 * Choosing from the list is a COMPLETE decision ("use this model"), so it saves through
 * the same store action the 保存 button uses rather than leaving an edit for a second
 * click — a picker that silently changes nothing until the user finds 保存 is a control
 * that lies about what it did. The save carries the endpoint currently IN THE FORM, so
 * the row it writes is the configuration the user is looking at.
 * What it never does is CHANGE the saved model on its own: a model the endpoint's list
 * does not mention is kept, offered as the first option, and flagged in words. The
 * reasons are in `chat/providers.ts`'s `ModelChoices` — the string is pinned by session
 * history, and `/models` is a convenience endpoint that omits ids the gateway serves.
 *
 * WHY THE PASSPHRASE FIELD IS PART OF THIS FORM'S STATE (M1-G3)
 * `secretIntent` below has to know whether the user typed a passphrase, because "store
 * this NEW key" under a passphrase and "store this new key" without one are different
 * rows. Keeping the passphrase in the form (and NOT in the store — see the policy in
 * `secrets/provider-secret.ts`) is what lets one save express both.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import type { MessageKey } from '@smarttavern/i18n';
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  clampFontScale,
  clampMessageWidth,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  isTheme,
  MESSAGE_WIDTH_MAX,
  MESSAGE_WIDTH_MIN,
  MESSAGE_WIDTH_STEP,
  THEMES,
  type Theme,
} from '../../appearance/appearance';
import {
  type ConnectionNote,
  connectionNote,
  formDefaults,
  listProviderModels,
  type ModelChoices,
  modelChoices,
  modelListNote,
  type ProviderConfigForm,
  providerConfigFormSchema,
  testConnection,
} from '../../chat/providers';
import type { ProviderSettings, StoredProviderSecret } from '../../db/repository';
import { useTranslation } from '../../i18n/use-translation';
import { useAppearanceStore } from '../../state/appearance-store';
import {
  type SecretIntent,
  type SecretSaveFailureKind,
  useSettingsStore,
} from '../../state/settings-store';

/**
 * The theme options in picker order, each with the catalog key that names it.
 *
 * A `Record<Theme, MessageKey>` rather than three literals in the markup: adding a theme
 * to `THEMES` then fails to compile until it has a sentence, which is the same guarantee
 * the catalogs give each other.
 */
const THEME_LABEL_KEYS: Readonly<Record<Theme, MessageKey>> = {
  system: 'setup.themeSystem',
  light: 'setup.themeLight',
  dark: 'setup.themeDark',
};

/**
 * The sentence for each way a settings action can be refused (M1-G3).
 *
 * A total `Record` over the failure union, so a new failure kind is a compile error until
 * someone decides what it says — the same reason `catalog.test.ts` pins the areas. The
 * mapping lives in the VIEW, not in the store: which sentence a person reads is a
 * presentation decision, and a state module that also owns prose is a state module that
 * has to be edited to translate the app (ADR-019, `i18n/error-keys.ts`).
 */
const SECRET_FAILURE_KEYS: Readonly<Record<SecretSaveFailureKind, MessageKey>> = {
  'wrong-passphrase': 'setup.passphraseWrong',
  'passphrase-too-short': 'setup.passphraseTooShort',
  'crypto-unavailable': 'setup.passphraseUnavailable',
  'malformed-envelope': 'setup.secretUnreadable',
  locked: 'setup.secretNoSession',
  storage: 'setup.secretStorageFailed',
};

export function SetupRoute() {
  const { t } = useTranslation();
  const loaded = useSettingsStore((state) => state.loaded);
  const provider = useSettingsStore((state) => state.provider);
  const key = useSettingsStore((state) => state.key);
  const locked = useSettingsStore((state) => state.locked);
  const load = useSettingsStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {loaded ? (
        <SetupForm stored={provider} storedKey={key} locked={locked} />
      ) : (
        <p className="muted">{t('setup.loading')}</p>
      )}
      <AppearanceSection />
    </>
  );
}

/**
 * The three appearance controls (M1-G2).
 *
 * WHY IT READS THE STORE DIRECTLY AND DOES NOT LOAD IT
 * `<App/>` already starts the appearance read on every mount (`app/app.tsx` records why
 * one place is enough), and the store's constructed value is a complete, usable
 * appearance — so this section renders immediately and never shows a spinner. The
 * sliders are CONTROLLED by the store, which is what makes a change visible everywhere at
 * once: `state/appearance-store.ts` updates its value before it awaits the write, and
 * `appearance/use-appearance-effect.ts` projects it onto `<html>`.
 */
function AppearanceSection() {
  const { t } = useTranslation();
  const theme = useAppearanceStore((state) => state.theme);
  const fontScale = useAppearanceStore((state) => state.fontScale);
  const messageWidth = useAppearanceStore((state) => state.messageWidth);
  const setTheme = useAppearanceStore((state) => state.setTheme);
  const setFontScale = useAppearanceStore((state) => state.setFontScale);
  const setMessageWidth = useAppearanceStore((state) => state.setMessageWidth);

  const onThemeChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    if (!isTheme(raw)) return;
    // Not awaited: the store applies the theme immediately and reports a write failure
    // through its own `error` field, so a slow write cannot stall the control
    // (`state/appearance-store.ts` records why).
    void setTheme(raw);
  };

  // A slider's event carries a STRING, and `Number('')` is 0 — which the bound turns into
  // the lower edge rather than into `calc(15px * 0)`. A bound the CSS can use is the
  // reason the clamp runs here and not only on the way back out of storage.
  const onFontScaleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    void setFontScale(clampFontScale(Number(event.target.value)));
  };

  const onMessageWidthChange = (event: ChangeEvent<HTMLInputElement>): void => {
    void setMessageWidth(clampMessageWidth(Number(event.target.value)));
  };

  return (
    <section className="appearance" aria-labelledby="appearance-title">
      <h2 id="appearance-title">{t('setup.appearanceTitle')}</h2>

      <div className="field">
        <label htmlFor="theme">{t('setup.themeLabel')}</label>
        <select id="theme" value={theme} onChange={onThemeChange}>
          {THEMES.map((option) => (
            <option key={option} value={option}>
              {t(THEME_LABEL_KEYS[option])}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="fontScale">{t('setup.fontScaleLabel')}</label>
        <div className="appearance-row">
          {/* The bounds are the exported constants, so the control and the parser cannot
              disagree about what is reachable (a test pins the attributes). */}
          <input
            id="fontScale"
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={fontScale}
            onChange={onFontScaleChange}
          />
          <span className="appearance-value">
            {t('setup.percentValue', { percent: Math.round(fontScale * 100) })}
          </span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="messageWidth">{t('setup.messageWidthLabel')}</label>
        <div className="appearance-row">
          <input
            id="messageWidth"
            type="range"
            min={MESSAGE_WIDTH_MIN}
            max={MESSAGE_WIDTH_MAX}
            step={MESSAGE_WIDTH_STEP}
            value={messageWidth}
            onChange={onMessageWidthChange}
          />
          <span className="appearance-value">
            {t('setup.percentValue', { percent: Math.round(messageWidth) })}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * What the key field should become after this save.
 *
 * THE THREE CASES, IN ORDER OF PRECEDENCE — and the first one is the one that must not be
 * got wrong:
 *   1. `locked` -> `keep`, UNCONDITIONALLY. The field is disabled and holds `''`, so
 *      comparing it with the (absent) session key would say "the user cleared the key"
 *      and overwrite an envelope with nothing. The form cannot express a key it cannot
 *      read, so it says nothing about it.
 *   2. The field still holds what it was pre-filled with -> `keep`. Editing the endpoint
 *      while the key sits untouched must not re-encrypt, re-derive or re-write it; this is
 *      the rule that makes a save cheap and a locked-then-unlocked row stable.
 *   3. A different value -> the user is replacing the key, and two sub-cases decide how it
 *      is protected: a typed passphrase seals it with that passphrase; no passphrase but an
 *      ALREADY ENCRYPTED row re-seals with the key open in this tab (`state/settings-store
 *      .ts` refuses that case when there is none); otherwise it is stored plaintext, which
 *      is the documented fallback and what the section's own status line says out loud.
 */
function secretIntent(
  values: ProviderConfigForm,
  options: {
    storedKey: string | undefined;
    locked: boolean;
    stored: StoredProviderSecret;
    passphrase: string;
  },
): SecretIntent {
  if (options.locked) return { kind: 'keep' };
  if (values.apiKey === (options.storedKey ?? '')) return { kind: 'keep' };
  if (values.apiKey === '') return { kind: 'clear' };
  if (options.passphrase !== '') {
    return { kind: 'seal', apiKey: values.apiKey, passphrase: options.passphrase };
  }
  return options.stored.kind === 'encrypted'
    ? { kind: 'seal', apiKey: values.apiKey }
    : { kind: 'plain', apiKey: values.apiKey };
}

/**
 * The options a model select shows, in order.
 *
 * The flagged saved model comes first (when the endpoint did not list it), then the fetched
 * ids, then whatever is currently TYPED when it is neither — the last one so the select can
 * always display the field's real value. Without it, a hand-typed id would leave the select
 * with no matching option, and a browser then shows a blank or the first entry: a control
 * silently disagreeing with the input beside it.
 */
function pickerOptions(choices: ModelChoices, current: string): string[] {
  const options: string[] = [];
  if (choices.savedModel !== undefined) options.push(choices.savedModel);
  for (const id of choices.ids) {
    if (!options.includes(id)) options.push(id);
  }
  const typed = current.trim();
  if (typed !== '' && !options.includes(typed)) options.push(typed);
  return options;
}

interface SetupFormProps {
  /** The stored row: endpoint, model, and what the key slot holds. */
  stored: ProviderSettings;
  /** The key this tab can read, or `undefined` while the row's key is locked. */
  storedKey: string | undefined;
  /** True when a key is stored under a passphrase and this tab cannot read it. */
  locked: boolean;
}

function SetupForm({ stored, storedKey, locked }: SetupFormProps) {
  const { t } = useTranslation();
  const save = useSettingsStore((state) => state.save);
  const unlock = useSettingsStore((state) => state.unlock);
  const lock = useSettingsStore((state) => state.lock);
  const encryptStored = useSettingsStore((state) => state.encryptStored);
  const [testResult, setTestResult] = useState<ConnectionNote | undefined>(undefined);
  const [testFailed, setTestFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<SecretSaveFailureKind | undefined>(undefined);
  const [passphrase, setPassphrase] = useState('');
  const [secretBusy, setSecretBusy] = useState(false);
  /** The endpoint's own ids, once a fetch answered with a list. */
  const [models, setModels] = useState<readonly string[] | undefined>(undefined);
  const [listNote, setListNote] = useState<ConnectionNote | undefined>(undefined);
  const [fetching, setFetching] = useState(false);

  const schema = useMemo(() => providerConfigFormSchema(t), [t]);

  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ProviderConfigForm>({
    resolver: zodResolver(schema),
    defaultValues: formDefaults(stored, storedKey ?? ''),
  });

  // The key can ARRIVE after the first render (an unlock), and the form was mounted with
  // `defaultValues` — which react-hook-form applies once. Without this the field would
  // stay empty after a successful unlock and the next save would look like "clear the
  // key". Keyed on `storedKey` only: a user's edits are not touched by a re-read, because
  // the store's key changes only when the ROW's key changes.
  useEffect(() => {
    setValue('apiKey', storedKey ?? '');
  }, [setValue, storedKey]);

  const currentModel = watch('model');
  const choices = useMemo(
    () => (models === undefined ? undefined : modelChoices(stored.model, models)),
    [models, stored.model],
  );

  /** Run one save and report what it answered; the single write path for this screen. */
  const persist = async (values: ProviderConfigForm): Promise<void> => {
    const answer = await save(
      { baseUrl: values.baseUrl, model: values.model },
      secretIntent(values, { storedKey, locked, stored: stored.secret, passphrase }),
    );
    setFailure(answer);
    setSaved(answer === undefined);
  };

  const onSubmit = (values: ProviderConfigForm): void => {
    void persist(values);
  };

  const onTest = async (): Promise<void> => {
    setTesting(true);
    setSaved(false);
    const result = await testConnection(getValues());
    setTestFailed(!result.ok);
    // The KEY travels, not the sentence: the paragraph below renders it through `t`, so
    // a language switch re-renders the note in the new language. `status` is only a
    // parameter when a response actually arrived, which is why it is spread conditionally.
    setTestResult(
      result.ok
        ? {
            key: 'setup.testOk',
            ...(result.status === undefined ? {} : { params: { status: result.status } }),
          }
        : connectionNote(result),
    );
    setTesting(false);
  };

  const onFetchModels = async (): Promise<void> => {
    setFetching(true);
    const values = getValues();
    const result = await listProviderModels({ baseUrl: values.baseUrl, apiKey: values.apiKey });
    setListNote(modelListNote(result));
    setModels(result.kind === 'ok' ? result.models : undefined);
    setFetching(false);
  };

  const onChooseModel = (event: ChangeEvent<HTMLSelectElement>): void => {
    const model = event.target.value;
    if (model === '') return;
    // The field first, then the row: `persist` reads the form, so a save that raced the
    // picker would otherwise write the previous model back.
    setValue('model', model);
    void persist({ ...getValues(), model });
  };

  const onUnlock = async (): Promise<void> => {
    setSecretBusy(true);
    setFailure(await unlock(passphrase));
    setPassphrase('');
    setSecretBusy(false);
  };

  const onSeal = async (): Promise<void> => {
    setSecretBusy(true);
    setFailure(await encryptStored(passphrase));
    setPassphrase('');
    setSecretBusy(false);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="field">
        <label htmlFor="baseUrl">{t('setup.baseUrlLabel')}</label>
        <input
          id="baseUrl"
          type="url"
          placeholder={t('setup.baseUrlPlaceholder')}
          {...register('baseUrl')}
        />
        {errors.baseUrl === undefined ? null : (
          <span className="field-error">{errors.baseUrl.message}</span>
        )}
      </div>

      <div className="field">
        <label htmlFor="apiKey">{t('setup.apiKeyLabel')}</label>
        <input
          id="apiKey"
          type="password"
          autoComplete="off"
          disabled={locked}
          {...register('apiKey')}
        />
        <span className="muted">{t('setup.apiKeyHint')}</span>
      </div>

      <SecretSection
        secret={stored.secret}
        locked={locked}
        passphrase={passphrase}
        onPassphrase={setPassphrase}
        busy={secretBusy}
        onUnlock={onUnlock}
        onSeal={onSeal}
        onLock={lock}
      />

      <div className="field">
        <label htmlFor="model">{t('setup.modelLabel')}</label>
        <input
          id="model"
          type="text"
          placeholder={t('setup.modelPlaceholder')}
          {...register('model')}
        />
        {errors.model === undefined ? null : (
          <span className="field-error">{errors.model.message}</span>
        )}
      </div>

      <div className="field">
        <button className="btn" type="button" disabled={fetching || locked} onClick={onFetchModels}>
          {fetching ? t('setup.modelsFetching') : t('setup.modelsFetch')}
        </button>
        {listNote === undefined ? null : (
          <p className="muted">{t(listNote.key, listNote.params)}</p>
        )}
        {choices === undefined ? null : (
          <>
            <label htmlFor="model-choice">{t('setup.modelChoicesLabel')}</label>
            <select id="model-choice" value={currentModel} onChange={onChooseModel}>
              {pickerOptions(choices, currentModel).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            {/* The decision M1-G3 had to make, said out loud: the saved model is kept. */}
            {choices.savedModel === undefined ? null : (
              <span className="muted">{t('setup.modelSavedMissing')}</span>
            )}
            {choices.total > choices.ids.length ? (
              <span className="muted">
                {t('setup.modelsTruncated', {
                  shown: choices.ids.length,
                  total: choices.total,
                })}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
          {t('common.save')}
        </button>
        <button className="btn" type="button" disabled={testing || locked} onClick={onTest}>
          {testing ? t('setup.testing') : t('setup.testConnection')}
        </button>
      </div>

      {failure === undefined ? null : (
        <p className="notice notice-error">{t(SECRET_FAILURE_KEYS[failure])}</p>
      )}
      {testResult === undefined ? null : (
        <p className={`notice ${testFailed ? 'notice-error' : 'notice-ok'}`}>
          {t(testResult.key, testResult.params)}
        </p>
      )}
      {saved ? <p className="notice notice-ok">{t('setup.saved')}</p> : null}
    </form>
  );
}

interface SecretSectionProps {
  secret: StoredProviderSecret;
  locked: boolean;
  passphrase: string;
  onPassphrase: (next: string) => void;
  busy: boolean;
  onUnlock: () => void;
  onSeal: () => void;
  onLock: () => void;
}

/**
 * The local key encryption section (M1-G3) — where the passphrase policy becomes a screen.
 *
 * WHAT IT SHOWS, AND WHY IT IS THREE STATES RATHER THAN ONE CONTROL
 * "No key yet", "a key in plain text" and "a key under a passphrase (locked or open)" need
 * different actions, so the section renders the action that fits: 加密保存 for a plaintext
 * key (the migration — M0's row becomes an envelope), 解锁 for a locked envelope, 锁定 for
 * an open one. Showing a single "toggle" would mean guessing, and the one guess that must
 * never happen is encrypting a key with a passphrase nobody typed.
 *
 * WHY 加密保存 IS ONLY OFFERED FOR A PLAINTEXT KEY: there is nothing to seal otherwise. An
 * absent key has nothing to protect, and an envelope is already sealed — re-sealing it needs
 * the current passphrase, which is the unlock path.
 *
 * WHY THE HINT IS ALWAYS VISIBLE: the passphrase cannot be recovered, because the
 * ciphertext is the only copy of the key. A user who learns that after typing has already
 * lost it, so the sentence sits next to the field they are about to fill
 * (`secrets/provider-secret.ts` records the policy).
 */
function SecretSection({
  secret,
  locked,
  passphrase,
  onPassphrase,
  busy,
  onUnlock,
  onSeal,
  onLock,
}: SecretSectionProps) {
  const { t } = useTranslation();

  const status =
    secret.kind === 'none'
      ? t('setup.secretNone')
      : secret.kind === 'plaintext'
        ? t('setup.secretPlaintext')
        : locked
          ? t('setup.secretLocked')
          : t('setup.secretUnlocked');

  return (
    <section className="secret" aria-labelledby="secret-title">
      <h2 id="secret-title">{t('setup.secretTitle')}</h2>
      <p className="muted">{status}</p>

      {/* The passphrase field is only rendered where a passphrase has a job to do: sealing
          a plaintext key, or opening an encrypted one. */}
      {secret.kind === 'none' ? null : (
        <>
          <div className="field">
            <label htmlFor="passphrase">{t('setup.passphraseLabel')}</label>
            <input
              id="passphrase"
              type="password"
              autoComplete="off"
              placeholder={t('setup.passphrasePlaceholder')}
              value={passphrase}
              onChange={(event) => onPassphrase(event.target.value)}
            />
            <span className="muted">{t('setup.passphraseHint')}</span>
          </div>

          <div className="btn-row">
            {secret.kind === 'plaintext' ? (
              <button className="btn" type="button" disabled={busy} onClick={onSeal}>
                {t('setup.passphraseSeal')}
              </button>
            ) : null}
            {secret.kind === 'encrypted' && locked ? (
              <button className="btn" type="button" disabled={busy} onClick={onUnlock}>
                {t('setup.passphraseUnlock')}
              </button>
            ) : null}
            {secret.kind === 'encrypted' && !locked ? (
              <button className="btn" type="button" disabled={busy} onClick={onLock}>
                {t('setup.passphraseLock')}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
