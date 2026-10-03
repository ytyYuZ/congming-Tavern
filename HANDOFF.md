# SmartTavern 交接说明（致后续开发 AI）

- 交接时间：2026-09-26（**2026-10-02 更新：M1 已完成**，见 §0）
- 交接时状态：**只有文档，零代码**；`git` 尚未初始化；无 `package.json` / `node_modules`
  （**2026-10-02 实际状态：M0 与 M1 共 26 行全部落地并推送**，`pnpm ci:local` 五步全绿，
  仓库级 116 个测试文件 / 1579 个用例；当前版本 v0.16，ADR 至 036）
- 工作区：`D:\SmartTavern`（Windows，PowerShell 环境）
- 本文档用途：让你在 15 分钟内掌握全局，并知道第一行代码该写什么

---

## 0. 30 秒速览

**项目**：SmartTavern —— 本地优先、多端运行、AI 辅助的一站式角色扮演与 TRPG 工作台。
以「创建世界 → 创建角色 → 开始扮演」三段式组织流程，兼容 SillyTavern 生态数据格式，
并把 AI 生图、TRPG 规则速查、**发言调度**、**时间与日程**、存档与版本迭代纳入同一条工作流。

**当前进度（2026-10-02）**：**M1 的 26 行全部落地**（`docs/06` §10 是逐行的状态与验收索引）。
界面能构建、能启动，但**本会话无人真正打开过它**（界面证据全是 jsdom），所以"第一次人工验收"
本身就是待办之一。已知缺口逐条记在 `docs/06` §10.5。

**最重要的一条原则**：**数据契约先于界面**。先把 `packages/schema` 和包格式写对，
再写任何编辑器 UI。schema 的返工成本远高于 UI。

**下次开工的待办**：

1. **一键启动** —— **已实现（2026-10-02）**：根目录 `pnpm start`（先构建再 `preview`，会打印 URL）与
   `pnpm dev`（开发服务器 + HMR）。**仓库侧脚本是可移植的**；本机（沙箱）需要的两个环境变量与 vite 探测
   shim，放在**未跟踪**的 `.local-appdata/start.ps1` 里 —— `pwsh -File .local-appdata/start.ps1`，
   或加 `-Dev` 走开发服务器。主机细节仍然不进受版本控制的文件。
2. **正在执行：首次人工验收的修复计划（已获用户批准）** ——
   **阶段 A（让"能用"成立）**：①导航（进了世界卡/角色卡/设置就回不到会话）②密钥（解锁随处可得 +
   用户要求的可选项"在这台设备上记住解锁" + **实现 ADR-034 多 Provider**，从而能新建并切换）③共创报错
   变诚实并按 `docs/02` §5.3 的降级阶梯回退 ④包导入导出界面 + 一键导入示例内容包 ⑤会话命名（创建时可填、
   之后可改）⑥一键启动（本条，已完成）。
   **阶段 B（界面重排）**：编辑器按类别折叠并按重要程度排序、按分组拆成子界面；会话把对话记录与输入框放到
   第一位置，其余进可折叠侧栏 / HUD。
   **阶段 C（可选化与帮助）**：时间推进与发言调度改为**默认关闭的应用级开关**（关掉时同时不注入内置预设的
   时间块）；新增 `/help` 与使用指南。
3. **首次人工验收的另一半**：界面观感 / 布局 / 手感（本会话无人看过，全部是 jsdom 证据），
   以及浏览器侧的导入包入口 —— 后者正是阶段 A 的 ④。
4. **`docs/06` §10.5 里那十条已记录的缺口**：其中"规则包与预设尚无可持久化的形状"和"`TurnScheduler`
   暂住 `apps/web` 而 `docs/02` §5.6 说引擎层"最值得先做决定。
5. **仍需用户拍板的事**见 §8（其中第 1 条"产品正式名称"至今未定）。

---

## 1. 项目是什么

一句话：**让一个没接触过 AI 跑团的人，5 分钟内完成「从零到第一轮对话」。**

六个差异化能力（也是需求文档 F1–F11 的来源）：

1. **三段式流程**：创建世界 / 创建角色 / 开始扮演，后者绑定前两者的**冻结版本**
2. **统一角色卡**：创建时不区分玩家与卡司，**扮演开始时指定一张为玩家角色**
3. **发言调度**：角色带"发言欲望 / 发言能力"，本地评分排序，模式可切换
4. **显式时间**：世界时钟是结构化数据，随存档回滚，支持日程表与倒计时
5. **一站式**：世界书 / 记忆 / 生图（立绘·颜绘·差分）/ TRPG 规则与骰子，全在同一应用内
6. **可携带**：`.stpack` 包格式承载存档、分享、备份与跨端迁移（格式已冻结）

