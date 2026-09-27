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
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  connectionNote,
  formDefaults,
  type ProviderConfigForm,
  ProviderConfigFormSchema,
  testConnection,
} from '../../chat/providers';
import type { ProviderSettings } from '../../db/repository';
import { useSettingsStore } from '../../state/settings-store';

export function SetupRoute() {
  const loaded = useSettingsStore((state) => state.loaded);
  const provider = useSettingsStore((state) => state.provider);
  const load = useSettingsStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return <p className="muted">正在读取设置…</p>;
  return <SetupForm stored={provider} />;
}

function SetupForm({ stored }: { stored: ProviderSettings }) {
  const save = useSettingsStore((state) => state.save);
  const [testResult, setTestResult] = useState<string | undefined>(undefined);
  const [testFailed, setTestFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ProviderConfigForm>({
    resolver: zodResolver(ProviderConfigFormSchema),
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
    setTestResult(result.ok ? `连接成功（HTTP ${result.status}）` : connectionNote(result));
    setTesting(false);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="field">
        <label htmlFor="baseUrl">服务地址（Base URL）</label>
        <input
          id="baseUrl"
          type="url"
          placeholder="https://api.deepseek.com/v1"
          {...register('baseUrl')}
        />
        {errors.baseUrl === undefined ? null : (
          <span className="field-error">{errors.baseUrl.message}</span>
        )}
      </div>

      <div className="field">
        <label htmlFor="apiKey">API Key</label>
        <input id="apiKey" type="password" autoComplete="off" {...register('apiKey')} />
        <span className="muted">本地 Ollama / vLLM 可以留空。密钥只保存在这台设备的数据库中。</span>
      </div>

      <div className="field">
        <label htmlFor="model">模型名</label>
        <input id="model" type="text" placeholder="deepseek-chat" {...register('model')} />
        {errors.model === undefined ? null : (
          <span className="field-error">{errors.model.message}</span>
        )}
      </div>

      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
          保存
        </button>
        <button className="btn" type="button" disabled={testing} onClick={onTest}>
          {testing ? '测试中…' : '测试连接'}
        </button>
      </div>

      {testResult === undefined ? null : (
        <p className={`notice ${testFailed ? 'notice-error' : 'notice-ok'}`}>{testResult}</p>
      )}
      {saved ? <p className="notice notice-ok">已保存</p> : null}
    </form>
  );
}
