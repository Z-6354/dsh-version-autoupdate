# dsh-version-autoupdate

DSH 双面 Cordis 插件：显示可拖动的浮动版本胶囊，提供版本检测、安装、确认重启三个步骤。

## 功能和更新边界

- 每 60 秒检测运行版本、磁盘版本和 npm 目标版本；执行更新期间加快刷新。
- `preview`（默认）取 registry 中语义化最高版本，包含 alpha/rc；`stable` 取最高正式版，没有正式版时回退 preview。`preview` 不等同 npm `latest`。
- Windows 默认允许 npm 安装和确认重启；Linux/macOS 默认仅检测。使用 `updatePolicy: full` 可启用支持的 CLI 更新操作。
- 只有包管理器的全局目录与当前运行包的真实路径一致，才执行全局安装。桌面版、npx、源码和未知安装来源不执行全局安装；桌面版和 npx 不提供进程重启。
- 桌面版请使用 DSH 官方更新流程；插件尚未接入桌面原生 updates bridge。
- 全局安装优先使用当前 Node 同目录的包管理器，支持 npm/pnpm/Yarn Classic。查询全局目录失败或目标不一致会阻止安装。
- 安装成功后点击确认重启；运行进程启动时读取的版本与磁盘版本分开显示。

## 安装和使用

```bash
npm i -g dsh-version-autoupdate
```

使用当前 DSH 版本的插件管理流程加载该包。包声明 `dsh.bundle.patch` 和 `exports["./client"]`；如手动配置 profile，Host 插件行如下：

```yaml
- id: dsh-version-autoupdate
  name: dsh-version-autoupdate
  config:
    channel: preview
    updatePolicy: platform
```

启动或重启 `dsh web` 后，通过浮动胶囊查看版本并执行检查、安装、确认重启。POSIX 上默认仅检测，可按部署情况选择 `full` 或通过原安装方式手动升级。

## 配置

| 字段 | Schema 默认值 | 说明 |
| --- | --- | --- |
| `packageManager` | `npm` | `npm` / `pnpm` / `yarn` / `auto` |
| `packageManagerPath` | 无 | 包管理器可执行文件的绝对路径；仍会核对全局安装目录 |
| `channel` | `preview` | 最高版本含 alpha/rc；`stable` 仅正式版，无正式版时回退 |
| `updatePolicy` | `platform` | Windows CLI 可更新，Linux/macOS 仅检测；可选 `full` / `detect-only`，安装来源限制始终生效 |
| `minAvailableMemoryMb` | `400` | Linux 可用内存低于阈值时拒绝更新；`0` 关闭 |
| `installTimeoutMs` | `1200000` | 安装总超时，默认 20 分钟 |
| `installIdleTimeoutMs` | `0` | 无输出超时，默认关闭，避免 npm 静默下载时被误终止 |
| `installGraceMs` | `60000` | 终止后的等待时间 |
| `autoRestart` | `false` | 保留的重启策略项；当前分步流程仍需点击确认重启，Windows 不自动重启 |
| `restartDelayMs` | `2000` | 确认重启后的延迟 |
| `offlineInstall` | `auto` | Linux 低内存离线安装；`always` / `never` 可覆盖。随包模板使用 `never` |
| `offlineInstallMaxMemMb` | `2560` | `auto` 模式的总内存阈值 |
| `systemdUnit` | `dsh-web.service` | 离线安装停止和启动的 systemd unit |
| `trustedOrigins` | `[]` | 反向代理改写 Host 时允许的来源主机名，由部署者设置 |
| `force` | `false` | 状态请求绕过 registry 缓存 |

重启日志、离线日志和状态文件使用非空 `DSH_HOME`，未设置时使用 `~/.dsh`；支持 `~` 展开。插件未提供独立的 home 配置项。

## 兼容性和验证

适配依据为 DSH `0.2.0-rc.2` 及 `0.2.1-alpha.1` 官方源码。当前 Node 预检遵循上游根清单的 `^22.19.0 || >=24.0.0`，拒绝 Node 23；目标版本以后若变更要求，需要重新适配。

已移除旧 `dsh-client-runtime` 包依赖，客户端仍使用 ModuleLoader 和 `shell.overlay`，React 由 DSH 提供。Host 路由与客户端挂载都随插件生命周期清理。

仓库测试包含模拟服务、客户端 bundle 加载、安装目标核对与回归测试，不会执行真实 npm 全局安装或成功重启。真实 DSH Web/桌面验收、alpha 的代理路径前缀支持尚未完成；不能将构建或模拟测试通过视为实际部署验证。

## HTTP API

- `GET /dsh-version-updater/status`
- `POST /dsh-version-updater/check`
- `POST /dsh-version-updater/install`
- `POST /dsh-version-updater/restart`
- `POST /dsh-version-updater/start-update`：兼容旧入口，目前只启动检查，返回分步流程提示。

方法不匹配返回 405；写操作检查来源；重复操作不能覆盖进行中的更新状态。重启在更新执行期间返回 409。

## 更新故障排查

全局目录不一致：确认 `packageManagerPath` 对应当前 DSH 安装，而不是 PATH 中的另一套 Node。npx、本地项目或桌面安装请按原方式升级。

安装超时：检查日志与网络，必要时增大 `installTimeoutMs`，或使用已确认的包管理器路径手动安装目标版本。不要把超时等同于安装损坏；若安装失败且 DSH 无法启动，可按原安装方式恢复上一个正常版本。

## 开发

```bash
npm ci
npm test                 # 客户端类型检查、构建、全部回归测试
npm run build
npm pack --dry-run       # prepack 自动重新构建并检查发布文件
```

构建输出在 `lib/`；新增 `.mjs` 和类型声明会自动复制，发布包包含源码子路径与客户端类型声明。客户端使用外部 source map，避免把调试数据内嵌到加载脚本。

## 许可

MIT