非目标（**不要自行扩大范围**）：不做在线多人实时联机、不做模型训练平台、不做内容市场、
不内置受版权保护的规则全文、不做云端账号与官方服务器。

---

## 2. 先读什么（推荐顺序）

| 顺序 | 文档 | 重点章节 |
| --- | --- | --- |
| 1 | `README.md` | 全局索引与核心概念 |
| 2 | `docs/01-需求规格.md` | §3 产品原则、§5 核心流程、§6 功能需求、§9 验收标准、§10 已决议事项 |
| 3 | `docs/04-分享格式规范.md` | **全文**（这是你要实现的第一个模块，格式已冻结） |
| 4 | `docs/02-技术架构.md` | §1 架构与三条不变式、§3 代码组织、§4 领域模型、§13 八项待冻结契约 |
| 5 | `docs/06-开发任务拆解.md` | §0 工程约定、§1 M0 任务表、§6 关键路径、§7 第一天清单 |
| 6 | `docs/05-决策记录.md` | ADR-001 ~ ADR-016（**不要重开的清单**） |
| 7 | `docs/03-路线图与风险.md` | §3 风险、§4 合规与法律 |

时间紧就按 **1 → 2 → 3 → 6**。

---

## 3. 当前文件清单与环境实测

### 3.1 文件清单

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `README.md` | 项目索引、核心概念、技术栈、下一步 | 完成 |
| `docs/01-需求规格.md` | PRD：F1–F11 功能需求、18 条验收标准、已决议事项 | 完成（v0.2） |
| `docs/02-技术架构.md` | 架构、D1–D11 决策、领域模型、7 个引擎、存储 Schema | 完成（v0.2） |
| `docs/03-路线图与风险.md` | M0–M4 里程碑、17 条风险、合规、20 条建议 | 完成（v0.2） |
| `docs/04-分享格式规范.md` | `.stpack` v1 格式规范 | **已冻结** |
| `docs/05-决策记录.md` | ADR-001 ~ ADR-016 | 完成 |
| `docs/06-开发任务拆解.md` | 工程约定 + M0–M4 任务表 + 第一天清单 | 完成 |
| `HANDOFF.md` | 本文件 | — |

所有文档均为 **UTF-8 无 BOM**，中文正文，Markdown 表格风格。改动时请保持。

### 3.2 环境实测（交接时）

| 工具 | 状态 |
| --- | --- |
| `node` | ✅ v24.17.0（`C:\Program Files\nodejs\node.exe`） |
| `npm` | ✅ 11.13.0 |
| `pnpm` | ✅ 12.6.0 |
| `git` | ✅ 2.45.1.windows.1（仓库已 `git init` 并有提交；**推送只能在正常网络下做**） |
| `python` | ✅ 3.13.3 |
| `rg` | ✅ 15.2.0 |
| `cargo` / `rustc` | ✅ 1.98.1（`x86_64-pc-windows-msvc`）—— M0-T8 前装好，Tauri 桌面方案因此成立；MSVC BuildTools 2022 与 Windows SDK 10.0.26100 也都在 |

---

## 4. 不可重开的决定（冻结项）

对应 `docs/05-决策记录.md`。这些已经和用户确认过，**不要重新论证**，除非出现新的技术事实。

| ADR | 结论 |
| --- | --- |
| 001 | **不 fork SillyTavern**，只兼容其数据格式；可选把 ST 后端当一个 Provider |
| 002 | 多端优先级：Web/PWA → 桌面（Tauri 2）→ 移动（响应式 PWA 优先） |
| 003 | 不做后端；BYO-Key 直连 Provider；提供可选自建轻量代理解决 CORS / 密钥暴露 |
| 004 | 存储：`StorageAdapter` 抽象；MVP 用 IndexedDB（Dexie），V1 补 SQLite |
| 005 | 前端框架：Svelte 5 为默认（若更熟 React 可切换，需先确认） |
| 006 | **完全开源，许可证 AGPL-3.0** |
| 007 | 规则内容只用开放许可（D&D 5e SRD 为 CC-BY-4.0，需署名）；其余靠用户导入 |
| 008 | 内容分级：**默认关闭 / 不提供**敏感内容策略，由本地开关控制 |
| 009 | **分享格式先行冻结**：`.stpack` v1 是第一个实现的模块 |
| 010 | **角色卡统一，身份是会话的属性**：`Session.refs.playerCharacter` + `cast[]` |
| 011 | **发言调度由本地计算并参数化**：欲望/能力评分 + 硬约束 + 三模式；AI 只能提顺序提案 |
| 012 | **时间显式建模并进入存档**：`WorldClock` 用纪元分钟数作唯一真值，读档一起回滚 |
| 013 | **骰点本地权威**：骰子与判定由本地引擎执行后回灌给 AI，禁止 AI 编造骰值 |
| 014 | 生图一致性分级：L1 固定种子 + 固定 base prompt（首发）→ L4 专属 LoRA |
| 015 | 世界书与结构化记忆**保留两套机制**，共用编辑器与存储层 |
| 016 | **数据契约集中在 `packages/schema`**，禁止模块私自定义类型 |

