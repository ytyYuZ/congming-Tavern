/**
 * The provider wiring for the setup screen (M0-T8).
 *
 * WHY THERE IS A SCHEMA HERE AND NOT ONLY IN THE ROUTE
 * The form's rules and the app's rules have to be the same rules: `baseUrl` must be
 * a URL the adapter can normalize, `model` must be non-empty (`ChatRequest.model` is
 * required by the port). Defining them once means the Zod form resolver and the
 * 「测试连接」 button cannot disagree about what "configured" means.
 *
 * WHY THE SCHEMA IS BUILT FROM A TRANSLATOR (M1-G1)
 * Zod bakes a message into the schema at construction time, so a module-level constant
 * would freeze the validation sentence into one language — the setup screen's errors
 * would stay Chinese in an English interface. `providerConfigFormSchema(t)` defers the
 * choice to the caller, which is why the resolver is built from the ACTIVE locale: a
 * language switch rebuilds the schema, and everything else about the form (its values,
 * its dirty state) is untouched.
 *
 * WHY THIS MODULE IMPORTS *TYPES* FROM `@smarttavern/i18n` AND NO RUNTIME LOOKUP
 * It has no way to know which language the user reads, so every sentence it needs is
 * returned as a KEY (`ConnectionNote`) or asked for through a translator the caller
 * supplies. Importing `translate` here would drag the locale store — and through it
 * `db/repository.ts` — into a leaf module, which is an import cycle rather than a
 * convenience (the layering note is in `i18n/translate.ts`).
 *
 * WHY `apiKey` IS ALLOWED TO BE EMPTY
 * `OpenAICompatibleOptions.apiKey` documents an empty string as "send no
 * `Authorization` header", which is what a local Ollama or vLLM needs. Requiring a
 * key would block the one setup the port explicitly supports.
 */
import type { MessageKey } from '@smarttavern/i18n';
import { type FetchLike, LLM_ERROR_CODES, OpenAICompatibleProvider } from '@smarttavern/providers';
import { z } from 'zod';
import type { ProviderSettings } from '../db/repository';

/**
 * The translator shape this module needs: a key, and optional `{name}` values.
 *
 * Structural on purpose: the only caller is the setup view, whose `t` comes from
 * `useTranslation`, and a named parameter type keeps the signature readable without
 * making a leaf module depend on the hook.
 */
export type MessageLookup = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * How long 「测试连接」 waits before giving up, in milliseconds.
 *
 * The comment keeps the button's name; the name itself is `setup.testConnection`.
 */
export const CONNECTION_TIMEOUT_MS = 15_000;

/**
 * The setup form's contract, with its messages read from the active locale.
 *
 * An empty `baseUrl` or `model` is refused with a sentence the user reads, because
 * a first run MUST be told what is missing rather than getting an adapter error
 * about an empty URL later. `t` is taken as a parameter (rather than imported as a
 * module-level function) so the caller's locale — and only the caller's — decides
 * which catalog the rules come from.
 */
export function providerConfigFormSchema(t: MessageLookup) {
  return z.object({
    baseUrl: z
      .string()
      .trim()
      .min(1, t('setup.baseUrlRequired'))
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      }, t('setup.baseUrlInvalid')),
    apiKey: z.string(),
    model: z.string().trim().min(1, t('setup.modelRequired')),
  });
}

export type ProviderConfigForm = z.infer<ReturnType<typeof providerConfigFormSchema>>;

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
 * The sentence 「测试连接」 shows for a failed probe, as a KEY plus its parameters.
 *
 * WHY IT IS NOT `error.message`: the adapter composes that sentence for a developer
 * (it names the endpoint, the status and the vendor's own words, in English). What a
 * person needs is which of the three mapped causes this is. The stable `code` is what
 * picks the sentence, exactly as the port intends.
 *
 * WHY A KEY AND NOT A SENTENCE (M1-G1): this function used to return the Chinese text,
 * which put UI copy in a module that has no idea what language the user reads — and
 * meant the view could not re-render the note on a language switch. Returning
 * `{ key, params }` lets the caller translate at render time, where the locale is known
 * and observable.
 *
 * WHY ONE KEY WITH `{status}` RATHER THAN CONCATENATION: `连接失败：服务端返回 HTTP `
 * + status is a sentence assembled from pieces, and a language that puts the status
 * first (or drops the colon) cannot be expressed by concatenating fragments. The status
 * travels as a parameter of a single catalog message, and the NO-STATUS case is a
 * different catalog key (`setup.testOffline`) rather than a Chinese stand-in string
 * concatenated in here — this module knows keys, never sentences.
 *
 * WHY `status` IS A `string | number` PARAMETER AND NOT A LOOKUP
 * `setup.statusUnknown` ("unknown status") is itself catalog text, so filling
 * `setup.testHttpFailed`'s `{status}` slot with it would be this module translating one
 * fragment to build another. Instead the whole sentence is chosen by the caller's
 * locale: no status means `setup.testOffline`'s own message.
 */
export interface ConnectionNote {
  key: MessageKey;
  /**
   * Values for the message's `{name}` placeholders.
   *
   * Indexed `string` (not `MessageKey`) because it is handed straight to `t`. `Readonly`
   * so a caller cannot mutate a value some other render is reading.
   */
  params?: Readonly<Record<string, string | number>>;
}

/** The catalog key and parameters for a failed probe. */
export function connectionNote(result: ConnectionTestResult): ConnectionNote {
  if (result.code === LLM_ERROR_CODES.network) return { key: 'setup.testNetworkFailed' };
  if (result.offline || result.status === undefined) return { key: 'setup.testOffline' };
  return { key: 'setup.testHttpFailed', params: { status: result.status } };
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
