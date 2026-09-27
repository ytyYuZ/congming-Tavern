/**
 * The message catalogs — every user-facing sentence in the app (M1-G1,
 * docs/06-开发任务拆解.md §2.1: 中英文案，无硬编码).
 *
 * WHY zh-CN IS THE SOURCE OF TRUTH AND en IS TYPED AGAINST IT
 * `MessageKey` is `keyof typeof zhCN`, and `en` is annotated `Messages` —
 * `Record<MessageKey, string>` — so a missing, extra or misspelled English key is a
 * `tsc` error at the moment it is written, not a Chinese sentence that silently
 * appears in an English UI at runtime. The runtime test over `Object.keys(zhCN)`
 * exists for the one hole the compiler cannot see: a future `as` cast that lies its
 * way past the annotation.
 *
 * WHY FLAT DOTTED KEYS AND NOT NESTED OBJECTS
 * A flat `<area>.<thing>` key is greppable (`grep "'play.send'"`), printable in a
 * lint message (`use t('area.key')`), and survives a rename in one line. Nested
 * objects would need a type-level path walker to keep the same autocomplete, and
 * would make "which keys exist?" a recursive question for the lint rule and the
 * debug panel.
 *
 * WHY THE AREAS APPEAR IN A FIXED, CONTIGUOUS ORDER
 * A reviewer checking a translation should be able to read zh-CN and en side by side
 * and diff them line by line; interleaving a `setup.` key between two `home.` keys
 * costs that for no gain. `catalog.test.ts` pins both the area names and their order,
 * so the convention fails loudly instead of eroding.
 *
 * WHY `{name}` PLACEHOLDERS AND NOT TEMPLATE FUNCTIONS
 * A function-valued message would have to live in the catalog as code (`(p) => …`),
 * which breaks the "the catalog is data a translator can edit" property and makes a
 * missing parameter a runtime crash rather than a visible `{name}`. See `translate.ts`
 * for the missing-parameter rule.
 *
 * WHERE THESE STRINGS CAME FROM
 * Every value here was moved out of `apps/web/src/**` (M0-T8's hardcoded copy) with
 * the source text kept byte-identical, so the UI conversion is a pure substitution
 * and this catalog is a faithful record of the app as it shipped. The single
 * exception is `nav.language`, which is marked where it is declared.
 */
import type { Locale } from './locale';

/**
 * zh-CN — the source of truth. Every key lives here first; see the header for why
 * the other catalogs are typed against this one.
 */
