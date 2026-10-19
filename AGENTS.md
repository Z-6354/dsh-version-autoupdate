# AGENTS.md — dsh-version-autoupdate

> 面向 AI 编程助手：架构、约束、开发/测试流程。人类读者见 [README.md](./README.md)。

## 1. 这是什么

Host + Client 双面 Cordis 插件，为 DSH Web 提供：

- **同源版本检测**（npm / GitHub / unknown，禁止跨渠道）
- **只读 HTTP status/check**
- **五个 MCP 工具**负责实际更新（UI 不写入；含默认进度 watch）
- **GitHub staging worker**（构建成功后才重启；健康检查失败回滚）
- **GitHub 产物本地缓存**（`cache/github/<version>/`；完整包可复用；`.partial` + Range 断链续传；`force` 仍复用完整包）

对应 Harness 源码仓库：`deepseek-ai/deepseek-harness`（GitHub 安装来源）。

## 2. 核心约束（必须遵守）

1. **安装来源隔离** — 先 `detectInstallationSource()`，再只访问对应 MirrorClient 渠道；GitHub status 不得请求 npm，npm status 不得请求 GitHub。
2. **完整性错误不回退** — SHA-256 / tag / 来源 / archive 结构错误 → 失败，不静默换源。镜像 **HTTP 401/403 认证失败也不回退官方**（重新询问密码或用户选官方）；仅网络/限流可回退官方。
3. **密码** — 仅显式 `dsh_update`（且 **GitHub 源**）可读/写入 `$DSH_HOME/version-autoupdate/credentials.json`。**代码内处理**：工具先读本地密钥并探活；缺失或鉴权失败时由工具调用 `ctx.userQuestions.ask` 弹出提问 UI（提交密码 / 仅官方 / 取消），**不依赖 Agent 在对话里自行询问**。Agent 不得传 `mirrorPassword` / `useOfficial`。npm 源更新走官方 registry，**不弹**镜像通道。`/status`、`/check`、`dsh_update_check` **不得**弹密码。
4. **HTTP 写入已废弃** — `/install`、`/start-update`、`/restart` 返回 410；更新走 MCP。
5. **单飞** — `UpdateOperationStore` 同一时刻只允许一个 operation；manifest **不含密码**；`load()` 在 `running` 时不得覆盖内存；进程重启留下的孤儿 op：先 `applyRestartOutcome`，再 `clearOrphanedIfNeeded`（**不得**把新鲜的 `restarting` 标 failed，否则成功重启会被误判中断）。
6. **Windows 开发** — 改完插件执行 `sync-to-dsh.ps1`，关 Watchdog 再开「DSH Web」；勿依赖 plugin-repo detached 重启。
7. **Host subprocess 无 shell** — `argv[0]` 不得为 Windows `.cmd`/`.bat`（Node 20+ → `spawn EINVAL`）。包管理器必须经 `formatToolArgv` / `makeSpawnablePnpm` 解包为 `node + *.mjs|*.js` 或 `ComSpec /c`；Host spawn 前调用 `assertHostSpawnableArgv`。勿把「PATH 上找得到」当成「Host 能启动」。
8. **镜像请求** — `createMirrorClientFromContext` 对镜像 URL 与二进制必须用 native `fetch`（Host `web.fetch` 会丢 Authorization / 损坏 tarball）。

## 3. 仓库结构

```
dsh-version-autoupdate/
├── src/
│   ├── index.ts                 # Host：HTTP 路由 + npm 安装 + 工具注册
│   ├── source-aware-check.ts    # /status、/check、MCP check 共用
│   ├── source-detection.ts      # npm / github / unknown
│   ├── source-evidence.ts       # 从 fs 收集 .git、markers、remote
│   ├── mirror-client.ts         # 镜像 + 官方；download 大小上限 512MiB；可选磁盘缓存/续传
│   ├── artifact-cache.ts        # GitHub archive 本地缓存与 partial
│   ├── github-promote.ts        # staging→live: checkout + lib(+web dist) + lib入口校验 + relink + workspace links
│   ├── credentials.ts           # 镜像密码持久化
│   ├── update-tools.ts          # 注册 dsh_update_* MCP 工具
│   ├── update-operation.ts      # operation.json manifest
│   ├── github-update-worker.ts  # GitHub staging 全流程
│   ├── github-archive.ts        # tar 解压校验
│   ├── github-staging-paths.ts  # staging / backup / outcome 路径
│   ├── restart-outcome.ts       # 读取重启 helper 写入的结果
│   ├── dsh-restart.mjs          # 复用的进程重启 + 健康检查 + 回滚
│   └── client/                  # Web UI 胶囊（只读展示）
├── tests/                       # node --test *.spec.mjs
├── cordis.patch.yml
├── README.md
└── AGENTS.md
```

Host `inject`：`webServer`, `subprocess`, `fs`, `sandboxPolicy`, `timer`, **`tools`**

## 4. MCP 工具注册模式

