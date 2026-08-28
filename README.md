# dsh-version-autoupdate

DSH (DeepSeek Harness) 双面 Cordis 插件：在 Web UI 中显示 DSH 版本角标（最新=绿 / 可更新=黄 / 待重启=蓝 / 失败=红 / 未知=灰），并支持**一键自动更新**。

## 功能

- **版本角标**：右上角（会话头部工具栏）常驻显示当前运行版本的更新状态，每 60 秒自动刷新。
- **状态判定**：对比「当前运行 / 已安装 / 目标最新」，语义化版本比较（含 `-rc.N` 预发布段）。
- **目标版本 = registry 最高版本**：不依赖 npm `latest` 标签（历史上常滞后于真正最高版本），而是枚举 registry 全部版本取语义化最高者——因此从 DSH `0.1.0-rc.6` 到未来的 `0.6.x` 都能被正确识别并追新。
- **更新通道 `channel`**（插件配置，可切）：
  - `preview`（默认）：最高版本，含预发布/rc（如 `0.1.0-rc.8`、未来 `0.6.0-rc.N`）；
  - `stable`：只认不带预发布后缀的最高正式版；若暂无正式版则自动回退到 preview。
  - 面板会同时显示「预览最新 / 稳定最新 / 目标版本（按当前通道）」。
- **一键更新**：可更新时点击角标 → 面板 → 「⚡ 立即更新」，使用**与当前 dsh 同 Node 目录的 npm**（不再误用 PATH 里的 Cursor/旧 Node）执行 `npm install -g @deepseek-ai/dsh@<target>` → 显示实时进度 → 「更新完成 · 重启生效」。默认安装超时 **10 分钟**（`installTimeoutMs`，小型 VPS 可调大）。内存不足（Linux MemAvailable < 400MB）时会拒绝安装，避免半装损坏。
- **只读探测**：拉取仅通过 `subprocess` + `web` 服务的只读链路；更新由用户点按钮触发，不静默后台安装。
- **点击外部关闭**：面板在点击任意非角标区域后自动关闭（无 × 按钮）。

## 架构

- **Host 面**（`src/index.ts`）：纯逻辑 + 服务消费（`fs` / `subprocess` / `web` / `sandboxPolicy` / `timer` / `webServer`）。通过 `webServer.register` 暴露同源 JSON API：
  - `GET /dsh-version-updater/status`
  - `POST /dsh-version-updater/start-update`
- **Client 面**（`src/client.tsx`）：通过 `exports["./client"]` 分发，注册到会话头部工具栏槽位，调用上面的 JSON API 渲染角标与面板。

## 安装

```bash
npm i -g dsh-version-autoupdate
# 在 cordis.yml 中写入一行：
# - id: dsh-version-autoupdate
#   name: 'dsh-version-autoupdate'
```

> **验证边界（重要）**
> Host 面的版本探测与更新逻辑通过真实的 DSH Service 接口实现，并已在本仓库做单测烟测。Client 面遵循 DSH 官方双面插件布局（`dsh.client` + `exports["./client"]`），槽位与 JSON 通信按当前版本接口实现，但在你的目标 DSH 版本上**可能需按该版本的槽位键/契约微调**。请以目标部署的实际 `dsh install` 结果为准。

## 使用

安装并加载插件后：

1. 重启 `dsh web` 服务，右上角出现版本角标。
2. 角标颜色含义见上。
3. 当显示「可更新」时点击角标 → 面板 → 「⚡ 立即更新」，等待完成。
4. 完成后提示**重启 `dsh web` 进程**使新版本生效（运行中的进程无法安全自重启）。
5. 想切换更新通道（预览/稳定）在 DSH 插件配置里把 `channel` 改为 `preview` 或 `stable` 后重启即可。

## 配置（cordis.yml / cordis.patch.yml）

| 字段 | 默认 | 说明 |
|------|------|------|
| `packageManager` | `npm` | 固定用 npm；也可 `pnpm` / `yarn` / `auto` |
| `packageManagerPath` | — | **推荐在 2G VPS 上显式指定**，如 `/home/ubuntu/.local/node-v22.19.0/bin/npm` |
| `minAvailableMemoryMb` | `400` | Linux 可用内存低于此值时拒绝更新（`0` 关闭） |
| `installTimeoutMs` | `600000` | 全局安装最长等待时间（毫秒），默认 10 分钟；慢速 VPS 可调到 `900000`（15 分钟） |
| `installGraceMs` | `60000` | 超时后 SIGTERM 的宽限期（毫秒） |
| `channel` | `preview` | `stable` 只追正式版 |

```yaml
- id: dsh-version-autoupdate
  name: dsh-version-autoupdate
  config:
    packageManager: npm
    packageManagerPath: /home/ubuntu/.local/node-v22.19.0/bin/npm
    minAvailableMemoryMb: 400
    installTimeoutMs: 900000   # 15 min on slow 2G VPS
```

## 更新超时

若面板显示「更新超时（600 秒）」且 npm 日志仍在 `http fetch`，说明安装未失败，只是超过了默认等待时间。可：

1. 在插件配置中增大 `installTimeoutMs`（如 `900000`）后重启 `dsh web` 再试；
2. 或 SSH 到服务器手动执行（使用**与 dsh 同 Node 的 npm 绝对路径**）：

```bash
/home/ubuntu/.local/node-v22.19.0/bin/npm install -g @deepseek-ai/dsh@0.1.0-rc.8 --no-audit --no-fund --omit=optional
```

超时**不等于** dsh 已损坏；只有安装命令非零退出且 `dsh` 无法启动时才需要回滚到旧版本。

若 `npm install -g` 中途被 OOM 杀死，`dsh` 可能每 5 秒崩溃重启。在控制台 VNC 登录后执行：

```bash
/home/ubuntu/.local/node-v22.19.0/bin/npm install -g @deepseek-ai/dsh@<上一个正常版本>
# 或
npm install -g @deepseek-ai/dsh@latest   # 确认 which npm 指向正确 Node
```

## 开发

```bash
npm install
npm run build     # 先构建 client bundle (lib/client.js)，再 tsc 编译 host (lib/)
npm test          # 构建校验
```

## 许可

MIT
