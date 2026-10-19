# dsh-version-autoupdate

DSH（DeepSeek Harness）双面 Cordis 插件：Web UI 版本胶囊 + **同源**自动更新（npm 或 GitHub checkout，严格隔离）。

## 0.3.61：兼容与更新结果

不绑定 DSH 的精确版本或源码 SHA。沿用 Cordis 4.x 与注入服务接口，声明宽版本范围，并包含目前 0.2.0 / 0.2.1 的预发布版本。DSH 版本号改变不会触发运行时白名单拒绝；接口发生实质变化时仍可能需要适配，不承诺任意未来版本。

- npm 安装前核对包管理器全局目录与正在运行的 DSH；安装后从同一目录读取版本并核对目标。
- 要求重启时，状态保持 restarting，由独立 helper 的健康检查结果决定成功或失败；不重启时明确表示仅安装完成。
- GitHub 重启保留 host、port、trusted-host、profile、patch 等原 CLI 参数。
- GitHub 手动回滚在宿主退出后恢复旧 Git ref、构建产物并重建依赖链接，健康检查通过后才报告 rolled_back；保留原操作备份用于定位。

Host 运行时以 lib/*.js 为维护源；src/dsh-restart.mjs 与 src/offline-install.mjs 通过 npm run build 同步。无需为了旧 TypeScript 树重新生成运行时。

## 功能概览

| 能力 | 说明 |
|------|------|
| **版本胶囊** | 会话头部显示运行/已装/最新版本、安装来源、检测通道、错误信息 |
| **同源检测** | 自动识别 `npm` / `github` / `unknown`；GitHub 安装只查 GitHub，npm 安装只查 npm |
| **镜像 + 官方** | 默认 `auto`：优先镜像；**网络/限流**失败时回退官方源；**认证失败不回退**（重新询问密码或选官方）；完整性错误不回退 |
| **MCP 更新** | `dsh_update_check` / `dsh_update` / `dsh_update_status` / `dsh_update_watch` / `dsh_update_rollback` |
| **GitHub staging** | 下载 → 校验 → staging 构建 → promote 到 live（含 `pnpm rebuild` 原生模块）→ **版本变化时默认重启**。若桌面 Watchdog（`watch-dsh-web`）在跑，插件只退出并写 outcome，由 Watchdog 拉起，避免抢占 3080 |
| **npm 更新** | 全局 `npm install -g @deepseek-ai/dsh@<version>`（走官方 registry，不弹镜像密码） |

UI **不再提供**安装/重启按钮；写入类 HTTP 端点（`/install`、`/start-update`、`/restart`）返回 **410 Gone**，提示使用 `dsh_update` 工具。

## HTTP API（只读）

| 路径 | 方法 | 说明 |
|------|------|------|
| `/dsh-version-updater/status` | GET | 同源 status（含 source / transport / updateAvailable） |
| `/dsh-version-updater/check` | POST | 纯检测，不安装、不重启、不询问密码 |
| `/dsh-version-updater/install` | * | 410 — 请用 `dsh_update` |
| `/dsh-version-updater/start-update` | * | 410 |
| `/dsh-version-updater/restart` | * | 410 |

## MCP 工具

| 工具 | 作用 |
|------|------|
| `dsh_update_check` | 同源只读检测 |
| `dsh_update` | 启动同源更新；`restart` / `force`；镜像密码由工具代码读取，缺失则弹出 userQuestions UI |
| `dsh_update_status` | 即时快照（用户追问时） |
| `dsh_update_watch` | **默认进度循环**：阻塞到启动 / 1 分 / 5 分 / 每 10 分 / 终态，再让 Agent 用 `summary` 汇报 |
| `dsh_update_rollback` | npm 回滚到 backup 版本；GitHub 回滚到记录的 live root |

**约束：** 不接受 caller 指定的 `source`；检测类调用不触发密码交互；镜像密码存于 `$DSH_HOME/version-autoupdate/credentials.json`。

## 自然语言怎么用

插件会向 Agent 注入指引。新开对话后可直接说：

```text
检查一下 DSH 有没有更新
```

```text
有更新的话就更新 DSH，先不要重启；告诉我进度
```

```text
更新 DSH 并重启
```

```text
强制重新安装当前最新版（force=true）并重启，然后用 dsh_update_status 报告进度
```

```text
回滚刚才的 DSH 更新
```

Agent 应自动调用 `dsh_update_check` → `dsh_update` → 循环 `dsh_update_watch`（直到 `done`）。用户追问进度时用 `dsh_update_status`。若模型没点到工具，可点名：`调用 dsh_update`，参数 `force=true`，`restart=true`。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|------|------|------|
| `updatePolicy` | `platform` | Windows 可装可重启；Linux/macOS 仅检测。`full` / `detect-only` 可覆盖 |
| `channel` | `preview` | `stable` 只追正式版 |
| `packageManager` / `packageManagerPath` | npm | npm 更新用的包管理器 |
| `installTimeoutMs` | `1200000` | npm 全局安装超时（毫秒） |
| `autoRestart` | `false` | 旧向导用；MCP 显式 `restart: true` 时强制重启 |
| `force` | `false` | `/status` 绕过 registry 缓存 |

## 本地开发（Windows）

插件源码目录：`D:\0HAN\Work\dsh-plugins\dsh-version-autoupdate`

```powershell
npm install --legacy-peer-deps
npm test
D:\0HAN\Work\dsh-plugins\sync-to-dsh.ps1
```

然后 **关闭 Watchdog → 双击「DSH Web」** 重启 DSH（不要用插件仓库 UI 的 detached 重启）。

## 验证

```bash
npm test
npm run build
npm pack --dry-run
git diff --check
```

## 许可

MIT