export const zhCN = {
  /* ── common: copy that recurs across screens ─────────────────────────────── */
  /** The product name. The English form is the untranslated brand. */
  'common.appName': '聪明酒馆 SmartTavern',
  'common.save': '保存',
  /** The error banner's re-send button; also what a retryable failure needs. */
  'common.retry': '重试',
  'common.close': '关闭',

  /* ── nav: the shell's navigation ─────────────────────────────────────────── */
  /**
   * The language picker's label (`<select aria-label={t('nav.language')}>`). It is
   * the ONE key added ahead of its consumer: M1-G1's acceptance criterion is
   * "switching the language takes effect across the UI", and the switch itself needs a
   * name. The options come from `LOCALE_LABELS`, not from here.
   */
  'nav.language': '语言',
  'nav.settings': '设置',

  /* ── setup: the BYO-Key screen, in the order the form is filled ──────────── */
  'setup.loading': '正在读取设置…',
  'setup.baseUrlLabel': '服务地址（Base URL）',
  /** The input's placeholder: an EXAMPLE value, not copy — same in both locales. */
  'setup.baseUrlPlaceholder': 'https://api.deepseek.com/v1',
  'setup.baseUrlRequired': '请填写服务地址',
  'setup.baseUrlInvalid': '服务地址必须是 http(s) URL',
  /** Protocol field name, identical in both languages; keyed for the lint rule. */
  'setup.apiKeyLabel': 'API Key',
  'setup.apiKeyHint': '本地 Ollama / vLLM 可以留空。密钥只保存在这台设备的数据库中。',
  'setup.modelLabel': '模型名',
  /** The input's placeholder: an EXAMPLE model id, not copy — same in both locales. */
  'setup.modelPlaceholder': 'deepseek-chat',
  'setup.modelRequired': '请填写模型名',
  'setup.testConnection': '测试连接',
  'setup.testing': '测试中…',
  /** A successful probe. `{status}` is the HTTP status `GET /models` answered with. */
  'setup.testOk': '连接成功（HTTP {status}）',
  'setup.testNetworkFailed': '连接失败：服务地址无法访问（检查地址、网络或浏览器 CORS 限制）',
  'setup.testOffline': '连接失败：服务地址不可达',
  'setup.testHttpFailed': '连接失败：服务端返回 HTTP {status}',
  /** `{status}`'s stand-in when no response arrived at all (the client fills it in). */
  'setup.statusUnknown': '未知状态',
  'setup.saved': '已保存',

  /* ── home: the session list ─────────────────────────────────────────────── */
  'home.newSession': '新建会话',
  'home.creating': '创建中…',
  'home.empty': '还没有会话。先到「设置」填写 API 配置，然后新建一个会话。',
  'home.noMessages': '暂无消息',
  'home.hasMessages': '已有消息',
  /**
   * A new session's stored title (`db/repository.ts`). It is PERSISTED DATA, so it
   * is written once in whatever language was active at creation time and does not
   * follow a later language switch; M1's title editor / auto-naming replaces it.
   */
  'home.defaultSessionTitle': '新会话',

  /* ── play: the transcript screen ────────────────────────────────────────── */
  'play.backToList': '← 返回会话列表',
  'play.generating': '正在生成…',
  'play.composerLabel': '输入你的行动或台词',
  'play.composerPlaceholder': '例如：我推开门，走进昏暗的酒馆。',
  'play.send': '发送',
  'play.stop': '停止',

  /* ── error: what a failed turn shows ────────────────────────────────────── */
  /*
   * THE FIRST SIX KEYS MIRROR `LLM_ERROR_CODES` (packages/providers/
   * openai-compatible.ts) as camelCase: `auth`, `rate_limit` -> `error.rateLimit`,
   * `network`, `content_filter`, `invalid_request`, `invalid_response`. ADR-019
   * exists so the UI picks the sentence from the stable code and never parses the
   * adapter's English message, so the code is what selects one of these; a renamed
   * code must fail in the UI's code→key table, not silently fall through to
   * `error.unknown`.
   */
  'error.auth': 'API Key 被拒绝，请在「设置」中检查',
  'error.rateLimit': '请求过于频繁，请稍后重试',
  'error.network': '无法连接到服务，请检查地址与网络',
  'error.contentFilter': '请求被内容审核拦截',
  'error.invalidRequest': '请求被服务端拒绝，请检查模型名',
  'error.invalidResponse': '服务端返回了无法解析的内容',
  /** The catch-all: any code the UI does not know, including its own `'unknown'`. */
  'error.unknown': '发生未知错误',
  /*
   * THE THREE KEYS BELOW ARE NOT SHOWN BY TODAY'S BANNER. They are the sentences
   * `state/chat-store.ts` puts in `ChatError.message`, the field ADR-019 (docs/02
   * §8.4) keeps for logs: the banner renders `errorLabel(code)`, i.e. the keys above.
   * They are catalogued because the lint rule bans bare CJK text anywhere under
   * `apps/*\/src`, and because they become visible the moment `ChatError` grows a
   * code for "not configured yet" instead of folding it into `'unknown'` — which is
   * what a reader of that code would expect the banner to do.
   */
  'error.notInitialized': '应用尚未完成初始化',
  'error.notConfigured': '请先在「设置」中填写服务地址与模型名',
  'error.localFailure': '未知的本地错误',
};

