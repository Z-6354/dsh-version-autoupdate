import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDshRoot } from './dsh-root.js';
import z from '@deepseek-ai/schemastery';
import { buildGlobalInstallArgv, buildInstallEnv, lowMemoryInstallWarning, packageManagerSearchPaths, runningNodeSatisfiesDsh, } from './package-manager.js';
import { isNewer, semverParts, versionCompare } from './semver.js';
import { estimateInstallProgress } from './update-progress.js';
import { STEP_LABELS } from './update-types.js';
import { autoRestartEnabled, isRestartScheduled, manualRestartHint, scheduleProcessRestart, } from './dsh-restart.mjs';
import { readLinuxMemTotalMb, readOfflineState, scheduleOfflineInstall, shouldUseOfflineInstall, offlineLogFile, } from './offline-install.mjs';
import { resolveUpdateCapabilities } from './platform-policy.js';
/**
 * Cordis plugin name used by the DSH Loader / cordis.yml.
 *
 * Installing this package adds a `dsh-version-autoupdate` plugin row that
 * exposes:
 *  - a startup self-checked version/status computation (running/installed/latest),
 *  - a same-origin HTTP JSON API on `/dsh-version-updater/*` (via `ctx.webServer`),
 *    so the browser half can read status and trigger an npm update,
 *  - an npm install -g update routine with live progress tail.
 */
export const name = 'dsh-version-autoupdate';
export { versionCompare } from './semver.js';
/**
 * Services the host half depends on. Declaring `inject` tells DSH/Cordis to
 * activate this plugin only once these are ready and to expose them on the
 * context — most importantly `webServer`, without which the HTTP routes would
 * be registered too early (before the web server listens) and never serve.
 * `web` is deliberately NOT injected: this deployment has no fetch provider,
 * and the plugin falls back to a subprocess fetch when it is absent.
 */
