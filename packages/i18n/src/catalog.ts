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
  /*
   * THE CARD EDITORS' SHARED CHROME (M1-W1 / M1-C1).
   *
   * WHY THESE ARE `common.` AND NOT `world.` / `character.`: both editors are one design — a
   * grouped form, a list control per collection, an autosaved draft and an explicit publish —
   * so their chrome is the same sentences twice otherwise. The AREA still means what it always
   * meant ("copy that recurs across screens"); what recurs here is one feature's vocabulary
   * across the two screens that implement it. The FIELD labels stay in `world.` / `character.`,
   * because those really are two different sets.
   */
  'common.loading': '正在读取…',
  'common.addItem': '添加',
  'common.removeItem': '删除',
  'common.moveUp': '上移',
  'common.moveDown': '下移',
  /** The line-oriented list controls: one item per line in a single textarea. */
  'common.onePerLine': '每行一项',
  'common.emptyList': '暂无条目',
  'common.updatedAt': '更新于 {date}',
  'common.versionLabel': 'v{version}',
  /*
   * THE DRAFT RULE, SAID OUT LOUD (ADR-010).
   *
   * A published version is immutable, so autosave cannot be a version write: the editor edits a
   * DRAFT, autosave persists that draft, and a new version is created by the explicit 「发布新版本」
   * act (`state/content-store.ts`). The user has to know that, or the button looks redundant
   * ("it already saved") — which is exactly the bug the split exists to prevent.
   */
  'common.unsavedDraft': '编辑的是草稿：自动保存只写草稿，点「发布新版本」才会生成新的版本。',
  'common.draftBase': '草稿基于 v{base}；发布后成为 v{next}。',
  'common.draftFailed': '草稿保存失败（{name}）',
  'common.publish': '发布新版本',
  'common.discardDraft': '放弃草稿',
  'common.published': '已发布 v{version}',
  'common.discarded': '已放弃草稿，恢复为已发布的版本',
  'common.publishRefused': '存在校验问题，未发布新版本',
  'common.publishFailed': '发布失败，未写入新版本',
  /*
   * VALIDATION IS SCHEMA-FIRST. `{field}` is the label of the field the problem belongs to (the
   * dotted path when the form has no label for it) and `{detail}` is the schema's or the time
   * engine's own sentence, kept verbatim: "toHour must be a whole hour index in 0..24" says
   * something a paraphrase would lose (ADR-019's split — the fact is the field, the prose is the
   * detail).
   */
  'common.issuesTitle': '校验',
  'common.issuesNone': '没有校验问题，可以发布。',
  'common.issue': '{field}：{detail}',
  /*
   * 自定义字段 (docs/01 §F2-1 「含自定义字段增删」) live in the card's OWN `customFields` record
   * (`docs/02` §4), where the key is the label the user typed — no key minting, no slug. They are
   * deliberately NOT in `extensions`: that bag is the plugin namespace, and a reader of `x-*` keys
   * must not find the author's own notes among them. Renaming is remove-and-add because the key IS
   * the field's identity (`cards/custom-fields.ts` records the whole rule).
   */
  'common.customFieldsTitle': '自定义字段',
  'common.customFieldsHint':
    '自定义字段保存在卡片数据的 customFields 里，字段名就是键，所以改名等于删除后重新添加。',
  'common.customFieldNameLabel': '字段名',
  'common.customFieldValueLabel': '字段值',
  'common.customFieldAdd': '添加字段',
  'common.customFieldEmpty': '还没有自定义字段。',
  'common.customFieldRefused': '字段名不能为空，且不能与已有字段重名',

  /* ── nav: the shell's navigation ─────────────────────────────────────────── */
  /**
   * The language picker's label (`<select aria-label={t('nav.language')}>`). It is
   * the ONE key added ahead of its consumer: M1-G1's acceptance criterion is
   * "switching the language takes effect across the UI", and the switch itself needs a
   * name. The options come from `LOCALE_LABELS`, not from here.
   */
  'nav.language': '语言',
  'nav.settings': '设置',
  /** The two card libraries (M1-W1 / M1-C1), reachable from every screen. */
  'nav.worlds': '世界',
  'nav.characters': '角色',

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
  'home.empty': '还没有会话。先到「设置」填写 API 配置，然后新建一个会话。',
  'home.noMessages': '暂无消息',
  'home.hasMessages': '已有消息',
  /**
   * A new session's stored title (`db/repository.ts`). It is PERSISTED DATA, so it
   * is written once in whatever language was active at creation time and does not
   * follow a later language switch; M1's title editor / auto-naming replaces it.
   */
  'home.defaultSessionTitle': '新会话',

  /* ── session: creating one (M1-S1, docs/01 §5.4 开局步骤 1–6) ─────────────── */
  /*
   * WHY THIS IS ITS OWN AREA AND NOT MORE `home.`: the list on `/` and the form on
   * `/sessions/new` are two screens. The form's vocabulary — a version, a cast, an initial
   * clock — is not the list's, and `home.creating` moved here with the button it labels:
   * the list only links to the form, so the form is what can be in the middle of creating.
   *
   * WHY THE FIVE REFUSALS ARE WHOLE SENTENCES AND NOT `common.issue`'s `{field}：{detail}`:
   * that shape is the card editors' schema-first report of a MALFORMED field, while these say
   * which CHOICE is missing (a world, a card, a player) or that the chosen clock is not a
   * minute. There is no schema path to name in either case.
   */
  'session.title': '新建会话',
  'session.backToHome': '← 返回会话列表',
  'session.hint':
    '选择世界版本与参与的角色卡；指定其中一张为玩家角色，其余自动组成卡司。身份属于会话而不属于角色卡，所以同一张卡可以在不同会话里扮演不同身份。',
  'session.worldLabel': '世界卡',
  'session.worldPlaceholder': '请选择世界卡',
  'session.worldEmpty': '还没有世界卡。先到「世界」新建一张，再回来创建会话。',
  'session.worldVersionLabel': '世界版本',
  'session.pinning': '本次会话固定 v{version}（该世界最新版本为 v{latest}）。',
  'session.cardsLabel': '参与的角色卡',
  'session.cardsEmpty': '还没有角色卡。先到「角色」新建一张，再回来创建会话。',
  'session.playerLabel': '玩家角色',
  'session.playerHint': '你操控的那一张。其余勾选的卡自动成为卡司，由 AI 扮演。',
  /** The radio's accessible name: the visible label repeats on every row, so it names WHICH card. */
  'session.playerOf': '将「{name}」指定为玩家角色',
  'session.castLabel': '卡司（自动生成）',
  'session.castEmpty': '卡司为空：本次只有你扮演的角色登场。',
  'session.presetLabel': 'Prompt 预设',
  'session.presetHint': '目前只有内置预设：还不能新建或导入预设，所以这里没有可选项。',
  'session.rulePackLabel': '规则包',
  'session.rulePackNone': '尚未提供规则包，本次会话不绑定规则包。',
  'session.clockLabel': '初始时钟（自历法纪元起的分钟数）',
  'session.clockHint': '默认取所选世界版本的起始时刻（{minute} 分钟）；留空即使用默认值。',
  'session.create': '创建会话',
  'session.creating': '创建中…',
  'session.createFailed': '创建失败，没有写入会话',
  'session.worldRequired': '请选择一个世界卡及其版本',
  'session.cardsRequired': '请至少勾选一张角色卡',
  'session.playerRequired': '请指定一张角色卡作为玩家角色',
  'session.playerNotChosen': '指定的玩家角色不在已勾选的角色卡中',
  'session.clockInvalid': '初始时钟必须是整数分钟',

  /* ── world: the world-card library and editor (M1-W1) ───────────────────── */
  'world.libraryTitle': '世界卡库',
  'world.libraryHint': '世界卡保存设定与历法；会话创建时选择一个具体版本。',
  'world.empty': '还没有世界卡。',
  'world.createLabel': '新世界的名称',
  /** An EXAMPLE name, not copy. */
  'world.createPlaceholder': '例如：霜月群岛',
  'world.create': '新建世界卡',
  'world.backToLibrary': '← 返回世界卡库',
  /** The persisted lineage sentence of a version published from this editor. */
  'world.lineageReason': '由世界卡编辑器发布',
  'world.sectionBasic': '基本',
  'world.sectionRegions': '地区',
  'world.sectionFactions': '势力',
  'world.sectionRules': '规则',
  'world.sectionNarrative': '叙事',
  'world.sectionCalendar': '历法与时间',
  'world.sectionRhythm': '时间节奏',
  'world.sectionOpening': '开场',
  'world.nameLabel': '名称',
  'world.premiseLabel': '一句话设定',
  'world.eraLabel': '时代背景',
  'world.techOrMagicLabel': '科技或魔法水平',
  'world.genreLabel': '题材标签',
  'world.regionsLabel': '地区列表',
  'world.regionIdLabel': '地区标识',
  'world.regionNameLabel': '地区名称',
  'world.regionDescriptionLabel': '地区描述',
  'world.regionParentLabel': '上级地区标识',
  'world.regionTagsLabel': '地区标签',
  'world.factionsLabel': '势力列表',
  'world.factionIdLabel': '势力标识',
  'world.factionNameLabel': '势力名称',
  'world.factionDescriptionLabel': '势力描述',
  'world.factionStanceLabel': '立场',
  'world.factionGoalsLabel': '目标',
  'world.powerSourceLabel': '力量来源',
  'world.limitsLabel': '限制与代价',
  'world.taboosLabel': '禁忌',
  'world.conflictLabel': '核心冲突',
  'world.toneLabel': '情绪基调',
  'world.themesLabel': '主题',
  'world.styleLabel': '叙事风格',
  'world.calendarIdLabel': '历法标识',
  'world.calendarNameLabel': '历法名称',
  'world.epochLabelLabel': '纪元前缀',
  /*
   * 历法与时间节奏 (docs/01 §F2-6, docs/02 §5.7). The hint is the one sentence of this block that
   * must not be dropped: the numbers below are DATA the time engine divides by, and a fantasy
   * calendar with a 26-hour day or a 100-minute hour is legal on purpose (ADR-012) — a user who
   * assumed 24/60 would "fix" a valid world.
   */
  'world.calendarHint':
    '历法是数据：一天的小时数与一小时的分钟数都可以不是 24/60。时段可以跨过午夜（结束小时小于起始小时是合法的）。',
  'world.minutesPerHourLabel': '每小时分钟数',
  'world.hoursPerDayLabel': '每天小时数',
  'world.weekdaysLabel': '星期名',
  'world.monthsLabel': '月份',
  'world.monthNameLabel': '月名',
  'world.monthDaysLabel': '天数',
  'world.segmentsLabel': '时段',
  'world.segmentIdLabel': '时段标识',
  'world.segmentNameLabel': '时段名',
  'world.segmentFromLabel': '起始小时',
  'world.segmentToLabel': '结束小时',
  'world.startMinuteLabel': '起始时刻（分钟）',
  'world.startMinuteHint': '从历法纪元起的分钟数，可以是负数。',
  'world.implicitAdvanceLabel': '每 N 轮自动推进时间',
  'world.advanceEveryTurnsLabel': '轮数（N）',
  'world.stepMinutesLabel': '每次推进（分钟）',
  'world.rhythmHint': '隐式推进默认关闭：关闭时，时间只在手动推进或读档回滚时移动。',
  'world.openingHooksLabel': '开场钩子',

  /* ── co-create: the AI co-creation panel (M1-W2) ────────────────────────── */
  /*
   * 对话 + 补丁提案 + 右侧实时预览 (docs/01 §5.2, docs/06 §2.2 M1-W2).
   *
   * WHY THIS IS AN AREA OF ITS OWN AND NOT MORE `world.` KEYS
   * The panel is about a WORLD CARD today, but nothing in it is about worlds: a conversation, a
   * patch proposal, an accept/reject pair and an undo are the same objects for the character
   * co-creation `M1-C2` asks for, and `docs/05` ADR-031 already records that the variable proposal
   * flow will reuse this accept/refuse pair. `world.` holds the CARD's fields; these sentences are
   * the PROPOSAL FLOW's, and a second caller is a certainty rather than a guess.
   *
   * WHY THE FINDINGS ARE SEPARATE KEYS AND NOT ONE SENTENCE
   * A model that answered prose and a model that answered four hundred operations are two different
   * problems with two different next moves ("ask again" versus "ask for fewer changes at once"), and
   * the author is the one who has to choose. `{detail}` is where a local fact goes — the schema path a
   * refused payload complained about.
   */
  'co-create.title': 'AI 共创',
  'co-create.show': '打开 AI 共创',
  'co-create.hide': '收起 AI 共创',
  'co-create.hint': '与 AI 讨论这张世界卡：它每次回答都会给出一份补丁提案，采纳与否由你决定。',
  'co-create.empty': '还没有对话。说出你想完善的方向，例如「补一个地区的设定」。',
  'co-create.inputLabel': '对 AI 说的话',
  'co-create.send': '发送',
  'co-create.thinking': '思考中…',
  'co-create.previewTitle': '实时预览',
  'co-create.previewHint': '下面是采纳这份提案后卡片的内容——预览用的就是要写进草稿的那份数据。',
  'co-create.noProposal': '当前没有待处理的提案。',
  'co-create.accept': '采纳',
  'co-create.reject': '否决',
  'co-create.undo': '撤销这次采纳',
  'co-create.undoHint': '撤销会把草稿恢复成采纳之前的样子。',
  'co-create.verbAdd': '新增',
  'co-create.verbRemove': '删除',
  'co-create.verbReplace': '修改',
  'co-create.opLine': '{op} {path}',
  /** `{detail}` is the schema path the refused payload complained about. */
  'co-create.refusedSchema': '这份提案会让卡片不合法（{detail}），没有应用。',
  'co-create.refusedOp': '这份提案里的「{op} {path}」无法应用，没有应用任何修改。',
  'co-create.notConfigured': '还没有配置模型服务，无法开始共创：请先在设置里填写服务地址与模型名。',
  /*
   * THE MALFORMED-ANSWER FINDINGS (docs/06 §2.2 M1-W2: the answer must be machine-readable, and an
   * answer that is not has to be reported rather than crash).
   *
   * WHY EACH ONE ENDS WITH THE MODEL'S OWN WORDS (`{detail}`)
   * "It was not a proposal" is not enough for the author to decide whether 「再试一次」 is worth
   * pressing: a model that answered prose about the world and a model that answered nothing at all are
   * two different situations. `{detail}` carries the answer VERBATIM — `state/co-create-store.ts` fills
   * it from `readProposal`'s refusal — while the sentence around it says which SHAPE was missing, which
   * is the half the author cannot see. The two halves are ONE message because a language that puts the
   * answer first cannot be assembled from concatenated fragments (`chat/providers.ts` records the same
   * rule for its connection notes).
   */
  'co-create.malformedNoJson':
    'AI 的回答里没有可解析的 JSON 提案。草稿没有变化，可以再试一次。\n\nAI 的回答：{detail}',
  'co-create.malformedNoOps':
    'AI 的回答缺少 ops 字段，无法作为提案。草稿没有变化，可以再试一次。\n\nAI 的回答：{detail}',
  'co-create.malformedNotAnOperation':
    'AI 的回答里有一条不是合法的补丁操作。草稿没有变化，可以再试一次。\n\nAI 的回答：{detail}',
  'co-create.malformedTooManyOps':
    'AI 一次给出了太多条改动。草稿没有变化，请让它分几次来。\n\nAI 的回答：{detail}',

  /*
   * ── co-create: 生成模式与字段级操作 (M1-W3 / M1-W4, docs/06 §2.5) ───────────
   *
   * WHY THE STEP NAMES ARE THEIR OWN KEYS RATHER THAN `world.` LABELS
   * A step is named for the GROUP of fields it writes (「世界设定」), and a group is not a field: the
   * form renders a label per control, and a step covering three of them has no single one to borrow.
   * The keys are listed in the plan's own order, so a reviewer can read the flow here.
   *
   * WHY THE SCOPE FINDINGS NAME A PATH (`{detail}`)
   * "The AI edited something else" is not actionable; 「它写了 /era」 is. The path is the model's own
   * pointer, quoted verbatim, because that is what the author would send back to it.
   */
  'co-create.generateTitle': '生成模式',
  'co-create.generateHint':
    '让 AI 按步骤把这张卡写出来：每个步骤单独请求一次，你逐步骤采纳或否决，草稿随之逐步长出来。',
  'co-create.generateStart': '从零生成',
  'co-create.generateNext': '生成下一步',
  'co-create.generateSkip': '跳过这一步',
  'co-create.generateStop': '停止生成',
  'co-create.generateStepOf': '第 {current} / {total} 步',
  'co-create.stepPremise': '一句话概要',
  'co-create.stepBasics': '世界设定',
  'co-create.stepPlaces': '地区',
  'co-create.stepPowers': '势力',
  'co-create.stepRules': '规则与禁忌',
  'co-create.stepNarrative': '叙事',
  'co-create.stepTelling': '题材、主题与开场',
  'co-create.stepField': '这个字段',
  /* The character's steps (docs/06 §2.3 M1-C2): the same plan machinery, a character's own order. */
  'co-create.stepIdentity': '身份与性格',
  'co-create.stepScenario': '场景与系统提示',
  'co-create.stepSpeech': '开场白与示例对话',
  'co-create.stepVoice': '发言档案',
  'co-create.stepLooks': '外貌与画风',
  'co-create.stepCredits': '作者与备注',
  'co-create.stepStatePending': '待生成',
  'co-create.stepStateAccepted': '已采纳',
  'co-create.stepStateRejected': '已否决',
  'co-create.stepStateSkipped': '已跳过',
  'co-create.nothingSelected': '还没有选择要生成的字段。勾选至少一个字段，再点「生成选中的字段」。',
  'co-create.noGeneration': '当前没有正在进行的生成流程。先点「从零生成」或「生成选中的字段」。',
  'co-create.generationBusy': '生成流程正在进行。先采纳、否决或停止当前步骤，再对单个字段操作。',
  'co-create.finishFirst': '还有一份提案没有处理。先采纳或否决它，再发起新的请求。',
  'co-create.genreFirst': '这张卡还只有名字：先在「题材」里写一两个词，AI 才知道要往哪个方向写。',
  'co-create.characterFirst':
    '这张角色卡还没有可依据的内容：先在「描述」「性格」或「场景」里写一两句，AI 才知道要生成什么样的角色。',
  'co-create.wrongCard': '共创面板当前打开的是另一种卡片。先切回对应的编辑器，再发起请求。',
  /** `{detail}` is the pointer the model tried to write. */
  'co-create.outOfScope':
    'AI 这次改动超出了本步骤的范围（它写了 {detail}），整份提案都没有应用。草稿没有变化。',

  /*
   * 字段级 AI 操作 (docs/06 §2.5 M1-W4): 选中字段 → 重写 / 扩写 / 精简.
   *
   * WHY THE THREE GESTURES ARE LABELS AND NOT A MENU
   * They are the three the milestone names, they take the same argument (one field), and each is one
   * clickable word. A `<select>` would hide two of them behind a second gesture for no gain.
   */
  'co-create.fieldTitle': '字段级 AI 操作',
  'co-create.fieldHint':
    '选择一个字段，让 AI 只改这一个字段：提案只会落在它上面，动到别处的提案会被直接拒绝。',
  'co-create.fieldSelectLabel': '选择字段',
  'co-create.fieldRewrite': '重写',
  'co-create.fieldExpand': '扩写',
  'co-create.fieldCondense': '精简',
  'co-create.fieldOpTitle': '{op}：{field}',
  'co-create.fieldSetStart': '生成选中的字段',
  'co-create.selectedTitle': '已选字段',

  /*
   * 发言档案自动评估 (docs/06 §2.3 M1-C3): 依据角色卡自身的内容评估发言档案，提案形式.
   *
   * WHY THE REASON SITS BESIDE THE BUTTON AND NOT IN THE CARD
   * 「生成欲望/能力值并给出理由」 asks for the reason to be READABLE; the card itself has no field for
   * an assessment argument, and writing one into `creator_notes` would put a transient opinion into
   * the author's own prose. So the reason is transcript copy, rendered while the proposal is pending.
   *
   * WHY TWO SENTENCES FOR "TOO THIN"
   * One is the LOCAL precondition (nothing to judge, no request sent) and the other is the MODEL's own
   * answer (`ops: []`): they are different facts, and merging them would tell an author whose card does
   * say something that it says nothing.
   */
  'co-create.voiceTitle': '发言档案评估',
  'co-create.voiceHint':
    '依据角色卡自身的内容（描述、性格、场景、开场白…）评估发言档案：AI 只给出可判断的字段，并说明理由。',
  'co-create.voiceEvaluate': '评估发言档案',
  'co-create.voiceWorldLabel': '依据哪个世界生成',
  'co-create.voiceWorldNone': '不指定世界',
  'co-create.voiceReasoning': '评估理由：{detail}',
  'co-create.voiceTooThin':
    '这张卡还没有可判断的内容：先写「描述」「性格」或「场景」，AI 才有依据评估发言档案。',
  'co-create.voiceNoSignal':
    'AI 认为这张卡还不足以判断发言欲望与能力，没有给出数值。先把角色的描述写得具体一些，再试一次。',

  /* ── character: the character-card library and editor (M1-C1) ────────────── */
  'character.libraryTitle': '角色卡库',
  'character.libraryHint': '角色卡兼容 SillyTavern V2/V3 字段，并保存发言档案与视觉档案。',
  'character.empty': '还没有角色卡。',
  'character.createLabel': '新角色的名称',
  /** An EXAMPLE name, not copy. */
  'character.createPlaceholder': '例如：银松镇的莉安',
  'character.create': '新建角色卡',
  'character.backToLibrary': '← 返回角色卡库',
  'character.lineageReason': '由角色卡编辑器发布',
  /*
   * WHY THIS HINT EXISTS (ADR-010, docs/01 §7.6 (1)): the card deliberately has no player/cast
   * field, and an ABSENT control is only legible if the screen says why. The same card plays the
   * protagonist in one session and the antagonist in the next, so identity is chosen when the
   * session is created — not here.
   */
  'character.identityHint':
    '身份由会话决定：同一张卡可以在一个会话里当玩家角色、在另一个会话里当配角，所以卡片上不保存玩家/卡司标记。',
  /** The C1/I1 boundary, stated where the ST field names are (docs/04 §10). */
  'character.stHint':
    '以下字段名与 SillyTavern V2/V3 保持一致；与真实 ST 卡片（PNG/JSON）的双向映射由 M1-I1 负责。',
  'character.sectionSt': 'SillyTavern 字段',
  'character.sectionVoice': '发言档案',
  'character.sectionVisual': '视觉档案',
  'character.sectionSampling': '默认采样参数',
  'character.nameLabel': '名称',
  'character.descriptionLabel': '描述',
  'character.personalityLabel': '性格',
  'character.scenarioLabel': '场景',
  'character.firstMesLabel': '开场白（first_mes）',
  'character.mesExampleLabel': '对话示例（mes_example）',
  'character.creatorNotesLabel': '创作者注记（creator_notes）',
  'character.systemPromptLabel': '系统提示（system_prompt）',
  'character.postHistoryLabel': '历史后指令（post_history_instructions）',
  'character.alternateGreetingsLabel': '备选开场白',
  'character.tagsLabel': '标签',
  'character.creatorLabel': '创作者',
  'character.characterVersionLabel': '卡片版本',
  'character.desireLabel': '发言欲望（0-100）',
  'character.abilityLabel': '发言能力（0-100）',
  'character.rolesLabel': '发言角色标签',
  'character.maxLinesLabel': '单轮条数上限（1-5）',
  'character.cooldownLabel': '冷却轮数（0-3）',
  'character.hairLabel': '发色发型',
  'character.eyesLabel': '瞳色',
  'character.buildLabel': '体型',
  'character.skinLabel': '肤色',
  'character.marksLabel': '显著特征',
  'character.outfitsLabel': '服装差分',
  'character.outfitIdLabel': '服装标识',
  'character.outfitNameLabel': '服装名称',
  'character.outfitPromptLabel': '提示词',
  'character.expressionsLabel': '表情差分',
  'character.expressionIdLabel': '表情标识',
  'character.expressionNameLabel': '表情名',
  'character.expressionPromptLabel': '提示词',
  'character.stylePresetLabel': '画风预设',
  'character.stylePositiveLabel': '正向提示词',
  'character.styleNegativeLabel': '负向提示词',
  'character.styleAspectLabel': '画幅',
  'character.paramsProviderLabel': '生图 Provider',
  'character.paramsModelLabel': '模型',
  'character.paramsSamplerLabel': '采样器',
  'character.paramsStepsLabel': '步数',
  'character.paramsCfgLabel': 'CFG',
  'character.seedPolicyLabel': '种子策略',
  'character.seedLabel': '种子',
  'character.seedPolicyFixed': '固定',
  'character.seedPolicyRandom': '随机',
  'character.seedPolicyIncrement': '递增',
  /*
   * 参考图 (L2/L3). The hint states the missing dependency rather than hiding it: there is no
   * asset pipeline in M0/M1 (docs/06 §10.5), so an `assetId` is stored and may dangle — the
   * editor does not invent an upload path to make the field look complete.
   */
  'character.referencesLabel': '参考图',
  'character.referenceAssetIdLabel': '资源 ID（assetId）',
  'character.referenceRoleLabel': '用途',
  'character.referenceRoleFace': '面部',
  'character.referenceRoleOutfit': '服装',
  'character.referenceRoleStyle': '画风',
  'character.assetsHint': '资源管线尚未实现：参考图只保存 assetId，可能指向不存在的资源。',
  'character.samplingHint': '留空表示不覆盖该参数；未设置的参数由会话配置决定。',
  'character.samplingTemperatureLabel': '温度（temperature）',
  'character.samplingTopPLabel': 'top_p',
  'character.samplingTopKLabel': 'top_k',
  'character.samplingMaxTokensLabel': 'max_tokens',
  'character.samplingPresenceLabel': 'presence_penalty',
  'character.samplingFrequencyLabel': 'frequency_penalty',
  'character.samplingRepetitionLabel': 'repetition_penalty',
  'character.samplingSeedLabel': '种子（seed）',
  'character.samplingStopLabel': 'stop 序列',
  'character.samplingReasoningLabel': '推理强度（reasoning_effort）',
  /** The empty option of the reasoning select: no override, the session decides. */
  'character.reasoningNone': '跟随会话',
  /** The four levels keep their protocol spelling: they travel to the provider verbatim. */
  'character.reasoningMinimal': 'minimal',
  'character.reasoningLow': 'low',
  'character.reasoningMedium': 'medium',
  'character.reasoningHigh': 'high',

  /* ── play: the transcript screen ────────────────────────────────────────── */
  'play.backToList': '← 返回会话列表',
  'play.generating': '正在生成…',
  'play.composerLabel': '输入你的行动或台词',
  'play.composerPlaceholder': '例如：我推开门，走进昏暗的酒馆。',
  'play.send': '发送',
  'play.stop': '停止',
  /*
   * THE OPENING PANEL (M1-S3) — the three ways a session can start.
   *
   * An opening is a START, not a turn: it is the chain's first message, the only one whose
   * `parentId` is `null` and the only one that may be written while the session has no head.
   * The panel is therefore offered exactly while the chain is empty, and every sentence here
   * belongs to that moment (the choices, the input's label, and the confirmation that 跳过
   * did something — it did: the session is usable with no transcript).
   *
   * WHY `play.openingInstruction` IS IN THE CATALOG AND NOT IN THE PRESET
   * The AI path sends this text as the turn's USER input through the ordinary turn
   * (`chat/send-turn.ts` with `append: {mode: 'none'}`), so it must come from somewhere that
   * holds text. It is an INSTRUCTION ABOUT THE INTERFACE'S MOMENT — "this is the first line
   * of a session, set the scene" — which is what the catalog is for, and keeping it here is
   * what lets `tools/scripts/check-i18n-literals.mjs` stay at zero exemptions beyond the
   * documented built-in-content one. It is never persisted: `mode: 'none'` writes no user
   * row, so the sentence is on the wire and nowhere else.
   *
   * WHAT IT DELIBERATELY IS NOT: it is not a `first_mes`. A character card's greeting is
   * `CharacterData.first_mes` (docs/02 §4) and would be authored content with its own pinned
   * language; no `CharacterVersion` row exists yet (docs/06 §8.5 决定 1), so this sentence
   * ASKS for an opening instead of quoting one, and it follows the UI language the way the
   * rest of the app's copy does.
   */
  'play.openingTitle': '开场',
  'play.openingHint': '会话还没有第一条消息。选择开场方式，一旦写下就不能再重选。',
  'play.openingInstruction':
    '这是本会话的第一条消息。请写一段开场：交代场景与当前时间，并留下一个可以开始行动的钩子。只写旁白与角色的内容，不要替玩家说话。',
  'play.openingLabel': '开场内容',
  'play.openingPlaceholder': '例如：酒馆的门在身后合上，炉火把长影投在墙上。',
  'play.openingWrite': '写开场',
  'play.openingWriteEmpty': '请先输入开场内容',
  'play.openingGenerate': 'AI 生成开场',
  'play.openingSkip': '跳过开场',
  'play.openingSkipped': '已跳过开场，直接发送第一条消息即可。',
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
  'common.loading': 'Loading…',
  'common.addItem': 'Add',
  'common.removeItem': 'Remove',
  'common.moveUp': 'Move up',
  'common.moveDown': 'Move down',
  'common.onePerLine': 'One item per line',
  'common.emptyList': 'No entries yet',
  'common.updatedAt': 'Updated {date}',
  'common.versionLabel': 'v{version}',
  'common.unsavedDraft':
    'You are editing a draft: autosave writes the draft only, and a new version is created by the publish button.',
  'common.draftBase': 'Draft based on v{base}; publishing creates v{next}.',
  'common.draftFailed': 'The draft was not saved ({name})',
  'common.publish': 'Publish a new version',
  'common.discardDraft': 'Discard the draft',
  'common.published': 'Published v{version}',
  'common.discarded': 'Draft discarded; the published version is back',
  'common.publishRefused': 'There are validation problems, so nothing was published',
  'common.publishFailed': 'The publish failed; no new version was written',
  'common.issuesTitle': 'Validation',
  'common.issuesNone': 'No validation problems — this card can be published.',
  'common.issue': '{field}: {detail}',
  'common.customFieldsTitle': 'Custom fields',
  'common.customFieldsHint':
    'Custom fields are stored in the card data’s customFields record, where the field name IS the key — so renaming means removing and adding again.',
  'common.customFieldNameLabel': 'Field name',
  'common.customFieldValueLabel': 'Field value',
  'common.customFieldAdd': 'Add a field',
  'common.customFieldEmpty': 'No custom fields yet.',
  'common.customFieldRefused': 'A field name cannot be blank, and must not repeat an existing one',

  /* ── nav ────────────────────────────────────────────────────────────────── */
  'nav.language': 'Language',
  'nav.settings': 'Settings',
  'nav.worlds': 'Worlds',
  'nav.characters': 'Characters',

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
  'home.empty':
    'No sessions yet. Fill in the API configuration under Settings, then create a session.',
  'home.noMessages': 'No messages',
  'home.hasMessages': 'Has messages',
  'home.defaultSessionTitle': 'New session',

  /* ── creating a session (M1-S1) ─────────────────────────────────────────── */
  'session.title': 'New session',
  'session.backToHome': '← Back to sessions',
  'session.hint':
    'Pick a world version and the cards taking part; designate one as the player character and the rest become the cast automatically. Identity belongs to the session, not to the card, so one card can play different roles in different sessions.',
  'session.worldLabel': 'World card',
  'session.worldPlaceholder': 'Choose a world card',
  'session.worldEmpty':
    'No world cards yet. Create one under Worlds, then come back to start a session.',
  'session.worldVersionLabel': 'World version',
  'session.pinning':
    'This session pins v{version} (the newest version of that world is v{latest}).',
  'session.cardsLabel': 'Cards taking part',
  'session.cardsEmpty':
    'No character cards yet. Create one under Characters, then come back to start a session.',
  'session.playerLabel': 'Player character',
  'session.playerHint':
    'The card you play. Every other ticked card becomes cast, played by the AI.',
  'session.playerOf': 'Designate {name} as the player character',
  'session.castLabel': 'Cast (generated)',
  'session.castEmpty': 'The cast is empty: only the card you play is on stage.',
  'session.presetLabel': 'Prompt preset',
  'session.presetHint':
    'Only the built-in preset exists so far: presets cannot be created or imported yet, so there is nothing to choose here.',
  'session.rulePackLabel': 'Rule pack',
  'session.rulePackNone': 'No rule pack is available yet, so this session binds none.',
  'session.clockLabel': 'Initial clock (minutes since the calendar epoch)',
  'session.clockHint':
    "Defaults to the chosen world version's start minute ({minute}); leaving the field blank uses that default.",
  'session.create': 'Create session',
  'session.creating': 'Creating…',
  'session.createFailed': 'The session was not created; nothing was written',
  'session.worldRequired': 'Choose a world card and one of its versions',
  'session.cardsRequired': 'Tick at least one character card',
  'session.playerRequired': 'Designate one of the cards as the player character',
  'session.playerNotChosen': 'The designated player character is not among the ticked cards',
  'session.clockInvalid': 'The initial clock must be a whole number of minutes',

  /* ── the world-card library and editor (M1-W1) ──────────────────────────── */
  'world.libraryTitle': 'World cards',
  'world.libraryHint':
    'A world card holds the setting and its calendar; a session pins one specific version.',
  'world.empty': 'No world cards yet.',
  'world.createLabel': 'Name of the new world',
  'world.createPlaceholder': 'for example: the Frostmoon Isles',
  'world.create': 'New world card',
  'world.backToLibrary': '← Back to the world cards',
  'world.lineageReason': 'Published from the world card editor',
  'world.sectionBasic': 'Basics',
  'world.sectionRegions': 'Regions',
  'world.sectionFactions': 'Factions',
  'world.sectionRules': 'Rules',
  'world.sectionNarrative': 'Narrative',
  'world.sectionCalendar': 'Calendar and time',
  'world.sectionRhythm': 'Time rhythm',
  'world.sectionOpening': 'Opening',
  'world.nameLabel': 'Name',
  'world.premiseLabel': 'One-line premise',
  'world.eraLabel': 'Era',
  'world.techOrMagicLabel': 'Technology or magic level',
  'world.genreLabel': 'Genre tags',
  'world.regionsLabel': 'Regions',
  'world.regionIdLabel': 'Region id',
  'world.regionNameLabel': 'Region name',
  'world.regionDescriptionLabel': 'Region description',
  'world.regionParentLabel': 'Parent region id',
  'world.regionTagsLabel': 'Region tags',
  'world.factionsLabel': 'Factions',
  'world.factionIdLabel': 'Faction id',
  'world.factionNameLabel': 'Faction name',
  'world.factionDescriptionLabel': 'Faction description',
  'world.factionStanceLabel': 'Stance',
  'world.factionGoalsLabel': 'Goals',
  'world.powerSourceLabel': 'Power source',
  'world.limitsLabel': 'Limits and costs',
  'world.taboosLabel': 'Taboos',
  'world.conflictLabel': 'Core conflict',
  'world.toneLabel': 'Tone',
  'world.themesLabel': 'Themes',
  'world.styleLabel': 'Narrative style',
  'world.calendarIdLabel': 'Calendar id',
  'world.calendarNameLabel': 'Calendar name',
  'world.epochLabelLabel': 'Epoch label',
  'world.calendarHint':
    'The calendar is data: neither a day’s hours nor an hour’s minutes has to be 24/60, and a segment may wrap past midnight (a to-hour below the from-hour is legal).',
  'world.minutesPerHourLabel': 'Minutes per hour',
  'world.hoursPerDayLabel': 'Hours per day',
  'world.weekdaysLabel': 'Weekday names',
  'world.monthsLabel': 'Months',
  'world.monthNameLabel': 'Month name',
  'world.monthDaysLabel': 'Days',
  'world.segmentsLabel': 'Day segments',
  'world.segmentIdLabel': 'Segment id',
  'world.segmentNameLabel': 'Segment name',
  'world.segmentFromLabel': 'From hour',
  'world.segmentToLabel': 'To hour',
  'world.startMinuteLabel': 'Start minute (epoch minutes)',
  'world.startMinuteHint': 'Minutes since the calendar’s epoch; a negative value is legal.',
  'world.implicitAdvanceLabel': 'Advance time automatically every N turns',
  'world.advanceEveryTurnsLabel': 'Turns (N)',
  'world.stepMinutesLabel': 'Minutes per advance',
  'world.rhythmHint':
    'Implicit advance is off by default: while it is off, the clock only moves when you advance it or load a save point.',
  'world.openingHooksLabel': 'Opening hooks',

  /* ── the AI co-creation panel (M1-W2) ───────────────────────────────────── */
  'co-create.title': 'AI co-creation',
  'co-create.show': 'Open AI co-creation',
  'co-create.hide': 'Close AI co-creation',
  'co-create.hint':
    'Discuss this world card with the AI: every answer offers a patch proposal, and accepting it is your call.',
  'co-create.empty':
    'No conversation yet. Say what you want to flesh out — “add a region”, for instance.',
  'co-create.inputLabel': 'What to say to the AI',
  'co-create.send': 'Send',
  'co-create.thinking': 'Thinking…',
  'co-create.previewTitle': 'Live preview',
  'co-create.previewHint':
    'This is the card as it would be after accepting the proposal — the preview is computed from the very data applying it would write.',
  'co-create.noProposal': 'There is no proposal waiting.',
  'co-create.accept': 'Accept',
  'co-create.reject': 'Reject',
  'co-create.undo': 'Undo this acceptance',
  'co-create.undoHint': 'Undoing restores the draft to exactly what it was before the acceptance.',
  'co-create.verbAdd': 'add',
  'co-create.verbRemove': 'remove',
  'co-create.verbReplace': 'change',
  'co-create.opLine': '{op} {path}',
  'co-create.refusedSchema':
    'This proposal would make the card invalid ({detail}); nothing was applied.',
  'co-create.refusedOp':
    'The operation “{op} {path}” in this proposal cannot be applied; nothing was changed.',
  'co-create.notConfigured':
    'No model service is configured yet, so co-creation cannot start: fill in the base URL and model name under Settings first.',
  'co-create.malformedNoJson':
    'The AI’s answer held no JSON proposal that could be read. The draft is unchanged, so try again.\n\nThe AI answered:\n{detail}',
  'co-create.malformedNoOps':
    'The AI’s answer has no ops field, so it is not a proposal. The draft is unchanged, so try again.\n\nThe AI answered:\n{detail}',
  'co-create.malformedNotAnOperation':
    'One entry of the AI’s answer is not a valid patch operation. The draft is unchanged, so try again.\n\nThe AI answered:\n{detail}',
  'co-create.malformedTooManyOps':
    'The AI proposed too many changes at once. The draft is unchanged; ask it to do them in smaller steps.\n\nThe AI answered:\n{detail}',

  /* ── 生成模式与字段级操作 (M1-W3 / M1-W4, docs/06 §2.5) ─────────────────── */
  'co-create.generateTitle': 'Generation',
  'co-create.generateHint':
    'Have the AI write this card in steps: each step is one request of its own, and you accept or refuse them one at a time, so the draft grows as you go.',
  'co-create.generateStart': 'Generate from scratch',
  'co-create.generateNext': 'Generate this step',
  'co-create.generateSkip': 'Skip this step',
  'co-create.generateStop': 'Stop generating',
  'co-create.generateStepOf': 'Step {current} of {total}',
  'co-create.stepPremise': 'One-line premise',
  'co-create.stepBasics': 'World facts',
  'co-create.stepPlaces': 'Regions',
  'co-create.stepPowers': 'Factions',
  'co-create.stepRules': 'Rules and taboos',
  'co-create.stepNarrative': 'Narrative',
  'co-create.stepTelling': 'Genre, themes and hooks',
  'co-create.stepField': 'This field',
  'co-create.stepIdentity': 'Identity and personality',
  'co-create.stepScenario': 'Scenario and system prompt',
  'co-create.stepSpeech': 'Opening line and example dialogue',
  'co-create.stepVoice': 'Speaking profile',
  'co-create.stepLooks': 'Appearance and art style',
  'co-create.stepCredits': 'Creator and notes',
  'co-create.stepStatePending': 'to generate',
  'co-create.stepStateAccepted': 'accepted',
  'co-create.stepStateRejected': 'refused',
  'co-create.stepStateSkipped': 'skipped',
  'co-create.nothingSelected':
    'No field is selected yet. Tick at least one field, then press “Generate the selected fields”.',
  'co-create.noGeneration':
    'No generation is running. Start one with “Generate from scratch” or “Generate the selected fields”.',
  'co-create.generationBusy':
    'A generation is running. Accept, refuse or stop the current step before working on a single field.',
  'co-create.finishFirst':
    'One proposal is still unanswered. Accept or refuse it before starting another request.',
  'co-create.genreFirst':
    'This card has nothing but a name: write a word or two under “Genre” first, so the AI knows which way to write.',
  'co-create.characterFirst':
    'This character card says nothing to build on: write a line or two under “Description”, “Personality” or “Scenario” first, so the AI knows what kind of character to generate.',
  'co-create.wrongCard':
    'The co-creation panel is open on the other kind of card. Switch back to the matching editor and start the request again.',
  'co-create.outOfScope':
    'This answer reached outside the current step (it wrote {detail}), so none of the proposal was applied. The draft is unchanged.',

  'co-create.fieldTitle': 'Field-level AI actions',
  'co-create.fieldHint':
    'Pick a field and let the AI change only that one: the proposal lands on it alone, and a proposal that touches anything else is refused.',
  'co-create.fieldSelectLabel': 'Field',
  'co-create.fieldRewrite': 'Rewrite',
  'co-create.fieldExpand': 'Expand',
  'co-create.fieldCondense': 'Condense',
  'co-create.fieldOpTitle': '{op}: {field}',
  'co-create.fieldSetStart': 'Generate the selected fields',
  'co-create.selectedTitle': 'Selected fields',

  'co-create.voiceTitle': 'Speaking profile assessment',
  'co-create.voiceHint':
    'Assesses the speaking profile from what the card itself says (description, personality, scenario, first message). The AI fills only the fields it can judge, and says why.',
  'co-create.voiceEvaluate': 'Assess the speaking profile',
  'co-create.voiceWorldLabel': 'Generate against which world',
  'co-create.voiceWorldNone': 'No world',
  'co-create.voiceReasoning': 'Why: {detail}',
  'co-create.voiceTooThin':
    'This card says nothing to judge yet: write a description, a personality or a scenario first, so the AI has something to assess.',
  'co-create.voiceNoSignal':
    'The AI judged the card too thin to score speaking desire and ability, so it proposed no numbers. Describe the character in more detail and try again.',

  /* ── the character-card library and editor (M1-C1) ──────────────────────── */
  'character.libraryTitle': 'Character cards',
  'character.libraryHint':
    'A character card keeps the SillyTavern V2/V3 fields plus the speaking profile and the visual bible.',
  'character.empty': 'No character cards yet.',
  'character.createLabel': 'Name of the new character',
  'character.createPlaceholder': 'for example: Lian of Silverpine',
  'character.create': 'New character card',
  'character.backToLibrary': '← Back to the character cards',
  'character.lineageReason': 'Published from the character card editor',
  'character.identityHint':
    'Identity belongs to the session: one card can be the player character in one session and an NPC in the next, so the card itself stores no player/cast flag.',
  'character.stHint':
    'These field names match SillyTavern V2/V3 verbatim; mapping to and from a real ST card (PNG/JSON) is M1-I1’s job.',
  'character.sectionSt': 'SillyTavern fields',
  'character.sectionVoice': 'Speaking profile',
  'character.sectionVisual': 'Visual bible',
  'character.sectionSampling': 'Default sampling',
  'character.nameLabel': 'Name',
  'character.descriptionLabel': 'Description',
  'character.personalityLabel': 'Personality',
  'character.scenarioLabel': 'Scenario',
  'character.firstMesLabel': 'First message (first_mes)',
  'character.mesExampleLabel': 'Example dialogue (mes_example)',
  'character.creatorNotesLabel': 'Creator notes (creator_notes)',
  'character.systemPromptLabel': 'System prompt (system_prompt)',
  'character.postHistoryLabel': 'Post-history instructions',
  'character.alternateGreetingsLabel': 'Alternate greetings',
  'character.tagsLabel': 'Tags',
  'character.creatorLabel': 'Creator',
  'character.characterVersionLabel': 'Card version',
  'character.desireLabel': 'Desire to speak (0-100)',
  'character.abilityLabel': 'Ability to contribute (0-100)',
  'character.rolesLabel': 'Speaking-role tags',
  'character.maxLinesLabel': 'Lines per round (1-5)',
  'character.cooldownLabel': 'Cooldown rounds (0-3)',
  'character.hairLabel': 'Hair',
  'character.eyesLabel': 'Eyes',
  'character.buildLabel': 'Build',
  'character.skinLabel': 'Skin',
  'character.marksLabel': 'Distinguishing marks',
  'character.outfitsLabel': 'Outfits',
  'character.outfitIdLabel': 'Outfit id',
  'character.outfitNameLabel': 'Outfit name',
  'character.outfitPromptLabel': 'Prompt',
  'character.expressionsLabel': 'Expressions',
  'character.expressionIdLabel': 'Expression id',
  'character.expressionNameLabel': 'Expression label',
  'character.expressionPromptLabel': 'Prompt',
  'character.stylePresetLabel': 'Style preset',
  'character.stylePositiveLabel': 'Positive prompt',
  'character.styleNegativeLabel': 'Negative prompt',
  'character.styleAspectLabel': 'Aspect',
  'character.paramsProviderLabel': 'Image provider',
  'character.paramsModelLabel': 'Model',
  'character.paramsSamplerLabel': 'Sampler',
  'character.paramsStepsLabel': 'Steps',
  'character.paramsCfgLabel': 'CFG',
  'character.seedPolicyLabel': 'Seed policy',
  'character.seedLabel': 'Seed',
  'character.seedPolicyFixed': 'Fixed',
  'character.seedPolicyRandom': 'Random',
  'character.seedPolicyIncrement': 'Increment',
  'character.referencesLabel': 'Reference images',
  'character.referenceAssetIdLabel': 'Asset id',
  'character.referenceRoleLabel': 'Role',
  'character.referenceRoleFace': 'Face',
  'character.referenceRoleOutfit': 'Outfit',
  'character.referenceRoleStyle': 'Style',
  'character.assetsHint':
    'There is no asset pipeline yet: a reference stores only an asset id, which may point at nothing.',
  'character.samplingHint':
    'Leave a field empty to not override it; an unset parameter is decided by the session’s configuration.',
  'character.samplingTemperatureLabel': 'Temperature',
  'character.samplingTopPLabel': 'top_p',
  'character.samplingTopKLabel': 'top_k',
  'character.samplingMaxTokensLabel': 'max_tokens',
  'character.samplingPresenceLabel': 'presence_penalty',
  'character.samplingFrequencyLabel': 'frequency_penalty',
  'character.samplingRepetitionLabel': 'repetition_penalty',
  'character.samplingSeedLabel': 'Seed',
  'character.samplingStopLabel': 'Stop sequences',
  'character.samplingReasoningLabel': 'Reasoning effort',
  'character.reasoningNone': 'Follow the session',
  'character.reasoningMinimal': 'minimal',
  'character.reasoningLow': 'low',
  'character.reasoningMedium': 'medium',
  'character.reasoningHigh': 'high',

  /* ── play ───────────────────────────────────────────────────────────────── */
  'play.backToList': '← Back to sessions',
  'play.generating': 'Generating…',
  'play.composerLabel': 'Type your action or line',
  'play.composerPlaceholder': 'For example: I push the door open and step into the dim tavern.',
  'play.send': 'Send',
  'play.stop': 'Stop',
  'play.openingTitle': 'Opening',
  'play.openingHint':
    'This session has no first message yet. Choose how it starts — once it is written, the opening cannot be chosen again.',
  'play.openingInstruction':
    'This is the first message of the session. Write an opening: establish the scene and the current time, and leave a hook the player can act on. Write only narration and the characters — do not speak for the player.',
  'play.openingLabel': 'Opening text',
  'play.openingPlaceholder':
    'For example: the tavern door closes behind me and the hearth throws long shadows on the wall.',
  'play.openingWrite': 'Write the opening',
  'play.openingWriteEmpty': 'Type the opening first',
  'play.openingGenerate': 'Generate an opening',
  'play.openingSkip': 'Skip the opening',
  'play.openingSkipped': 'Opening skipped — just send your first message.',
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
