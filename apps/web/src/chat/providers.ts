/**
 * The provider wiring for the setup screen (M0-T8; the model list added by M1-G3).
 *
 * WHY THERE IS A SCHEMA HERE AND NOT ONLY IN THE ROUTE
 * The form's rules and the app's rules have to be the same rules: `baseUrl` must be
 * a URL the adapter can normalize, `model` must be non-empty (`ChatRequest.model` is
 * required by the port). Defining them once means the Zod form resolver and the
 * 「测试连接」 button cannot disagree about what "configured" means.
 *
 * WHAT M1-G3 ADDED, AND WHY IT IS THE SAME KIND OF MODULE
 * `listProviderModels` asks the endpoint what it serves, and `modelChoices` decides what
 * to offer given the saved model. Both are here rather than in the route because both are
 * rules about the endpoint (which URL, what counts as a list, what to do when the saved
 * value is absent) and the route is only their renderer — the same split that keeps the
 * validation schema out of the markup.
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

/**
 * The form's initial values, from whatever the settings row holds.
 *
 * `apiKey` is a SEPARATE argument rather than a field of `provider` (M1-G3): the row
 * holds the key slot (an envelope once a passphrase is set) and only this tab's unlocked
 * session can turn that into a string to show. Passing it explicitly is what lets the
 * form distinguish "there is no key" from "there is a key I cannot read" — the second
 * case passes `''` AND disables the field, and a form that could not tell them apart
 * would offer to overwrite a key it never read.
 */
export function formDefaults(provider: ProviderSettings, apiKey: string): ProviderConfigForm {
  return { baseUrl: provider.baseUrl, apiKey, model: provider.model };
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
 * WHY IT REPEATS THE ADAPTER'S RULE INSTEAD OF ASKING IT: the adapter keeps its endpoint
 * normalisation private, and exposing it would change `packages/providers`' public surface
 * for a settings control. So the rule is spelled here in the SAME form the adapter uses
 * (`openai-compatible.ts`'s `normalizeEndpoint`: strip trailing slashes, then ask the parsed
 * URL whether its path is empty or `/`) rather than as a regex over the raw string — a regex
 * and a URL parser disagree about inputs like a query string, and the one thing this must
 * never do is send a model list request to an address the chat request would not use.
 * `chat/providers.test.ts` drives the REAL adapter over a fake transport and compares the
 * URL it requests with this function's answer, so the two cannot drift unseen.
 */
export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    // A bare host has no path of its own, and every vendor here documents `{host}/v1/...`.
    if (url.pathname === '' || url.pathname === '/') return `${trimmed}/v1/models`;
  } catch {
    // Not a URL at all: the adapter appends `/models` to whatever the caller wrote, and so
    // does this. The form refuses such a value before it is ever saved.
  }
  return `${trimmed}/models`;
}

/* ───────────────────────────── the model list ─────────────────────────────── */

/**
 * How many fetched ids the model picker renders.
 *
 * WHY A CAP AT ALL: aggregators answer `GET /models` with thousands of ids (OpenRouter
 * is over 300 today), and a `<select>` of that size is both slow to build on every
 * render and unusable to scroll. The cap is not a limitation of what can be CONFIGURED
 * — the model field stays a free-text input, which is the adapter's documented normal
 * case ("a hand-typed model name") — it only limits what the picker offers, and the
 * screen states the truncation with both numbers so nothing is hidden.
 */
export const MODEL_OPTION_LIMIT = 200;

/** What a model-list fetch answered. A union, so the screen must handle every outcome. */
export type ModelListResult =
  /** The endpoint answered with at least one model id. */
  | { readonly kind: 'ok'; readonly models: readonly string[] }
  /** The endpoint answered, and its list is empty (`data: []`). */
  | { readonly kind: 'empty' }
  /** No response arrived at all: DNS, TLS, CORS, or our own timeout. */
  | { readonly kind: 'unreachable' }
  /** A response arrived with a non-2xx status. The body is deliberately discarded. */
  | { readonly kind: 'http'; readonly status: number };

/**
 * Ask the provider which models it serves, for the setup screen's picker.
 *
 * WHY THIS DOES NOT CALL `provider.listModels()`
 * That method's contract is "never throws, and answer the vendor's well-known ids when
 * `GET /models` fails" — which is right for a chat request that needs a default and
 * wrong for a picker, because it makes three different facts indistinguishable: an
 * EMPTY list, an unreachable endpoint and a 401 would all come back as a plausible list
 * of model names that this endpoint may not serve at all. A picker that offers invented
 * ids is worse than one that says nothing, so this reads the same URL directly and
 * reports which of the four outcomes happened.
 *
 * WHERE THE DUPLICATION IS, AND WHY IT IS ONE RULE RATHER THAN TWO
 * The URL rule is shared: this function calls `modelsUrl`, which a test pins against the
 * adapter's own normalisation. What is duplicated is the tiny `data[].id` read, and that
 * is deliberate — the adapter's version also folds in three names for a context window
 * and then substitutes a fallback list, i.e. it is shaped for a different question. The
 * port has no "tell me what the endpoint actually answered" method, and adding one would
 * change `packages/providers`' public surface for a settings control.
 *
 * The response BODY of a failure is discarded and never surfaced: an untrusted gateway
 * can echo the `Authorization` header into its error text, and invariant 6 forbids the
 * key reaching anything the user can see (the same rule `testConnection` documents).
 */
