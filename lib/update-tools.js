import { restartOutcomePath } from './github-staging-paths.js';
import { versionCompare } from './semver.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runSourceAwareCheck } from './source-aware-check.js';
import { isOperationOrphaned, summarizeOperation, UpdateOperationStore, } from './update-operation.js';
import { applyRestartOutcome } from './restart-outcome.js';
import { watchUpdateProgress } from './update-watch.js';
import { resolveUpdateChannel } from './resolve-update-channel.js';
const defineToolLoose = defineTool;
/** Strip undefined so harness lossless-JSON snapshot succeeds. */
export function losslessJson(value) {
    return JSON.parse(JSON.stringify(value));
}
const TOOL_OUTPUT = {
    schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
        },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};
const UPDATE_PROMPT = [
    'When the user asks in any language to check, update, upgrade, or roll back DSH / DeepSeek Harness (例如：检查更新、更新 DSH、升级、回滚), use these tools directly — they are Host tools from dsh-version-autoupdate, not a separate MCP server:',
    '- dsh_update_check: read-only same-source version check (call with {}). Never asks for mirror password.',
    '- dsh_update: start same-source update. For 强制更新 / same-version reinstall pass force=true. GitHub version bumps promote staging→live (checkout+lib+pnpm relink+link check) then auto-restart; on promote failure falls back to staging restart. restart=false keeps checkout only without switching.',
    '  * Mirror password is handled IN CODE via userQuestions UI (密码/官方源/取消). Do NOT ask for password in chat; do NOT invent mirrorPassword/useOfficial args.',
    '  * When current==latest, still call dsh_update with force=true — do NOT tell the user there is no update available unless the tool returned that error without force.',
    '  * If cancelled: tell the user to answer the on-screen question — pick「仅用官方源」for official force reinstall, or「输入镜像密码」then type the password under the title (block input, not a separate「其他」row).',
    '  * Just call dsh_update once with the right flags and wait for the UI / tool result.',
    '- dsh_update_status: instant status snapshot (用户询问进度时立刻调用). Prefer top-level `summary` and `operation.progress`.',
    '- dsh_update_watch: DEFAULT progress loop after starting an update. Blocks until the next report event (start / 1min / 5min / every 10min / terminal). Pass lastMilestoneMs from the previous watch result. Do NOT busy-poll dsh_update_status every few seconds.',
    '- dsh_update_rollback: roll back the previous same-source update.',
    'Always check with dsh_update_check before updating. Never invent a caller-supplied install source; never cross npm and GitHub channels.',
    'If dsh_update fails with pnpm/corepack remediation text: report the suggested fix commands to the user (this is GitHub staging build, not npm). Do not claim the source was npm.',
    'If source is unknown: explain the GitHub vs npm path requirements from the tool error; do not start an update.',
    'Default progress reporting (automatic — the user does NOT need to ask for progress updates):',
    '1) After dsh_update returns started=true: tell the user it started and that the version capsule shows a live progress bar; mention whether channel is mirror or official from the tool result.',
    '2) Immediately call dsh_update_watch with {} (omit lastMilestoneMs). When it returns with reportToUser=true, post a 1–2 sentence update using `summary`. If done=false, call dsh_update_watch again with lastMilestoneMs=nextLastMilestoneMs. Repeat until done=true.',
    '3) Whenever the user asks about progress: call dsh_update_status immediately (do not wait for the next watch milestone).',
    '4) On terminal/orphaned: report the final result once and stop watching.',
    'Between watch returns, stay quiet. Prefer the on-screen progress bar for continuous feedback; chat reports are milestones only.',
].join('\n');
export function registerUpdateTools(host) {
    const { ctx, capabilities, store, runNpmInstall, runGithubUpdate, scheduleRestart, invalidateInstalledCache, dshHome } = host;
    const ctxTools = ctx;
    const tools = ctxTools.tools
        ?? (typeof ctxTools.get === 'function' ? ctxTools.get('tools') : undefined);
    if (!tools || typeof tools.register !== 'function')
        return [];
    const disposers = [];
    const register = (definition, label) => {
        if (typeof ctxTools.effect === 'function') {
            disposers.push(ctxTools.effect(() => tools.register(definition), label));
        }
        else {
            disposers.push(tools.register(definition));
        }
    };
    const systemPrompt = ctxTools.systemPrompt
        ?? (typeof ctxTools.get === 'function' ? ctxTools.get('systemPrompt') : undefined);
    if (systemPrompt && typeof systemPrompt.section === 'function') {
        const order = typeof systemPrompt.getSectionOrder === 'function'
            ? systemPrompt.getSectionOrder('TOOL_WEB_FETCH') + 50
            : 2150;
        const section = () => systemPrompt.section({ name: 'tool:dsh_update', order, text: UPDATE_PROMPT });
        if (typeof ctxTools.effect === 'function') {
            disposers.push(ctxTools.effect(section, 'dsh-version-autoupdate: system prompt'));
        }
        else {
            disposers.push(section());
        }
    }
    register(defineToolLoose({
        name: 'dsh_update_check',
        description: 'Check whether a same-source DSH / DeepSeek Harness update is available (检查 DSH 更新). Returns source, versions, and updateAvailable. Call with {}.',
        parameters: {},
        output: TOOL_OUTPUT,
        async execute() {
            const check = await runSourceAwareCheck(ctx);
            const payload = {
                ok: check.error === null,
                source: check.source,
                transport: check.transport,
                currentVersion: check.currentVersion,
                latestVersion: check.latestVersion,
                updateAvailable: check.updateAvailable,
                checkedAt: check.checkedAt,
            };
            if (check.error)
                payload.error = check.error;
            return losslessJson(payload);
        },
    }), 'dsh-version-autoupdate: dsh_update_check');
    register(defineToolLoose({
        name: 'dsh_update_status',
        description: 'Return the current DSH update operation status/progress (更新进度/状态). Prefer top-level summary and operation.progress for user-facing updates. Call with {}.',
        parameters: {},
        output: TOOL_OUTPUT,
        async execute() {
            await store.load();
            await applyRestartOutcome(store, dshHome);
            const operation = store.snapshot();
            const running = store.isRunning();
            const orphaned = isOperationOrphaned(operation, running);
            return losslessJson({
                ok: true,
                running,
                orphaned,
                summary: summarizeOperation(operation, running),
                operation,
            });
        },
    }), 'dsh-version-autoupdate: dsh_update_status');
    register(defineToolLoose({
        name: 'dsh_update_watch',
        description: 'Wait until the next default progress report for an in-flight DSH update (启动后默认进度：约 1 分 / 5 分 / 每 10 分 / 结束). Pass lastMilestoneMs from the previous watch result. Then tell the user summary if reportToUser is true.',
        parameters: {
            lastMilestoneMs: {
                type: 'number',
                description: 'Milestone ms already reported (use nextLastMilestoneMs from the previous dsh_update_watch result; 0 on first call).',
            },
            timeoutMs: {
                type: 'number',
                description: 'Optional max wait for this call (default ~11 minutes).',
            },
        },
        output: TOOL_OUTPUT,
        async execute(args) {
            const result = await watchUpdateProgress({
                store,
                dshHome,
                lastMilestoneMs: typeof args.lastMilestoneMs === 'number' ? args.lastMilestoneMs : undefined,
                timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
            });
            return losslessJson(result);
        },
    }), 'dsh-version-autoupdate: dsh_update_watch');
    register(defineToolLoose({
        name: 'dsh_update',
        description: 'Start a same-source DSH / DeepSeek Harness update. For强制更新 same version pass force=true. Mirror channel is chosen in-code via userQuestions UI (not chat). GitHub version bumps promote into live (with pnpm relink + workspace link verify) then auto-restart unless restart=false; promote failure falls back to staging restart.',
        parameters: {
            restart: {
                type: 'boolean',
                description: 'GitHub: omit to auto-restart when target≠current; true forces restart; false keeps staging only. npm: restart only when true.',
            },
            force: { type: 'boolean', description: 'Required for 强制更新 when already on latest (reinstall same version, e.g. 0.1.2-alpha.2).' },
        },
        output: TOOL_OUTPUT,
        async execute(args, exec) {
            if (!capabilities.canInstall) {
                return losslessJson({ ok: false, error: capabilities.detectOnlyReason || 'install is disabled for this platform' });
            }
            if (store.isRunning()) {
                return losslessJson({ ok: false, busy: true, error: 'update operation already running' });
            }
            await applyRestartOutcome(store, dshHome);
            await store.clearOrphanedIfNeeded();
            // Resolve target first so force/availability fails before password UI.
            const check = await runSourceAwareCheck(ctx);
            if (check.source === 'unknown') {
                return losslessJson({ ok: false, error: check.error || 'installation source is unknown' });
            }
            const targetVersion = check.latestVersion;
            if (!targetVersion) {
                return losslessJson({
                    ok: false,
                    error: 'no same-source latest version could be resolved',
                    source: check.source,
                    transport: check.transport,
                    currentVersion: check.currentVersion,
                    latestVersion: check.latestVersion,
                    updateAvailable: check.updateAvailable,
                    checkedAt: check.checkedAt,
                });
            }
            if (!args.force && !check.updateAvailable) {
                return losslessJson({
                    ok: false,
                    error: 'no same-source update is available (pass force=true to reinstall the current latest)',
                    source: check.source,
                    transport: check.transport,
                    currentVersion: check.currentVersion,
                    latestVersion: check.latestVersion,
                    updateAvailable: check.updateAvailable,
                    checkedAt: check.checkedAt,
                });
            }
            // npm always installs from the registry — skip mirror password UI.
            if (check.source === 'npm') {
                const operation = await store.beginPersisted({
                    source: 'npm',
                    transport: 'official',
                    currentVersion: check.currentVersion,
                    targetVersion,
                });
                await store.patch({
                    progress: { message: 'Starting npm update (official registry)…' },
                });
                const run = (async () => {
                    try {
                        await store.patch({ phase: 'installing', progress: { message: `Installing @deepseek-ai/dsh@${targetVersion}…` } });
                        const result = await runNpmInstall(targetVersion, check.currentVersion);
                        store.appendTail(result.tail);
                        invalidateInstalledCache();
                        if (!result.afterVersion || versionCompare(result.afterVersion, targetVersion) !== 0) {
                            await store.finish('failed', `install target mismatch: expected ${targetVersion}, actual ${result.afterVersion ?? 'unreadable'}`);
                            return;
                        }
                        await store.patch({ currentVersion: result.afterVersion });
                        if (args.restart === true) {
                            if (!capabilities.canRestart) {
                                await store.finish('failed', 'Installation completed, but restart is unavailable; restart DSH manually.');
                                return;
                            }
                            await store.patch({ phase: 'restarting', progress: { message: 'Installed; waiting for restart health check…' } });
                            const restart = scheduleRestart({ operationId: operation.id, outcomeFile: restartOutcomePath(dshHome) });
                            store.appendTail(`${restart.message}\n`);
                            if (!restart.ok) {
                                await store.finish('failed', restart.message);
                                return;
                            }
                            return; // Detached helper owns the final health outcome.
                        }
                        await store.patch({ progress: { message: 'Installation completed; restart was not requested.' } });
                        await store.finish('succeeded');
                    }
                    catch (error) {
                        if (store.isRunning()) {
                            await store.finish('failed', error instanceof Error ? error.message : String(error));
                        }
                    }
                })();
                void run;
                return losslessJson({
                    ok: true,
                    started: true,
                    forced: Boolean(args.force),
                    channel: 'official',
                    channelNote: 'npm installs from the official registry (mirror channel not used)',
                    operation,
                });
            }
            const asker = (typeof ctxTools.get === 'function'
                ? ctxTools.get('userQuestions')
                : ctx.userQuestions);
            const channel = await resolveUpdateChannel({
                dshHome,
                asker: asker ?? null,
                agent: exec?.agent,
                signal: exec?.signal,
            });
            if (!channel.ok) {
                return losslessJson({
                    ok: false,
                    cancelled: channel.cancelled === true,
                    error: channel.error,
                    hint: 'On the question UI: choose「仅用官方源」to force-reinstall without mirror, or「输入镜像密码」then type the password under the title (block input).',
                    force: Boolean(args.force),
                    targetVersion,
                });
            }
            const operation = await store.beginPersisted({
                source: check.source,
                transport: channel.transport,
                currentVersion: check.currentVersion,
                targetVersion,
            });
            await store.patch({
                progress: { message: `Starting GitHub update (${channel.note})…` },
            });
            const runGithub = (async () => {
                try {
                    await runGithubUpdate({
                        targetVersion,
                        transport: channel.transport,
                        restart: args.restart,
                        mirrorPassword: channel.password,
                    });
                }
                catch (error) {
                    if (store.isRunning()) {
                        await store.finish('failed', error instanceof Error ? error.message : String(error));
                    }
                }
            })();
            void runGithub;
            return losslessJson({
                ok: true,
                started: true,
                forced: Boolean(args.force),
                channel: channel.transport,
                channelNote: channel.note,
                operation,
            });
        },
    }), 'dsh-version-autoupdate: dsh_update');
    register(defineToolLoose({
        name: 'dsh_update_rollback',
        description: 'Roll back the previous same-source DSH update (回滚 DSH 更新) using the recorded backup version or live root. Call with {}.',
        parameters: {},
        output: TOOL_OUTPUT,
        async execute() {
            await store.load();
            await applyRestartOutcome(store, dshHome);
            const operation = store.snapshot();
            if (!operation?.backupVersion) {
                return losslessJson({ ok: false, error: 'no backup version is available to roll back' });
            }
            if (store.isRunning()) {
                return losslessJson({ ok: false, busy: true, error: 'update operation already running' });
            }
            if (!capabilities.canInstall) {
                return losslessJson({ ok: false, error: capabilities.detectOnlyReason || 'install is disabled for this platform' });
            }
            if (operation.source === 'github') {
                if (!operation.liveRoot && !operation.backupPath) {
                    return losslessJson({ ok: false, error: 'no GitHub backup root is available to roll back' });
                }
                if (typeof host.runGithubRollback !== 'function')
                    return losslessJson({ ok: false, error: 'GitHub rollback helper unavailable' });
                const rollbackOperation = await store.beginPersisted({
                    source: 'github', transport: operation.transport,
                    currentVersion: operation.currentVersion, targetVersion: operation.backupVersion,
                });
                try {
                    const rollback = await host.runGithubRollback(operation);
                    if (!rollback.ok) throw new Error(rollback.message || 'rollback scheduling failed');
                    return losslessJson({ ok: true, started: true, operationId: rollbackOperation.id,
                        message: 'Rollback scheduled after host exit; wait for the health outcome.' });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await store.finish('failed', message);
                    return losslessJson({ ok: false, error: message });
                }
            }
            store.begin({
                source: 'npm',
                transport: operation.transport,
                currentVersion: operation.currentVersion,
                targetVersion: operation.backupVersion,
            });
            await store.patch({ phase: 'installing' });
            try {
                const result = await runNpmInstall(operation.backupVersion, operation.currentVersion);
                store.appendTail(result.tail);
                invalidateInstalledCache();
                if (!result.afterVersion || versionCompare(result.afterVersion, operation.backupVersion) !== 0)
                    throw new Error(`rollback target mismatch: expected ${operation.backupVersion}, actual ${result.afterVersion ?? 'unreadable'}`);
                await store.finish('rolled_back');
                return losslessJson({ ok: true, restoredVersion: result.afterVersion ?? operation.backupVersion });
            }
            catch (error) {
                await store.finish('failed', error instanceof Error ? error.message : String(error));
                return losslessJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        },
    }), 'dsh-version-autoupdate: dsh_update_rollback');
    return disposers;
}
//# sourceMappingURL=update-tools.js.map