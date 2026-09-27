# 参与开发 / Contributing to SmartTavern

本文件是仓库根级的工程约定（对应 `docs/06-开发任务拆解.md` §0 与 `HANDOFF.md` §5
M0-T0）。**只增不改**：修改这里的规则需要先改文档并补一条 ADR（`docs/05-决策记录.md`）。

This file records the repository-level engineering conventions. It intentionally
lives at the root so it is not confused with the spec documents in `docs/`.

---

## 1. 环境准备 / Setup

| 项 | 要求 |
| --- | --- |
| Node | `>=22.12.0`（CI 用 `.nvmrc` 锁定的版本） |
| 包管理 | pnpm（版本由 `.github/workflows/ci.yml` 的 `pnpm/action-setup` 钉住；不要用 npm / yarn） |
| 命令 | `pnpm install` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` |

```bash
pnpm install        # 必须在仓库根目录执行
pnpm lint           # Biome（lint + 格式校验）+ 依赖方向检查
pnpm typecheck      # tsc -b，strict + noUncheckedIndexedAccess
pnpm test           # Vitest，跑遍所有 workspace
pnpm build          # Vite 构建 apps/web 与 apps/desktop
```

`pnpm ci` 可以一次跑完 lint → typecheck → test → build，等价于 CI。

> **根 `package.json` 里刻意没有 `packageManager` 字段。** pnpm 见到该字段会先把指定
> 版本自装进 store 再 re-exec，这在无法写用户级目录的机器上会失败并留下一个空包目录，
> 此后每次 `pnpm` 调用都指向不存在的二进制。版本改由 CI 显式钉住 —— 本地版本可以不同，
> 但请让 `pnpm install` 之后**提交 lockfile 的变化**，因为 CI 用 `--frozen-lockfile`。

### CI 的 install 步骤：两类会让**四个 job 一起红**的失败（都踩过）

CI 的第一步就是 `pnpm install --frozen-lockfile`，所以它一坏不是某个 job 红，而是**四个全红**，
日志里只有一行 `ERR_PNPM_…`，看起来非常像"环境问题"。已知两类成因：

1. **manifest 与 lockfile 的 specifier 对不上**（`ERR_PNPM_OUTDATED_LOCKFILE`）。
   典型成因：手改了某个 `package.json` 的版本（尤其是把 `^x` 换成精确版本）却没有重跑安装。
   `pnpm ci:local` 现在第一步就是 `lockfile`，专门查这个
   （`--lockfile-only --ignore-scripts`：不碰 node_modules、不跑生命周期脚本）。
2. **依赖比"最小发布年龄"更新**（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。
   pnpm 12 默认拒绝安装**发布不足 24 小时**的版本；本仓库把它显式写在 `pnpm-workspace.yaml`
   里，理由与解法也在那段注释里。关键坑：**本机 pnpm 11 只校验"当前平台会装"的条目，
   pnpm 12 校验整份 lockfile**，所以这类问题经常表现为"本机全绿、CI 全红"。
   权威检查必须用 CI 钉住的那个版本：

   ```bash
   npx --yes pnpm@12.6.0 install --frozen-lockfile --lockfile-only --ignore-scripts
   ```

   解法是让 pnpm 自己挑"已满 24 小时"的版本（依赖写**范围**、别写精确版本），
   然后用 pnpm 12 跑 `pnpm install --lockfile-only` 重新解析，而不是放宽这条策略。
   精确版本是唯一的例外：pnpm 绕不过它，会把受影响的包写进 `minimumReleaseAgeExclude`
   —— 那是**显式豁免**，不是静默跳过。

### Vite 8 / Vitest 5（已不再使用 rolldown-vite）

当前工具链：**`vite` 8.3.1 + `vitest` 5.0.2**。此前用来绕开 esbuild 转换管道的
`overrides: vite: npm:rolldown-vite@^7.3.1` 已删除：`rolldown-vite` 已被 registry 标记
deprecated，弃用语即"用它从 Vite 7 迁移到 Vite 8"，Rolldown 已并入 Vite 8 本体。

**esbuild 目前不在依赖树里**：pnpm 12 解析 `vite@8.3.1` 时不会带上它（Vite 8 已内置 Rolldown）。
`pnpm-workspace.yaml` 里的 `allowBuilds: esbuild: true` 因此是**预留**——一旦某个新版把 esbuild
带回依赖树，没有这一项安装会直接硬失败。三点务必别改动它：

1. 它必须是**映射**（`包名: 布尔`）。写成列表会被 pnpm 当成配置错误，安装直接失败。
2. pnpm 检测到被忽略的构建脚本时**会自己往 `pnpm-workspace.yaml` 里插一个占位项**，
   值是字符串 `set this to true or false`；字符串不等于 `true`，照原样保留等于没批准。
3. 不批准会让 pnpm 以 `ERR_PNPM_IGNORED_BUILDS` 结束安装，而有些 pnpm 版本还会把它
   当**硬错误**（不是警告）。

### `.npmrc`

pnpm 12 的 `allowBuilds` / `cacheDir` / `storeDir` 都读 `pnpm-workspace.yaml`，
**不读** `.npmrc`；根目录 `.npmrc` 只为 npm 与旧版 pnpm 保留少量兼容设置。
`cacheDir` 指向工作区内的 `.npm-cache/`，让依赖缓存留在仓库内、构建更接近封闭环境。

### 受限主机（禁止子进程管道通信的沙箱等）

一些沙箱会拒绝管道子进程，Vite 的网络驱动器探测（`net use`）因此抛 `EPERM`，
`vitest` 与 `vite build` 会在启动阶段就挂掉。仓库提供了本地包装脚本，它会预加载一个
**只中和该探测**的 shim：

```bash
pnpm ci:local            # 等价于 pnpm ci，但带上探测 shim
pnpm ci:local lint test  # 只跑其中几步
```

`tools/scripts/run-ci-local.mjs` 与 `tools/scripts/vite-sandbox-probe-shim.mjs` 都只服务
本地跑法，`pnpm ci` 与 CI 完全不使用它们。

与**具体某台机器**有关的其它绕行（用户级目录、链接器、安装为何可能非零退出等）不写进
本文件，而是记在**未纳入版本控制**的 `LOCAL-DEV-NOTES.md`。若你在类似环境里开发，
照它的思路处理即可；公开仓库里不需要这些信息。

---

## 2. 仓库结构与依赖方向 / Layout & dependency direction

目录树见 `docs/02-技术架构.md` §3。**唯一允许的依赖方向**：

```
packages/schema  ←  packages/core  ←  {providers, storage, rules, packages, importers}  ←  apps/*
```

- `packages/schema` 不得 import 任何其他内部包。
- `packages/core` 不得依赖 DOM / 浏览器专有 API，也不得 import 任何具体
  Provider / Storage / Rules / 打包器实现——这些只能通过 `core/ports` 的接口注入。
- 适配器层（providers / storage / rules / packages / importers）之间**互不 import**。
- `apps/*` 在最上层，可以 import 任何内部包。
- `tools/*` 是叶子，可以消费库，但库不得 import 工具。
- 所有实体与包格式的类型**只能**从 `packages/schema` 导入（硬不变量 #2）。

### 这条规则由两处同时强制

1. **Biome**（编辑器里即时反馈）：`biome.json` → `overrides` →
   `style.noRestrictedImports`（按包分组），`packages/core` 另有
   `style.noRestrictedGlobals` 禁掉 `window` / `document` / `localStorage` /
   `fetch` 等。类型层面还有第三重：`packages/core/tsconfig.json` 继承
   `tsconfig.core.json`，该配置**移除了 DOM lib**，因此 `window` 等名字在 core 里
   根本无法通过 `tsc`。
2. **`tools/scripts/check-dependency-direction.mjs`**（权威检查）：真的遍历每个
   workspace 的源码 import 图，因此还能抓到 Biome 规则看不到的情况——深层导入
   （`@smarttavern/core/engine/prompt`）、导入了 package.json 里没声明的包、以及
   新加进仓库却忘了登记进 layering 表的包。

---

## 3. 提交规范 / Commit convention — Conventional Commits

**所有提交信息必须符合 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/)。**

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

规则：

- `type` 用小写，取自下表；`scope` 用下方工作区名（可省略，但改动集中在单个包时应写）。
- `subject` 用祈使句、不加句号、不超过 ~72 字符；中文或英文都可以，但一个仓库内保持一致。
- 破坏性变更：`type(scope)!: subject`，并在 footer 写 `BREAKING CHANGE: …`。
- 关联任务编号写在 body 末尾，例如 `Refs: M0-T0`。

| type | 用途 |
| --- | --- |
| `feat` | 新功能（用户可感知的能力） |
| `fix` | 修 bug |
| `docs` | 只改文档（含 `docs/`、`CONTRIBUTING.md`） |
| `refactor` | 不改行为的重构 |
| `test` | 增删改测试 |
| `build` | 构建脚本、打包、依赖版本 |
| `ci` | CI 配置（`.github/workflows/*`） |
| `chore` | 其它杂项（脚手架、忽略文件） |
| `perf` | 性能优化 |
| `revert` | 回滚某次提交 |

常用 `scope`（与工作区同名）：`schema`、`core`、`providers`、`storage`、`rules`、
`packages`、`importers`、`ui`、`i18n`、`web`、`desktop`、`stpack-cli`、`ci`、`deps`。

示例：

```
feat(schema): add CharacterData + VoiceProfile zod schemas

Refs: M0-T1
```

```
fix(core): stop TurnScheduler from exceeding per-turn speaker budget

The hard constraint was applied before cooldowns were subtracted, so a
character on cooldown could still be picked as the second speaker.

Refs: M0-T5
```

```
ci: run biome on the whole tree instead of changed files

BREAKING CHANGE: contributors must format with pnpm lint:fix before pushing.
```

提交前请确认 `pnpm lint && pnpm typecheck && pnpm test` 全绿（`pnpm ci` 一次跑完）。

---

## 4. CI：四个 job 全绿才允许合并 / Four green jobs before merge

`.github/workflows/ci.yml` 按顺序串起四个 job：

| job | 命令 | 内容 |
| --- | --- | --- |
| `lint` | `pnpm lint` | Biome lint + 格式校验，外加依赖方向检查脚本 |
| `typecheck` | `pnpm typecheck` | `tsc -b`（strict + `noUncheckedIndexedAccess`；core 无 DOM） |
| `test` | `pnpm test` | Vitest 跑遍全部 workspace |
| `build` | `pnpm build` | Vite 构建 `apps/web`、`apps/desktop` |

四个 job 用 `needs:` 串行；最后由 `ci` 这个 gate job 汇总，分支保护只需要把
`ci` 设为必需状态检查。**任何一项变红都不允许合并。**

---

## 5. 如何验证"依赖方向"这条规则真的会红 / Proving the rule is live

两条规则都要能证实会失败，否则它只是装饰。以下步骤约 30 秒，两条都做一遍。

### 5.1 Biome 规则（编辑器 / lint 立刻报错）

1. 在 `packages/core/src/index.ts` 末尾加一行：
   ```ts
   import { STORAGE_PACKAGE } from '@smarttavern/storage';
   ```
2. 运行 `pnpm lint`。预期：Biome 报 `noRestrictedImports`
   （"core only knows core/ports; storage is injected…"），退出码非 0。
3. 再试 DOM：把 core 里的某个值改成 `export const w = window;`。
   预期：`pnpm lint` 报 `noRestrictedGlobals`，`pnpm typecheck` 报 `TS2304`
   （因为 `tsconfig.core.json` 移除了 DOM lib）。
4. 删掉这两处改动，`pnpm lint` 恢复绿色。

### 5.2 依赖图检查脚本（权威检查，CI 的 `lint` job 里跑）

1. 在 `packages/core/src/index.ts` 里加一行：
   ```ts
   import '@smarttavern/storage';
   ```
2. 运行 `node tools/scripts/check-dependency-direction.mjs`（或 `pnpm lint`）。
   预期：退出码 1，且输出形如
   ```
   [deps] 1 dependency-direction violation(s):
     - packages/core/src/index.ts:NN
       packages/core (layer "packages/core") must not import @smarttavern/storage [packages/storage]
       allowed from packages/core: packages/schema
   ```
3. 删掉该行；同一命令输出
   `[deps] OK — 12 workspaces respect the dependency direction …` 并退出 0。
4. 更省事的版本：`pnpm test` 会跑
   `tools/scripts/check-dependency-direction.test.mjs`，其中用合成的违规 import
   断言检查器确实会报告（以及干净树确实为 0 条）。把检查器里的 `ALLOWED` 表改坏，
   这些测试立刻变红。

### 5.3 测试文件的类型检查（`tsconfig.test.json`）

每个 workspace 的 `tsconfig.json` 都排除了自己的测试文件，而 Vitest 只**转译**测试
（剥掉类型但不检查），所以测试里的类型错误此前完全不可见 —— 直到它在运行时炸掉。
`pnpm typecheck` 因此是两步：`tsc -b` 加上 `node tools/scripts/typecheck-tests.mjs`，
后者按 workspace 运行 `tsconfig.test.json`（继承本包配置并放回测试，`composite: false`
且永不产出）。

**逐包而不是根级单项目**是刻意的：`packages/core` 继承 `tsconfig.core.json`，那份配置
**移除了 DOM lib** 以让 core 远离浏览器 API。根级单项目会把 DOM 还给 core 的测试，
反而削弱它存在的意义。

证实这条规则会红（约 15 秒）：

1. 在任意 `*.test.ts` 里加一行类型错误，例如 `const n: number = 'no';`
2. 运行 `pnpm typecheck`。预期：退出码非 0，并打印
   `[types] N test project(s) failed to typecheck:`，随后列出出问题的配置文件。
3. 删掉该行；同一命令输出 `[types] OK — N test projects typecheck clean.` 并退出 0。

新增 workspace 时记得一并加 `tsconfig.test.json`；如果**一个都没找到**，检查脚本会
**大声失败**（而不是静默地什么都不查）—— 一个"全绿但其实没检查任何东西"的 job，
比没有这个 job 更危险。

---

## 6. 代码约定 / Code conventions

- 文件 `kebab-case.ts`，类型 `PascalCase`，函数与变量 `camelCase`，常量 `SCREAMING_SNAKE`。
- 纯函数优先：Prompt 装配、评分、时间计算、骰子解析都必须是可单测的纯函数。
- 不写"以后可能用得上"的抽象；抽象只在出现第二个实现时提取。
- 每个 PR 必须包含测试；纯 UI 调整可用 e2e 覆盖。
- 密钥绝不进入导出包、日志与消息元数据（硬不变量 #6）。
- **访问 `Record` 的字段要留神本仓库的两个开关**：`tsconfig` 开了
  `noPropertyAccessFromIndexSignature`（禁止 `record.key`），而 Biome 的
  `useLiteralKeys` 又反对 `record['key']`。两者都接受的形式是**参数化键**——
  `const field = (record, key) => record[key]`，然后到处用它。

### 本仓库当前待定（M0-T0 未在文档中规定，先按此执行）

- **`packages/ui` 与 `packages/i18n` 的层位置**：文档只固定了
  `schema ← core ← {providers, storage, rules, packages, importers} ← apps/*`。
  M0-T0 采用较窄的读法：两者是叶子，可以依赖 `schema`/`core`，
  **不允许被下层 import**；`core` 也不得 import 它们。
- **样式方案**：`README.md` 与 `docs/02-技术架构.md` 的技术栈里写着 Tailwind CSS v4，
  但 M0-T8 的壳（设置 / 会话列表 / 对话三个路由）没有设计系统要承载，因此只写了
  一份普通 CSS，**没有引入 Tailwind**。M1 做真实 UI 时接上；届时若仍不引入，
  要改的是文档，而不是让这条差异继续漂着。
- **`tools/schema-export`**：M0-T0 只占位目录与说明，M0-T2 才加入真正的
  `package.json` 与 JSON Schema 导出脚本。
- **`tsconfig.base.json` 未开启 `exactOptionalPropertyTypes`**：文档只要求
  `strict` + `noUncheckedIndexedAccess`。该选项与 Zod 的可选字段（`?: T` 与
  `?: T | undefined`）冲突面较大，留到 M0-T1 定义实体 schema 时再评估。
- **工作区之间靠源码引用（`exports: "./src/index.ts"`）而不是构建产物**：M0 阶段
  包很小、且全部 `private`，这样 `typecheck`/`test` 不需要先 build。等 M0-T3 起
  出现需要独立发布的产物（例如 `tools/stpack-cli`）再引入真正的打包步骤。

---

## 7. 桌面壳（Tauri 2）/ Desktop shell

桌面端**不是**第二套 UI：`apps/desktop` 只做两件事 —— 调用 `apps/web` 导出的
`mountApp(root, { transport })`，并注入一个由 Rust 承载的 `FetchLike`
（`src-tauri/` 的 `llm_stream` / `llm_cancel`，见 ADR-025）。UI、状态层与业务逻辑只有一份，
差别只在注入的那一个参数上，所以 web 端**不需要**到处写 `if (isTauri)`。

```bash
pnpm --filter @smarttavern/desktop tauri:dev            # 开发（内部会拉起 vite dev server）
pnpm --filter @smarttavern/desktop tauri:build          # 只出 exe（= tauri build --no-bundle）
pnpm --filter @smarttavern/desktop tauri build          # 完整打包（msi/nsis…，打包阶段要联网下载工具）
pnpm --filter @smarttavern/desktop tauri:check          # cargo fmt --check + clippy -D warnings + test
```

前置条件：Rust 工具链（`rustup` 默认目标即可）与 WebView2 运行时（Windows 10/11 自带）。
`pnpm install` **不装** Rust 依赖，`cargo` 会自己拉。

**两个会让人白费半小时的坑**（都踩过）：

1. **debug 构建加载的是 `build.devUrl`，不是内嵌的前端产物。** Tauri 在开发模式下故意不打包
   前端资源，改成直接读 `frontendDist` 目录 / 连 `devUrl`（`tauri/src/app.rs` 的 `#[cfg(dev)]`
   分支写得很清楚）。所以**直接双击 `target/debug/*.exe` 只会得到一个白窗口** —— 那不代表
   前端坏了。要么用 `tauri:dev`（它会替你把 vite 起在 1420），要么做 release 构建，
   那才会把 `dist/` 嵌进去。
2. **窗口只在 `tauri.conf.json` 里声明，不要在 Rust 里再建一个同 label 的。** `Ready` 事件会
   先创建配置里的窗口，`setup` 闭包再建一个同名窗口就会撞 label / 撞 WebView2 的初始化。

**这条跨语言边界不允许漂移**：Rust 与 TS 两侧共读同一份夹具
`apps/desktop/src/transport/fixtures/llm-stream-events.json` —— Rust 侧断言事件枚举序列化成
夹具里的 JSON，TS 侧把同一份帧喂进假的 channel，断言还原出的 `Response` 的状态码、响应头与
正文字节一致。**改一侧的形状，另一侧的测试就会红。**（顺带一条 serde 经验：枚举上
`rename_all` 只重命名**变体**，变体里的字段要靠 `rename_all_fields` —— 这条正是夹具测试抓出来的。）

**Rust 目前不在 CI 里 —— 这是已知缺口，不是疏忽。** 原因：`cargo test` 要编译整棵 `tauri`
依赖树，Linux runner 还得装 `webkit2gtk-4.1` 一类系统库，冷构建十分钟起步，而 M0 的四个 job
要保持在"几分钟内给人答案"的量级。因此在桌面端有改动的 PR 上，**`tauri:check` 与
`tauri:build` 是提交前必须自己跑的一步**，把结果写进 PR 说明。补一个带缓存的 Rust job
已记在 `docs/06-开发任务拆解.md` 的后续项里。
