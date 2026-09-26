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
| 包管理 | `pnpm@12.6.0`（`packageManager` 字段已固定；不要用 npm / yarn） |
| 命令 | `pnpm install` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` |

```powershell
pnpm install        # 必须在仓库根目录执行
pnpm lint           # Biome（lint + 格式校验）+ 依赖方向检查
pnpm typecheck      # tsc -b，strict + noUncheckedIndexedAccess
pnpm test           # Vitest，跑遍所有 workspace
pnpm build          # Vite 构建 apps/web 与 apps/desktop
```

`pnpm ci` 可以一次跑完 lint → typecheck → test → build，等价于 CI。

### 沙箱 / 受限主机上的本地跑法

以下两点只影响**某些受限主机**（例如禁止子进程管道通信的沙箱），CI 不需要：

1. **pnpm 的用户级目录必须在工作区内。** pnpm 12 会在
   `%LOCALAPPDATA%\pnpm-store-operation-locks\all-stores.lock` 上取全局操作锁；
   该目录不可写时会在访问 registry 前就失败：
   `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK ... 拒绝访问 (os error 5)`。
   跑 pnpm 前先把两个用户目录指进工作区（`.local-appdata/` 已忽略）：

   ```powershell
   $env:LOCALAPPDATA = "$PWD\.local-appdata"; $env:USERPROFILE = $env:LOCALAPPDATA
   pnpm install
   ```

2. **Vite 在 Windows 上会探测网络驱动器。** 它调用
   `child_process.exec('net use')`；禁止管道子进程的主机会抛 `EPERM`，
   于是 `vitest` 与 `vite build` 还没开始就挂掉。用本地包装脚本跑四个 job，
   它会预加载一个只中和该探测的 shim：

   ```powershell
   pnpm ci:local            # 等价于 pnpm ci，但带上探测 shim
   pnpm ci:local lint test  # 只跑其中几步
   ```

   shim 见 `tools/scripts/vite-sandbox-probe-shim.mjs`（只拦截 `net use`，
   其它 spawn 全部原样透传），包装脚本见 `tools/scripts/run-ci-local.mjs`。
   这两者都是**本地跑法**，`pnpm ci` / CI 完全不使用它们。

### 关于 `vite` 的 override（rolldown-vite）

`pnpm-workspace.yaml` 里有一行 `overrides: vite: npm:rolldown-vite@^7.3.1`。
原因：esbuild 的 JavaScript API 要通过**管道**和一个常驻子进程通信，
而上述受限主机禁止这种 spawn，于是任何 TypeScript 文件都无法转译，
`pnpm test` 与 `pnpm build` 一起失效。`rolldown-vite` 是同一套 Vite 7 API
换用原生、进程内的打包器，因此 `vite.config.ts` 与 CI 命令都不变。
等所有开发者主机都能 spawn 管道子进程后，删掉这一行即可回到标准 `vite`。

### `.npmrc`

pnpm 12 的 `allowBuilds` / `cacheDir` / `storeDir` 都读
`pnpm-workspace.yaml`，**不读** `.npmrc`；根目录 `.npmrc` 只为 npm 与旧版
pnpm 保留少量兼容设置。`cacheDir` 指向工作区内的 `.npm-cache/`，使依赖缓存
在无法写用户级目录的机器上也正常，并让构建更接近封闭环境。

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

---

## 6. 代码约定 / Code conventions

- 文件 `kebab-case.ts`，类型 `PascalCase`，函数与变量 `camelCase`，常量 `SCREAMING_SNAKE`。
- 纯函数优先：Prompt 装配、评分、时间计算、骰子解析都必须是可单测的纯函数。
- 不写"以后可能用得上"的抽象；抽象只在出现第二个实现时提取。
- 每个 PR 必须包含测试；纯 UI 调整可用 e2e 覆盖。
- 密钥绝不进入导出包、日志与消息元数据（硬不变量 #6）。

### 本仓库当前待定（M0-T0 未在文档中规定，先按此执行）

- **`packages/ui` 与 `packages/i18n` 的层位置**：文档只固定了
  `schema ← core ← {providers, storage, rules, packages, importers} ← apps/*`。
  M0-T0 采用较窄的读法：两者是叶子，可以依赖 `schema`/`core`，
  **不允许被下层 import**；`core` 也不得 import 它们。
- **框架与 Tauri**：`docs/02-技术架构.md` D2 / ADR-005 与 ADR-002 尚未定论，因此
  `biome.json`、Vite 配置与 `packages/ui` 都不引入任何框架依赖，只留扩展点。
- **`tools/schema-export`**：M0-T0 只占位目录与说明，M0-T2 才加入真正的
  `package.json` 与 JSON Schema 导出脚本。
- **`tsconfig.base.json` 未开启 `exactOptionalPropertyTypes`**：文档只要求
  `strict` + `noUncheckedIndexedAccess`。该选项与 Zod 的可选字段（`?: T` 与
  `?: T | undefined`）冲突面较大，留到 M0-T1 定义实体 schema 时再评估。
- **`vite` 换成 `rolldown-vite`**（见 §1"关于 `vite` 的 override"）：这是
  `pnpm-workspace.yaml` 中唯一一处偏离文档字面写法的地方，动机是让受限主机也能
  跑通 `test` / `build`；API 与 CI 命令完全不变，回退只需删一行。
- **`packages/ui` / `packages/i18n` 目前不引入任何框架依赖**，因此它们的
  `package.json` 的 `dependencies` 为空；等 ADR-005 定论后再加。
- **工作区之间靠源码引用（`exports: "./src/index.ts"`）而不是构建产物**：M0 阶段
  包很小、且全部 `private`，这样 `typecheck`/`test` 不需要先 build。等 M0-T3 起
  出现需要独立发布的产物（例如 `tools/stpack-cli`）再引入真正的打包步骤。
