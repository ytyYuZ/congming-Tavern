# 聪明酒馆（SmartTavern）

> 本地优先、多端运行、AI 辅助的一站式角色扮演与 TRPG 工作台。
> 以「**创建世界 → 创建角色 → 开始扮演**」三段式组织整个流程，兼容 SillyTavern
> 的角色卡 / 世界书 / 预设等生态数据格式。

## 关于本项目的生成方式（AI 生成声明）

**本项目的绝大部分内容由 AI 生成。** 说清楚具体是哪些部分：

- **代码**：`packages/*`、`apps/*`、`tools/*` 下的实现与测试，主体由 AI 编写；人类负责提出需求、
  拍板设计决策、审阅产出并验收。
- **文档**：`README.md`、`HANDOFF.md`、`docs/01`–`docs/06` 同样以 AI 起草为主，经人类审阅、修正与定稿。
- **设计决策**：`docs/05-决策记录.md` 里的 ADR 由**人类最终拍板**（采纳哪一条、优先级、取舍），
  AI 负责记录理由与后果。
- **质量保证方式**：AI 生成的代码不靠"看起来对"来交付，而靠机械化的证据 —— 单元测试、
  产物与源码的**逐字节漂移测试**、契约回归套件（`docs/04` §12），以及 CI 四步
  `lint → typecheck → test → build`。已知的宿主环境绕行都写在 `CONTRIBUTING.md` 里，不隐晦。

**使用者应当知道**：AI 生成的代码可能存在与人类直觉不同的写法，也可能存在未被发现的缺陷。
本项目按 **AGPL-3.0** 提供，**不附带任何担保**。用于重要场景前请自行审阅关键路径 ——
尤其是处理不可信输入的部分（包解析与安全校验，见 `docs/04` §9 与 `packages/packages/src/zip/`）。

**贡献者注意**：提交信息、代码注释与测试同样可能是 AI 起草的，这不影响审阅标准 ——
**以测试与 CI 的绿灯为准**，约定见 `CONTRIBUTING.md`。

## 名称约定

| 用途 | 取值 |
| --- | --- |
| 中文显示名 | **聪明酒馆** |
| 英文显示名 | SmartTavern |
| 仓库名 | `congming-tavern`（避免与 GitHub 上已存在的同名项目混淆） |
| 机器标识 | `smarttavern`（已写进冻结的包格式：`format: "smarttavern.package"`、MIME、`extensions.smarttavern`，**不改**） |
| npm 包名 | `@smarttavern/*`，仅内部 workspace 使用，**不发布公共 registry** |
| 桌面 bundle id | `app.congmingjiuguan.desktop`（M0-T8 已定，写进 `apps/desktop/src-tauri/tauri.conf.json`） |

品牌表述固定为：**"兼容 SillyTavern 数据格式，但完全独立实现"**（ADR-001）。

## 一句话定位

把"设定世界、捏角色、跑剧情、存档回滚、生成配图、查规则、推进时间"这几件分散在不同工具里的事，
收进同一个简单易用的界面；并且所有 AI 产出都以**可编辑的提案**形式出现，用户永远有最终决定权。

## 核心概念