### 4.1 六条硬不变量（违反即返工）

1. `packages/core` 不得依赖 DOM / 浏览器专有 API，不得直接 import 具体 Provider。
2. 所有实体与包格式的类型只能从 `packages/schema` 导入。
3. **AI 只能"请求"，不能"写入"**：一切状态变更经 ToolRuntime 校验后由本地执行。
4. 依赖方向固定：`schema ← core ← {providers, storage, rules, packages, importers} ← apps/*`。
5. 包读取方**必须忽略未知字段**；主版本不兼容时必须拒绝并提示升级。
6. 密钥绝不进入导出包、日志与消息元数据。
---

## 5. 立即开工：M0 的具体做法

> **历史记录（2026-10-02 注）**：M0 与 M1 均已落地，本节保留为"M0 当时该怎么做"的存档 ——
> **不要照它开工**。下一步见 §0 的待办清单，逐行状态见 `docs/06` §10。

目标：**把最贵、最难改的东西先钉死，并验证最不确定的技术点。**

### M0-T0 工程约定（先做这个）

1. `git init`，加 `.gitignore`（`node_modules`、`dist`、`target`、`*.stpack` 测试产物）
2. 建 pnpm workspaces 骨架（见 `docs/02-技术架构.md` §3 的目录树）：
   `apps/web`、`apps/desktop`、`packages/{schema,core,providers,storage,rules,packages,importers,ui,i18n}`、`tools/`
3. 配置 Biome（lint + format）、Vitest、TypeScript `strict` + `noUncheckedIndexedAccess`
4. CI 四个 job：`lint` → `typecheck` → `test` → `build`，全绿才允许合并
5. **用 lint 规则固化依赖方向**（例如 Biome 的 `noRestrictedImports`），并写一个"故意违规应导致 CI 失败"的验证
6. 提交规范：Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `test:`）

**完成标志**：空仓库 CI 全绿；故意违反依赖方向时 CI 变红。

### M0-T1 实体 schema（决定数据库与迁移成本）

在 `packages/schema/entities/` 下按文件拆分定义，**用 Zod 定义，用 `z.infer` 导出类型**：

```
world.ts       → WorldData（含 Calendar 历法、startMinute、timeRhythm）
character.ts   → CharacterData（ST V2/V3 字段 + VoiceProfile + VisualBible）★ 最核心
session.ts     → Session、SessionRefs、SessionState
message.ts     → Message（树形 parentId）
checkpoint.ts  → Checkpoint（必须含 clock / innerClock / deadlines）
agenda.ts      → AgendaEntry、Deadline
memory.ts      → MemoryEntry（带 atMinute）
asset.ts       → AssetMeta
turn.ts        → TurnPlan
```

字段基线直接抄 `docs/02-技术架构.md` §4 的接口草案。**`character.ts` 先写**——
它是全项目最核心也最容易被后续需求撕扯的数据结构。

要求：每个实体都有单测（正例 + 边界 + 缺字段），并保证 `JSON.parse(JSON.stringify(x))` 往返稳定。

### M0-T2 包格式 schema（已冻结，照抄即可）

`packages/schema/package.ts` 按 `docs/04-分享格式规范.md` §3 实现 `PackageManifest`，
然后用脚本导出 JSON Schema 到 `schema/package-1.json`（提交到仓库，供第三方实现复用）。
**禁止手写第二份 schema。**

### M0-T3 / T4 打包与校验

- `packages/packages`：`pack` / `unpack` / `validate`，**确定性 ZIP**（路径字典序、固定时间戳 `1980-01-01`、稳定 JSON 键序）
- `tools/stpack-cli`：`validate <file>` / `inspect <file>` / `unpack <file> <dir>`
- 验收即 `docs/04-分享格式规范.md` §12 的第 1–7 条，全部接进 CI