export const inject = ['webServer', 'subprocess', 'fs', 'sandboxPolicy', 'timer'];
/** Schemastery schema consumed by Cordis/DSH plugin loaders. */
export const Config = z.object({
    packageManager: z.union(['npm', 'pnpm', 'yarn', 'auto']).default('npm'),
    packageManagerPath: z.string(),
    minAvailableMemoryMb: z.number().default(400),
    force: z.boolean().default(false),
    channel: z.union(['stable', 'preview']).default('preview'),
    trustedOrigins: z.array(z.string()).default([]),
    autoRestart: z.boolean().default(false),
    restartDelayMs: z.number().default(2000),
    installTimeoutMs: z.number().default(1200000),
    installIdleTimeoutMs: z.number().default(0),
    installGraceMs: z.number().default(60000),
    offlineInstall: z.union(['auto', 'always', 'never']).default('auto'),
    offlineInstallMaxMemMb: z.number().default(2560),
    systemdUnit: z.string().default('dsh-web.service'),
    updatePolicy: z.union(['platform', 'full', 'detect-only']).default('platform'),
});
export { estimateInstallProgress } from './update-progress.js';
const NODE_FETCH_SCRIPT = (pkg) => [
    '(async () => {',
    `  const r = await fetch('https://registry.npmjs.org/${pkg}', { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.npm.install-v1+json' } });`,
    '  console.log(JSON.stringify({ status: r.status, body: await r.text() }));',
    '})().catch((e) => { console.log(JSON.stringify({ status: 0, body: String((e && e.message) || e) })); });',
].join('\n');
const PLUGIN_PKG = 'dsh-version-autoupdate';
const PLUGIN_INSTALLED_VERSION = (() => {
    try {
        const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : null;
    }
    catch {
        return null;
    }
})();
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
function enrichUpdateState(state, installTimeoutMs = 1_200_000) {
    const progress = estimateInstallProgress(state.phase, state.startedAt, state.tail, installTimeoutMs);
    const restartScheduled = state.restartScheduled || isRestartScheduled();
    let progressLabel = '';
    if (state.phase === 'checking')
        progressLabel = STEP_LABELS.check;
    else if (state.phase === 'check-done')
        progressLabel = '检查完成';
    else if (state.phase === 'installing')
        progressLabel = STEP_LABELS.install;
    else if (state.phase === 'install-done')
        progressLabel = '安装完成';
    else if (state.phase === 'restarting')
        progressLabel = STEP_LABELS.restart;
    else if (state.phase === 'done')
        progressLabel = '全部完成';
    else if (state.phase === 'error')
        progressLabel = state.failedStep ? `${STEP_LABELS[state.failedStep]} · 失败` : '失败';
    return {
        ...state,
        progress,
        progressLabel,
        progressSpeed: '',
        restartScheduled,
    };
}
function stageError(step, detail) {
    const label = step === 'idle' ? '准备' : STEP_LABELS[step];
    return `[${label}] ${detail}`;
}
/** Extract a bare hostname (no scheme/port/path) from a URL or Host header value. */
function hostnameOf(value) {
    const v = value.trim();
    if (!v)
        return null;
    try {
        // Origin/Referer are absolute URLs; Host is a bare authority.
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'http://' + v;
        const host = new URL(withScheme).hostname;
        return host.replace(/^\[|\]$/g, '');
    }
    catch {
        return null;
    }
}
/** Pick the highest version from a list, optionally filtering pre-releases (those carrying a `-` suffix). */
function maxVersion(versions, includePrerelease) {
    let best = null;
    for (const v of versions) {
        const parts = semverParts(v);
        if (!parts)
            continue;
        if (!includePrerelease && parts.pre.length > 0)
            continue;
        if (best === null || versionCompare(v, best) > 0)
            best = v;
    }
    return best;
}
/** Reduce a registry version-manifest to the stable and preview maxima. */
function candidatesFromVersions(versions) {
    const stableMax = maxVersion(versions, false);
    const previewMax = maxVersion(versions, true);
    return { stableMax, previewMax };
}
/** Wrap a fetch to npm registry. Prefers the host web service, falls back to a node subprocess. */
async function fetchVersionCandidates(ctx) {
    const body = await fetchRegistryBody(ctx, '@deepseek-ai/dsh');
    if (!body)
        return null;
    try {
        const pkg = JSON.parse(body);
        if (!pkg || typeof pkg.versions !== 'object' || pkg.versions === null)
            return null;
        return candidatesFromVersions(Object.keys(pkg.versions));
    }
    catch {
        return null;
    }
}
/** Fetch the raw npm registry manifest, via web service then node subprocess. */
async function fetchRegistryBody(ctx, packageName = '@deepseek-ai/dsh') {
    const registryUrl = `https://registry.npmjs.org/${packageName}`;
    // 1. Prefer the web service if present.
    const webSvc = ctx.get('web');
    if (webSvc) {
        try {
            const res = await webSvc.fetch({ url: registryUrl });
            if (res && res.statusCode === 200 && typeof res.body?.content === 'string') {
                return res.body.content;
            }
        }
        catch {
            /* fall through */
        }
    }
    // 2. Fallback: node subprocess performing the same fetch.
    const sub = ctx.get('subprocess');
    if (!sub)
        return null;
    const nodeExe = process.execPath;
    const sp = ctx.get('sandboxPolicy');
    const cwd = sp?.workspaceRoot || '/tmp';
    let handle;
    try {
        handle = sub.spawn({
            argv: [nodeExe, '-e', NODE_FETCH_SCRIPT(packageName)],
            cwd,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 131072 } },
            graceMs: 25000,
        });
    }
    catch {
        return null;
    }
    const timer = ctx.get('timer');
    let clearTimer;
    if (timer)
        clearTimer = timer.timeout(() => handle?.terminate(), 25000);
    try {
        const outcome = await handle.done;
        const text = handle.collected?.stdout?.readFrom(0).text ?? '';
        if (outcome.exitCode !== 0)
            return null;
        const line = text.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
        const data = JSON.parse(line);
        if (data.status === 200 && typeof data.body === 'string')
            return data.body;
    }
    catch {
        return null;
    }
    finally {
        if (clearTimer)
            clearTimer();
    }
    return null;
}
async function readInstalledVersion(ctx) {
    const fsSvc = ctx.get('fs');
    if (!fsSvc)
        return null;
    const root = await findDshRoot(ctx);
    if (!root)
        return null;
    try {
        const target = await fsSvc.resolve(root + '/package.json');
        const text = await fsSvc.readText(target);
        const pkg = JSON.parse(text);
        return typeof pkg.version === 'string' ? pkg.version : null;
    }
    catch {
        return null;
    }
}
function computeStatus(running, installed, latest) {
    if (!latest || !installed)
        return 'unknown';
    if (isNewer(installed, latest))
        return 'update-available';
    if (running && isNewer(running, installed))
        return 'update-done-restart';
    return 'up-to-date';
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
/**
 * Install the plugin.
 *
 * Host half: computes DSH version status and exposes a same-origin JSON API
 * via `ctx.webServer` so the browser half can query status and trigger a
 * package-manager update. The runtime side only touches verified DSH services
 * (`fs`, `subprocess`, `web`, `sandboxPolicy`, `timer`, `webServer`).
 */
export function apply(ctx, config = {}) {
    const cfg = config || {};
    // Caches.
    let versionCache = { t: 0, v: null };
    let moduleLatestCache = { t: 0, v: null };
    let installedCache = { t: 0, v: null };
    const runningPromise = readInstalledVersion(ctx).catch(() => null);
    const getModuleLatest = async (force = false) => {
        const now = Date.now();
        if (!force && moduleLatestCache.v !== null && now - moduleLatestCache.t < 120000)
            return moduleLatestCache.v;
        const body = await fetchRegistryBody(ctx, PLUGIN_PKG);
        let latest = null;
        if (body) {
            try {
                const pkg = JSON.parse(body);
                if (pkg?.versions)
                    latest = maxVersion(Object.keys(pkg.versions), true);
            }
            catch { /* ignore */ }
        }
        moduleLatestCache = { t: now, v: latest };
        return latest;
    };
    const channel = cfg.channel === 'stable' ? 'stable' : 'preview';
    const capabilities = resolveUpdateCapabilities(process.platform, (cfg.updatePolicy ?? 'platform'));
    // Update state machine.
    const updateState = {
        running: false,
        phase: 'idle',
        step: 'idle',
        failedStep: null,
        done: false,
        ok: false,
        message: '',
        tail: '',
        progress: 0,
        progressLabel: '',
        progressSpeed: '',
        startedAt: null,
        restartScheduled: false,
        system: null,
        before: null,
        after: null,
        latest: null,
    };
    function restoreOfflineState() {
        const s = readOfflineState();
        if (!s?.status)
            return;
        const log = s.logFile || offlineLogFile();
        updateState.before = s.before ?? updateState.before;
        updateState.latest = s.target ?? updateState.latest;
        if (s.status === 'running') {
            updateState.phase = 'installing';
            updateState.step = 'install';
            updateState.message = `离线安装进行中（DSH 可能已短暂关闭）。SSH 查看：${log}`;
            updateState.tail = `离线安装日志：${log}\n`;
        }
        else if (s.status === 'done') {
            updateState.phase = 'install-done';
            updateState.step = 'install';
            updateState.ok = true;
            updateState.done = true;
            updateState.message = `离线安装已完成（目标 v${s.target ?? '?'}）。请刷新页面；若运行版本未变可点 ③ 重启。日志：${log}`;
        }
        else if (s.status === 'error') {
            updateState.phase = 'error';
            updateState.step = 'install';
            updateState.failedStep = 'install';
            updateState.ok = false;
            updateState.done = true;
            const restartHint = s.restartFailed
                ? ' npm 已成功但未能自动拉起 DSH，请 SSH 执行：sudo systemctl start dsh-web.service'
                : '';
            updateState.message = `[② 安装到本地] 离线安装失败（exit ${s.exitCode ?? '?'}）${restartHint}，见 ${log}`;
        }
    }
    function failStep(step, detail, hint = '') {
        updateState.phase = 'error';
        updateState.step = step;
        updateState.failedStep = step;
        updateState.ok = false;
        updateState.done = true;
        updateState.running = false;
        updateState.message = stageError(step, detail) + hint;
    }
    restoreOfflineState();
    /** Keep wizard step ① in sync with automatic /status registry polling. */
    function syncAutoCheckFromStatus(installed, latest, system) {
        if (updateState.running)
            return;
        if (updateState.phase === 'installing' || updateState.phase === 'install-done' || updateState.phase === 'restarting') {
            return;
        }
        if (updateState.phase === 'error' && updateState.failedStep && updateState.failedStep !== 'check') {
            return;
        }
        updateState.system = system;
        updateState.before = installed;
        updateState.latest = latest;
        if (!latest) {
            if (updateState.phase === 'idle' || (updateState.phase === 'error' && updateState.failedStep === 'check')) {
                updateState.phase = 'error';
                updateState.step = 'check';
                updateState.failedStep = 'check';
                updateState.ok = false;
                updateState.done = true;
                updateState.message = stageError('check', '无法连接 npm registry，请检查网络');
            }
            return;
        }
        if (installed && !isNewer(installed, latest)) {
            updateState.phase = 'idle';
            updateState.step = 'idle';
            updateState.failedStep = null;
            updateState.ok = true;
            updateState.done = false;
            updateState.message = '';
            return;
        }
        updateState.phase = 'check-done';
        updateState.step = 'check';
        updateState.failedStep = null;
        updateState.ok = true;
        updateState.done = true;
        updateState.message = installed
            ? `已检测到新版本 v${latest}（当前 v${installed}）`
            : `已检测到版本 v${latest}`;
    }
    const getCandidates = async (force = false) => {
        const now = Date.now();
        if (!force && versionCache.v !== null && now - versionCache.t < 120000)
            return versionCache.v;
        const v = await fetchVersionCandidates(ctx);
        versionCache = { t: now, v };
        return v;
    };
    /** Resolve the update target for the active channel, falling back across channels. */
    const resolveTarget = (cands) => {
        if (!cands)
            return { version: null, note: '' };
        const pick = channel === 'stable' ? cands.stableMax : cands.previewMax;
        if (pick)
            return { version: pick, note: channel === 'stable' ? 'stable' : 'preview' };
        // Chosen channel has nothing (e.g. stable with only pre-releases) → fall back.
        const fb = channel === 'stable' ? cands.previewMax : cands.stableMax;
        return fb ? { version: fb, note: (channel === 'stable' ? 'preview' : 'stable') + '\uff08\u56de\u9000\uff09' } : { version: null, note: '' };
    };
    const getInstalled = async () => {
        const now = Date.now();
        if (installedCache.v !== null && now - installedCache.t < 10000)
            return installedCache.v;
        const v = await readInstalledVersion(ctx);
        installedCache = { t: now, v };
        return v;
    };
    async function detectSystem(dshRoot, packageManager) {
        const sys = {
            os: process.platform,
            arch: process.arch,
            node: process.version,
            installMethod: 'unknown',
            packageManager,
        };
        if (dshRoot)
            sys.installMethod = dshRoot.includes('/node_modules/') ? 'npm' : 'git';
        return sys;
    }
    async function readLinuxMemAvailableMb() {
        if (process.platform !== 'linux')
            return null;
        const fsSvc = ctx.get('fs');
        if (!fsSvc)
            return null;
        try {
            const target = await fsSvc.resolve('/proc/meminfo');
            const text = await fsSvc.readText(target);
            const m = text.match(/MemAvailable:\s+(\d+)\s+kB/i);
            if (!m)
                return null;
            return Math.round(parseInt(m[1], 10) / 1024);
        }
        catch {
            return null;
        }
    }
    async function resolvePackageManager(dshRoot) {
        const sub = ctx.get('subprocess');
        if (!sub)
            return null;
        const installEnv = buildInstallEnv();
        const nodeBinDir = dirname(process.execPath);
        if (cfg.packageManagerPath && cfg.packageManagerPath.trim()) {
            try {
                return await sub.resolveExecutable(cfg.packageManagerPath);
            }
            catch {
                return null;
            }
        }
        const wanted = cfg.packageManager === 'auto' ? ['npm', 'pnpm', 'yarn'] : [cfg.packageManager];
        for (const name of wanted) {
            for (const candidate of packageManagerSearchPaths({
                dshRoot,
                pm: name,
                nodeBinDir,
                platform: process.platform,
            })) {
                try {
                    return await sub.resolveExecutable(candidate);
                }
                catch {
                    /* try next candidate */
                }
            }
            try {
                return await sub.resolveExecutable(name, installEnv);
            }
            catch {
                /* try next package manager */
            }
        }
        return null;
    }
    async function runCaptured(argv, cwd, timeoutMs, opts = {}) {
        const sub = ctx.get('subprocess');
        if (!sub)
            throw new Error('subprocess service unavailable');
        const installGraceMs = Math.max(5_000, opts.graceMs ?? cfg.installGraceMs ?? 60_000);
        const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: 32 * 1024 * 1024 } });
        const handle = sub.spawn({
            argv,
            cwd,
            env: buildInstallEnv(),
            stdio: { stdin: 'ignore', stdout: collect(524288), stderr: collect(4 * 1024 * 1024) },
            graceMs: installGraceMs,
        });
        const timer = ctx.get('timer');
        let offsetOut = 0;
        let offsetErr = 0;
        let clearIdle;
        let timedOut = false;
        let timedOutIdle = false;
        const idleMs = typeof opts.idleMs === 'number' && opts.idleMs > 0 ? opts.idleMs : 0;
        const bumpIdle = () => {
            if (!timer || !idleMs)
                return;
            if (clearIdle)
                clearIdle();
            clearIdle = timer.timeout(() => {
                timedOut = true;
                timedOutIdle = true;
                try {
                    handle.terminate();
                }
                catch { /* ignore */ }
            }, idleMs);
        };
        const appendTail = (text) => {
            if (!text)
                return;
            updateState.tail = (updateState.tail + text).slice(-6000);
            bumpIdle();
        };
        let lastTailLen = 0;
        let lastOutputAt = Date.now();
        const poll = () => {
            try {
                const ro = handle.collected?.stdout?.readFrom(offsetOut);
                if (ro && ro.text) {
                    offsetOut = ro.nextOffset;
                    appendTail(ro.text);
                }
                const re = handle.collected?.stderr?.readFrom(offsetErr);
                if (re && re.text) {
                    offsetErr = re.nextOffset;
                    appendTail(re.text);
                }
                const tailLen = updateState.tail.length;
                if (tailLen !== lastTailLen) {
                    lastTailLen = tailLen;
                    lastOutputAt = Date.now();
                }
                else if (updateState.phase === 'installing' && Date.now() - lastOutputAt > 60_000) {
                    const elapsed = Math.round((Date.now() - (updateState.startedAt ?? Date.now())) / 1000);
                    updateState.message = `npm 仍在运行（已 ${elapsed}s，可能正在下载/解压依赖，请耐心等待）`;
                    lastOutputAt = Date.now();
                }
            }
            catch { /* ignore read races */ }
        };
        let clearPoll;
        let clearTimeout;
        if (timer) {
            clearPoll = timer.interval(poll, 250);
            bumpIdle();
            clearTimeout = timer.timeout(() => {
                timedOut = true;
                timedOutIdle = false;
                try {
                    handle.terminate();
                }
                catch { /* ignore */ }
            }, timeoutMs);
        }
        try {
            const outcome = await handle.done;
            poll();
            if (timedOut) {
                const timeoutSec = Math.round(timeoutMs / 1000);
                const idleSec = idleMs ? Math.round(idleMs / 1000) : 0;
                if (timedOutIdle && idleSec) {
                    throw new Error(`[② 安装到本地] 安装超时（${idleSec} 秒无输出）。npm 下载大包时可能长时间无日志，建议将 installIdleTimeoutMs 设为 0 关闭空闲超时。`);
                }
                throw new Error(`[② 安装到本地] 安装超时（${timeoutSec} 秒）。可增大 installTimeoutMs 或 SSH 手动安装。`);
            }
            if (outcome.exitCode !== 0) {
                const tail = updateState.tail.split('\n').filter(Boolean).slice(-4).join('\n').slice(0, 500);
                throw new Error('\u5b89\u88c5\u547d\u4ee4\u9000\u51fa\u7801 ' + outcome.exitCode + (tail ? '\uff1a' + tail : ''));
            }
        }
        finally {
            if (clearPoll)
                clearPoll();
            if (clearIdle)
                clearIdle();
            if (clearTimeout)
                clearTimeout();
        }
    }
    async function runInstall(pmExe, version) {
        const sp = ctx.get('sandboxPolicy');
        const cwd = sp?.workspaceRoot || '/tmp';
        const installTimeoutMs = Math.max(60_000, cfg.installTimeoutMs ?? 1_200_000);
        // Default 0: npm often has multi-minute silent phases; 300s idle kill was aborting real installs.
        const installIdleTimeoutMs = Math.max(0, cfg.installIdleTimeoutMs ?? 0);
        await runCaptured(buildGlobalInstallArgv(pmExe, version), cwd, installTimeoutMs, { idleMs: installIdleTimeoutMs, graceMs: cfg.installGraceMs });
    }
    async function runCheckStep() {
        updateState.phase = 'checking';
        updateState.step = 'check';
        updateState.failedStep = null;
        updateState.tail = '';
        updateState.message = '正在连接 npm registry…';
        updateState.startedAt = Date.now();
        const dshRoot = await findDshRoot(ctx);
        const nodeCheck = runningNodeSatisfiesDsh();
        if (!nodeCheck.ok) {
            failStep('check', nodeCheck.message);
            return;
        }
        const memThreshold = cfg.minAvailableMemoryMb ?? 400;
        if (memThreshold > 0) {
            const availableMb = await readLinuxMemAvailableMb();
            const memWarn = lowMemoryInstallWarning(availableMb, memThreshold);
            if (memWarn) {
                failStep('check', memWarn);
                return;
            }
        }
        const pm = await resolvePackageManager(dshRoot);
        const system = await detectSystem(dshRoot, pm ?? undefined);
        updateState.system = system;
        systemInfoCache = system;
        if (system.installMethod === 'git') {
            failStep('check', '检测到 git 源码安装，请手动 git pull 后执行步骤 ③ 重启');
            return;
        }
        const before = await getInstalled();
        updateState.before = before;
        let cands;
        try {
            cands = await getCandidates(true);
        }
        catch (e) {
            failStep('check', '无法连接 npm registry 或解析版本列表', `（${errMsg(e)}）`);
            return;
        }
        const { version: latest } = resolveTarget(cands);
        updateState.latest = latest;
        if (!latest) {
            failStep('check', 'registry 未返回可用版本，请检查网络或 registry.npmjs.org 可达性');
            return;
        }
        updateState.tail = `registry 最新: v${latest}\n当前已装: ${before ? 'v' + before : '未知'}\n`;
        if (before && !isNewer(before, latest)) {
            updateState.phase = 'check-done';
            updateState.step = 'check';
            updateState.ok = true;
            updateState.done = true;
            updateState.running = false;
            updateState.after = before;
            updateState.message = `已是最新版本 v${before}，无需安装`;
            return;
        }
        if (!pm) {
            failStep('check', '未找到 npm/pnpm/yarn，无法执行步骤 ②。可在配置中设置 packageManagerPath');
            return;
        }
        updateState.phase = 'check-done';
        updateState.step = 'check';
        updateState.ok = true;
        updateState.done = true;
        updateState.running = false;
        updateState.message = before
            ? capabilities.canInstall
                ? `检查完成：v${before} → v${latest}。请点击安装`
                : `检测到新版本 v${latest}（当前 v${before}）。${capabilities.detectOnlyReason}`
            : capabilities.canInstall
                ? `检查完成：将安装 v${latest}。请点击安装`
                : `检测到版本 v${latest}。${capabilities.detectOnlyReason}`;
    }
    async function runInstallStep() {
        if (!capabilities.canInstall) {
            failStep('install', capabilities.detectOnlyReason || '此环境仅支持版本检测');
            return;
        }
        if (updateState.phase !== 'check-done' || !updateState.latest) {
            failStep('install', '请先完成步骤 ① 检查更新');
            return;
        }
        const latest = updateState.latest;
        const before = updateState.before;
        const dshRoot = await findDshRoot(ctx);
        const pmResolved = await resolvePackageManager(dshRoot);
        if (!pmResolved) {
            failStep('install', '未找到包管理器，无法安装');
            return;
        }
        updateState.phase = 'installing';
        updateState.step = 'install';
        updateState.failedStep = null;
        updateState.ok = false;
        updateState.done = false;
        updateState.startedAt = Date.now();
        updateState.tail = `使用 ${pmResolved} (Node ${process.version})\n目标: @deepseek-ai/dsh@${latest}\n`;
        const memTotalMb = readLinuxMemTotalMb();
        if (shouldUseOfflineInstall(cfg, memTotalMb)) {
            const npmArgv = buildGlobalInstallArgv(pmResolved, latest);
            const r = scheduleOfflineInstall({
                pmExe: pmResolved,
                npmArgv,
                version: latest,
                before,
                cfg: cfg,
                dshPid: process.pid,
            });
            updateState.phase = 'installing';
            updateState.tail += `离线模式（内存约 ${memTotalMb ?? '?'}MB）：先停 DSH → npm install → 再启动\n日志：${r.logFile}\n`;
            updateState.message = r.message || '离线安装已启动';
            updateState.running = false;
            updateState.done = false;
            return;
        }
        try {
            await runInstall(pmResolved, latest);
            installedCache = { t: 0, v: null };
            const after = await getInstalled();
            updateState.after = after;
            if (!after) {
                failStep('install', '安装命令已结束，但无法读取已安装的 DSH 版本（可能 OOM 或全局路径损坏）');
                return;
            }
            if (versionCompare(after, latest) < 0) {
                failStep('install', `安装后版本仍为 v${after}，未达到目标 v${latest}。可能安装被 OOM 中断或 npm 未完成，请 SSH 手动执行全局安装`);
                return;
            }
            updateState.phase = 'install-done';
            updateState.step = 'install';
            updateState.ok = true;
            updateState.done = true;
            updateState.running = false;
            updateState.message = after
                ? `安装完成：${before ? 'v' + before + ' → ' : ''}v${after}。请点击「③ 确认重启」加载新版本`
                : '安装命令执行成功。请点击「③ 确认重启」';
        }
        catch (e) {
            const base = errMsg(e);
            const pm = updateState.system?.packageManager ?? 'npm';
            const isTimeout = /超时/.test(base);
            let hint = '';
            if (isTimeout) {
                hint = ` 可 SSH 手动执行：${pm} install -g @deepseek-ai/dsh@${latest} --no-audit --no-fund --omit=optional`;
            }
            else if (before) {
                hint = ` 若 dsh 损坏可回滚：${pm} install -g @deepseek-ai/dsh@${before}`;
            }
            failStep('install', base.replace(/^\[② 安装到本地\] /, ''), hint);
        }
    }
    let systemInfoCache = null;
    let systemInfoPromise = null;
    async function getSystemInfo() {
        if (updateState.system)
            return updateState.system;
        if (systemInfoCache)
            return systemInfoCache;
        if (!systemInfoPromise) {
            systemInfoPromise = (async () => {
                const dshRoot = await findDshRoot(ctx);
                const pm = await resolvePackageManager(dshRoot);
                const sys = await detectSystem(dshRoot, pm ?? undefined);
                systemInfoCache = sys;
                return sys;
            })();
        }
        return systemInfoPromise;
    }
    async function statusPayload(force = false) {
        let running = null;
        let installed = null;
        let cands = null;
        try {
            running = await runningPromise;
            installed = await getInstalled();
            cands = await getCandidates(force);
        }
        catch {
            /* partial ok */
        }
        const { version: latest, note } = resolveTarget(cands);
        const moduleLatest = await getModuleLatest(force);
        const system = updateState.system ?? (await getSystemInfo());
        const memTotalMb = readLinuxMemTotalMb();
        if (system)
            syncAutoCheckFromStatus(installed, latest, system);
        return {
            runningVersion: running,
            installedVersion: installed,
            latestVersion: latest,
            stableLatest: cands?.stableMax ?? null,
            previewLatest: cands?.previewMax ?? null,
            channel,
            note,
            status: computeStatus(running, installed, latest),
            system,
            platform: process.platform,
            hostMemTotalMb: memTotalMb,
            offlineInstallRecommended: capabilities.canInstall && shouldUseOfflineInstall(cfg, memTotalMb),
            offlineInstallLog: offlineLogFile(),
            autoRestart: autoRestartEnabled(cfg),
            restartHint: manualRestartHint(),
            capabilities,
            moduleName: PLUGIN_PKG,
            moduleVersion: PLUGIN_INSTALLED_VERSION,
            moduleLatestVersion: moduleLatest,
            moduleUpdateAvailable: !!(PLUGIN_INSTALLED_VERSION && moduleLatest && isNewer(PLUGIN_INSTALLED_VERSION, moduleLatest)),
            update: enrichUpdateState({ ...updateState }, cfg.installTimeoutMs ?? 1_200_000),
        };
    }
    const webServer = ctx.get('webServer');
    const registerRoutes = () => {
        if (!webServer)
            return;
        const trustedOrigins = Array.isArray(cfg.trustedOrigins)
            ? cfg.trustedOrigins
            : [];
        /**
         * Reject cross-origin write requests (CSRF guard). The write endpoint
         * triggers a global `npm install`, so no third-party page may invoke it.
         * A request is allowed when it carries no Origin/Referer (curl, same-page
         * scripts, browsers that suppress the header), when the Origin matches the
         * request Host (same-origin), when it is loopback, or when the Origin
         * hostname is in the configured `trustedOrigins`. Anything else is a
         * cross-origin attack and is rejected.
         */
        const isSameOrigin = (req) => {
            const origin = req.headers.origin ?? req.headers.referer;
            if (!origin)
                return true;
            const host = req.headers.host;
            const originHost = hostnameOf(origin);
            if (originHost === null)
                return false;
            const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(originHost);
            if (loopback)
                return true;
            if (host) {
                const hostName = hostnameOf(host);
                if (hostName !== null && hostName === originHost)
                    return true;
            }
            if (trustedOrigins.includes(originHost))
                return true;
            return false;
        };
        const rejectForbidden = (req, res, message = '拒绝跨域请求') => {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, busy: false, message }));
            void req;
        };
        webServer.register({
            kind: 'exact',
            path: '/dsh-version-updater/status',
            handler: async (_req, res) => {
                try {
                    const payload = await statusPayload(Boolean(cfg.force));
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify(payload));
                }
                catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: errMsg(e) }));
                }
            },
        });
        const beginAsyncStep = (runner) => {
            if (updateState.running)
                return { ok: false, busy: true, message: '更新正在进行中，请稍候' };
            updateState.running = true;
            updateState.done = false;
            updateState.ok = false;
            updateState.restartScheduled = false;
            updateState.failedStep = null;
            const run = runner();
            run
                .catch((e) => {
                const step = updateState.step === 'idle' ? 'check' : updateState.step;
                failStep(step, errMsg(e));
            })
                .finally(() => {
                updateState.running = false;
            });
            void run;
            return { ok: true, busy: false };
        };
        const rejectDetectOnly = (res) => {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, busy: false, message: capabilities.detectOnlyReason || '此环境仅支持版本检测' }));
        };
        const postStepRoute = (path, reset, runner, opts) => {
            webServer.register({
                kind: 'exact',
                path,
                handler: async (req, res) => {
                    if (!isSameOrigin(req)) {
                        rejectForbidden(req, res);
                        return;
                    }
                    if (opts?.requiresInstall && !capabilities.canInstall) {
                        rejectDetectOnly(res);
                        return;
                    }
                    if (opts?.requiresRestart && !capabilities.canRestart) {
                        rejectDetectOnly(res);
                        return;
                    }
                    try {
                        await readBody(req);
                    }
                    catch {
                        /* ignore body parse */
                    }
                    reset();
                    const payload = beginAsyncStep(runner);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(payload));
                },
            });
        };
        postStepRoute('/dsh-version-updater/check', () => {
            updateState.phase = 'checking';
            updateState.step = 'check';
            updateState.tail = '';
            updateState.message = '';
            updateState.before = null;
            updateState.after = null;
            updateState.latest = null;
            updateState.system = null;
            updateState.startedAt = Date.now();
        }, runCheckStep, { requiresInstall: false });
        postStepRoute('/dsh-version-updater/install', () => {
            /* keep check-done state except running flags */
        }, runInstallStep, { requiresInstall: true });
        webServer.register({
            kind: 'exact',
            path: '/dsh-version-updater/start-update',
            handler: async (req, res) => {
                if (!isSameOrigin(req)) {
                    rejectForbidden(req, res);
                    return;
                }
                try {
                    await readBody(req);
                }
                catch {
                    /* ignore body parse */
                }
                updateState.phase = 'checking';
                updateState.step = 'check';
                updateState.tail = '';
                updateState.message = '';
                updateState.before = null;
                updateState.after = null;
                updateState.latest = null;
                updateState.system = null;
                updateState.startedAt = Date.now();
                const payload = beginAsyncStep(runCheckStep);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ...payload, deprecated: true, hint: '请使用分步流程：检查 → 安装 → 确认重启' }));
            },
        });
        webServer.register({
            kind: 'exact',
            path: '/dsh-version-updater/restart',
            handler: async (req, res) => {
                if (!isSameOrigin(req)) {
                    rejectForbidden(req, res);
                    return;
                }
                if (!capabilities.canRestart) {
                    rejectDetectOnly(res);
                    return;
                }
                try {
                    await readBody(req);
                }
                catch {
                    /* ignore body parse */
                }
                const r = scheduleProcessRestart({
                    reason: 'version-autoupdate-manual',
                    cfg: cfg,
                    delayMs: cfg.restartDelayMs,
                    force: true,
                });
                updateState.phase = 'restarting';
                updateState.step = 'restart';
                updateState.restartScheduled = !!r.restartScheduled || isRestartScheduled();
                if (r.restartScheduled) {
                    updateState.message = r.message || '正在重启…';
                }
                else if (r.skipped) {
                    updateState.message = r.message || manualRestartHint();
                }
                else if (r.error) {
                    failStep('restart', r.error);
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({
                    ok: !!r.ok,
                    restartScheduled: !!r.restartScheduled || isRestartScheduled(),
                    skipped: !!r.skipped,
                    platform: process.platform,
                    autoRestart: autoRestartEnabled(cfg),
                    message: r.message || r.error || manualRestartHint(),
                }));
            },
        });
    };
    // Register the same-origin JSON API immediately; routes become active once
    // the web server listens.
    registerRoutes();
}
//# sourceMappingURL=index.js.map