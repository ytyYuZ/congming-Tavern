/**
 * The BYO-Key setup view: endpoint, key, model, and 「测试连接」 (M0-T8).
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
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
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
import { useSettingsStore } from '../../state/settings-store';

export function SetupRoute() {
  const { t } = useTranslation();
  const loaded = useSettingsStore((state) => state.loaded);
  const provider = useSettingsStore((state) => state.provider);
  const load = useSettingsStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return <p className="muted">{t('setup.loading')}</p>;
  return <SetupForm stored={provider} />;
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