- **统一角色卡**：创建时不区分玩家 / 卡司；扮演开始时指定一张为玩家角色，其余自动成为卡司。
- **发言调度**：角色带"发言欲望 / 发言能力"，由本地调度器排序，模式可选（用户全权 / 自定义规则 / AI 决定）。
- **显式时间**：世界时钟是结构化数据，随存档回滚；支持日程表与倒计时。
- **不可变版本**：世界与角色迭代产生新版本，旧存档永远可复现。
- **包格式**：`.stpack` 承载存档、分享、备份与跨端迁移，格式已冻结。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/01-需求规格.md` | 目标、用户、产品原则、核心流程、F1–F11 功能需求、原始需求澄清与优化、非功能需求、18 条 MVP 验收标准、已决议事项 |
| `docs/02-技术架构.md` | 分层架构、D1–D11 技术决策、代码组织、领域模型、五大引擎（Prompt / 记忆 / 工具 / 骰子 / 生图）+ **发言调度器** + **时间引擎**、Provider 契约、存储 Schema |
| `docs/03-路线图与风险.md` | M0–M4 里程碑、17 条风险登记、合规与版权、开放问题决议、20 条补充建议 |
| `docs/04-分享格式规范.md` | **已冻结**的 `.stpack` v1 格式：目录结构、manifest 规范、包类型、导入流程、版本演进、安全校验、兼容性测试清单 |
| `docs/05-决策记录.md` | ADR-001 ~ ADR-016：每项决策的状态、理由与影响 |
| `docs/06-开发任务拆解.md` | 工程约定、M0–M4 任务清单（产出 / 依赖 / 验收）、关键路径、第一天清单、**§8 M0-T2 ~ M0-T5 实施计划**、**§9 M0-T6 ~ M0-T9 实施计划** |
| `HANDOFF.md` | 交接说明：给后续开发 AI 的阅读顺序、冻结决策、立即开工步骤、已知坑 |

发布产物（均由 `pnpm schema:export` 从 `packages/schema` 的 Zod 定义生成，**禁止手写**，有漂移测试守护）：
`schema/package-1.json` —— `.stpack` manifest 的 JSON Schema（draft 2020-12），供第三方实现无需依赖本项目代码即可校验；
`schema/tools-1.json` —— 工具声明的 JSON Schema，供插件作者与 prompt 装配使用。

## 技术栈速览（详见 `docs/02-技术架构.md`）

- 语言 / 框架：TypeScript + **React 19** + Vite + Tailwind CSS v4（ADR-017）
- 多端：Web / PWA 优先，Tauri 2 提供桌面壳（移动端后续）
- 存储：`StorageAdapter` 抽象，MVP 用 IndexedDB，资源内容寻址存独立 AssetStore
- 推理：BYO-Key，OpenAI 兼容 / Anthropic / Gemini / Ollama 等多 Provider，可选自建代理
- 生图：A1111 / ComfyUI / NovelAI 等可插拔 Provider，一致性采用分级策略
- 架构：headless `core` + 冻结契约 `schema` + 插件化规则包
- 许可证：AGPL-3.0

## 当前状态

v0.9：**M0 全部完成** —— M0-T0 工程骨架、M0-T1 实体契约、M0-T2 包格式契约
（`schema/package-1.json` 与 `schema/tools-1.json` 由 `pnpm schema:export` 生成，有逐字节漂移测试守护）、
M0-T3 `.stpack` 打包 / 解包 / 校验（自研窄 ZIP + canonical JSON，ADR-018）、M0-T4 包 CLI、
M0-T5 `core/ports` 核心接口与测试替身、**M0-T9 契约回归套件**（`docs/04` §12 第 1–7 条逐条覆盖）、
**M0-T6 OpenAI 兼容 Provider**（零依赖 SSE 解析器，密钥脱敏有专门断言）、
**M0-T7 IndexedDB 存储**（Dexie；集合与索引取自 `core/ports` 的常量，含跨集合事务回滚）、
**M0-T8 应用骨架**（`apps/web` 的 React 19 壳打通「配置密钥 → 发消息 → 流式渲染 → 落库 → 重启仍在」；
`apps/desktop` 是 Tauri 2 壳，Rust 侧 `llm_stream` 字节管道绕开 CORS）
均已完成；工具链为 **Vite 8.3.1 + Vitest 5.0.2 + Rust 1.98 + Tauri 2.12**，
`pnpm ci:local` 四步全绿（**55 个测试文件 / 633 个用例**），Rust 侧 `fmt` / `clippy -D warnings` /
`cargo test` 亦全绿。

> **一处保留**：桌面**窗口**在开发用的受限环境里起不来（事件循环到不了 `Ready`，因此没有窗口被创建），
> 所以"窗口里显示了界面"需要在正常桌面会话里自行确认；界面与传输逻辑分别有测试覆盖。
> 详见 `docs/06-开发任务拆解.md` §9.4 的状态块。

**下一步**：M1（MVP 三阶段跑通），入口是 **M1-G1 i18n 骨架**与 **M1-G4 PromptComposer 最小版**；
动手前建议先收掉 §9.4 记下的 UUIDv7 双实现。