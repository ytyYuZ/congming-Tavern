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
  /** Dismiss a dialog without acting; the pair of `common.save`. */
  'common.cancel': '取消',
  /** Start something new in a list (a provider row) — a verb, unlike `common.addItem`. */
  'common.add': '新增',
  /**
   * The separator between items of a list rendered INSIDE a sentence.
   *
   * It is a catalog entry rather than a literal at the call site because the punctuation is part
   * of the language: Chinese enumerates with `、` and English with a comma and a space, so a
   * sentence that names several sessions (`setup.providerDeleteRefused`'s `{titles}`) would be
   * punctuated in one language's convention whichever language the rest of it was written in.
   */
  'common.listSeparator': '、',
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
  /*
   * THE SECTION CHROME (acceptance fix B1).
   *
   * Both card editors are grouped into sections that fold, with a table of contents above them, so
   * the three sentences that chrome says are `common.` like the rest of it — one implementation
   * (`app/collapsible-section.tsx`) serves both screens. The section TITLES are not here: they are
   * `world.section*` / `character.section*`, because they name that card's own parts.
   */
  'common.sectionsTitle': '目录',
  'common.sectionExpand': '展开「{name}」',
  'common.sectionCollapse': '收起「{name}」',

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
  /**
   * The two ways OUT of an editor (acceptance fix A1): the session list, and the session that is
   * currently open. The first manual acceptance test found that the editor screens had no way back
   * to a session at all — the header offered the two libraries and Settings only, and
   * `/play/$sessionId` needs an id that only the store can supply.
   */
  'nav.sessions': '会话',
  'nav.currentSession': '回到当前会话',
  /**
   * The third door onto content (acceptance fix A4). The two libraries show what is
   * ALREADY here; this one moves content in and out, which is why it sits beside them
   * rather than inside Settings.
   */
  'nav.packs': '内容包',
  /**
   * The tenth link: the in-app tour of the application (C2). It is NOT a screen's own label — the
   * page it opens is copy-driven — so it belongs here rather than in the `help` area.
   */
  'nav.help': '帮助',

  /* ── pack: import and export a content pack (acceptance fix A4) ──────────── */
  /**
   * WHY THIS AREA EXISTS AT ALL
   * The manual acceptance test found no way to import or export a content pack, and
   * no way to obtain the example pack, from inside the app. `/packs` is that way, and
   * every sentence it says is here. The finding DETAILS the page shows are NOT here:
   * they are `packages/importers`' own diagnostics, one vocabulary that must not be
   * re-worded into a second one (`import-package.ts` says so itself).
   */
  'pack.title': '内容包',
  'pack.hint':
    '把当前的库导出成一个 .stpack 文件，或者从文件、内置示例导入。导入会先给出报告，确认之后才写入。',
  'pack.exampleWhy':
    '内置示例「长日港 · 末班渡」在进程内构建，并走与你所选文件完全相同的一条导入路径。命令行的 stpack 写入的是 JSON 文件库，与浏览器应用使用的 IndexedDB 不是同一个库，所以应用内需要这个入口。',
  'pack.exportTitle': '导出',
  'pack.exportHint': '把库里每个世界和角色的最新版本（连同世界书条目）打包成一个 .stpack 文件。',
  'pack.exportButton': '导出内容包',
  'pack.exportEmpty': '库里还没有世界或角色，没有可导出的内容。',
  'pack.exported': '已导出 {name}',
  'pack.exportFailed': '导出失败：{detail}',
  'pack.importTitle': '导入',
  'pack.importHint':
    '选择一个 .stpack 文件。解析后先显示报告，确认才会写入；被拒绝的导入不会改动任何数据。',
  'pack.chooseFile': '选择文件…',
  'pack.importExample': '导入示例内容包',
  'pack.previewTitle': '导入报告（尚未写入）',
  'pack.previewHint': '下面是这次导入将会发生的改动。确认之前不会写入任何数据。',
  'pack.confirm': '确认导入',
  'pack.cancel': '取消',
  'pack.resultTitle': '导入结果',
  'pack.resultHint': '上表的内容已经写入。',
  'pack.refused': '这个包无法导入，库没有改动。',
  'pack.findings': '报告与提示',
  'pack.noFindings': '没有问题。',
  'pack.packageLine': '{name}（{kind}，格式版本 {formatVersion}）',
  'pack.counts': '新增 {created} · 复用 {reused} · 改名 {remapped} · 跳过 {skipped}',
  'pack.importedTitle': '导入的世界与角色',
  'pack.entityWorld': '世界',
  'pack.entityWorldbook': '世界书条目',
  'pack.entityCharacter': '角色',
  'pack.entityPromptPreset': '提示预设',
  'pack.entitySession': '会话',
  'pack.entityMessage': '消息',
  'pack.entityCheckpoint': '存档点',
  'pack.entityAgenda': '日程',
  'pack.entityMemory': '记忆',
  'pack.actionCreated': '新增',
  'pack.actionReused': '复用',
  'pack.actionRemapped': '改名',
  'pack.actionSkipped': '跳过',
  'pack.openWorlds': '打开世界库',
  'pack.openCharacters': '打开角色库',
  'pack.startExample': '用示例开局',
  'pack.startExampleHint': '按示例包建议的搭配（长日港，扮演沈砚），用刚导入的行新建一个会话。',
  'pack.startExampleUnavailable': '示例行不在库里，无法用示例开局。',
  'pack.startFailed': '未能创建会话：{detail}',
  'pack.fileUnreadable': '无法读取这个文件：{detail}',

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
   * THE FEATURE SWITCHES (ADR-037, docs/05-决策记录.md §758-775) — today exactly one:
   * `feature.timeAndScheduling`, the switch the play screen's 时间推进, 发言调度 and 卡司干预
   * sections hang on.
   *
   * WHY THE HINT NAMES THE CONSEQUENCES RATHER THAN THE MECHANISM: the user is deciding whether
   * time moves and whether something else decides who talks. "关闭" alone would leave the one
   * thing that is easy to get wrong untold — that the world clock also stops being written into
   * the prompt — so the sentence lists all three effects and says which state is the default
   * (ADR-037's 缺席即关闭), because a switch nobody touched never had a row at all.
   */
  'setup.featureTitle': '功能',
  'setup.featureTimeAndSchedulingLabel': '时间推进与多角色发言调度',
  'setup.featureTimeAndSchedulingHint':
    '开启后：时间可以手动推进，每回合的提示里会带上世界的当前时刻，本地调度器决定谁发言。关闭（默认）：这三件事都不参与——时刻不写进提示，也没有调度器决定发言者。',
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

  /*
   * THE UNLOCK DIALOG (Phase A2) — the same act as this screen's 「解锁」, offered where the
   * refusal actually happened. The acceptance test's first failure was that the only passphrase
   * field lived here, so a user who never opened this screen could not use a key they had saved.
   *
   * `setup.rememberLabel` is the OPT-IN and it is OFF by default: `secrets/unlock-memory.ts`
   * records exactly what it stores (the derived, non-extractable key — never the passphrase) and
   * why that is device-local state rather than a nineteenth collection.
   */
  'setup.unlockTitle': '解锁密钥',
  'setup.unlockHint': '输入这条配置的口令即可发送请求。口令不会被保存。',
  'setup.unlockTarget': '这条配置：{provider}',
  'setup.rememberLabel': '在这台设备上记住解锁',
  'setup.rememberHint':
    '只记住解锁后的密钥（不可导出的 WebCrypto 密钥），不保存口令；本设备的解锁可在「设置」里忘记。',
  'setup.rememberForget': '忘记本设备的解锁',
  'setup.rememberRevoked': '已忘记本设备的解锁；密钥内容没有改变，仍然可以用口令解锁。',

  /*
   * THE PROVIDER LIST (ADR-034) — `provider.<id>` rows plus a `provider.default` marker. The
   * sentences here are about the LIST, not about the AES envelope (which the section above
   * states); the delete refusal names the sessions that pin the row, because the pin has no
   * version and a deleted row would leave them pointing at nothing.
   */
  'setup.providersTitle': '模型服务',
  'setup.providersHint':
    '可以保存多份服务配置，各自使用自己的一份密钥。新建会话会钉住当前选中的这一份；已经被会话钉住的配置不能删除。',
  'setup.providerAdd': '新增配置',
  'setup.providerActive': '当前使用',
  'setup.providerUse': '切换到这份配置',
  'setup.providerDelete': '删除这份配置',
  'setup.providerKeyMissing': '尚未保存密钥',
  'setup.providerRemembered': '本设备已记住解锁',
  'setup.providerDeleteConfirm': '确认删除',
  'setup.providerDeleteRefused':
    '不能删除：还有 {count} 个会话钉住了这份配置（{titles}）。可以先在那些会话里改用别的配置。',
  'setup.providerDeleted': '已删除这份配置',

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
   * WHY THE REFUSALS ARE WHOLE SENTENCES AND NOT `common.issue`'s `{field}：{detail}`: that shape
   * is the card editors' schema-first report of a MALFORMED field, while these say which CHOICE is
   * missing (a world, a card, a player) or that the value given is one the row cannot store (an
   * initial clock that is not a whole minute, a name longer than the stored title accepts). There
   * is no schema path to name in either case.
   */
  'session.title': '新建会话',
  'session.backToHome': '← 返回会话列表',
  'session.hint':
    '选择世界版本与参与的角色卡；指定其中一张为玩家角色，其余自动组成卡司。身份属于会话而不属于角色卡，所以同一张卡可以在不同会话里扮演不同身份。',
  /**
   * The name field, asked first: it is the only field with no choice in it, and BLANK IS AN
   * ANSWER — the hint names the default title it will store, so an empty field is never a
   * mistake. `{default}` lives in the HINT rather than the label because the rename form reuses
   * `nameLabel` alone, where no default applies; the create screen passes
   * `home.defaultSessionTitle` for the parameter.
   */
  'session.nameLabel': '会话名',
  'session.namePlaceholder': '例如：雾港的第一夜',
  'session.nameHint': '留空则使用默认名「{default}」；最多 200 个字符。',
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
  'session.nameRequired': '会话名不能为空',
  /** No `{limit}` interpolation on purpose: the form renders this key with no parameters. */
  'session.nameTooLong': '会话名最多 200 个字符',
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
   * THE DEGRADED PATH, SAID OUT LOUD (A3, docs/02 §5.3).
   * The ladder is ① 原生 function calling → ② 结构化输出（JSON Schema 约束）→ ③ 文本协议. A
   * co-create turn has no tool to call, so it starts at ②，and `co-create/ask.ts` spends ③ by
   * retrying ONCE without `response_format` when the server's refusal names that field.
   *
   * WHY THIS IS A PLAIN NOTICE AND NOT A FINDING
   * The retry is the ladder working as designed, and it usually still produces a proposal —
   * `{detail}` carrying the model's own words is for the turns that FAILED. What the author has to
   * know is the one thing they cannot see: the answer is no longer constrained by the server, so the
   * instruction is now a request rather than a rule, and `readProposal`'s tolerance of a fenced or
   * prefixed JSON object is the only thing making it a proposal. Silence here would leave a
   * 测试连接-success-plus-co-create-failure, or a stray prose answer, unexplained.
   */
  'co-create.degradedRequest':
    '服务端不接受响应格式约束，本次已改用普通请求重试：回答不再由服务端保证是提案格式。',
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
   * The session's own fold on the play screen (B2): the screen keeps the transcript and the composer
   * in place and folds the eight panels around them, so each folded panel needs a heading the table
   * of contents can name. This one names the RENAME form — the session's title, on the session's own
   * screen (see `play.nameSubmit` below for why the form is here rather than in the home list).
   */
  'play.sessionTitle': '本会话',
  /* The rename form: the button names the act, the status line reports whether the row changed. */
  'play.nameSubmit': '保存名称',
  'play.nameChanged': '已改名为「{name}」',
  'play.nameFailed': '改名失败，没有写入会话',
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
  /**
   * The clock's fold heading (B2). Distinct from `play.clockLabel`, which is the readout's
   * accessible name INSIDE the sentence: this one names the fold in the heading and in the table of
   * contents, and the reading itself travels beside it as the section's summary line.
   */
  'play.clockTitle': '时间',
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
   * FORKING A TIMELINE (M1-M2) — a NEW session cut at a save point, or right now.
   *
   * `play.forkHint` is the sentence that must not be dropped: the user is about to get a second
   * session, and what happens to the one on screen (nothing) and what the new one carries (the
   * position, the clock, the variables, the cast and the save points up to the cut) are the two
   * facts that make the act predictable. 「在当前进度分叉」 is the live position — the same thing a
   * save point taken now would capture — and 「从此存档分叉」 is one row lower, on each save point.
   *
   * WHY `play.forkSuffix` IS A FRAGMENT AND NOT A `{title}` TEMPLATE: a session's title may sit
   * at the schema's ceiling (200 characters), so `state/chat-store.ts`'s `forkTitleOf` cuts the
   * ORIGIN'S title to leave room for this suffix and never cuts the suffix itself. A whole
   * sentence with the title inside it could only be cut at the end, which would drop the one part
   * that says what the session is.
   */
  'play.forkTitle': '分叉时间线',
  'play.forkHint':
    '分叉会新建一个会话：它带着所选位置的消息、时钟、变量与卡司状态，以及此前存档点的副本；原会话完全不受影响，其中的引用也全部指向新会话自己的消息。',
  'play.forkAtHead': '在当前进度分叉',
  'play.forkAtCheckpoint': '从此存档分叉',
  /** The second step of a fork, shown only after one of the two labels above was pressed. */
  'play.forkConfirm': '确认分叉',
  /** Only shown when there is no save point: the live position is always a fork point. */
  'play.forkNoSavePoints': '还没有存档点；也可以在任意时刻用「在当前进度分叉」。',
  /** A fork that wrote nothing: the save point it named is gone (or belongs elsewhere). */
  'play.forkRefused': '未能分叉：该存档点已不存在，或不属于当前会话。',
  /** The suffix a forked session's title carries; see the note above for why it is a fragment. */
  'play.forkSuffix': '（分叉）',
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
   * THE TURN SCHEDULER (M1-S5, docs/02 §5.6, docs/01 §F4-6) — who speaks next, and why.
   *
   * WHY THE PANEL SAYS THE CAPS OUT LOUD: 上限被硬性强制执行 is the milestone's own acceptance
   * sentence, and a limit a user cannot see is indistinguishable from a bug the day a
   * character stays silent. `{speakers}` is the per-round speaker cap; the line cap and the
   * cooldown come from each card, so the hint points at the card instead of inventing a
   * number the scheduler does not own.
   *
   * WHY THE REASONS ARE SEPARATE SENTENCES AND NOT ONE TEMPLATE: a reason is a FACT the
   * engine produced (`session/scheduler-text.ts` maps each one exhaustively), and the two
   * locales order the clause differently — the same argument `play.clock` records. The
   * reason is then nested into the selection sentence, so a screen reader hears one
   * sentence rather than a name followed by a fragment.
   */
  'play.schedulerTitle': '发言调度',
  'play.schedulerHint':
    '本地调度器按发言欲望与能力给出顺序，并强制执行硬上限：每轮最多 {speakers} 人发言，单人条数与冷却轮数由角色卡决定，模型无法突破。',
  /** `{reason}` is one of the `play.schedulerReason*` sentences, already translated. */
  'play.schedulerNext': '下一位发言：{name}（{reason}）',
  'play.schedulerNobody': '本轮没有人可以发言。',
  'play.schedulerEmptyCast': '这个会话还没有卡司角色，目前只有玩家角色。',
  /** The refusal of a manual assignment the limits block; `{reason}` as above. */
  'play.schedulerRefused': '{name} 现在不能发言（{reason}）',
  'play.schedulerSpeak': '让 TA 发言',
  'play.schedulerCastTitle': '卡司',
  'play.schedulerSelectable': '可以发言',
  /** The visible label of a row's assign control; the accessible name carries the card. */
  'play.schedulerAssign': '指派',
  'play.schedulerAssignLabel': '指派 {name} 发言',
  /** A cast pin whose card version cannot be read: the panel still lists the character. */
  'play.schedulerUnknownCard': '角色卡已不在库中',
  /**
   * A second turn cannot start while one is streaming or an opening is being written. The
   * panel's controls are disabled in that state, so this sentence is for a programmatic
   * caller - and it exists rather than a bare `false`, because "why did nothing happen" is
   * the question an unstated refusal leaves behind.
   */
  'play.schedulerBusy': '上一条回复还在生成中，请先停止或等待它写完',
  /**
   * ADR-037's switch is off, so the scheduler takes no part in the speaking decision and there
   * is nobody for this call to ask. The panel is not rendered in that state either, which makes
   * this the programmatic caller's sentence — the same reason `play.schedulerBusy` above exists
   * rather than a bare `false`.
   */
  'play.schedulerOff': '时间推进与发言调度已在设置中关闭，可在“设置”里开启',
  'play.schedulerReasonManual': '你手动指派了顺序，TA 排在第 {position} 位',
  'play.schedulerReasonScore': '发言欲望 {desire} / 发言能力 {ability}，在可选角色里最高',
  'play.schedulerExcludedCapped': '单轮条数已达上限（{lines}/{limit}）',
  'play.schedulerExcludedCooling': '冷却中：还要等 {remaining} 轮（冷却 {cooldown} 轮）',
  'play.schedulerExcludedSpeakerCap': '本轮发言人数已达上限（{limit} 人）',
  'play.schedulerExcludedCardMissing': '绑定的角色卡版本已不在库中，读不到发言档案',
  'play.schedulerExcludedNotInCast': 'TA 不在本次会话的卡司里',
  /**
   * THE USER'S OWN INTERVENTION (M1-S4) — the two reasons a silence can be the person's own
   * doing, named as such rather than as a generic "not eligible".
   *
   * WHY THEY ARE SEPARATE SENTENCES FROM THE LIMITS: a muted or absent member was not refused by
   * a cap, and saying so would describe a rule that never applied — the user would go looking for
   * a cooldown instead of at the control they just used. The acceptance clause is 「干预后调度器
   * 行为符合预期」, and the reason is how the user can see that the behaviour is theirs.
   */
  'play.schedulerExcludedAbsent': '你已把 TA 移出当前场景',
  'play.schedulerExcludedMuted': '你已把 TA 禁言',
  /**
   * The intervention controls themselves (M1-S4), on each cast row. The two acts are 禁言 and
   * 移出当前场景 (docs/01 §5.4 用户对卡司的干预), and each control is named by what pressing it
   * DOES — 解除禁言 puts them back, 恢复出场 brings them back on stage — because a button
   * labelled with the state rather than the act leaves the user guessing which one they are in.
   */
  'play.castMute': '禁言',
  'play.castUnmute': '解除禁言',
  'play.castAbsent': '移出场景',
  'play.castPresent': '恢复出场',
  /** The armed second step of each act: same row, and the label says the act is about to happen. */
  'play.castMuteConfirm': '确认禁言',
  'play.castAbsentConfirm': '确认移出场景',
  'play.castInterventionTitle': '卡司干预',
  'play.castMuteLabel': '禁言 {name}：TA 仍在场，但不会被调度发言',
  'play.castUnmuteLabel': '解除 {name} 的禁言，让 TA 重新参与调度',
  'play.castAbsentLabel': '把 {name} 移出当前场景，TA 将不参与本轮',
  'play.castPresentLabel': '让 {name} 回到当前场景并重新参与调度',
  /** The row's own state sentence, so the cast list says what an intervention did. */
  'play.castStateMuted': '已禁言',
  'play.castStateAbsent': '已移出场景',
  /** The same sentence for the control that APPLIES the intervention, as a tooltip. */
  'play.castMuteHint': '禁言后 TA 仍会在场，但调度器不会再选中 TA 发言。',
  'play.castAbsentHint': '移出场景后 TA 不参与本轮，调度器不会再选中 TA。',
  'play.castStateNone': '可发言',
  'play.castIntervened': '已更新卡司状态：{name}',
  /** The undo, named after the precedent in the save-point panel and the co-creation flow. */
  'play.castRestore': '撤销这次干预',
  'play.castRestored': '已恢复到干预之前的卡司状态',
  'play.castRestoreNothing': '没有可撤销的干预',
  /**
   * The hint above the cast rows. It says WHICH half of the milestone the controls are: the
   * silence is live state that a save point and a rollback carry, so the user knows an undo has
   * two sizes — this panel's one step, and the save-point panel's rollback.
   */
  'play.castInterventionHint':
    '禁言与移出场景只影响调度，不改角色卡：被禁言或移出场景的角色不会被选为下一位发言者。这是会话的实时状态，会随存档点一起回滚；改错了可以撤销。',
  /**
   * The instruction a scheduled turn sends: the plan decided WHO, this says it to the model.
   * It is the same kind of text as `play.openingInstruction` — a director's note that goes
   * on the wire and is deliberately NOT written into the transcript as a message.
   */
  'play.schedulerInstruction':
    '现在请以「{name}」的身份发言：接着当前的场景写下去，只写这个角色会说的话与做的事，不要替其他角色或玩家发言。',

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
  /*
   * ── help: the in-app guided tour (C2) ────────────────────────────────────
   *
   * THE NINETEEN SECTIONS MIRROR `docs/07-使用指南.md` SECTION FOR SECTION — same count, same
   * order, same meaning — so a reader can carry the numbering from this tour into the long
   * document. They are a CONDENSATION and not a copy: quoting the guide's own paragraphs here
   * would create a second, silently drifting edition of it. The guide remains the long form, and
   * the tour says where it is (`help.docPointer`).
   *
   * WHY ONE KEY PER SECTION AND NOT ONE PER BULLET: each value is a newline-separated list of
   * points, which the route splits into a `<ul>`. That keeps this block readable, keeps the zh
   * and en listings diffable line by line, and keeps the key count at a size a reviewer can
   * check against the guide's table of contents.
   *
   * WHY SECTION 19 READS THE WAY IT DOES: `docs/07` §19 still says the application-level
   * 「时间与调度」 switch is unimplemented, which stopped being true when ADR-037's switch landed
   * (off by default, turned on in 设置). An in-app help page that repeated the stale sentence
   * would send a reader looking for a control that exists.
   */
  'help.title': '应用内帮助',
  'help.intro':
    '这里用十九节把应用讲一遍：每节几条要点，顺序与仓库里的长文档一致。想读细节时，那篇文档是完整版。',
  'help.documentPreview': '本页是长文档的浓缩版，不是把文档搬进浏览器。',
  'help.docPointer':
    '完整文档在仓库的 `docs/07-使用指南.md`：十九节的编号与本页一一对应，从第 1 节「这是什么」到第 19 节「本指南未覆盖 / 待补」。应用不服务仓库文件，所以这里只给出路径，不做成链接。',
  'help.footer': '本页只讲现在能做什么和暂时做不到什么；以界面与代码为准。',
  'help.sec01Title': '这是什么',
  'help.sec01':
    '本地优先、多端、AI 辅助的角色扮演与 TRPG 工作台，用法是三段式：创建世界 → 创建角色 → 开始扮演。\n' +
    '没有官方后端，也没有账号，你的世界、角色、会话、偏好与密钥都放在这台设备的浏览器数据库里。\n' +
    '模型请求由浏览器直接发给你自己配置的服务，自带密钥。\n' +
    '兼容 SillyTavern 的数据格式，不是复刻它的引擎。\n' +
    '数据契约先于界面，所以有些数据字段在卡片和包里已经存在，界面还没有编辑它的地方。\n' +
    '仍是开发中的版本，功能和界面都会变。',
  'help.sec02Title': '安装与启动',
  'help.sec02':
    '前置条件：Node.js ≥ 22.12.0，以及 pnpm（只用 pnpm，不要与 npm / yarn 混用）。\n' +
    'pnpm install 装依赖，pnpm dev 启动开发服务器，pnpm start 预览构建产物，pnpm build 只构建。\n' +
    'pnpm test 跑测试，pnpm test:watch 是监听模式，pnpm lint 是代码检查，pnpm typecheck 是类型检查，pnpm ci 一次跑完构建前的检查。\n' +
    'pnpm dev 与 pnpm start 会在终端打印本地地址，只在本机提供服务。\n' +
    '桌面壳是可选的，挂载的就是网页这份界面，需要 Rust 工具链与 WebView2 运行时。',
  'help.sec03Title': '首次运行：语言与外观',
  'help.sec03':
    '语言下拉一直在页面顶部，不在设置页里；选项只有中文与 English，语言名用各自的语言书写。\n' +
    '没选过语言时看浏览器偏好，认不出来就回落到中文；选择会存进本机数据库。\n' +
    '切换语言立即生效：界面文案跟着变，已经写进数据的文本（例如会话标题）不会跟着变。\n' +
    '设置页的「外观」一节有三个本机设置：主题（跟随系统 / 亮色 / 暗色）、字号、消息宽度。\n' +
    '这三项与语言存在同一个本机数据库里，与用户数据分开存放。',
  'help.sec04Title': '首次运行：配置模型服务',
  'help.sec04':
    '设置页的「模型服务」是模型请求的唯一入口；配置可以有多份，每份有自己的密钥。\n' +
    '填的是服务地址（Base URL）、API Key 与模型名，地址必须是 http(s) URL；本地服务可以留空密钥。\n' +
    '模型名可以手填，也可以点「获取模型列表」从服务端拉一份，列表只显示前 200 个，输入框始终是自由文本。\n' +
    '当前保存的模型如果不在列表里，会被保留并标记说明，不会悄悄改掉。\n' +
    '「测试连接」只证明这个地址可达、模型列表有响应，不校验模型名是否可用、上下文预算是否够、别的路径上是否有跨域限制。\n' +
    '一份配置可以新增、切换为当前使用、删除；还有会话钉着它时删除会被拒绝，并告诉你被几个会话钉住。',
  'help.sec05Title': '首次运行：密钥加密与解锁',
  'help.sec05':
    '密钥只写进这台设备的数据库，不会进导出包、日志或消息元数据。\n' +
    '默认是明文；设置口令后以 WebCrypto 加密存储，口令至少 8 个字符。\n' +
    '锁定状态发请求会被拒绝；解锁后的密钥只在当前标签页的内存里，刷新后要重新解锁。\n' +
    '口令不会被保存，忘记口令就无法恢复密钥，只能重新填写一次密钥。\n' +
    '口令错误时存储内容不做任何修改，可以无限次重试。\n' +
    '解锁对话框里可以勾选「在这台设备上记住解锁」：记住的是不可导出的密钥而不是口令，记录存在一个独立的数据库里，可以在设置里忘记。',
  'help.sec06Title': '世界卡与角色卡',
  'help.sec06':
    '世界卡库与角色卡库各自有一张新建卡片，填一个名字就可以开始写。\n' +
    '世界卡按分区编辑：基本 / 地区 / 势力 / 规则 / 叙事 / 历法与时间 / 时间节奏 / 开场。\n' +
    '角色卡按分区编辑：SillyTavern 字段 / 发言档案 / 视觉档案 / 默认采样参数，字段名与 SillyTavern V2/V3 保持一致。\n' +
    '角色卡上不保存玩家 / 卡司标记：身份由会话决定，同一张卡可以在不同会话里扮演不同身份。\n' +
    '历法是数据不是常量：一天几小时、一小时几分钟都可以不是 24/60，时段可以跨午夜，起始时刻可以是负数。\n' +
    '自动保存只写草稿，点「发布新版本」才会生成新版本；已发布的版本不可变。\n' +
    '发布前校验不通过会被拒绝并列出问题字段，此时不会产生新版本；「放弃草稿」会回退到已发布版本。\n' +
    '自定义字段存在卡片数据的 customFields 里，字段名就是键，所以改名等于删除后重新添加。\n' +
    '参考图目前只保存资源 ID，应用还不管理图片本身。',
  'help.sec07Title': '创建会话',
  'help.sec07':
    '「新建会话」页把开局要钉住的东西一次选完；身份属于会话，不属于角色卡。\n' +
    '先选世界卡与世界版本：这一步就把版本钉死，该世界之后发新版本也不影响这个会话。\n' +
    '勾选参与的角色卡（至少一张），再指定一张玩家角色；其余勾选的卡自动成为卡司，由 AI 扮演。\n' +
    '提示预设与规则包：目前只有内置预设，也不能绑定规则包。\n' +
    '初始时钟按「自历法纪元起的分钟数」填写，留空就用所选世界版本的起始时刻，必须是整数分钟。\n' +
    '创建失败会明确告诉你「创建失败，没有写入会话」。\n' +
    '模型信息在第一次成功生成时才写进会话，让转录上标注的模型就是实际产出它的那个；采样参数的界面还没有提供。',
  'help.sec08Title': '扮演界面：开场、时钟、消息流',
  'help.sec08':
    '开场面板只在会话还没有第一条消息时出现，三种方式任选：写开场、AI 生成开场、跳过开场；一旦写下就不能再重选，空内容会被拒绝。\n' +
    '「时间」一节即使折叠着，折叠头也会显示当前世界时间（日期，可能带时段名）。\n' +
    '时间推进只有手动这一种：+1 时段、+1 小时、+1 天，以及自定义分钟（可以是负数）；这些控件只在设置页的「时间推进与多角色发言调度」开关打开后才出现。\n' +
    '时钟属于会话状态，会随存档点一起回滚。\n' +
    '每条消息可以「继续写」（只能在角色发言之后续写）、「重新生成」（生成兄弟分支，用上一条 / 下一条切换，切分支不会删掉另一条）、「编辑」与「删除」。\n' +
    '删除只对链尾生效，后面还有内容时会被拒绝，而且是两步确认。\n' +
    '底部输入框写你的行动或台词；发送后可以「停止」正在进行的生成。',
  'help.sec09Title': '状态栏与变量',
  'help.sec09':
    '状态栏是会话级的一组自由变量，类型有文本、数值、布尔三种。\n' +
    '{{getvar}} 读取它，{{setvar}} 赋值，{{addvar}} 做增量；布尔值写 true 或 false。\n' +
    '变量是会话级、扁平的，没有全局 / 角色 / 会话的多级查找链。\n' +
    '数值只接受有限数（空白不是 0，是拒绝），布尔只接受 true / false，文本可以是空串。\n' +
    '写进转录的是算好的绝对值，所以回看历史时看到的就是当时的值。\n' +
    '变量会随存档点一起回滚；让 AI 自己写状态或关系尚未提供。',
  'help.sec10Title': '定点存档、读档与分叉',
  'help.sec10':
    '存档点会记下当前的消息位置、时钟、变量与卡司状态，可以给它起个名字。\n' +
    '读档是一次整体回滚，不会出现「时钟回去了、变量还在现在」这种半吊子状态。\n' +
    '读档不删消息，也不改世界、角色与预设的绑定；也允许存一个「还没有任何消息」的档。\n' +
    '读档与删除都是两步确认，删除一个不存在的存档点不会报错。\n' +
    '分叉会新建一个会话，带着所选位置的消息、时钟、变量与卡司状态，以及此前存档点的副本，原会话完全不受影响。\n' +
    '分叉有两种位置：在当前进度分叉，或从此存档分叉；新会话标题会带「（分叉）」后缀。\n' +
    '存档点已被删除或属于别的会话时，分叉会被拒绝并说明原因。',
  'help.sec11Title': 'AI 共创',
  'help.sec11':
    '与模型讨论一张卡，模型只能提案，不能直接改你的数据。\n' +
    '流程是四步：说要求、看「实时预览」（预览的就是要写进草稿的那份数据）、采纳或否决、把这次采纳撤销回去。\n' +
    '采纳写的是草稿，仍然要再点「发布新版本」才会成为版本。\n' +
    '会让卡片不合法的提案、无法应用的操作、不是可解析提案的回答、动了不该动字段的提案，都会被拒绝，而且草稿不变。\n' +
    '生成模式按步骤写一张卡：每个步骤单独请求一次，逐步骤采纳或否决，可以跳过或停止。\n' +
    '字段级操作只改你选中的那一个字段（重写 / 扩写 / 精简），动到别处会被直接拒绝。\n' +
    '发言档案评估只依据卡片已有内容，并给出理由；卡片内容太少时在本地就拒绝，不发请求。\n' +
    '使用共创前要先在设置里配好模型服务。',
  'help.sec12Title': '卡司干预与发言调度',
  'help.sec12':
    '调度在本地完成，模型无法突破：每轮最多 3 人发言。\n' +
    '单人的条数上限与冷却轮数写在角色卡的发言档案里，按角色生效。\n' +
    '面板会说明下一位发言者及理由，或者本轮没有人可以发言；不能发言的角色也会被点名原因。\n' +
    '手动指派优先于本地打分，被指派的角色会排到你指定的位置。\n' +
    '对任一卡司角色可以禁言 / 解除禁言、移出场景 / 恢复出场，也可以撤销这次干预。\n' +
    '两种干预都只影响调度、不改角色卡，属于会话的实时状态，会随存档点一起回滚。\n' +
    '本节描述的调度与卡司干预都只在设置页的「时间推进与多角色发言调度」开关打开后才存在（默认关闭）；关闭时这三组控件与目录项都不出现，时钟只留下读数。',
  'help.sec13Title': '内容包：导出、导入与示例',
  'help.sec13':
    '顶部导航的「内容包」页是导出、导入与示例内容的唯一入口。\n' +
    '导出会把库里每个世界和角色的最新版本（连同世界书条目）打包成一个 .stpack 文件，由浏览器下载。\n' +
    '导入先显示报告（包名、格式版本，以及逐条实体的新增 / 复用 / 改名 / 跳过），确认之后才写入。\n' +
    '被拒绝的导入不会改动任何数据。\n' +
    '内置示例「长日港 · 末班渡」走的是与你选文件完全相同的一条导入路径，导入后还可以「用示例开局」。\n' +
    '命令行 stpack 写的是 JSON 文件库，与浏览器应用使用的数据库不是同一个库。',
  'help.sec14Title': 'SillyTavern 兼容性',
  'help.sec14':
    '数据层的兼容已经实现并有测试覆盖，但界面里现在没有「导入 / 导出 SillyTavern 文件」的按钮，命令行工具也没有这条命令。\n' +
    '角色卡 JSON 能读 SillyTavern V1/V2/V3 卡，也能写回。\n' +
    '角色卡 PNG：卡片 JSON 放在 tEXt 块里，读的时候优先用 ccv3 块，没有再退回 chara，并会报告用的是哪一个。\n' +
    '导出一张 PNG 必须给底图，没有底图时不产出任何字节；给了底图时其余数据块按原样保留。\n' +
    '世界书两种写法都读：独立的 world_info 文件，以及卡片里的 character_book。\n' +
    '不认识的字段原样保留并在导入报告里逐条点名；已知的两处语义缺口（constant 恒注入、conditions 条件注入）也会被报告。',
  'help.sec15Title': '数据存在哪里',
  'help.sec15':
    '数据在浏览器数据库里，按站点隔离：换地址、换浏览器、换设备都是另一个空库。\n' +
    '清空站点数据或换浏览器就等于数据没了，要搬到别处只能导出内容包再导入；应用没有官方同步服务，也没有云备份。\n' +
    '库里按集合存放不同种类的行；界面目前用到的是其中一部分，有些集合已经定义好但还没有界面在用。\n' +
    '设置行里放着本机偏好与草稿：语言、主题、字号、消息宽度、模型服务配置、默认使用哪一份，以及世界卡与角色卡的草稿。\n' +
    '密钥的加密行与用户数据在一起，而「在这台设备上记住解锁」的记录放在另一个独立的数据库里。',
  'help.sec16Title': '命令行工具 stpack',
  'help.sec16':
    '仓库里有一个命令行工具，用 pnpm stpack -- <参数> 调用。\n' +
    'stpack validate 检查一个包，stpack inspect 打印摘要与内容列表，stpack unpack 把包解到目录。\n' +
    'stpack import 导入到一个 JSON 文件库并打印报告，stpack example 生成内置示例内容包。\n' +
    '常用选项：--json、--force、--dry-run、--select a,b 与 -h。\n' +
    '退出码 0 成功、1 包不合法或导入被拒、2 用法错误、3 读写失败。\n' +
    '要记住：stpack import 的目标是 JSON 文件库，不是应用使用的浏览器数据库，命令行导入的内容不会出现在应用界面里。',
  'help.sec17Title': '常见问题',
  'help.sec17':
    '密钥被锁定：这条配置的密钥已加密而当前标签页没有解锁，点提示里的「解锁」输入口令即可。\n' +
    '口令忘了无法恢复，只能在设置里重新填写一次密钥。\n' +
    '「测试连接」成功但生成仍失败：逐条排除解锁状态、模型名是否与服务的实际名称一致、是否超出上下文预算、别的请求路径上的浏览器来源限制。\n' +
    '同一个 .stpack 文件可以重复导入：文件选择框每次选择后都会被重置。\n' +
    '导入被拒绝时库不会变；消息删不掉是因为它后面还有内容；读档不会删消息；分叉不影响原会话。\n' +
    '某份配置删不掉，是因为还有会话钉着它，提示里会说明被几个会话钉住。\n' +
    '改了卡片版本号没变，是因为自动保存只写草稿。\n' +
    '不能直接输入网址打开某一页：应用用的是内存路由，地址栏里没有可分享的页面地址。',
  'help.sec18Title': '开发者：本地验证与约定',
  'help.sec18':
    'pnpm ci:local 按 lockfile → lint → typecheck → test → build 的顺序跑完本地 CI，任何一步失败就停下并打印汇总；也可以只跑子集。\n' +
    '依赖方向只有一条：packages/schema ← packages/core ← 适配器包 ← apps/*，由脚本真实遍历 import 图强制。\n' +
    '界面文案必须写进目录，不许在界面代码里硬编码中文；检查命令是 pnpm check:i18n。\n' +
    '语言名用各自语言书写（中文 / English），刻意不翻译；界面文案与模型提示词是两件事，开发日志写英文。\n' +
    '背景文档：需求规格、技术架构、决策记录、分享格式规范与工程约定都按编号放在仓库的 docs 目录下。',
  'help.sec19Title': '本指南未覆盖 / 待补',
  'help.sec19':
    '提示预设的编辑器：现在只能用内置预设，不能新建或导入预设。\n' +
    '规则包：会话模板里没有可绑定的规则包，骰点、检定与检索属于规则层，尚未提供。\n' +
    '世界书的编辑界面：条目能随内容包导入导出，但应用里还没有编辑它们的页面。\n' +
    '资源（图片）管线：参考图只保存资源 ID，没有生图流程，相关字段只是数据。\n' +
    '记忆与日程：存储里已经留了集合，界面还没有用它们的地方。\n' +
    '让 AI 自己写状态或关系（例如自动更新变量、好感度）。\n' +
    'SillyTavern 文件的导入 / 导出入口：映射层已实现并有测试，但界面与命令行都没有暴露这条操作。\n' +
    '「时间与调度」的应用级开关：已经落地在设置页（默认关闭），打开后时间可手动推进、时钟读数进入每回合提示、本地调度器决定发言者；仍未接线的是卡片数据里那套「自动推进时间」的节奏字段。\n' +
    '主题包、更多界面语言，以及桌面端的打包与发布细节（安装包签名、更新机制）。\n' +
    '术语的悬停提示：标签上的术语（宏、世界书、token、发言调度等）还没有悬停解释；应用内的「帮助」页与本指南是唯一的解释入口。',

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
  /*
   * WHY THIS ONE CARRIES `{detail}` AND NO LONGER NAMES THE MODEL (A3)
   * The sentence used to guess at the cause — 「请检查模型名」 — while the adapter
   * already knew better: `failureEvent` composes `HTTP {status}: {label} ({the
   * vendor's own words})` out of the response it actually received, and
   * `invalid_request` is the class for EVERY 4xx that is not auth, rate limiting or
   * moderation, so the guess was wrong as often as it was right (the reported bug:
   * 测试连接 succeeded, co-create failed, and the message blamed the model name).
   * `docs/02` §5.3 requires 提示用户并可重试, which needs the fact and not a guess, so
   * the co-create path fills `{detail}` with that composed sentence while the CODE
   * still selects this key (ADR-019). The play path passes no detail — ADR-019 keeps
   * a provider's `message` out of its banner — so the sentence must also stand alone.
   */
  'error.invalidRequest': '服务端拒绝了这次请求。{detail}',
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
   *
   * IT NO LONGER SAYS "GO TO SETTINGS" (Phase A2): the unlock dialog is offered right here, on
   * the banner that shows this sentence, because the first manual acceptance test showed that
   * "go to another screen" is not an answer a user can act on mid-turn.
   */
  'error.keyLocked': '密钥已加密且处于锁定状态：点下面的「解锁」并输入口令即可继续',
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
  'common.cancel': 'Cancel',
  'common.add': 'Add',
  'common.listSeparator': ', ',
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
  /* The section chrome (acceptance fix B1) — see the zh-CN block for why it is `common.`. */
  'common.sectionsTitle': 'Sections',
  'common.sectionExpand': 'Expand “{name}”',
  'common.sectionCollapse': 'Collapse “{name}”',

  /* ── nav ────────────────────────────────────────────────────────────────── */
  'nav.language': 'Language',
  'nav.settings': 'Settings',
  'nav.worlds': 'Worlds',
  'nav.characters': 'Characters',
  'nav.sessions': 'Sessions',
  'nav.currentSession': 'Back to the current session',
  'nav.packs': 'Content packs',
  'nav.help': 'Help',

  /* ── pack ───────────────────────────────────────────────────────────────── */
  'pack.title': 'Content packs',
  'pack.hint':
    'Export this library to one .stpack file, or import one from a file or the built-in example. An import shows its report first and writes only once you confirm.',
  'pack.exampleWhy':
    'The built-in example (长日港 · 末班渡) is built in process and imported through exactly the same path as a file you pick. The stpack command-line tool writes a JSON-file library, which is not the IndexedDB database this app uses, so the app needs an entry of its own.',
  'pack.exportTitle': 'Export',
  'pack.exportHint':
    'Package the newest version of every world and character in this library, with its worldbook entries, into one .stpack file.',
  'pack.exportButton': 'Export content pack',
  'pack.exportEmpty':
    'This library holds no world and no character yet, so there is nothing to export.',
  'pack.exported': 'Exported {name}',
  'pack.exportFailed': 'Export failed: {detail}',
  'pack.importTitle': 'Import',
  'pack.importHint':
    'Pick a .stpack file. Its report is shown first and nothing is written until you confirm; a refused import changes nothing at all.',
  'pack.chooseFile': 'Choose a file…',
  'pack.importExample': 'Import the example content pack',
  'pack.previewTitle': 'Import report (nothing written yet)',
  'pack.previewHint':
    'This is the change the import would make. Nothing is written until you confirm.',
  'pack.confirm': 'Confirm import',
  'pack.cancel': 'Cancel',
  'pack.resultTitle': 'Import result',
  'pack.resultHint': 'The rows listed above have been written.',
  'pack.refused': 'This package cannot be imported; the library is unchanged.',
  'pack.findings': 'Findings',
  'pack.noFindings': 'No findings.',
  'pack.packageLine': '{name} ({kind}, format version {formatVersion})',
  'pack.counts': 'created {created} · reused {reused} · remapped {remapped} · skipped {skipped}',
  'pack.importedTitle': 'Imported worlds and characters',
  'pack.entityWorld': 'World',
  'pack.entityWorldbook': 'Worldbook entry',
  'pack.entityCharacter': 'Character',
  'pack.entityPromptPreset': 'Prompt preset',
  'pack.entitySession': 'Session',
  'pack.entityMessage': 'Message',
  'pack.entityCheckpoint': 'Checkpoint',
  'pack.entityAgenda': 'Agenda',
  'pack.entityMemory': 'Memory',
  'pack.actionCreated': 'created',
  'pack.actionReused': 'reused',
  'pack.actionRemapped': 'remapped',
  'pack.actionSkipped': 'skipped',
  'pack.openWorlds': 'Open the world library',
  'pack.openCharacters': 'Open the character library',
  'pack.startExample': 'Start the example session',
  'pack.startExampleHint':
    'Create a session from the rows just imported, using the pairing the example pack suggests (长日港, playing 沈砚).',
  'pack.startExampleUnavailable':
    'The example rows are not in this library, so the example session cannot be started.',
  'pack.startFailed': 'Could not create the session: {detail}',
  'pack.fileUnreadable': 'Could not read this file: {detail}',

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
  'setup.featureTitle': 'Features',
  'setup.featureTimeAndSchedulingLabel': 'Time advance and multi-speaker scheduling',
  'setup.featureTimeAndSchedulingHint':
    'On: time can be advanced by hand, each turn carries the world’s current moment, and the local scheduler decides who speaks. Off (the default): none of the three take part — no moment in the prompt, and no scheduler choosing speakers.',

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
  'setup.unlockTitle': 'Unlock the key',
  'setup.unlockHint':
    'Enter this configuration passphrase to send requests. The passphrase is not saved.',
  'setup.unlockTarget': 'This configuration: {provider}',
  'setup.rememberLabel': 'Remember the unlock on this device',
  'setup.rememberHint':
    'Only the unlocked key is remembered (a non-extractable WebCrypto key); the passphrase is never saved. You can forget this device unlock in Settings.',
  'setup.rememberForget': 'Forget this device unlock',
  'setup.rememberRevoked':
    'This device unlock was forgotten. The stored key is unchanged and the passphrase still opens it.',
  'setup.providersTitle': 'Model services',
  'setup.providersHint':
    'You can save several service configurations, each with its own key. A new session pins the selected one, and a configuration a session pins cannot be deleted.',
  'setup.providerAdd': 'Add configuration',
  'setup.providerActive': 'In use',
  'setup.providerUse': 'Switch to this configuration',
  'setup.providerDelete': 'Delete this configuration',
  'setup.providerKeyMissing': 'No key stored yet',
  'setup.providerRemembered': 'Unlock remembered on this device',
  'setup.providerDeleteConfirm': 'Confirm delete',
  'setup.providerDeleteRefused':
    'Cannot delete: {count} sessions pin this configuration ({titles}). Switch those sessions to another configuration first.',
  'setup.providerDeleted': 'This configuration was deleted',

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
  'session.nameLabel': 'Session name',
  'session.namePlaceholder': 'For example: the first night in Mistport',
  'session.nameHint':
    'Leaving this blank stores the default name “{default}”; at most 200 characters.',
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
  'session.nameRequired': 'A session name cannot be empty',
  'session.nameTooLong': 'A session name has at most 200 characters',
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
  /** Level ③ of docs/02 §5.3's ladder was spent on this turn (A3); the zh-CN side records why. */
  'co-create.degradedRequest':
    'The server refused the response-format constraint, so this turn was retried as an ordinary request and the answer is no longer guaranteed to be a proposal.',
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
  'play.sessionTitle': 'This session',
  'play.nameSubmit': 'Save name',
  'play.nameChanged': 'Renamed to “{name}”',
  'play.nameFailed': 'The session was not renamed; nothing was written',
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
  'play.clockTitle': 'Time',
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
  'play.forkTitle': 'Fork the timeline',
  'play.forkHint':
    'A fork creates a new session: it carries the messages, clock, variables and cast state of the chosen position, plus copies of the earlier save points. The session you are in is not affected at all, and every reference inside the new one points at its own messages.',
  'play.forkAtHead': 'Fork from right now',
  'play.forkAtCheckpoint': 'Fork from this save point',
  'play.forkConfirm': 'Confirm fork',
  'play.forkNoSavePoints': 'No save points yet; you can still fork from right now at any moment.',
  'play.forkRefused': 'Could not fork: that save point is gone, or belongs to another session.',
  'play.forkSuffix': ' (fork)',
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
  'play.schedulerTitle': 'Turn scheduling',
  'play.schedulerHint':
    'The local scheduler orders the cast by desire and ability and enforces the hard caps: at most {speakers} speakers per round, while lines per round and cooldown come from each card. The model cannot override them.',
  'play.schedulerNext': 'Next to speak: {name} ({reason})',
  'play.schedulerNobody': 'Nobody can take a turn in this round.',
  'play.schedulerEmptyCast': 'This session has no cast yet, only the player character.',
  'play.schedulerRefused': '{name} cannot speak right now ({reason})',
  'play.schedulerSpeak': 'Give them the turn',
  'play.schedulerCastTitle': 'Cast',
  'play.schedulerSelectable': 'Can speak',
  'play.schedulerAssign': 'Assign',
  'play.schedulerAssignLabel': 'Assign the turn to {name}',
  'play.schedulerUnknownCard': 'card no longer in the library',
  'play.schedulerBusy': 'The previous reply is still being written. Stop it or wait for it.',
  'play.schedulerOff': 'Time advance and turn scheduling are off in settings',
  'play.schedulerReasonManual': 'you placed them at position {position} in your order',
  'play.schedulerReasonScore': 'desire {desire} / ability {ability}, the highest of the candidates',
  'play.schedulerExcludedCapped': 'line limit reached this round ({lines}/{limit})',
  'play.schedulerExcludedCooling': 'cooling down: {remaining} more round(s) at cooldown {cooldown}',
  'play.schedulerExcludedSpeakerCap': 'this round already has its maximum of {limit} speakers',
  'play.schedulerExcludedCardMissing':
    'the pinned card version is no longer in the library, so its voice profile cannot be read',
  'play.schedulerExcludedNotInCast': 'they are not in the cast of this session',
  'play.schedulerExcludedAbsent': 'you took them off stage',
  'play.schedulerExcludedMuted': 'you muted them',
  'play.castMute': 'Mute',
  'play.castUnmute': 'Unmute',
  'play.castAbsent': 'Take off stage',
  'play.castPresent': 'Bring back on stage',
  'play.castMuteConfirm': 'Confirm mute',
  'play.castAbsentConfirm': 'Confirm off stage',
  'play.castInterventionTitle': 'Cast intervention',
  'play.castMuteLabel': 'Mute {name}: they stay on stage but are never scheduled to speak',
  'play.castUnmuteLabel': 'Unmute {name} so they take part in scheduling again',
  'play.castAbsentLabel': 'Take {name} off stage so they take no part in this round',
  'play.castPresentLabel': 'Bring {name} back on stage so they take part in scheduling again',
  'play.castStateMuted': 'Muted',
  'play.castStateAbsent': 'Off stage',
  'play.castMuteHint': 'Muted characters stay on stage, but the scheduler never picks them.',
  'play.castAbsentHint': 'A character off stage takes no part in the round and is never picked.',
  'play.castStateNone': 'Can speak',
  'play.castIntervened': 'Cast state updated: {name}',
  'play.castRestore': 'Undo this intervention',
  'play.castRestored': 'Restored the cast to the state before that intervention',
  'play.castRestoreNothing': 'There is no intervention to undo',
  'play.castInterventionHint':
    'Muting and taking a character off stage affect scheduling only, never the card: a muted or off-stage character is not chosen as the next speaker. This is live session state, so a save point rolls it back too, and a mistake can be undone here.',
  'play.schedulerInstruction':
    'Now speak as {name}: continue the current scene and write only what this character says and does. Do not speak for any other character or for the player.',
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
  /* ── help: the in-app guided tour (C2); see the zh block for why it is shaped this way ── */
  'help.title': 'In-app help',
  'help.intro':
    'Nineteen short sections walk through the application: a few points each, in the same order as the long document in the repository. That document is the full version when you want the details.',
  'help.documentPreview':
    'This page condenses the long document; it does not render it in the browser.',
  'help.docPointer':
    'The full document lives in the repository at `docs/07-使用指南.md`: its nineteen sections are numbered exactly like this page, from section 1, “这是什么”, to section 19, “本指南未覆盖 / 待补”. The application does not serve repository files, so this is the path itself and not a link.',
  'help.footer':
    'This page covers what works today and what does not yet; the interface and the code are the authority.',
  'help.sec01Title': 'What this is',
  'help.sec01':
    'A local-first, multi-device, AI-assisted role-play and TRPG workbench. The shape is: create a world → create characters → start playing.\n' +
    'There is no official backend and no account: your worlds, characters, sessions, preferences and keys live in this device’s browser database.\n' +
    'Model requests go from the browser straight to a service you configure, with your own key.\n' +
    'It is compatible with SillyTavern’s data formats, not a copy of its engine.\n' +
    'The data contract comes before the interface, so some fields already exist in cards and packages while the interface has nowhere to edit them yet.\n' +
    'This is still a version in development: features and screens will change.',
  'help.sec02Title': 'Install and start',
  'help.sec02':
    'Requirements: Node.js ≥ 22.12.0, and pnpm (pnpm only — do not mix it with npm or yarn).\n' +
    'pnpm install installs dependencies, pnpm dev starts the dev server, pnpm start previews a build, pnpm build only builds.\n' +
    'pnpm test runs the tests, pnpm test:watch watches, pnpm lint checks the code, pnpm typecheck checks types, pnpm ci runs the pre-build checks in one go.\n' +
    'pnpm dev and pnpm start print a local address in the terminal and serve this machine only.\n' +
    'The desktop shell is optional: it mounts this same web interface and needs a Rust toolchain and the WebView2 runtime.',
  'help.sec03Title': 'First run: language and appearance',
  'help.sec03':
    'The language picker always sits in the page header, not in the settings page; the options are 中文 and English, each written in its own language.\n' +
    'Before you have chosen, the browser’s preference is used, falling back to Chinese when it cannot be recognised; the choice is stored in this device’s database.\n' +
    'Switching language takes effect immediately for the interface, but text already written into data (a session title, for example) does not change.\n' +
    'The Appearance section of the settings page has three local settings: theme (follow the system / light / dark), font size and message width.\n' +
    'Those three live in the same local database as the language and are kept apart from your user data.',
  'help.sec04Title': 'First run: configuring a model service',
  'help.sec04':
    'Model services in the settings page is the only entry point for model requests; you can keep several configurations, each with its own key.\n' +
    'You fill in a service address (Base URL), an API key and a model name; the address must be an http(s) URL, and a local service may leave the key blank.\n' +
    'The model name can be typed, or you can fetch the endpoint’s list — only the first 200 are shown, and the field always stays free text.\n' +
    'If the model you have saved is not in that list it is kept and flagged, never silently replaced.\n' +
    'Test connection only proves the address is reachable and the model list answers; it does not check that the model name is usable, that the context budget is enough, or that no cross-origin limit applies to other paths.\n' +
    'A configuration can be added, switched to, or deleted; deletion is refused while sessions still pin it, and the refusal says how many and which.',
  'help.sec05Title': 'First run: encrypting and unlocking keys',
  'help.sec05':
    'A key is written only to this device’s database: it never enters an export package, a log or message metadata.\n' +
    'Keys are plain text by default; setting a passphrase stores them encrypted with WebCrypto, and the passphrase is at least 8 characters.\n' +
    'While locked, requests are refused; an unlocked key lives only in this tab’s memory, so a refresh locks it again.\n' +
    'The passphrase is never saved, and forgetting it means the key cannot be recovered — you simply enter the key again.\n' +
    'A wrong passphrase changes nothing that is stored, so you can retry as often as you like.\n' +
    'The unlock dialog offers “remember the unlock on this device”: it remembers the non-exportable key rather than the passphrase, in a separate database, and Settings can forget it.',
  'help.sec06Title': 'World cards and character cards',
  'help.sec06':
    'The world library and the character library each offer a new card; a name is enough to begin.\n' +
    'A world card is edited in sections: basic / regions / factions / rules / narrative / calendar and time / time rhythm / opening.\n' +
    'A character card is edited in sections: SillyTavern fields / speaking profile / visual profile / default sampling parameters, and its field names match SillyTavern V2/V3.\n' +
    'A character card carries no player/cast marker: that belongs to the session, so one card can be the player in one session and a cast member in another.\n' +
    'The calendar is data, not a constant: a day need not have 24 hours nor an hour 60 minutes, a segment may cross midnight, and the starting moment may be negative.\n' +
    'Autosave writes a draft only; Publish a new version is what creates a version, and published versions are immutable.\n' +
    'A failed validation refuses the publish and lists the fields, creating no version; Discard draft returns to the published version.\n' +
    'Custom fields live in the card’s customFields, where the field name is the key — so renaming means deleting and adding again.\n' +
    'Reference images currently store an asset id only; the application does not manage the images themselves yet.',
  'help.sec07Title': 'Creating a session',
  'help.sec07':
    'The new-session page pins everything an opening needs in one pass; identity belongs to the session, not to the card.\n' +
    'Choose the world card and world version first: that pins the version, so later versions of that world do not affect this session.\n' +
    'Tick the character cards that take part (at least one) and designate one as the player; the rest automatically become the cast, played by the AI.\n' +
    'Prompt presets and rule packs: only built-in presets exist so far, and no rule pack can be bound.\n' +
    'The initial clock is entered as minutes since the calendar’s epoch; leaving it blank uses the chosen world version’s starting moment, and it must be a whole number of minutes.\n' +
    'A failed creation says so plainly: nothing was written.\n' +
    'The model is recorded on the first successful generation, so the transcript names the model that actually produced it; sampling parameters have no interface yet.',
  'help.sec08Title': 'The play screen: opening, clock, message stream',
  'help.sec08':
    'The opening panel appears only while the session has no first message, and offers three ways to start: write the opening, generate one, or skip it; once it is written it cannot be chosen again, and empty text is refused.\n' +
    'The “time” section shows the world time (a date, with the segment name when there is one) in its fold header, even while it is folded.\n' +
    'Time is advanced by hand only: +1 segment, +1 hour, +1 day, or a custom number of minutes, including negative amounts; those controls appear only once the “time advance and multi-speaker scheduling” switch on the settings page is on.\n' +
    'The clock is part of the session state, so it rolls back together with a save point.\n' +
    'Each message offers Continue writing (only after a character’s turn), Regenerate (a sibling branch, switched with previous/next, and switching never deletes the other one), Edit, and Delete.\n' +
    'Delete works on the tip of the chain only: it is refused while anything follows the message, and it takes two clicks.\n' +
    'The box at the bottom is where you write your action or line; a running generation can be stopped.',
  'help.sec09Title': 'The status bar and variables',
  'help.sec09':
    'The status bar is a session-level set of free variables, of type text, number or boolean.\n' +
    '{{getvar}} reads one, {{setvar}} assigns it and {{addvar}} adds to it; booleans are written true or false.\n' +
    'Variables are session-level and flat — there is no global/character/session lookup chain.\n' +
    'A number must be finite (blank is a refusal, not 0), a boolean must be true or false, and text may be empty.\n' +
    'What reaches the transcript is the resolved value, so reading history shows the value of that moment.\n' +
    'Variables roll back with a save point; letting the AI write state or relationships is not available yet.',
  'help.sec10Title': 'Save points, loading and forking',
  'help.sec10':
    'A save point records the current message position, clock, variables and cast state, and can be given a name.\n' +
    'Loading one rolls the whole session back, so you never get a half-rolled state such as an old clock beside current variables.\n' +
    'Loading deletes no messages and changes no world, character or preset binding; a save point before any message is allowed too.\n' +
    'Loading and deleting both take two clicks, and deleting a save point that is already gone does not error.\n' +
    'A fork creates a new session carrying the messages, clock, variables and cast state of the chosen position plus copies of the earlier save points; the original session is untouched.\n' +
    'You can fork at the current position or from a save point, and the new session’s title carries a fork suffix.\n' +
    'A fork is refused, with the reason, when the save point is gone or belongs to another session.',
  'help.sec11Title': 'AI co-creation',
  'help.sec11':
    'This is a discussion with the model about one card, and the model can only propose — it never edits your data directly.\n' +
    'Four steps: say what you want, read the live preview (the very data that would be written to the draft), accept or reject, and undo the acceptance if you change your mind.\n' +
    'Accepting writes to the draft, so Publish a new version is still needed before it becomes a version.\n' +
    'A proposal that would make the card invalid, an operation that cannot be applied, an unparseable answer, or a change to a field this request must not touch are all refused, and the draft is left unchanged.\n' +
    'Generation mode writes a card step by step: each step is its own request, accepted or rejected one at a time, and can be skipped or stopped.\n' +
    'A field-level action changes one chosen field only (rewrite / expand / shorten); a proposal that touches anything else is refused.\n' +
    'The speaking-profile assessment works from the card’s existing content and gives its reasons; too little content is refused locally without a request.\n' +
    'Co-creation needs a configured model service first.',
  'help.sec12Title': 'Cast intervention and turn scheduling',
  'help.sec12':
    'Scheduling happens locally and the model cannot exceed it: at most 3 speakers per round.\n' +
    'A character’s line cap and cooldown rounds live in that card’s speaking profile.\n' +
    'The panel names the next speaker with the reason, or says that nobody can speak this round; a character who cannot be chosen is told why.\n' +
    'A manual assignment outranks the local score and puts the character where you put them.\n' +
    'Any cast member can be muted/unmuted or taken off stage/brought back, and the intervention can be undone.\n' +
    'Both interventions affect scheduling only and never the card; they are live session state and roll back with a save point.\n' +
    'Everything this section describes — the scheduler and the cast interventions — exists only while the “time advance and multi-speaker scheduling” switch on the settings page is on (it is off by default); while it is off, those three sections and their table-of-contents entries do not appear at all, and the clock is left as a reading.',
  'help.sec13Title': 'Content packs: export, import and the example',
  'help.sec13':
    'The Content packs page in the top navigation is the only entry point for exporting, importing and the built-in example.\n' +
    'Exporting packs the latest version of every world and character (with their worldbook entries) into one .stpack file, which the browser downloads.\n' +
    'Importing shows a report first — package name, format version, and each entity as created / reused / remapped / skipped — and writes only after you confirm.\n' +
    'A refused import changes no data at all.\n' +
    'The built-in example, 长日港 · 末班渡, travels the exact same import path as a file you choose, and can be followed by “start with the example”.\n' +
    'The command-line stpack tool writes a JSON-file library, which is not the database the browser application uses.',
  'help.sec14Title': 'SillyTavern compatibility',
  'help.sec14':
    'The data layer is compatible and covered by tests, but the interface has no import/export button for SillyTavern files yet, and the command-line tool has no such command either.\n' +
    'Character-card JSON reads SillyTavern V1/V2/V3 cards and writes back.\n' +
    'A character-card PNG keeps its JSON in a tEXt chunk; reading prefers the ccv3 chunk, falls back to chara, and reports which one it used.\n' +
    'Writing a PNG requires a base image, and without one not a single byte is produced; with one, every other chunk is preserved byte for byte.\n' +
    'World books are read in both shapes: a standalone world_info file, and a card’s character_book.\n' +
    'Unknown fields are preserved and named in the import report, and the two known semantic gaps (SillyTavern’s always-injected constant, our conditions) are reported as well.',
  'help.sec15Title': 'Where the data lives',
  'help.sec15':
    'Data lives in the browser database, isolated per site: another address, another browser or another device is another empty database.\n' +
    'Clearing site data or changing browser therefore means the data is gone, and the only way to move it is to export a content pack and import it; there is no official sync service and no cloud backup.\n' +
    'The database stores different kinds of row in collections; the interface uses some of them today, while others are defined but unused.\n' +
    'The settings rows hold local preferences and drafts: language, theme, font size, message width, model-service configurations, which one is the default, and the world and character drafts.\n' +
    'The encrypted key row sits with your user data, while the “remember the unlock on this device” record lives in a separate database.',
  'help.sec16Title': 'The command-line tool stpack',
  'help.sec16':
    'The repository ships a command-line tool, invoked as pnpm stpack -- <arguments>.\n' +
    'stpack validate checks a package, stpack inspect prints a summary and its contents, and stpack unpack unpacks it into a directory.\n' +
    'stpack import imports into a JSON-file library and prints a report, and stpack example generates the built-in example package.\n' +
    'Common options: --json, --force, --dry-run, --select a,b and -h.\n' +
    'Exit codes: 0 success, 1 invalid package or refused import, 2 usage error, 3 read/write failure.\n' +
    'Remember: stpack import targets a JSON-file library, not the browser database the application uses, so what you import there never appears in the interface.',
  'help.sec17Title': 'Frequently asked questions',
  'help.sec17':
    'A key is locked: that configuration’s key is encrypted and this tab has not unlocked it — use the Unlock control in the notice and enter the passphrase.\n' +
    'A forgotten passphrase cannot be recovered: enter the key again in the settings page.\n' +
    'Test connection succeeds but generation still fails: rule out the lock state, a model name that differs from the service’s real one, a context budget that is too small, and browser origin limits on other paths.\n' +
    'The same .stpack file can be imported again because the file picker is reset after every choice.\n' +
    'A refused import changes nothing; a message cannot be deleted while content follows it; loading a save point deletes no messages; a fork leaves the original session alone.\n' +
    'A configuration that refuses to be deleted is still pinned by sessions, and the notice names how many and which.\n' +
    'A card’s version number does not change on edit because autosave writes a draft only.\n' +
    'A page cannot be opened by typing a URL: the router is in memory, so the address bar holds no shareable page address.',
  'help.sec18Title': 'Developer: local verification and conventions',
  'help.sec18':
    'pnpm ci:local runs the local CI in the order lockfile → lint → typecheck → test → build, stopping at the first failure and printing a summary; a subset of steps works too.\n' +
    'There is exactly one allowed dependency direction: packages/schema ← packages/core ← the adapter packages ← apps/*, enforced by a script that really walks the import graph.\n' +
    'Interface copy must live in the catalog — no hard-coded Chinese in interface code; the check is pnpm check:i18n.\n' +
    'Language names are written in their own language (中文 / English) and deliberately not translated; interface copy and model prompts are two different things, and development logs are written in English.\n' +
    'Background documents — requirements, architecture, decision records, the sharing format and the engineering conventions — are numbered in the repository’s docs directory.',
  'help.sec19Title': 'Not covered yet / to come',
  'help.sec19':
    'A prompt-preset editor: only built-in presets exist, and presets cannot be created or imported yet.\n' +
    'Rule packs: a session template has none to bind, and dice, checks and retrieval belong to a rules layer that is not provided yet.\n' +
    'A worldbook editing screen: entries travel with content packs, but the application has no page to edit them.\n' +
    'The asset (image) pipeline: a reference image stores an asset id only, there is no generation flow, and the related fields are data only.\n' +
    'Memory and agenda: the collections are defined in storage, but no screen uses them yet.\n' +
    'Letting the AI write state or relationships (updating variables or affinity automatically, for example).\n' +
    'An import/export entry point for SillyTavern files: the mapping layer is implemented and tested, but neither the interface nor the command line exposes it.\n' +
    'The application-level “time and scheduling” switch: it has landed on the settings page (off by default), and once it is on, time can be advanced by hand, the clock reading enters every turn’s prompt, and the local scheduler decides who speaks; what is still unwired is the card data’s own “advance time automatically” rhythm.\n' +
    'Theme packs, more interface languages, and the desktop packaging and release details (installer signing, the update mechanism).\n' +
    'Hover explanations for jargon: labels carry no tooltip for terms such as macros, worldbooks, tokens or the speaker scheduler; the in-app Help page and this guide are the only places that explain them.',

  /* ── error ──────────────────────────────────────────────────────────────── */
  'error.auth': 'The API key was rejected. Check it in Settings.',
  'error.rateLimit': 'Too many requests. Try again in a moment.',
  'error.network': 'Cannot reach the service. Check the address and the network.',
  'error.contentFilter': 'The request was blocked by content moderation.',
  'error.invalidRequest': 'The server rejected this request. {detail}',
  'error.invalidResponse': 'The server returned a response we cannot read.',
  'error.unknown': 'An unknown error occurred.',
  'error.notInitialized': 'The app has not finished starting up.',
  'error.notConfigured': 'Enter the endpoint and model name in Settings first.',
  'error.localFailure': 'Unknown local error.',
  'error.promptBudget': 'This request is over the model budget, so it was not sent. {detail}',
  'error.keyLocked':
    'The key is encrypted and locked. Choose Unlock below and enter the passphrase to continue.',
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
