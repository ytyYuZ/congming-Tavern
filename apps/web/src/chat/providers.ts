/**
 * The provider wiring for the setup screen (M0-T8).
 *
 * WHY THERE IS A SCHEMA HERE AND NOT ONLY IN THE ROUTE
 * The form's rules and the app's rules have to be the same rules: `baseUrl` must be
 * a URL the adapter can normalize, `model` must be non-empty (`ChatRequest.model` is
 * required by the port). Defining them once means the Zod form resolver and the
 * 「测试连接」 button cannot disagree about what "configured" means.
 *
 * WHY `apiKey` IS ALLOWED TO BE EMPTY
 * `OpenAICompatibleOptions.apiKey` documents an empty string as "send no
 * `Authorization` header", which is what a local Ollama or vLLM needs. Requiring a
 * key would block the one setup the port explicitly supports.
 */
import { type FetchLike, LLM_ERROR_CODES, OpenAICompatibleProvider } from '@smarttavern/providers';
import { z } from 'zod';
import type { ProviderSettings } from '../db/repository';

/** How long 「测试连接」 waits before giving up, in milliseconds. */
export const CONNECTION_TIMEOUT_MS = 15_000;

/**
 * The setup form's contract.
 *
 * An empty `baseUrl` or `model` is refused with a sentence the user reads, because
 * a first run MUST be told what is missing rather than getting an adapter error
 * about an empty URL later.
 */
export const ProviderConfigFormSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .min(1, '请填写服务地址')
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, '服务地址必须是 http(s) URL'),
  apiKey: z.string(),
  model: z.string().trim().min(1, '请填写模型名'),
});

export type ProviderConfigForm = z.infer<typeof ProviderConfigFormSchema>;

/** The form's initial values, from whatever the settings row holds. */
export function formDefaults(provider: ProviderSettings): ProviderConfigForm {
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model };
}

/** What 「测试连接」 reports back to the screen. */
export interface ConnectionTestResult {
  ok: boolean;
  /** HTTP status of `GET {base}/models`, when a response arrived at all. */
  status?: number;
  /** The models `listModels()` answered with; the adapter's offline list on failure. */
  models: readonly string[];
  /** Stable machine code; the UI picks the sentence (the port's convention). */
  code: string;
  /** No `/models` response arrived, so `models` is the adapter's offline fallback. */
  offline: boolean;
}

/**
 * The sentence 「测试连接」 shows for a failed probe.
 *
 * WHY IT IS NOT `error.message`: the adapter composes that sentence for a developer
 * (it names the endpoint, the status and the vendor's own words, in English). What a
 * person needs is which of the four mapped causes this is. The stable `code` is what
 * picks the sentence, exactly as the port intends, and `chat/providers.test.ts` pins
 * that the code — not the prose — decides.
 */
export function connectionNote(result: ConnectionTestResult): string {
  if (result.code === LLM_ERROR_CODES.network) {
    return '连接失败：服务地址无法访问（检查地址、网络或浏览器 CORS 限制）';
  }
  if (result.offline) return '连接失败：服务地址不可达';
  return `连接失败：服务端返回 HTTP ${result.status ?? '未知状态'}`;
}

/**
 * The `GET {base}/models` URL for a configured base URL.
 *
 * It mirrors the adapter's own rule (`openai-compatible.ts`: a bare host gets `/v1`
 * appended, a path is left as the caller wrote it) because the alternative — asking
 * the adapter for the URL it would use — would change the provider's public surface
 * for a button. The rule is one condition wide, and `chat/providers.test.ts` pins it
 * against the adapter's observable behaviour so the two cannot drift unnoticed.
 */
export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const bareHost = /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(trimmed);
  return bareHost ? `${trimmed}/v1/models` : `${trimmed}/models`;
}

/**
 * Ask the provider whether the configuration can reach a model list.
 *
 * `listModels()` NEVER THROWS — it answers the vendor's well-known ids when
 * `GET /models` fails (`openai-compatible.ts` documents this: a hand-typed model
 * name is the normal case). So a connection test that only called `listModels()`
 * would report success for an unreachable gateway. This therefore makes its own
 * probe request for the STATUS, and treats "no response" as the failure it is.
 *
 * The probe BODY is discarded rather than reported: an untrusted gateway could echo
 * the `Authorization` header into its error text, and invariant 6 forbids the key
 * reaching anything the user can see. Only the status code travels back.
 */
export async function testConnection(
  config: ProviderSettings,
  options: { transport?: FetchLike } = {},
): Promise<ConnectionTestResult> {
  const provider = new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(options.transport === undefined ? {} : { fetch: options.transport }),
  });
  const transport: FetchLike = options.transport ?? ((url, init) => globalThis.fetch(url, init));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const models = await provider.listModels(controller.signal);
    const response = await transport(modelsUrl(config.baseUrl), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(config.apiKey === '' ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      models: models.map((model) => model.id),
      code: response.ok ? 'ok' : LLM_ERROR_CODES.invalidRequest,
      offline: false,
    };
  } catch {
    // The transport itself failed (DNS, TLS, CORS, our own timeout). The cause is
    // deliberately not reported: a rejection message can quote the request, and the
    // request carries the key.
    return {
      ok: false,
      models: [],
      code: LLM_ERROR_CODES.network,
      offline: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
