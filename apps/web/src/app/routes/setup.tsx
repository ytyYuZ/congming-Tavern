/**
 * The BYO-Key setup view: endpoint, key, model, and 「测试连接」 (M0-T8), plus the
 * appearance section — theme, font scale, message width — added by M1-G2.
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
 * message (HANDOFF §4.1 invariant 6).
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
  type ProviderConfigForm,
  providerConfigFormSchema,
  testConnection,
} from '../../chat/providers';
import type { ProviderSettings } from '../../db/repository';
import { useTranslation } from '../../i18n/use-translation';
import { useAppearanceStore } from '../../state/appearance-store';
import { useSettingsStore } from '../../state/settings-store';

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

export function SetupRoute() {
  const { t } = useTranslation();
  const loaded = useSettingsStore((state) => state.loaded);
  const provider = useSettingsStore((state) => state.provider);
  const load = useSettingsStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {loaded ? <SetupForm stored={provider} /> : <p className="muted">{t('setup.loading')}</p>}
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

function SetupForm({ stored }: { stored: ProviderSettings }) {
  const { t } = useTranslation();
  const save = useSettingsStore((state) => state.save);
  const [testResult, setTestResult] = useState<ConnectionNote | undefined>(undefined);
  const [testFailed, setTestFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  const schema = useMemo(() => providerConfigFormSchema(t), [t]);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ProviderConfigForm>({
    resolver: zodResolver(schema),
    defaultValues: formDefaults(stored),
  });

  const onSubmit = async (values: ProviderConfigForm): Promise<void> => {
    await save(values);
    setSaved(true);
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
        <input id="apiKey" type="password" autoComplete="off" {...register('apiKey')} />
        <span className="muted">{t('setup.apiKeyHint')}</span>
      </div>

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

      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
          {t('common.save')}
        </button>
        <button className="btn" type="button" disabled={testing} onClick={onTest}>
          {testing ? t('setup.testing') : t('setup.testConnection')}
        </button>
      </div>

      {testResult === undefined ? null : (
        <p className={`notice ${testFailed ? 'notice-error' : 'notice-ok'}`}>
          {t(testResult.key, testResult.params)}
        </p>
      )}
      {saved ? <p className="notice notice-ok">{t('setup.saved')}</p> : null}
    </form>
  );
}
