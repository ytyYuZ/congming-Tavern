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

  /* ── setup: the BYO-Key screen, then the appearance section (M1-G2) ──────── */
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
  /*
   * THE APPEARANCE SECTION (M1-G2) — the theme / font-size / message-width controls
   * that share the setup screen with the BYO-Key form.
   *
   * WHY `setup.` AND NOT AN `appearance.` AREA: the catalog's areas are a pinned list in
   * order (`catalog.test.ts`), and a new area is a change to that test and to every
   * `grep` a translator runs — for eight keys describing one screen. The keys are named
   * after the screen they are on; they can move to their own area the day appearance
   * gets a screen of its own.
   */
  'setup.appearanceTitle': '外观',
  'setup.themeLabel': '主题',
  /** The documented default: follow the operating system (`appearance/appearance.ts`). */
  'setup.themeSystem': '跟随系统',
  'setup.themeLight': '亮色',
  'setup.themeDark': '暗色',
  'setup.fontScaleLabel': '字号',
  'setup.messageWidthLabel': '消息宽度',
  /**
   * The readout beside both sliders. `{percent}` is the value as a percentage, which is
   * the unit the settings are stored and shown in (a multiplier `1.15` reads as `115%`).
   */
  'setup.percentValue': '{percent}%',
  /*
   * THE MODEL LIST (M1-G3) — the endpoint's own `GET /models` answer, offered beside the
   * free-text model field.
   *
   * WHY THE SENTENCES ARE SEPARATED BY OUTCOME: an unreachable endpoint, an HTTP error
   * and an EMPTY list are three different facts about three different fixes, and the one
   * thing a picker must not do is imply "no models exist" when it means "I could not ask"
   * (`chat/providers.ts` records the whole argument). `setup.modelSavedMissing` is the
   * decision this feature had to make — the saved model is KEPT and flagged rather than
   * replaced, because the string is pinned by session history and a `/models` list is not
   * authoritative — so its wording says "kept" explicitly.
   */
  'setup.modelsFetch': '获取模型列表',
  'setup.modelsFetching': '获取中…',
  'setup.modelsLoaded': '已获取 {count} 个模型',
  'setup.modelsEmpty': '服务端返回了空列表；模型名仍可手动填写',
  'setup.modelsUnreachable': '无法获取模型列表：服务地址不可达',
  'setup.modelsHttpFailed': '无法获取模型列表：服务端返回 HTTP {status}',
  'setup.modelChoicesLabel': '列表中的模型',
  'setup.modelSavedMissing': '当前保存的模型不在该列表中，已保留',
  'setup.modelsTruncated': '列表较长，只显示前 {shown} 个（共 {total} 个）；也可以直接输入模型名',
  /*
   * THE LOCAL KEY ENCRYPTION SECTION (M1-G3) — the passphrase flow.
   *
   * The policy these sentences state is decided in `apps/web/src/secrets/provider-secret.ts`:
   * the passphrase is asked for when a key must be read or sealed and never in the
   * background; cancelling changes nothing (a plaintext row stays plaintext, an envelope
   * stays locked); a wrong passphrase is retryable and does not touch the stored row; and
   * it is never cached, so a reload locks again. Every sentence below is that policy said
   * to a person — `setup.passphraseHint` is the one that must not be dropped, because
   * "forget it and the key is gone" is the fact a user has to know BEFORE typing one.
   */
  'setup.secretTitle': '本地密钥加密',
  'setup.secretNone': '尚未保存密钥。',
  'setup.secretPlaintext': '密钥目前以明文保存在本机数据库中。设置口令后将以 WebCrypto 加密存储。',
  'setup.secretLocked': '密钥已加密并处于锁定状态：解锁后才能发送请求。',
  'setup.secretUnlocked': '密钥已加密存储，并在本标签页内解锁；刷新页面后需要重新解锁。',
  'setup.passphraseLabel': '口令',
  'setup.passphrasePlaceholder': '至少 8 个字符',
  'setup.passphraseHint':
    '口令不会被保存，刷新页面后需要重新输入。忘记口令后无法恢复密钥，只能在下面重新填写密钥。',
  'setup.passphraseSeal': '加密保存',
  'setup.passphraseUnlock': '解锁',
  'setup.passphraseLock': '锁定',
  'setup.passphraseTooShort': '口令至少需要 8 个字符',
  'setup.passphraseWrong': '口令不正确，密钥无法解密；存储内容未做任何修改',
  'setup.passphraseUnavailable': '当前环境不支持 WebCrypto（需要安全上下文），无法加密',
  'setup.secretNoSession': '当前标签页没有已解锁的口令',
  'setup.secretUnreadable': '存储的密钥无法识别，请重新填写密钥',
  'setup.secretStorageFailed': '保存失败，密钥未被修改',

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
  /**
   * The persistent world clock (M1-T1). `{date}` is the time engine's own
   * `renderParts` output — `纪元 1 一月 1 06:30` — and `{segment}` the day-part name
   * from the world's calendar (`晨`/`昼`/`昏`/`夜`). Those two are WORLD CONTENT and
   * deliberately do NOT translate with this key; only the words and punctuation
   * around them are interface copy (ADR-030). The two locales genuinely differ here
   * — word order and brackets — which is why the sentence cannot be assembled by the
   * engine or by the app without a catalog.
   */
  'play.clock': '当前 {date}（{segment}）',
  /** The same clock for a calendar that names no day-parts (`Calendar.segments: []`). */
  'play.clockNoSegment': '当前 {date}',
  /** The clock readout's accessible name; a screen reader reads this, not the `·`. */
  'play.clockLabel': '世界时钟',
  /*
   * MANUAL TIME ADVANCE (M1-T2) — the controls beside the clock.
   *
   * WHY THE ADVANCE LIVES ON THE PLAY SCREEN AND NOT IN THE ENGINE: the engine's
   * `advance()` is a pure minute mapper, and docs/02 §5.7's advance POLICY —
   * `timeRhythm`'s implicit every-N-turns step, and the AI `advance_time` request's
   * auto / ask / deny choice with its "over one day forces ask" rule — is a decision
   * about WHO may move the clock. That is an approval question, so it belongs to the
   * approval UI and not to a function that cannot ask a human. The buttons below are
   * therefore the WHOLE policy of this build: the user pressed a button.
   *
   * WHY 「+1 时段」 AND NOT A FIXED MINUTE COUNT: a day segment is the world's own
   * authored stretch of the day, so the control moves to the next segment BOUNDARY
   * (`chat/clock.ts`'s `segmentStep`) rather than by a number the catalog would freeze.
   * The custom amount is the escape hatch that needs no calendar at all.
   */
  'play.advanceTitle': '推进时间',
  'play.advanceSegment': '+1 时段',
  'play.advanceHour': '+1 小时',
  'play.advanceDay': '+1 天',
  'play.advanceCustomLabel': '自定义（分钟）',
  /** An EXAMPLE amount, not copy — deliberately the same in both locales. */
  'play.advanceCustomPlaceholder': '例如 90，或 -30 往前回拨',
  'play.advanceCustom': '推进',
  /** `{minutes}` is what was moved and `{date}` the clock's own sentence afterwards. */
  'play.advanceDone': '已推进 {minutes} 分钟：{date}',
  /** A custom amount that is not a usable whole number of minutes; nothing was written. */
  'play.advanceInvalid': '请输入整数分钟数',
  /*
   * FIXED-POINT SAVES (M1-M1, M1-T4) — the checkpoint panel.
   *
   * `play.checkpointHint` is the sentence that must not be dropped: restoring DISCARDS
   * the current live position, so the user has to know that it is a deliberate act and
   * what it does NOT do. It does not delete messages (ADR-010 — messages are immutable,
   * and a rollback is a pointer move, so the branch that was live a moment ago is still
   * stored) and it does not touch the world / character / preset pins (a save point is a
   * position in a scene, not a different build of the content). The panel's restore
   * button therefore asks for a confirmation before it writes anything.
   */
  'play.checkpointTitle': '定点存档',
  'play.checkpointHint':
    '存档会记下当前的消息位置、时钟、变量与卡司状态。读档会把会话整体回滚到那一刻：不会删除任何消息，也不会改变世界、角色与预设的绑定。',
  'play.checkpointLabelPlaceholder': '存档名称，例如：进城前',
  'play.checkpointSave': '保存存档点',
  'play.checkpointEmpty': '还没有存档点。',
  'play.checkpointSaved': '已保存存档点',
  'play.checkpointRestored': '已读档回滚到该存档点',
  /** The first step of a two-step restore; it writes nothing on its own. */
  'play.checkpointRestore': '读档',
  /** The second step, shown only after 「读档」 was pressed. */
  'play.checkpointRestoreConfirm': '确认回滚',
  'play.checkpointDelete': '删除',
  /** The second step of a delete, shown only after 「删除」 was pressed. */
  'play.checkpointDeleteConfirm': '确认删除',
  /*
   * THE STATUS BAR (M1-S6, ADR-031) — the open session's free variables.
   *
   * WHY THE HINT NAMES THE MACROS: this panel is the HUMAN half of the variable system, and
   * the same table is what `{{getvar}}` reads and `{{setvar}}` / `{{addvar}}` write
   * (ADR-031). A user who can read the macro names can connect the two without a manual.
   *
   * WHY THE DOUBLE BRACES SURVIVE `t(...)`: `translate.ts` fills `{name}` from the
   * params it is given, and this sentence is rendered with NO params, so the macro names
   * are documented verbatim. They are the macro language being named, not placeholders.
   *
   * A save point taken before the first message needs no sentence any more: `messageId` is
   * nullable (a checkpoint mirrors `Session.headMessageId`), so the act is simply allowed.
   */
  'play.variablesTitle': '状态栏',
  'play.variablesHint':
    '会话级自由变量：{{getvar}} 读取它，{{setvar}} 赋值、{{addvar}} 做增量；布尔值写 true 或 false。',
  'play.variablesEmpty': '还没有变量。',
  'play.variableNameLabel': '变量名',
  /** An EXAMPLE name, not copy — the value the user replaces. */
  'play.variableNamePlaceholder': '变量名，例如 hp',
  'play.variableKindLabel': '类型',
  'play.variableKindString': '文本',
  'play.variableKindNumber': '数值',
  'play.variableKindBoolean': '布尔',
  'play.variableValueLabel': '值',
  /** An EXAMPLE value per kind — data the user replaces, not interface copy. */
  'play.variableValuePlaceholder': '值，例如 10、暴雪 或 true',
  'play.variableAdd': '添加变量',
  'play.variableDelete': '删除',
  'play.variableSaved': '已保存变量',
  'play.variableAdded': '已添加变量',
  /** Text the chosen kind cannot hold (a non-number for 数值, or a blank name). */
  'play.variableInvalid': '请输入该类型的一个有效值',

  /*
   * THE MESSAGE-STREAM CONTROLS (M1-S2) — one label per act on a message.
   *
   * WHY THE BRANCH SWITCHER SAYS 「第 1 / 2 条」 AND NOT AN ARROW ONLY: an arrow pair with
   * no count is a control that cannot tell the user whether a second answer EXISTS, which
   * is the one thing this feature is about (docs/02 §7: 重生成（同父多子）). The count is
   * also the acceptance made visible: after a regenerate there are two answers to the same
   * prompt, and the sentence says so before anything is clicked.
   */
  'play.siblingCounter': '第 {position} / {total} 条',
  'play.siblingPrevious': '上一条',
  'play.siblingNext': '下一条',
  /** The switcher's accessible name: the buttons are read aloud with it, the count is not. */
  'play.siblingLabel': '本轮的多个回答',
  'play.continue': '继续写',
  'play.regenerate': '重新生成',
  'play.edit': '编辑',
  'play.editSave': '保存修改',
  'play.editCancel': '取消',
  'play.delete': '删除',
  /**
   * The delete button's ACCESSIBLE name: `{target}` is the message's own text, so a screen
   * reader says which row the destructive control belongs to. The visible label stays short
   * (`play.delete`), because a full sentence on every row would bury the text it acts on.
   */
  'play.deleteLabel': '删除：{target}',
  /**
   * The delete's second step. A message delete is NOT recoverable (unlike a regenerate,
   * which only adds a sibling), so it takes the save-point panel's two-step shape.
   */
  'play.deleteConfirm': '确认删除',
  /**
   * WHY THE DELETE OF A NODE WITH REPLIES IS A REFUSAL AND NOT A CASCADE: the tree records
   * what was generated from what (docs/02 §7), so deleting a middle node would either orphan
   * its replies or silently re-parent them. The sentence names the way forward — delete the
   * replies (or the branch point) first — instead of destroying them under one click.
   */
  'play.deleteRefused': '这条消息后面还有内容，请先删除它之后的消息',
  /*
   * 继续写 refusals. Three DIFFERENT facts, so three sentences: an empty transcript, a head
   * the user themselves wrote, and a turn already in flight. Collapsing them into one
   * message ("cannot continue") would leave the user unable to tell which control to reach
   * for instead — the composer, or 「停止」.
   */
  'play.nothingToContinue': '还没有可续写的内容',
  'play.continueNeedsAssistant': '只能在角色发言之后续写',
  /** An edit that the store refused — a message that left the active branch meanwhile. */
  'play.editFailed': '未能保存这条修改，请刷新后重试',

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
  /*
   * THE ONE KEY BELOW IS SHOWN, unlike the three above it. `{detail}` is the
   * composer's own numbers (`engine/prompt/budget.ts` reports the shortfall, the
   * limit and the levers), and the sentence exists because an over-budget assembly
   * must be explained instead of sent: docs/02 §5.1 requires 明确报错并给出建议, and a
   * banner saying only "something failed" would hide the one fact — by how much —
   * that tells the user what to change.
   */
  'error.promptBudget': '本次请求超出模型上下文预算，未能发送。{detail}',
  /*
   * SHOWN, and the reason it exists at all (M1-G3): once the key is encrypted at rest,
   * "the key is refused" and "the key is present but this tab has not unlocked it" become
   * different failures with different fixes. Reporting the second as the first would be a
   * lie the user cannot act on — the provider's own 401 would say the key is wrong when it
   * is simply still locked (`state/chat-store.ts` picks this code before it builds a
   * request, so nothing is sent).
   */
  'error.keyLocked': '密钥已加密且处于锁定状态，请到「设置」解锁后再发送',
  /*
   * SHOWN (M1-S2). A regenerate / edit / continue names a message the user could see a
   * moment ago; another tab — or a save-point rollback — can move the branch in between.
   * The sentence says what happened and what fixes it, because "发生未知错误" would report
   * an ordinary stale click as an app fault.
   */
  'error.messageMissing': '这条消息已不在当前分支上，请刷新后重试',
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

  /* ── the appearance section (M1-G2), in the order the controls appear ───── */
  'setup.appearanceTitle': 'Appearance',
  'setup.themeLabel': 'Theme',
  'setup.themeSystem': 'Match system',
  'setup.themeLight': 'Light',
  'setup.themeDark': 'Dark',
  'setup.fontScaleLabel': 'Text size',
  'setup.messageWidthLabel': 'Message width',
  'setup.percentValue': '{percent}%',

  /* ── the model list, then the key encryption section (M1-G3) ────────────── */
  'setup.modelsFetch': 'Fetch models',
  'setup.modelsFetching': 'Fetching…',
  'setup.modelsLoaded': 'Fetched {count} models',
  'setup.modelsEmpty': 'The server returned an empty list. You can still type a model name.',
  'setup.modelsUnreachable': 'Could not fetch the model list: the endpoint did not answer',
  'setup.modelsHttpFailed': 'Could not fetch the model list: the server answered HTTP {status}',
  'setup.modelChoicesLabel': 'Models in the list',
  'setup.modelSavedMissing': 'The saved model is not in that list; it has been kept',
  'setup.modelsTruncated':
    'Long list: showing the first {shown} of {total}. You can also type a model name.',
  'setup.secretTitle': 'Local key encryption',
  'setup.secretNone': 'No key is stored yet.',
  'setup.secretPlaintext':
    'The key is currently stored in plain text in this device database. Set a passphrase to store it encrypted with WebCrypto.',
  'setup.secretLocked': 'The key is encrypted and locked. Unlock it before sending a request.',
  'setup.secretUnlocked':
    'The key is stored encrypted and unlocked in this tab; you will need to unlock again after a reload.',
  'setup.passphraseLabel': 'Passphrase',
  'setup.passphrasePlaceholder': 'At least 8 characters',
  'setup.passphraseHint':
    'The passphrase is not saved, so you will be asked for it again after a reload. If you forget it the key cannot be recovered — enter a new key below instead.',
  'setup.passphraseSeal': 'Encrypt',
  'setup.passphraseUnlock': 'Unlock',
  'setup.passphraseLock': 'Lock',
  'setup.passphraseTooShort': 'A passphrase needs at least 8 characters',
  'setup.passphraseWrong':
    'Wrong passphrase: the key could not be decrypted. Nothing stored was changed.',
  'setup.passphraseUnavailable':
    'This environment has no WebCrypto (a secure context is required), so it cannot encrypt',
  'setup.secretNoSession': 'No passphrase is unlocked in this tab',
  'setup.secretUnreadable': 'The stored key is not readable; enter the key again',
  'setup.secretStorageFailed': 'The save failed; the key was not changed',

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
  'play.clock': 'Now {date} ({segment})',
  'play.clockNoSegment': 'Now {date}',
  'play.clockLabel': 'World clock',
  'play.advanceTitle': 'Advance time',
  'play.advanceSegment': '+1 segment',
  'play.advanceHour': '+1 hour',
  'play.advanceDay': '+1 day',
  'play.advanceCustomLabel': 'Custom (minutes)',
  'play.advanceCustomPlaceholder': 'for example 90, or -30 to turn it back',
  'play.advanceCustom': 'Advance',
  'play.advanceDone': 'Advanced {minutes} minutes: {date}',
  'play.advanceInvalid': 'Enter a whole number of minutes',
  'play.checkpointTitle': 'Save points',
  'play.checkpointHint':
    'A save point records the current message position, clock, variables and cast state. Loading one rolls the whole session back to that moment: it deletes no messages and changes no world, character or preset binding.',
  'play.checkpointLabelPlaceholder': 'Save-point name, e.g. before entering the town',
  'play.checkpointSave': 'Save a save point',
  'play.checkpointEmpty': 'No save points yet.',
  'play.checkpointSaved': 'Save point stored',
  'play.checkpointRestored': 'Rolled back to that save point',
  'play.checkpointRestore': 'Load',
  'play.checkpointRestoreConfirm': 'Confirm rollback',
  'play.checkpointDelete': 'Delete',
  'play.checkpointDeleteConfirm': 'Confirm delete',
  'play.variablesTitle': 'Status bar',
  'play.variablesHint':
    'Session-scoped free variables: {{getvar}} reads one, {{setvar}} assigns and {{addvar}} increments; a boolean is written true or false.',
  'play.variablesEmpty': 'No variables yet.',
  'play.variableNameLabel': 'Variable name',
  'play.variableNamePlaceholder': 'Variable name, e.g. hp',
  'play.variableKindLabel': 'Type',
  'play.variableKindString': 'Text',
  'play.variableKindNumber': 'Number',
  'play.variableKindBoolean': 'Boolean',
  'play.variableValueLabel': 'Value',
  'play.variableValuePlaceholder': 'A value, e.g. 10, snow or true',
  'play.variableAdd': 'Add variable',
  'play.variableDelete': 'Delete',
  'play.variableSaved': 'Variable saved',
  'play.variableAdded': 'Variable added',
  'play.variableInvalid': 'Enter a valid value for that type',
  'play.siblingCounter': 'Answer {position} of {total}',
  'play.siblingPrevious': 'Previous',
  'play.siblingNext': 'Next',
  'play.siblingLabel': 'The answers to this turn',
  'play.continue': 'Continue',
  'play.regenerate': 'Regenerate',
  'play.edit': 'Edit',
  'play.editSave': 'Save changes',
  'play.editCancel': 'Cancel',
  'play.delete': 'Delete',
  'play.deleteLabel': 'Delete: {target}',
  'play.deleteConfirm': 'Confirm delete',
  'play.deleteRefused': 'There is more after this message. Delete what follows it first.',
  'play.nothingToContinue': 'There is nothing to continue yet',
  'play.continueNeedsAssistant': 'You can continue only after a character has spoken',
  'play.editFailed': 'That change was not saved. Refresh and try again.',

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
  'error.promptBudget': 'This request is over the model budget, so it was not sent. {detail}',
  'error.keyLocked': 'The key is encrypted and locked. Unlock it in Settings before sending.',
  'error.messageMissing': 'That message is no longer on the active branch. Refresh and try again.',
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
