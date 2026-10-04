# DSH 自动更新插件适配审计（2026-10-04）

审计基线：插件 `0.3.21` / `37a6d91`。本轮先完成更新前调查，不修改安装、重启行为，也不发布包。上游接口核对见同目录 `dsh-upstream-research-2026-10-04.md`。

## 已确认的发布现状

实时查询 [DSH npm registry](https://registry.npmjs.org/@deepseek-ai/dsh)：`latest` 与 `next` 指向 `0.2.0-rc.2`（2026-09-29），`alpha` 指向 `0.2.1-alpha.1`。发布标签与语义化最高版本代表不同选择，不应混为“稳定版”。

插件 `src/index.ts` 枚举全部版本并取最高，默认 `preview` 会追踪 alpha；`stable` 在没有正式版本时也会回退到 preview。建议补充明确的发布通道选择与回退提示，保留已有配置的兼容性。是否改变默认值属于产品选择，实施时应明确记录。

## 必须优先处理

| 优先级 | 本地位置 | 问题及更新方向 | 验收要求 |
| --- | --- | --- | --- |
| P0 | `package.json`、`src/client/apply.ts`、构建脚本 | 前端仍依赖旧 `dsh-client-runtime`；其 registry 最新发布序列停在 `0.1.1-rc.2`，DSH `0.2.0-rc.2` CLI 已依赖 `dsh-cordis-client-runner`。按新客户端契约核对 manifest、类型与 ModuleLoader；不要仅机械升级版本号。 | 在目标 Web profile 实际安装，确认前端激活、悬浮胶囊挂载和卸载。 |
| P0 | `src/dsh-root.ts`、`src/index.ts` | DSH 根目录探测未直接解析普通 npm 启动的 `process.argv` 中 `lib/bin.js`；会回退查 PATH。`detectSystem` 仅按 `/node_modules/` 判断 npm/git，Windows 反斜杠路径会误判。需要区分运行安装与被更新安装，并识别桌面、源码、npx、本地/全局 npm 来源。 | 多安装共存及 Windows 路径下，显示与安装目标一致；非全局来源不能误报全局更新成功。 |
| P0 | `src/platform-policy.ts`、`src/index.ts`、重启脚本 | 当前按 OS 授予安装/重启能力，不能表达桌面内置运行时和 CLI 安装之间的差别。应先识别安装来源，再开放相应操作，桌面更新需遵循其实际机制。 | 桌面与 CLI 分别验证；不把 `npm install -g` 当作桌面应用升级。 |
| P1 | `src/index.ts` | 所有 `webServer.register` 返回的 disposer 未接入插件 effect。上游新服务明确拒绝重复 `(kind,path)`。 | 插件卸载后路由消失，再加载不报重复注册。 |
| P1 | `src/dsh-restart.mjs`、`src/offline-install.mjs` | 重启和离线状态文件采用固定 `~/.dsh`，应遵循 `DSH_HOME` 与实际 home 配置。 | 自定义 home 的日志、状态读写位于同一根目录。 |
| P1 | `src/package-manager.ts` | Node 检查仅采用 `>=22.19.0`，上游根清单范围是 `^22.19.0 \|\| >=24.0.0`，当前逻辑会错误放行 Node 23。对目标发布的运行时要求做预检；CLI npm manifest 缺少 engines 时不能声称 registry 已声明该范围。 | Node 23 被拦截，22.19+ 与 24+ 按官方范围判断；目标要求与来源可追溯。 |
| P1 | README、`cordis.patch.yml`、锁文件 | README 仍写头部角标、10 分钟超时、手动重启等旧行为；实际为浮动胶囊、20 分钟、Windows 默认全功能及 POSIX 默认仅检测。锁文件顶层版本 `0.3.16` 与包版本 `0.3.21` 不一致；模板包含部署专用 trustedOrigins。 | 文档和默认配置逐项对照代码；重新生成锁文件，移除通用模板中的特定部署域名。 |

## 已核对、无需直接重写

### alpha 额外适配

`0.2.1-alpha.1` 的[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)移除了 runtime invariant 插件与官方包的 invariant 导出，并新增 `--public-url` 路径前缀支持。需审查本插件 `src/invariant.ts` / `./invariant` 是否仍有调用方，避免继续依赖已移除机制；同时验证 `src/client/api.ts` 的根绝对 URL 在带前缀代理下是否指向正确入口。这些是 alpha 验收项目，不能视为 rc.2 的已验证故障。

- [0.2.0-rc.2 WebServer 源码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/host/webserver/src/index.ts)仍支持 `register({ kind, path, handler })`，当前 HTTP handler 形状本身没有证据表明已经失效；需修复的是生命周期管理，并验证载体差异。
- [home-paths 源码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/util/home-paths/src/index.ts)规定显式配置、`DSH_HOME`、`~/.dsh` 的优先级，可作为路径适配依据。
- [CLI 包清单](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/cli/package.json)仍以 `lib/bin.js` 提供 `dsh` 命令。
- 目前 registry 的简化 DSH manifest 实测约 576600 UTF-8 bytes，尚未超过插件 subprocess stdout 的 1 MiB 限制；可作为后续可扩展性问题，不能描述为当前已发生的故障。
- 插件语义化比较支持多位 rc 数字和常见 alpha 后缀，无需因主次版本提升硬编码更新版本；完整 SemVer build metadata 与非法版本过滤仍应补充边界测试。

## 推荐实施顺序

1. 选定 `0.2.0-rc.2` 为首个验收版本，明确 alpha 通道行为；同时标记与上游 master 的差异。
2. 适配 manifest、客户端类型/加载契约、槽位，修复路由生命周期。
3. 建立安装来源和运行版本探测，依此控制安装/重启能力。
4. 适配 home、Node 预检与重启参数，补充针对性回归测试。
5. 同步 README、配置模板与锁文件，完成真实 Web profile 验收后再递增插件版本。

本轮未安装依赖、未运行构建或真实 DSH；上述内容是源码和官方发布数据审计结果，不代表完成兼容性验收。
