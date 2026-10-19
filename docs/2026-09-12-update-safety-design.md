# 更新安全：停机后 promote + 插件自治重启

日期：2026-09-12  
范围：`dsh-version-autoupdate` + `deepseek-harness/scripts/watch-dsh-web.ps1`

## 1. 目标与非目标

### 目标

- GitHub 自动更新在**无看门狗**时完整可用（停进程 → 改 live → 拉起 → 健康检查 → 终态）。
- live 被改动期间**不允许** `dsh web` 跑在半更新树上（杜绝 `sidebarRight` pending 类故障）。
- `promoting` / `restarting` 必须落到 `succeeded` | `failed` | `rolled_back`，禁止无限卡住。
- 有看门狗时仅协作 handoff（`next-root` + maintenance hold），**不**把 promote 交给看门狗。

### 非目标

- 不新增长驻 update daemon。
- 不重写整个插件；npm 全局安装路径仅对齐 restart 契约。
- 不在看门狗里实现 git/pnpm promote。

## 2. 状态机

```
checking → downloading → installing(staging build)
  → promoting   # dsh 已退出或即将退出；detached helper 改 live
  → restarting  # 新进程拉起中（helper 或 watchdog）
  → succeeded | failed | rolled_back
```

`installing` 仅表示 staging 下载/构建；**不得**在此阶段改 live。

## 3. 文件契约（`$DSH_HOME/version-autoupdate/`）

| 文件 | 写入方 | 含义 |
|------|--------|------|
| `operation.json` | worker + helper | 进度与终态 |
| `promote-job.json` | worker（退出前） | helper 入参：roots、tag、plans、healthUrl、outcome、parentPid |
| `maintenance.json` | worker 置 `active`；helper 清除 | `active:true` 时禁止 boot 半树 |
| `restart-outcome.json` | helper | 供新进程 `applyRestartOutcome` |
| `~/.dsh/watchdog-web.next-root` | helper（仅手递看门狗时） | 一次性 boot root |

## 4. 流程（推荐实现）

1. Host 内：下载 → 解压 → staging `pnpm install/rebuild` + `build:lib:host` + `build:lib:client` + `build:web` + `assertHarnessLibEntrypoints`。
2. 写 `promote-job.json` + `maintenance.json{active:true}`；`phase=promoting`。
3. Detach `node …/promote-and-boot.mjs <job>`，然后当前 `dsh` `process.exit`。
4. Helper：等 parent 退出且端口空闲 → `promoteGithubStagingToLive`（失败则 scheme B=staging）→  
   - **有看门狗**：先写 `next-root`，再清 maintenance，等健康后写 outcome（不双开进程）。  
   - **无看门狗**：清 maintenance → 自行 spawn next plan → health + ~25s dwell → outcome + `finish`。  
   - **健康失败**：若已成功 promote 到 live，必须用 `previousRef` + artifact 快照做 **git 回滚** 并 relink，再交看门狗/`rollbackPlan` 拉起并验活；不得只重启同一棵已升版坏树却标 `rolled_back`。scheme B（live 未改）仅切换 boot root。`next-root` 写失败时保持 maintenance，改为 self-spawn。
5. 看门狗：`maintenance.active` 时**不** `Start-DshWeb`；hold 清除后若短暂未见 `next-root` 再 grace 等待；超时（如 45min）解除 hold 并告警。**每次启动前**对 boot root 做完整性门控（`bin` + `web/dist` + `native` flock/index + `packages/client` lib 入口）；不完整则 `build:lib:*` 修复，失败则拒绝半树 boot（override root 退避；live 可降级 source）。

`restart=false`：**不得**在 host 存活时 promote live；仅保留 staging，提示 `restart=true`。

`/status` 在 helper 在飞时必须带 `update.running=true` + `update.phase`（胶囊读这组字段，不只读 `operation`）。

## 5. 看门狗角色

- 可选。锁文件 + `next-root` 仅避免双启动。
- 更新安全不依赖看门狗；无锁时 helper 自己 spawn。
- 过期 `restarting`（>30min 无 `finishedAt`）不得永久暂停 host rebuild（已有逻辑保留）。

## 6. 验收

- [ ] 无看门狗：一次 `dsh_update` 能升到新 tag，`operation.phase=succeeded`，`:3080` 健康。
- [ ] 有看门狗：promote 窗口内日志出现 hold，不出现半树 boot；结束后 Ready。
- [ ] 人为弄缺 staging client `lib`：promote 前/后断言失败，不写 succeeded，可回滚或 scheme B。
- [ ] 杀 helper 中途：maintenance 超时后看门狗恢复；operation 可被标 failed/orphaned。

## 7. 决策摘要

- 做法：扩展 detached helper（非 daemon）。
- 停机时机：staging 完成后、动 live 前。
- 插件自治：无看门狗也能 promote+boot。

## 8. 已知坑：native entry `lib/` 未拷贝

因果链（2026-09-12）：

1. `build:lib:host`（`tsconfig.host.json`）会编译 `native/system/packages/entry` → staging 有 `lib/flock.js`
2. 该 `lib/` 在 `native/system/.gitignore`（`packages/*/lib/`），**不会**随 git tag 进入 live
3. promote：`git checkout -f tag` 后靠 `copyHarnessBuildArtifacts` 把 staging 的 gitignored 构建物盖到 live
4. 旧实现 `listHarnessLibDirs` **只扫** `apps|packages|vendor`，**漏扫 `native/`**
5. live junction `@deepseek-ai/node-addon-system` → `entry` 无 `lib` → boot 报 `Cannot find module .../flock.js`

避免：拷贝与 assert 都必须包含 `native/` + subpath exports；回归测试 `tests/github-promote-copy-native.spec.mjs`。