### M0-T5 ~ T9

- `core/ports`：`LLMProvider` / `StreamEvent` / `StorageAdapter` / `AssetStore` / `PackageReader|Writer|Validator`
- `providers/llm/openai-compatible.ts`：流式、取消、四种错误映射（鉴权 / 限流 / 网络 / 内容审核）
- `storage/indexeddb`：Dexie，实体读写与事务回滚测试
- `apps/web` 最小壳 + `apps/desktop` Tauri 打包；打通"配置密钥 → 发消息 → 流式渲染 → 落库 → 重启仍在"
- 最后把包格式回归测试（规范 §12 前 7 条）锁进 CI

### 依赖顺序（不要跳步）

```
M0-T0 → M0-T1 → M0-T2 → ┬─ M0-T3 → M0-T4 ─┐
                        └─ M0-T5 → M0-T6 / M0-T7 → M0-T8 → M0-T9
```

---

## 6. 领域模型中最容易理解错的六点

1. **身份是会话的属性**：角色卡没有"玩家/卡司"字段。`Session.refs.playerCharacter` 指定玩家角色，
   其余进 `cast[]`。同一张卡可在不同会话扮演不同身份，导入导出无需身份映射。
2. **消息是树不是列表**：`Message.parentId`。重生成 = 同父多子（swipe），编辑 = 新分支，
   回溯 = 移动 `headMessageId`，分叉 = 从任意节点复制祖先链新建会话。
   显示路径 = 从 `headMessageId` 上溯到根再反转。
3. **TurnPlan 是本地产物**：发言顺序由 `TurnScheduler` 计算或校验，AI 只能提提案。
   每轮人数、单人条数、冷却由本地硬性强制，**AI 不能突破**。
4. **`EpochMinute` 是时间的唯一真值**：`WorldClock` = 纪元分钟数 + 历法映射（用于显示）。
   所有时间相关行为（世界书时间条件、日程触发、倒计时、记忆时间戳）都从它派生。
   时间随 Checkpoint 回滚，**不允许"时间回退但状态不回退"**。
5. **版本不可变 + 血缘**：世界与角色的迭代是**新增版本**，绝不原地修改。
   存档引用具体的 `{id, version}`，因此历史永远可复现。
6. **世界书与记忆是两套机制**：世界书是确定性的关键词 / 时间条件命中；
   记忆是 AI 抽取 + 用户确认的语义条目。共用编辑器与存储层，但**不要合并成一套**。

---

## 7. 文档维护约定

- 每个文档头部有 `版本` 与 `变更记录` 表；每次实质修改都要追加一行（不要重写历史）。
- 需求编号规则：`F<模块号>-<序号>`（如 `F4-2`），优先级 `P0`（MVP）/ `P1`（V1）/ `P2`（后续）。
- 决策编号：`ADR-<三位数>`，**只追加不重写**；若推翻旧决策，新增一条并注明"取代 ADR-xxx"。
- 改了需求要同步更新：`docs/01`（需求）、`docs/02`（架构，若涉及模型）、`docs/06`（任务）。
- 改了包格式：必须提升 `formatVersion` 并更新 `docs/04` 的版本演进章节 + 测试清单。
- 写文件用 **UTF-8 无 BOM**（Windows 下 PowerShell 注意 `Set-Content -Encoding UTF8` 会带 BOM）。

---

## 8. 需要问用户、不要自己拍板的事

| # | 问题 | 说明 |
| --- | --- | --- |
| 1 | **产品正式名称** | `SmartTavern` 是工作区名，可能与既有项目重名 |
| 2 | 前端框架最终定 | **已定：React 19**（ADR-017，取代 ADR-005） |
| 3 | 桌面壳方案 | **已定：Tauri 2**（ADR-002）。Rust 工具链已装（1.98.1），**兜底 Electron 未触发** |
| 4 | 包格式是否还要调整 | **这是最后一次低成本窗口**，动工实现后再改要提 `formatVersion` |
| 5 | 是否上架应用商店 | 只影响签名分发与 NSFW 策略，不影响架构 |

---

## 9. 已知坑与提醒

1. **不要 fork SillyTavern 的代码**。项目本身是 AGPL-3.0，但仍建议保持"格式兼容、代码独立"，
   避免把上游的技术债一起继承过来。
2. **不要内置受版权保护的规则全文**。D&D 5e SRD 可以（CC-BY-4.0，须署名）；
   CoC 7e / Cyberpunk RED / Fabula Ultima 的免费材料通常仅限个人使用。