/** Every key that must exist in every catalog, derived from the source of truth. */
export type MessageKey = keyof typeof zhCN;

/** The shape of a catalog: exactly the zh-CN keys, every one a non-empty string. */
export type Messages = Record<MessageKey, string>;

/**
 * en — annotated `Messages`, so this object is checked against `zhCN` key by key
 * (see the header). Copy is written as UI English, not as a gloss of the Chinese:
 * a translated interface should read as if it were written in that language.
 */
export const en: Messages = {
  /* ── common ─────────────────────────────────────────────────────────────── */
  'common.appName': 'SmartTavern',
  'common.save': 'Save',
  'common.retry': 'Retry',
  'common.close': 'Close',

  /* ── nav ────────────────────────────────────────────────────────────────── */
  'nav.language': 'Language',
  'nav.settings': 'Settings',

  /* ── setup ──────────────────────────────────────────────────────────────── */
  'setup.loading': 'Loading settings…',
  'setup.baseUrlLabel': 'Endpoint (Base URL)',
  'setup.baseUrlPlaceholder': 'https://api.deepseek.com/v1',
  'setup.baseUrlRequired': 'Enter an endpoint',
  'setup.baseUrlInvalid': 'The endpoint must be an http(s) URL',
  'setup.apiKeyLabel': 'API Key',
  'setup.apiKeyHint':
    'Leave empty for a local Ollama / vLLM. The key is stored only in the database on this device.',
  'setup.modelLabel': 'Model name',
  'setup.modelPlaceholder': 'deepseek-chat',
  'setup.modelRequired': 'Enter a model name',
  'setup.testConnection': 'Test connection',
  'setup.testing': 'Testing…',
  'setup.testOk': 'Connected (HTTP {status})',
  'setup.testNetworkFailed':
    'Connection failed: the endpoint could not be reached. Check the address, the network and browser CORS.',
  'setup.testOffline': 'Connection failed: the endpoint did not answer',
  'setup.testHttpFailed': 'Connection failed: the server answered HTTP {status}',
  'setup.statusUnknown': 'unknown status',
  'setup.saved': 'Saved',

  /* ── home ───────────────────────────────────────────────────────────────── */
  'home.newSession': 'New session',
  'home.creating': 'Creating…',
  'home.empty':
    'No sessions yet. Fill in the API configuration under Settings, then create a session.',
  'home.noMessages': 'No messages',
  'home.hasMessages': 'Has messages',
  'home.defaultSessionTitle': 'New session',

  /* ── play ───────────────────────────────────────────────────────────────── */
  'play.backToList': '← Back to sessions',
  'play.generating': 'Generating…',
  'play.composerLabel': 'Type your action or line',
  'play.composerPlaceholder': 'For example: I push the door open and step into the dim tavern.',
  'play.send': 'Send',
  'play.stop': 'Stop',

  /* ── error ──────────────────────────────────────────────────────────────── */
  'error.auth': 'The API key was rejected. Check it in Settings.',
  'error.rateLimit': 'Too many requests. Try again in a moment.',
  'error.network': 'Cannot reach the service. Check the address and the network.',
  'error.contentFilter': 'The request was blocked by content moderation.',
  'error.invalidRequest': 'The server rejected the request. Check the model name.',
  'error.invalidResponse': 'The server returned a response we cannot read.',
  'error.unknown': 'An unknown error occurred.',
  'error.notInitialized': 'The app has not finished starting up.',
  'error.notConfigured': 'Enter the endpoint and model name in Settings first.',
  'error.localFailure': 'Unknown local error.',
};

/**
 * The catalogs by locale. Typed `Record<Locale, Messages>` so a new entry in
 * `LOCALES` without a catalog here is a compile error rather than a runtime
 * `undefined` in the middle of a render.
 */
export const CATALOGS: Readonly<Record<Locale, Messages>> = {
  'zh-CN': zhCN,
  en,
};