参考 `dsh-plugin-repo`：每个工具用 `ctx.effect(() => tools.register(defineTool({...})))` 注册。

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'
// 见 src/update-tools.ts
```

不要使用 `McpServer.registerTool()`。

## 5. 更新路径

### npm（`source === 'npm'`）

1. `dsh_update` → `runNpmInstall` → `npm install -g @deepseek-ai/dsh@<target>`
2. 可选 `restart: true` → `scheduleProcessRestart({ force: true })`

### GitHub（`source === 'github'`）

1. 下载 tarball（MirrorClient，`auto` / mirror / official）
2. 解压至 `$DSH_HOME/version-autoupdate/staging/<op-id>/extract/`
3. 校验：单顶层目录、Harness markers、`package.json` 版本/tag
4. **预检 pnpm**（下载前）：`ensurePnpmReady` 解析并 `--version` 验证；Windows 上 **不得**直接 spawn `.cmd`（Node 会 EINVAL）——解包为 `node + pnpm.mjs` 或 `ComSpec /c`；失败则尝试 `corepack prepare`；仍失败返回跨平台修复建议
5. staging 内 **`pnpm` install + rebuild + `build:lib:host` + `build:lib:client` + `build:web`**，并 **校验** 各包 `lib` 入口文件存在（含 `native/` 与 subpath exports，如 `@deepseek-ai/node-addon-system/flock`）
6. **停机后再 promote（更新安全）**：写 `promote-job.json` + `maintenance.json{active:true}`，`phase=promoting`，`schedulePromoteAndBoot` 拉起 detached `promote-and-boot.mjs` 后 **host `process.exit`**。helper 等 parent 退出 → `promoteGithubStagingToLive`（失败则 scheme B=staging）→ **先写 `next-root` 再清 maintenance**（写失败则保持 hold 并 self-spawn）→（有看门狗交手 / 无看门狗自行 spawn）→ health + dwell ~25s → `succeeded`/`failed`/`rolled_back`。live promote 后 health 失败须 **`rollbackLiveToPreviousRef` + relink** 再拉起，禁止假 `rolled_back`。`restart=false` 时**禁止**在 host 存活时改 live（只保留 staging）。
   - **拷贝面**：`copyHarnessBuildArtifacts` 必须覆盖 `apps|packages|vendor|native` 下全部 `lib/`（`native/.../entry/lib` 被 gitignore，不拷则 live 缺 `flock.js` 无法 boot）。
7. 看门狗可选：`maintenance.active` 时 **禁止** `Start-DshWeb`；hold 清后 grace 等 `next-root`；插件**不依赖**看门狗也能闭环
8. `/status`：新鲜 `promoting`/`restarting` 视为 helper 在飞（`update.running=true`），不得标 orphaned
9. `dsh_update_status` 通过 `applyRestartOutcome()` 合并最终 phase；`promoting`/`restarting` 新鲜时不得被 `clearOrphanedIfNeeded` 误标 failed

> 旧路径（进程内 promote 再 restart）会在 live `pnpm install` 窗口跑半更新树（如缺 `ui-sidebar-right` → chat 等 `sidebarRight`）。

> 仅编 host（旧行为）会导致新增 client 包缺 `lib/index.js`，Web 启动失败、Watchdog 一直重启。详见 `docs/2026-09-12-update-safety-design.md`。

### 开发布局（本机）

- Host 运行时代码以 `lib/*.js` 为准（完整 `src/*.ts` 未检入时）；`src/dsh-restart.mjs` / `src/offline-install.mjs` 为可编辑入口，`npm run sync` / `npm test` 会同步到 `lib/`。
- `npm test` **不**依赖 `tsc`（无 host `.ts` 时）。

> 用户看到 `spawn pnpm ENOENT` 仍是 **GitHub 路径**（不是 npm 全局安装）。npm 源走 `npm install -g`，不会 spawn `pnpm`。

## 6. 开发命令

```bash
cd dsh-version-autoupdate
npm install --legacy-peer-deps   # devDeps 含 file: 指向 deepseek-harness 的 dsh-tools/schemastery
npm test                         # build + node --test（约 90 项）
npm run build
npm pack --dry-run
git diff --check
```

Windows 同步到 profile：

```powershell
D:\0HAN\Work\dsh-plugins\sync-to-dsh.ps1
```

## 7. 测试要点

| 场景 | 测试文件 |
|------|----------|
| GitHub status 不访问 npm | `host-http.integration.spec.mjs` |
| npm status 不访问 GitHub | 同上 |
| `/check` 只读、410 写入路由 | 同上 |
| MirrorClient 隔离 / sha256 / 大小限制 | `mirror-client.spec.mjs` |
| Archive 校验 | `github-archive.spec.mjs` |
| Staging worker 构建失败不重启 | `github-update-worker.spec.mjs` |
| MCP 工具注册与行为 | `update-tools.spec.mjs` |
| 凭据模块 | `credentials.spec.mjs` |

集成测试 mock `ctx.web.fetch` 与 `ctx.fs`，不依赖真实网络。

## 8. 常见陷阱

- **`workspaceRoot` 不能优先于运行入口** — 否则 npm 全局 dsh + GitHub workspace 会误判来源。
- **旧 npm 状态机** — `index.ts` 内 `runCheckStep` / `updateState` 等仍保留但 HTTP 路径已断开；勿重新接到 `/status` 或 `/check`。
- **`ctx.effect` 注册工具** — 错误写法 `ctx.effect(() => disposers.forEach(d => d()))` 会在 setup 时立刻 dispose；应 per-tool `ctx.effect(() => tools.register(...))`。
- **TypeScript + dsh-tools** — 用 `defineToolLoose`  cast 避免 strict schema 类型冲突（见 `update-tools.ts`）。

## 9. 发布注意

- `peerDependencies`：`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, cordis, dsh-client-*
- `files` 字段只打包 `lib/` 与 patch；源码在 `exports["./src/*"]` 供 profile file: 链接
- Bump `package.json` version 后 `sync-to-dsh.ps1` 或 push 到 plugin-repo