3. **规则包是纯数据，绝不执行任意代码**。公式一律走白名单求值器，**永远不要 `eval`**。
4. **不要在包往返测试通过之前写编辑器 UI**。数据模型错了，UI 全部白做。
5. **不要把 API Key 写进包、日志或消息元数据**；Web 端直连有密钥暴露风险，需提示用户并提供代理方案。
6. **CJK 文档 + Windows PowerShell**：写文件用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`。
7. **调度与时间必须用表驱动测试锁行为**（给定状态 → 期望输出），否则调参会悄悄改坏体验。
8. **Prompt 装配与宏系统用快照测试锁住**，这是最容易无声退化的部分。
9. **平台差异**：桌面端通过 Tauri Rust 侧发请求可绕开 CORS；Web 端直连受 CORS 限制，
   部分 Provider 需要代理。设计 Provider 层时不要假设"浏览器一定能直连"。
10. **资源文件不进数据库**：图片走 `AssetStore` 内容寻址（文件名 = SHA-256），数据库只存元数据。

---

## 10. 交接完成度自检

读完本文后，你应该能回答：

- [ ] 这个项目解决什么问题？三段式流程分别产出什么？
- [ ] 为什么角色卡不区分玩家/卡司？玩家角色在哪里指定？
- [ ] 发言调度的三种模式是什么？为什么必须本地计算？
- [ ] 时间的唯一真值是什么？它如何与存档交互？
- [ ] 包格式的必需文件有哪些？导入时 ID 冲突怎么处理？
- [ ] 六条硬不变量分别是什么？
- [ ] 你的第一个任务是什么？完成标志是什么？
- [ ] 有五件事必须问用户，分别是什么？

如果全部能答上来，可以从 `M0-T0` 开始了。

---

## 11. 交接后的决议更新（追加，2026-09-26）

本文正文记录的是交接时的原始状态。以下是接手后已落定的决议，**与正文冲突时以本节为准**：

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 产品名 | 中文显示名 **聪明酒馆**，英文显示名 SmartTavern；**机器标识保持 `smarttavern` 不变**（已写进冻结包格式，不改）；仓库名建议 `congming-tavern`（GitHub 上 `SmartTavern` 已被 [Lianues/SmartTavern](https://github.com/Lianues/SmartTavern) 占用）；npm 用 `@smarttavern/*` 但仅限内部 workspace，**不发布公共 registry** |
| 2 | 前端框架 | **React 19**（新增 **ADR-017**，取代 ADR-005）。配套：TanStack Router / Zustand + Dexie liveQuery / `react-hook-form` + `@hookform/resolvers/zod` / Tailwind v4 + Radix Primitives / TanStack Virtual / dnd-kit / react-i18next（**Tailwind 在 M0-T8 的壳里尚未引入**，理由见 `CONTRIBUTING.md` §6 的待定条目） |
| 3 | 桌面壳 | **Tauri 2 不变**（ADR-002）。Rust 工具链**已装好**（1.98.1 / MSVC 目标），兜底 Electron **未触发**；桌面端的 HTTP 通道由自建 `llm_stream` 字节管道承载（**ADR-025**），TLS 用 `rustls`（**ADR-026**），`packages/*` 与 `apps/web` 的端口契约一行未改 |
| 4 | 包格式 | `docs/04` 完成**规范文本消歧 r2**：6 处内部矛盾 / 空缺已修正，**`formatVersion` 仍为 1**，不删字段、不改字段语义、不改必需文件 |
| 5 | 应用商店 | 未决，不影响架构 |

**包格式 r2 修订的 6 处**：

1. `formatVersion` 只表示主版本，纯新增可选字段不提升（原 §8 的"次版本 1.1"与 integer 类型矛盾）
2. ZIP 条目顺序 = 第 1 条固定 `manifest.json`，其余按路径字典序（原 §2 与 §11 冲突）
3. §2 目录树补上 `data/theme.json`（原 §5 有 `theme` 类型但目录树缺该文件）
4. 固定 `contents.counts` 与 `schemaVersions` 的键集
5. `messages.jsonl` 增加 tie-break（`createdAt` 相同按 `id` 升序）
6. 补充 ZIP64 支持与"字节级确定性仅在同一实现内成立"的边界说明

**为什么没有提升 `formatVersion`**：以上全部是消歧与补全，不删字段、不改语义、不改必需文件；
且当时世界上还没有任何一个 `.stpack` 文件，不存在兼容包袱。修订后 `formatVersion: 1` 即锁定。

**当前进度**：M0-T0（工程约定）落地中；下一步 M0-T1（实体 schema，先写 `character.ts`）。