export async function listProviderModels(
  config: Pick<ConnectionTarget, 'baseUrl' | 'apiKey'>,
  options: { transport?: FetchLike; signal?: AbortSignal } = {},
): Promise<ModelListResult> {
  // An empty endpoint has nothing to ask. Building `${''}/models` would produce a RELATIVE
  // URL, i.e. a request to the app's own origin — somewhere the user never configured, and a
  // request whose 404 would read as "your server answered wrongly".
  if (config.baseUrl.trim() === '') return { kind: 'unreachable' };
  const transport: FetchLike = options.transport ?? ((url, init) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  // The caller's signal (a screen that is going away) and our own timeout both abort.
  const signal = options.signal ?? controller.signal;

  try {
    const response = await transport(modelsUrl(config.baseUrl), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(config.apiKey === '' ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      signal,
    });
    if (!response.ok) return { kind: 'http', status: response.status };
    const parsed: unknown = await response.json();
    // OpenAI-compatible vendors answer `{data: [{id}]}`; a few answer a bare array, and
    // the adapter accepts both, so this does too.
    const body = asRecord(parsed);
    const entries = Array.isArray(parsed)
      ? parsed
      : body === undefined
        ? undefined
        : field(body, 'data');
    const ids = modelIds(entries);
    return ids.length === 0 ? { kind: 'empty' } : { kind: 'ok', models: ids };
  } catch {
    // The cause is deliberately not reported: a rejection message can quote the request,
    // and the request carries the key (`testConnection` records the same rule).
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The model ids of an untrusted `data` value, deduped, in the endpoint's own order. */
function modelIds(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = field(record, 'id');
    const name = field(record, 'name');
    const candidate = typeof id === 'string' ? id : typeof name === 'string' ? name : undefined;
    if (candidate === undefined || candidate === '' || seen.has(candidate)) continue;
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

/** An object, or `undefined` for anything else. The untrusted-input narrow used above. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One field of an untrusted record.
 *
 * A PARAMETERISED key rather than `record.id`: this workspace compiles with
 * `noPropertyAccessFromIndexSignature` (which rejects dot access on an index signature) while
 * Biome's `useLiteralKeys` rejects the literal `record['id']` form. A key passed as an argument
 * is the one spelling both accept — the same conflict `db/repository.ts`'s `stringField` and
 * `state/write-error.ts` record.
 */
function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/**
 * The picker's options and the one fact that needs a decision: is the saved model
 * still in the list?
 *
 * KEPT AND FLAGGED, NEVER SILENTLY CHANGED — and the reasons are in the data, not in
 * taste:
 *   1. The string is PINNED BY HISTORY. `Session.refs.modelConfig.model` records which
 *      model produced a transcript (`db/repository.ts`'s `recordSessionModel` calls a
 *      mismatch "a debugging trap"), so rewriting it because a list endpoint omitted it
 *      would relabel every past turn of every session.
 *   2. THE LIST IS NOT AUTHORITATIVE. `/models` is usually a convenience endpoint: the
 *      adapter's own documentation calls a hand-typed model name the normal case, and
 *      gateways routinely omit aliases, fine-tunes and proxied ids they happily serve.
 *      A missing entry therefore means "this endpoint does not list it", not "this
 *      endpoint cannot serve it".
 * So the saved id stays selected, `savedModelMissing` is reported so the screen can say
 * so, and the row is only written when the USER picks a different id.
 */
export interface ModelChoices {
  /** The ids to offer, capped at `MODEL_OPTION_LIMIT`. */
  readonly ids: readonly string[];
  /** The saved model, when the endpoint did not list it — offered first, marked. */
  readonly savedModel: string | undefined;
  /** Total ids the endpoint answered with, before the cap. */
  readonly total: number;
}

/** What to offer, given the saved model and the ids the endpoint answered with. */
export function modelChoices(
  savedModel: string,
  models: readonly string[],
  limit: number = MODEL_OPTION_LIMIT,
): ModelChoices {
  const saved = savedModel.trim();
  const known = saved !== '' && models.includes(saved);
  return {
    ids: models.slice(0, Math.max(0, limit)),
    savedModel: saved !== '' && !known ? saved : undefined,
    total: models.length,
  };
}

/**
 * The sentence a model-list fetch shows, as a KEY plus its parameters.
 *
 * WHY A KEY AND NOT A SENTENCE (the rule `connectionNote` above records): this module has
 * no way to know which language the user reads, so it returns the key and the view
 * translates at render time. WHY ONE KEY PER OUTCOME AND NOT A COMPOSED SENTENCE: "the
 * endpoint could not be reached", "the server answered HTTP 401" and "the list is empty"
 * are three different instructions to the user, and concatenating a status into a fragment
 * cannot be translated (`connectionNote`'s comment makes the same argument for the
 * connection test).
 */
export function modelListNote(result: ModelListResult): ConnectionNote {
  switch (result.kind) {
    case 'ok':
      return { key: 'setup.modelsLoaded', params: { count: result.models.length } };
    case 'empty':
      return { key: 'setup.modelsEmpty' };
    case 'unreachable':
      return { key: 'setup.modelsUnreachable' };
    case 'http':
      return { key: 'setup.modelsHttpFailed', params: { status: result.status } };
  }
}

/**
 * What a connection probe needs: an endpoint, a key (allowed to be empty), and the model
 * it will be asked for.
 *
 * A STRUCTURAL type and not `ProviderSettings` (M1-G3): the row no longer owns a key
 * string — it owns a key SLOT, which may be an envelope — so a function that needs a key to
 * put in a header takes the key, and the caller (the form, or the store's unlocked session)
 * is the one that knows whether it has one. Passing the whole row here would force this
 * module to know how to decrypt.
 */
export interface ConnectionTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
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
  config: ConnectionTarget,
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
