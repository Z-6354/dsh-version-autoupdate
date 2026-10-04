# DSH 上游更新研究（2026-10-04）

查询日采用 Asia/Shanghai 日期。仅使用 DeepSeek 官方 GitHub、源码标签和 npm registry；没有用 master 状态冒充已发布 API。本轮为审计，不修改实现。

## 发布现状（已验证）

- npm `latest`、`next` 均为 **0.2.0-rc.2**，`alpha` 为 **0.2.1-alpha.1**。最高已发布 SemVer 是 alpha，不等于 latest。当前插件 preview 枚举最高版本的策略因此会推荐 alpha；这是产品通道选择，不能将 latest 描述为故障或滞后。[官方 registry](https://registry.npmjs.org/@deepseek-ai/dsh)
- latest 发布于 2026-09-29；alpha 发布于 2026-10-03。rc.8 是 2026-08-19，期间已有 0.1.1、0.1.2、0.1.3、0.1.4、0.1.5、0.1.6、0.1.7 到 0.2 系列变更。[rc.2 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[alpha 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)、[rc.8 发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)
- rc.2 和 alpha 的根 package.json 均要求 Node `^22.19.0 || >=24.0.0`。22.20 可用，23.x 不匹配，24+ 可用；不能用单纯“>=22.19”判断。发布 CLI manifest 本身没有 engines 字段，根开发契约与 npm 强制校验必须区分。[rc.2 根 manifest](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/package.json)、[alpha 根 manifest](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/package.json)、[CLI manifest](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/apps/cli/package.json)

## 本插件相关契约（已验证）

| 内容 | 已发布证据 | 对本项目的影响 |
|---|---|---|
| Client manifest | rc.2 支持 `dsh.client.external`；alpha 类型说明 `inject` 是包依赖信息，不是 Cordis service injection，`external` 是隐式 baseline 之外的准确模块请求 | 删掉旧 client-runtime 依赖前，核对真实 require；服务依赖由 client 导出 inject 声明，避免混淆两者 |
| ModuleLoader | alpha 仍支持 `window.__ModuleLoader__.load({id,factory})` lazy CJS 注册 | 现有 bundle 包装没有仅凭新版本就重写的理由，须验证 graph/baseline externals |
| UI | rc.2 和 alpha 均保留 `shell.overlay` root/list 槽，alpha 官方用 `slots.register(options, Component)` | 浮动胶囊槽位可保留，建议把 React 组件直接传给 register，并做真实加载验证 |
| WebServer | alpha `register({kind:'exact'|'prefix',path,handler(req,res)})` 返回 disposer | 本插件同源 API 形状仍可用；不要假定随机桌面端口固定；反向代理前缀须单独验收 |
| Subprocess | rc.2 和 alpha 都有 `argv/cwd/stdio/graceMs/signal/env`；handle `done` 为退出事实，文本在 `collected.stdout/stderr.readFrom(offset)` | 更新日志、registry fallback、超时必须按真实 contract 验证，stdout/stderr 不在 done 中 |
| Home | rc.2 和 alpha 为显式配置 > 非空 DSH_HOME > ~/.dsh；含 ~ 展开、空值处理 | 本插件固定 `~/.dsh` 的日志/状态路径需适配，不能丢弃 DSH_HOME |
| Desktop | rc.2 macOS/Windows 有内置 dsh 命令与包管理，无需另装 Node/pnpm；与 CLI 共用 Harness home，desktop profile 位于 profiles/desktop | 不应把桌面端 Electron/私有 runtime 视为普通 npm global 安装；重启与更新必须走桌面官方流程 |

来源：[manifest rc.2](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/util/package-manifest/src/types.ts)、[manifest alpha](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/util/package-manifest/src/types.ts)、[ModuleLoader](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/modules/src/client/manifest.ts)、[UI rc.2](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-layout/src/client/index.ts)、[UI alpha](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/ui-layout/src/client/index.ts)、[WebServer](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/host/webserver/src/index.ts)、[subprocess rc.2](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/subprocess/subprocess/src/types.ts)、[subprocess alpha](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/subprocess/subprocess/src/types.ts)、[home rc.2](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/util/home-paths/src/index.ts)、[desktop paths](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/apps/desktop/src/paths.ts)。

## Desktop 内置 runtime 和更新（已验证）

alpha primary-runtime lock 指定 Node 24.21.0；Desktop runtime 构建明确要求 node 和 pnpm 两组件，不能据此假定所有历史或所有机器实际安装版本均相同。[runtime lock](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/scripts/primary-runtime/lock.json)、[Desktop runtime preparation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/apps/desktop/scripts/prepare-primary-runtime.ts)

rc.2 与 alpha preload 都暴露 `dshDesktop.updates.status()/open()/subscribe()`。这是呈现和打开原生确认窗口的 carrier bridge；bridge 自身不能选择 artifact 或授权安装。建议插件检测存在后展示官方状态并调用 open，不尝试通过 npm global 升级 Desktop。[rc.2 preload](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/desktop/src/preload-app.ts)、[alpha bridge types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/client/ui-settings-general/src/types.ts)

alpha Electron updater 配置 `autoDownload=false`、`autoInstallOnAppQuit=false`、channel nightly、allowPrerelease=true、allowDowngrade=false，并检查 packaged/app-update.yml。npm release 通道无法替代桌面 updater 通道。[coordinator](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/apps/desktop/src/update-coordinator.ts)

## alpha 专属改动（不能宣称 rc.2 已具备）

0.2.1-alpha.1 发布说明明确：移除 runtime invariant 插件及各包 `./invariant` 导出；子路径插件不再读独立 package.json，文本与图标用子路径 exports；composer stats 拆为 activity/usage；开发目录 HMR 刷新 package entry/dependency mappings；替换已安装包版本仍需重启；启停插件样式清理修复；`--public-url` 支持反向代理路径前缀；Desktop 默认 OS 分配端口。对本插件最直接的是 invariant 配置/导出清理、module loader 依赖检查、同源 API 前缀、重启提示。[alpha 官方发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)

旧 `@deepseek-ai/dsh-client-runtime` registry latest 是 0.0.1-rc.1、next 是 0.1.1-rc.2，没有 0.2 版本。当前 CLI 使用模块系统和 cordis-client-runner 等分层包；不能机械把旧 peer 提升到 ^0.2.0，应根据实际 import 和服务依赖迁移。[旧 runtime registry](https://registry.npmjs.org/@deepseek-ai/dsh-client-runtime)、[CLI dependencies](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/apps/cli/package.json)、[client-runner](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/packages/extensions/cordis-client-runner/src/client/index.ts)

## 待验证

- 本插件在 0.2.0-rc.2 与 0.2.1-alpha.1 的实际安装、client materialization、服务注入和拖动/弹窗行为；读源码不是运行验收。
- client baseline externals、没有旧 runtime inject 后 React 与 Cordis require 的可用性。
- 桌面端不同发行渠道是否提供完整 updates bridge；未提供时继续只读并给可执行提示。
- 带路径前缀 reverse proxy 下插件 fetch 路径应如何与官方入口一致。
- 当前各种启动方式的 executable/安装包版本可否可靠映射；仅检测 npm registry 与 process.version 不足以代表实际 Desktop 可更新状态。
