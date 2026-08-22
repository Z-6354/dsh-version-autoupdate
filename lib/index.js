import z from '@deepseek-ai/schemastery';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
/**
 * Cordis plugin name used by the DSH Loader / cordis.yml.
 *
 * Installing this package adds a `dsh-version-autoupdate` plugin row that
 * exposes:
 *  - a startup self-checked version/status computation (running/installed/latest),
 *  - a same-origin HTTP JSON API on `/dsh-version-updater/*` (via `ctx.webServer`),
 *    so the browser half can read status and trigger an npm update,
 *  - an npm install -g update routine with live progress tail.
 *  - optional auto-restart of the web process after a successful update.
 */
export const name = 'dsh-version-autoupdate';
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
    packageManager: z
        .union(['npm', 'pnpm', 'yarn', 'auto'])
        .default('auto')
        .description('Package manager used to auto-update DSH.'),
    force: z
        .boolean()
        .default(false)
        .description('Bypass per-call caching of registry lookups.'),
    channel: z
        .union(['stable', 'preview'])
        .default('preview')
        .description('Update target: preview (highest version incl. pre-release) or stable (highest release only).'),
    trustedOrigins: z
        .array(z.string())
        .default([])
        .description('Extra hostnames allowed to POST to the update endpoint (CSRF allow-list).'),
    autoRestart: z
        .boolean()
        .default(true)
        .description('After a successful update, auto-restart on Linux/macOS. Always ignored on Windows (manual restart only).'),
    restartDelayMs: z
        .number()
        .default(2000)
        .description('Milliseconds to wait before exiting (lets the UI show “restarting…”).'),
});
const KNOWN_DEPLOYMENT_ROOTS = [
    '/home/ubuntu/.local/node-v22.19.0/lib/node_modules/@deepseek-ai/dsh',
];
const NODE_INFO_SCRIPT = 'console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }));';
const NODE_FETCH_SCRIPT = [
    '(async () => {',
    "  const r = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh', { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.npm.install-v1+json' } });",
    '  console.log(JSON.stringify({ status: r.status, body: await r.text() }));',
    '})().catch((e) => { console.log(JSON.stringify({ status: 0, body: String((e && e.message) || e) })); });',
].join('\n');
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
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
function semverParts(s) {
    if (typeof s !== 'string')
        return null;
    const t = s.trim().replace(/^v/i, '');
    const dash = t.indexOf('-');
    const main = dash >= 0 ? t.slice(0, dash) : t;
    const pre = dash >= 0 ? t.slice(dash + 1).split('.') : [];
    const nums = main.split('.').map((x) => parseInt(x, 10));
    if (nums.length === 0 || nums.some((x) => Number.isNaN(x)))
        return null;
    return { nums, pre };
}
/** Minimal semver compare specialised for DSH versions (x.y.z and -rc.N). */
export function versionCompare(a, b) {
    const x = semverParts(a);
    const y = semverParts(b);
    if (!x || !y)
        return a < b ? -1 : a > b ? 1 : 0;
    const n = Math.max(x.nums.length, y.nums.length);
    for (let i = 0; i < n; i++) {
        const xv = x.nums[i] || 0;
        const yv = y.nums[i] || 0;
        if (xv !== yv)
            return xv < yv ? -1 : 1;
    }
    if (x.pre.length && !y.pre.length)
        return -1;
    if (!x.pre.length && y.pre.length)
        return 1;
    const m = Math.max(x.pre.length, y.pre.length);
    for (let i = 0; i < m; i++) {
        const xp = x.pre[i] || '';
        const yp = y.pre[i] || '';
        if (xp !== yp)
            return xp < yp ? -1 : 1;
    }
    return 0;
}
function isNewer(installed, latest) {
    return versionCompare(installed, latest) < 0;
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
    const body = await fetchRegistryBody(ctx);
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
/** Fetch the raw @deepseek-ai/dsh registry manifest, via web service then node subprocess. */
async function fetchRegistryBody(ctx) {
    // 1. Prefer the web service if present.
    const webSvc = ctx.get('web');
    if (webSvc) {
        try {
            const res = await webSvc.fetch({ url: 'https://registry.npmjs.org/@deepseek-ai/dsh' });
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
    let nodeExe = 'node';
    try {
        nodeExe = await sub.resolveExecutable('node');
    }
    catch {
        /* keep default */
    }
    const sp = ctx.get('sandboxPolicy');
    const cwd = sp?.workspaceRoot || os.tmpdir();
    let handle;
    try {
        handle = sub.spawn({
            argv: [nodeExe, '-e', NODE_FETCH_SCRIPT],
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
/** Locate the installed / running DSH package root and read its version. */
async function findDshRoot(ctx) {
    const fsSvc = ctx.get('fs');
    if (!fsSvc)
        return null;
    const roots = [];
    const push = (p) => {
        if (typeof p === 'string' && p.trim())
            roots.push(p.trim());
    };
    // 0. Live process: source checkout runs `node … apps/cli/src/bin.ts web`
    for (const arg of process.argv) {
        const norm = String(arg).replace(/\\/g, '/');
        for (const marker of ['/apps/cli/src/bin.ts', '/apps/cli/lib/bin.js', '/apps/cli/src/bin.js']) {
            const i = norm.indexOf(marker);
            if (i > 0)
                push(norm.slice(0, i));
        }
    }
    // 1. Workspace / cwd (dev watchdog often starts from the harness root)
    const sp = ctx.get('sandboxPolicy');
    if (sp?.workspaceRoot)
        push(sp.workspaceRoot);
    try {
        push(process.cwd());
    }
    catch { /* ignore */ }
    // 2. resolveExecutable('dsh') — Windows + Unix layouts
    const sub = ctx.get('subprocess');
    if (sub) {
        try {
            const exe = (await sub.resolveExecutable('dsh')).replace(/\\/g, '/');
            if (exe.endsWith('/bin/dsh') || /\/dsh(\.cmd)?$/i.test(exe)) {
                // …/node_modules/@deepseek-ai/dsh/bin/dsh  OR  …/npm/dsh.CMD shim
                if (exe.includes('/node_modules/@deepseek-ai/dsh/')) {
                    push(exe.slice(0, exe.indexOf('/node_modules/@deepseek-ai/dsh/') + '/node_modules/@deepseek-ai/dsh'.length));
                }
                else if (exe.endsWith('/bin/dsh')) {
                    push(exe.slice(0, -'/bin/dsh'.length) + '/lib/node_modules/@deepseek-ai/dsh');
                }
                else if (exe.toLowerCase().endsWith('/dsh.cmd') || exe.toLowerCase().endsWith('/dsh')) {
                    // npm global shim: <prefix>/dsh.CMD → <prefix>/node_modules/@deepseek-ai/dsh
                    push(dirname(exe) + '/node_modules/@deepseek-ai/dsh');
                }
            }
            else if (exe.endsWith('/lib/bin.js')) {
                push(exe.slice(0, -'/lib/bin.js'.length));
            }
        }
        catch { /* ignore */ }
    }
    // 3. Common global install prefixes (Windows npm + Unix)
    try {
        push(join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
        push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'));
        push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
    }
    catch { /* ignore */ }
    roots.push(...KNOWN_DEPLOYMENT_ROOTS);
    const seen = new Set();
    for (const root of roots) {
        if (!root || seen.has(root))
            continue;
        seen.add(root);
        try {
            const target = await fsSvc.resolve(join(root, 'package.json'));
            const text = await fsSvc.readText(target);
            const pkg = JSON.parse(text);
            // Published package is `@deepseek-ai/dsh`; monorepo root is `@deepseek-ai/dsh-root`.
            if ((pkg?.name === '@deepseek-ai/dsh' || pkg?.name === '@deepseek-ai/dsh-root')
                && typeof pkg.version === 'string' && pkg.version) {
                return root;
            }
        }
        catch { /* try next */ }
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
        const target = await fsSvc.resolve(join(root, 'package.json'));
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
    let installedCache = { t: 0, v: null };
    const runningPromise = readInstalledVersion(ctx).catch(() => null);
    const channel = cfg.channel === 'stable' ? 'stable' : 'preview';
    // Update state machine.
    const updateState = {
        running: false,
        phase: 'idle',
        done: false,
        ok: false,
        message: '',
        tail: '',
        progress: 0,
        progressLabel: '',
        progressSpeed: '',
        divergence: null,
        startedAt: null,
        system: null,
        before: null,
        after: null,
        latest: null,
        restartScheduled: false,
    };

    function psQuote(s) {
        return "'" + String(s ?? '').replace(/'/g, "''") + "'";
    }

    function shellQuote(s) {
        return "'" + String(s ?? '').replace(/'/g, `'\\''`) + "'";
    }

    function detectListenPort() {
        const argv = process.argv || [];
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === '--port' && argv[i + 1] && /^\d+$/.test(argv[i + 1]))
                return parseInt(argv[i + 1], 10);
            const m = /^--port=(\d+)$/.exec(argv[i]);
            if (m)
                return parseInt(m[1], 10);
        }
        return 3080;
    }

    function dshStateDir() {
        const dir = join(os.homedir(), '.dsh');
        try {
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
        }
        catch {
            /* ignore */
        }
        return dir;
    }

    function appendRestartLog(line) {
        try {
            const p = join(dshStateDir(), 'autoupdate-restart.log');
            writeFileSync(p, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a', encoding: 'utf8' });
        }
        catch {
            /* ignore */
        }
    }

    /** Best-effort plan to relaunch the same web process after exit. */
    function resolveRestartPlan() {
        const exe = process.execPath;
        // Node strips flags like `--import tsx/esm` from process.argv and keeps
        // them on process.execArgv — omitting them makes `bin.ts` fail to boot.
        const execArgv = Array.isArray(process.execArgv) ? process.execArgv.slice() : [];
        let args = execArgv.concat((process.argv || []).slice(1));
        let cwd = process.cwd();
        const joined = args.join(' ');
        // Prefer re-executing the exact current web command.
        if (/\bweb\b/.test(joined) || /bin\.ts/.test(joined) || /(^|[\\/])dsh(\.cmd|\.exe)?$/i.test(exe) || /\bdsh\b/.test(joined)) {
            return { exe, args, cwd, port: detectListenPort(), mode: 'reexec' };
        }
        // Known local harness layout (Cursor / source checkout).
        const harnessBin = join(cwd, 'apps', 'cli', 'src', 'bin.ts');
        if (existsSync(harnessBin)) {
            return {
                exe,
                args: ['--import', 'tsx/esm', harnessBin, 'web', '--no-open'],
                cwd,
                port: detectListenPort(),
                mode: 'harness-bin',
            };
        }
        // Fallback: `dsh web --no-open` from PATH.
        return {
            exe: process.platform === 'win32' ? 'cmd.exe' : 'dsh',
            args: process.platform === 'win32' ? ['/c', 'dsh', 'web', '--no-open'] : ['web', '--no-open'],
            cwd,
            port: detectListenPort(),
            mode: 'dsh-path',
        };
    }

    /**
     * Spawn a fully detached helper (survives parent exit on Windows) that waits
     * for this PID/port to clear, then relaunches DSH. Then exit this process.
     */
    function scheduleProcessRestart(reason) {
        if (updateState.restartScheduled)
            return { ok: true, already: true };
        const plan = resolveRestartPlan();
        const pid = process.pid;
        const delayMs = Math.max(800, Number(cfg.restartDelayMs) || 2000);
        const port = plan.port || 3080;
        const stateDir = dshStateDir();
        const logFile = join(stateDir, 'autoupdate-restart.log');
        updateState.restartScheduled = true;
        setProgress('done', '\u5373\u5c06\u81ea\u52a8\u91cd\u542f\u2026', 100);
        updateState.message = (updateState.message ? updateState.message + ' ' : '')
            + '\u5373\u5c06\u81ea\u52a8\u91cd\u542f\u4ee5\u52a0\u8f7d\u65b0\u7248\u672c'
            + (reason ? '\uff08' + reason + '\uff09' : '')
            + '\u2026';
        appendRestartLog(`schedule reason=${reason || ''} mode=${plan.mode} pid=${pid} port=${port} exe=${plan.exe} cwd=${plan.cwd} args=${JSON.stringify(plan.args)}`);
        try {
            // Do NOT embed secrets or the full PATH into the script file.
            // `cmd start` gives the helper a normal user environment; only pass
            // a small non-secret hint when present.
            const compileCache = process.env.NODE_COMPILE_CACHE || '';
            if (process.platform === 'win32') {
                const scriptPath = join(stateDir, `dsh-restart-${pid}.ps1`);
                const argLines = (plan.args || []).map((a, i, arr) => {
                    const comma = i < arr.length - 1 ? ',' : '';
                    return `  ${psQuote(a)}${comma}`;
                }).join('\n');
                const ps = [
                    `$ErrorActionPreference = 'Continue'`,
                    `$log = ${psQuote(logFile)}`,
                    `function Log([string]$m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date).ToString('o'), $m) -Encoding utf8 }`,
                    `Log 'helper start pidToWait=${pid} port=${port}'`,
                    `$pidToWait = ${pid}`,
                    `$port = ${port}`,
                    `$script:waitStart = Get-Date`,
                    compileCache
                        ? `if (${psQuote(compileCache)} -ne '') { $env:NODE_COMPILE_CACHE = ${psQuote(compileCache)} }`
                        : `# no NODE_COMPILE_CACHE`,
                    `$deadline = (Get-Date).AddSeconds(120)`,
                    `while ((Get-Date) -lt $deadline) {`,
                    `  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { Log 'parent exited'; break }`,
                    `  if (((Get-Date) - $script:waitStart).TotalSeconds -ge 12) {`,
                    `    Log 'force-stopping parent (exit did not happen)'`,
                    `    Stop-Process -Id $pidToWait -Force -ErrorAction SilentlyContinue`,
                    `    break`,
                    `  }`,
                    `  Start-Sleep -Milliseconds 400`,
                    `}`,
                    `Start-Sleep -Seconds 1`,
                    `$deadline = (Get-Date).AddSeconds(60)`,
                    `while ((Get-Date) -lt $deadline) {`,
                    `  $c = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)`,
                    `  if ($c.Count -eq 0) { Log 'port free'; break }`,
                    `  Start-Sleep -Milliseconds 500`,
                    `}`,
                    `$exe = ${psQuote(plan.exe)}`,
                    `$wd = ${psQuote(plan.cwd)}`,
                    `$argList = @(\n${argLines}\n)`,
                    `Log ("starting exe=$exe wd=$wd argc=$($argList.Count)")`,
                    `try {`,
                    `  if ($argList.Count -gt 0) {`,
                    `    $p = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $wd -WindowStyle Hidden -PassThru`,
                    `  } else {`,
                    `    $p = Start-Process -FilePath $exe -WorkingDirectory $wd -WindowStyle Hidden -PassThru`,
                    `  }`,
                    `  Log ("started newPid=$($p.Id)")`,
                    `} catch {`,
                    `  Log ("Start-Process FAILED: $($_.Exception.Message)")`,
                    `  exit 1`,
                    `}`,
                    `$deadline = (Get-Date).AddSeconds(90)`,
                    `while ((Get-Date) -lt $deadline) {`,
                    `  $c = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)`,
                    `  if ($c.Count -gt 0) { Log 'READY listen'; exit 0 }`,
                    `  if ($p -and $p.HasExited) { Log ("child exited early code=$($p.ExitCode)"); exit 2 }`,
                    `  Start-Sleep -Seconds 1`,
                    `}`,
                    `Log 'TIMEOUT waiting for listen'`,
                    `exit 3`,
                ].join('\n');
                writeFileSync(scriptPath, ps, 'utf8');
                appendRestartLog(`wrote script ${scriptPath}`);
                // Quote the window title; required so /MIN is not eaten as title.
                const child = spawn('cmd.exe', [
                    '/c', 'start', 'DSHAutoRestart', '/MIN',
                    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
                ], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                    cwd: plan.cwd,
                    env: process.env,
                });
                child.unref();
                appendRestartLog(`cmd start launched (spawn pid may be ephemeral)`);
            }
            else {
                const scriptPath = join(stateDir, `dsh-restart-${pid}.sh`);
                const argsJoined = (plan.args || []).map(shellQuote).join(' ');
                const sh = [
                    '#!/bin/bash',
                    'set +e',
                    `LOG=${shellQuote(logFile)}`,
                    'log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }',
                    `log 'helper start pidToWait=${pid} port=${port}'`,
                    `pid=${pid}`,
                    `port=${port}`,
                    compileCache ? `export NODE_COMPILE_CACHE=${shellQuote(compileCache)}` : 'true',
                    'for i in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || { log parent_exited; break; }; if [ "$i" -ge 30 ]; then log force_kill_parent; kill -9 "$pid" 2>/dev/null; break; fi; sleep 0.4; done',
                    'sleep 1',
                    'for i in $(seq 1 60); do',
                    '  if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN || { log port_free; break; }',
                    '  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || { log port_free; break; }',
                    '  else break; fi',
                    '  sleep 0.5',
                    'done',
                    `cd ${shellQuote(plan.cwd)} || exit 1`,
                    `log "starting ${plan.exe} ${argsJoined}"`,
                    `nohup ${shellQuote(plan.exe)} ${argsJoined} >>"$LOG" 2>&1 &`,
                    'newpid=$!',
                    'log "started newPid=$newpid"',
                    'for i in $(seq 1 90); do',
                    '  if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN && { log READY; exit 0; }',
                    '  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { log READY; exit 0; }',
                    '  fi',
                    '  kill -0 "$newpid" 2>/dev/null || { log child_exited; exit 2; }',
                    '  sleep 1',
                    'done',
                    'log TIMEOUT',
                    'exit 3',
                ].join('\n');
                writeFileSync(scriptPath, sh, { encoding: 'utf8', mode: 0o755 });
                const child = spawn('bash', [scriptPath], {
                    detached: true,
                    stdio: 'ignore',
                    env: process.env,
                });
                child.unref();
                appendRestartLog(`bash helper launched script=${scriptPath}`);
            }
        }
        catch (e) {
            updateState.restartScheduled = false;
            updateState.phase = 'error';
            updateState.message = '\u5b89\u6392\u91cd\u542f\u5931\u8d25\uff1a' + errMsg(e) + '\u3002\u8bf7\u624b\u52a8\u91cd\u542f dsh web\u3002';
            appendRestartLog(`schedule FAILED ${errMsg(e)}`);
            return { ok: false, error: errMsg(e) };
        }
        const timer = ctx.get('timer');
        const exitSoon = () => {
            appendRestartLog('attempting process.exit(0)');
            try {
                process.exitCode = 0;
                process.exit(0);
            }
            catch (e) {
                appendRestartLog('process.exit threw: ' + errMsg(e));
            }
            try {
                appendRestartLog('fallback process.kill(pid)');
                process.kill(process.pid);
            }
            catch (e2) {
                appendRestartLog('process.kill failed: ' + errMsg(e2));
            }
        };
        // Prefer native timers: Cordis timer.timeout has been observed not to
        // run process.exit in this host. Still register Cordis timer as backup.
        setTimeout(exitSoon, delayMs);
        if (timer) {
            try {
                timer.timeout(exitSoon, delayMs + 250);
            }
            catch {
                /* ignore */
            }
        }
        return { ok: true, delayMs, port, logFile, mode: plan.mode };
    }

    function autoRestartEnabled() {
        // Windows job-object / PowerShell relaunch is unreliable for this host;
        // always require a manual restart and keep the UI honest.
        if (process.platform === 'win32')
            return false;
        return cfg.autoRestart !== false;
    }

    function manualRestartHint(before, after) {
        const run = before ? ('v' + before) : '?';
        const disk = after ? ('v' + after) : '?';
        if (process.platform === 'win32') {
            return '\u78c1\u76d8\u5df2\u66f4\u65b0\u4e3a ' + disk
                + '\uff08\u5f53\u524d\u8fdb\u7a0b\u4ecd\u4e3a ' + run
                + '\uff09\u3002Windows \u8bf7\u624b\u52a8\u5173\u95ed\u5e76\u91cd\u65b0\u542f\u52a8 dsh web \u540e\u751f\u6548\u3002';
        }
        return '\u8bf7\u91cd\u542f dsh web \u670d\u52a1\u540e\u751f\u6548\u3002';
    }

    function maybeAutoRestart(reason) {
        if (!autoRestartEnabled()) {
            appendRestartLog('skip autoRestart platform=' + process.platform + ' reason=' + (reason || ''));
            return;
        }
        scheduleProcessRestart(reason || 'update');
    }

    /** Parse git --progress lines for % and throughput. */
    function ingestGitProgress(chunk, stage) {
        if (!chunk)
            return;
        // Git often uses \r for in-place progress updates.
        const lines = String(chunk).split(/\r|\n/).filter(Boolean);
        const last = lines[lines.length - 1] || '';
        const pctM = /(?:Receiving objects|Resolving deltas|Compressing objects|Counting objects|Writing objects):\s+(\d+)%/i.exec(last)
            || /(?:Receiving objects|Resolving deltas|Compressing objects|Counting objects|Writing objects):\s+(\d+)%/i.exec(chunk);
        const speedM = /\|\s*([0-9.]+\s*[KMGT]?i?B\/s)/i.exec(last)
            || /\|\s*([0-9.]+\s*[KMGT]?i?B\/s)/i.exec(chunk.slice(-120));
        if (speedM)
            updateState.progressSpeed = speedM[1].replace(/\s+/g, ' ');
        if (pctM) {
            const local = Math.max(0, Math.min(100, parseInt(pctM[1], 10)));
            // Map stage-local % into overall bar.
            // fetch: 20–55, pull: 55–75
            let lo = 20, hi = 55;
            if (stage === 'pull') {
                lo = 55;
                hi = 75;
            }
            else if (stage === 'fetch') {
                lo = 20;
                hi = 55;
            }
            const mapped = lo + (hi - lo) * (local / 100);
            const kind = /Receiving objects/i.test(last) ? '接收对象'
                : /Resolving deltas/i.test(last) ? '解析增量'
                    : /Compressing objects/i.test(last) ? '压缩对象'
                        : /Writing objects/i.test(last) ? '写入对象'
                            : 'git';
            const label = (stage === 'pull' ? 'git pull' : 'git fetch')
                + ' · ' + kind + ' ' + local + '%'
                + (updateState.progressSpeed ? ' · ' + updateState.progressSpeed : '');
            setProgress('installing', label, mapped);
        }
    }

    function setProgress(phase, label, hardPercent) {
        updateState.phase = phase;
        if (label)
            updateState.progressLabel = label;
        if (phase === 'done' || phase === 'error' || phase === 'detect')
            updateState.progressSpeed = updateState.progressSpeed || '';
        if (typeof hardPercent === 'number') {
            updateState.progress = Math.max(0, Math.min(100, Math.round(hardPercent)));
            return;
        }
        // Soft estimate by phase + npm log heuristics + elapsed time.
        let p = updateState.progress || 0;
        if (phase === 'detect')
            p = Math.max(p, 8);
        else if (phase === 'installing')
            p = Math.max(p, 18);
        else if (phase === 'diverged')
            p = Math.max(p, 40);
        else if (phase === 'done')
            p = 100;
        else if (phase === 'error')
            p = Math.max(p, 5);
        const tail = updateState.tail || '';
        const pctMatch = /(\d{1,3})\s*%/.exec(tail.slice(-400));
        if (pctMatch) {
            const n = parseInt(pctMatch[1], 10);
            if (n >= 0 && n <= 100)
                p = Math.max(p, Math.min(95, n));
        }
        if (/fetch|download|GET http|resolving/i.test(tail))
            p = Math.max(p, 30);
        if (/reify|extract|tarball|integrity/i.test(tail))
            p = Math.max(p, 55);
        if (/added \d+|changed \d+|up to date|packages in/i.test(tail))
            p = Math.max(p, 88);
        if (phase === 'installing' && updateState.startedAt) {
            const elapsed = Date.now() - updateState.startedAt;
            const creep = Math.min(90, 18 + elapsed / 2500);
            p = Math.max(p, creep * 0.35 + p * 0.65);
        }
        if (phase !== 'done' && phase !== 'error')
            p = Math.min(95, p);
        updateState.progress = Math.round(p);
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
    async function detectSystem() {
        const sys = { os: 'unknown', arch: 'unknown', node: '', installMethod: 'unknown' };
        const sub = ctx.get('subprocess');
        if (sub) {
            try {
                const nodeExe = await sub.resolveExecutable('node').catch(() => 'node');
                const sp = ctx.get('sandboxPolicy');
                const cwd = sp?.workspaceRoot || os.tmpdir();
                const handle = sub.spawn({
                    argv: [nodeExe, '-e', NODE_INFO_SCRIPT],
                    cwd,
                    stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } },
                    graceMs: 10000,
                });
                const outcome = await handle.done;
                if (outcome.exitCode === 0) {
                    const text = handle.collected?.stdout?.readFrom(0).text ?? '';
                    const d = JSON.parse(text.trim());
                    if (d.platform)
                        sys.os = d.platform;
                    if (d.arch)
                        sys.arch = d.arch;
                    if (d.node)
                        sys.node = d.node;
                }
            }
            catch {
                /* keep defaults */
            }
        }
        const root = await findDshRoot(ctx);
        if (root) {
            const hasGit = existsSync(join(root, '.git'));
            const inNm = root.includes('/node_modules/') || root.includes('\\node_modules\\');
            if (hasGit && !inNm)
                sys.installMethod = 'git';
            else if (inNm)
                sys.installMethod = 'npm';
            else
                sys.installMethod = hasGit ? 'git' : 'npm';
            sys.root = root;
        }
        return sys;
    }
    async function resolvePackageManager() {
        const sub = ctx.get('subprocess');
        if (!sub)
            return null;
        const wanted = cfg.packageManager === 'auto' ? ['npm', 'pnpm', 'yarn'] : [cfg.packageManager];
        for (const name of wanted) {
            try {
                return await sub.resolveExecutable(name);
            }
            catch {
                /* try next */
            }
        }
        return null;
    }

    async function resolveGitExe() {
        const sub = ctx.get('subprocess');
        if (!sub)
            return 'git';
        try {
            return await sub.resolveExecutable('git');
        }
        catch {
            return 'git';
        }
    }

    /** Short git command; returns { code, out, err }. */
    async function gitCapture(gitExe, args, root, timeoutMs = 45000) {
        const sub = ctx.get('subprocess');
        if (!sub)
            throw new Error('subprocess service unavailable');
        const handle = sub.spawn({
            argv: [gitExe, ...args],
            cwd: root,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 262144 } },
            graceMs: 15000,
            env: { GIT_TERMINAL_PROMPT: '0', GIT_ADVICE: '0' },
        });
        const timer = ctx.get('timer');
        let clearTimeout;
        let timedOut = false;
        if (timer) {
            clearTimeout = timer.timeout(() => {
                timedOut = true;
                try {
                    handle.terminate();
                }
                catch { /* ignore */ }
            }, timeoutMs);
        }
        try {
            const outcome = await handle.done;
            const out = (handle.collected?.stdout?.readFrom(0).text || '').trim();
            const err = (handle.collected?.stderr?.readFrom(0).text || '').trim();
            if (timedOut)
                return { code: 124, out, err: err || 'timeout' };
            return { code: outcome.exitCode ?? 1, out, err };
        }
        finally {
            if (clearTimeout)
                clearTimeout();
        }
    }

    function formatDivergenceMessage(div) {
        const lines = [];
        lines.push('\u65e0\u6cd5\u5feb\u8fdb\u5408\u5e76\uff08git pull --ff-only\uff09\u3002');
        lines.push('\u5206\u652f ' + (div.branch || '?') + ' \u76f8\u5bf9 ' + (div.upstream || 'origin')
            + '\uff1a\u8d85\u524d ' + div.ahead + ' \u63d0\u4ea4\uff0c\u843d\u540e ' + div.behind + ' \u63d0\u4ea4'
            + (div.dirty ? '\uff0c\u672a\u63d0\u4ea4\u6539\u52a8 ' + div.dirty + ' \u9879' : '') + '\u3002');
        if (div.localCommits && div.localCommits.length) {
            lines.push('\u672c\u5730\u591a\u51fa\u7684\u63d0\u4ea4\uff1a');
            for (const c of div.localCommits.slice(0, 5))
                lines.push('  \u2022 ' + (c.id || '').slice(0, 8) + ' ' + (c.subject || ''));
            if (div.localCommits.length > 5)
                lines.push('  \u2026\u5171 ' + div.localCommits.length + ' \u6761');
        }
        lines.push('\u8bf7\u9009\u62e9\uff1a\u300c\u4e00\u952e\u5408\u5e76\u300d / \u300c\u4fdd\u7559\u672c\u5730\u5e76\u62c9\u53d6\u300d / \u300c\u53ea\u4fdd\u7559\u8fdc\u7a0b\u300d\u3002');
        return lines.join('\n');
    }

    async function inspectGitDivergence(root) {
        const gitExe = await resolveGitExe();
        let branch = 'master';
        const br = await gitCapture(gitExe, ['rev-parse', '--abbrev-ref', 'HEAD'], root);
        if (br.code === 0 && br.out && br.out !== 'HEAD')
            branch = br.out;
        const upstream = 'origin/' + branch;
        let ahead = 0;
        let behind = 0;
        const counts = await gitCapture(gitExe, ['rev-list', '--left-right', '--count', 'HEAD...' + upstream], root);
        if (counts.code === 0) {
            const parts = counts.out.split(/\s+/);
            ahead = parseInt(parts[0], 10) || 0;
            behind = parseInt(parts[1], 10) || 0;
        }
        const localLog = await gitCapture(gitExe, ['log', '--oneline', '--left-only', 'HEAD...' + upstream, '-10'], root);
        const localCommits = (localLog.code === 0 ? localLog.out : '')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
            const sp = line.indexOf(' ');
            return sp > 0
                ? { id: line.slice(0, sp), subject: line.slice(sp + 1) }
                : { id: line, subject: '' };
        });
        const porcelain = await gitCapture(gitExe, ['status', '--porcelain'], root);
        const dirtyLines = (porcelain.code === 0 ? porcelain.out : '').split(/\r?\n/).filter(Boolean);
        return {
            branch,
            upstream,
            ahead,
            behind,
            dirty: dirtyLines.length,
            dirtySample: dirtyLines.slice(0, 8),
            localCommits,
            canFastForward: ahead === 0,
        };
    }

    /** Run a command, stream stdout/stderr into updateState.tail, throw on non-zero exit.
     *  opts.gitStage: 'fetch' | 'pull' → parse git --progress into % + speed.
     *  opts.idleMs: if set, reset the kill timer whenever new output arrives (stall detection).
     *               timeoutMs then acts as the hard absolute ceiling.
     */
    async function runCaptured(argv, cwd, label, timeoutMs = 180000, opts = {}) {
        const sub = ctx.get('subprocess');
        if (!sub)
            throw new Error('subprocess service unavailable');
        const handle = sub.spawn({
            argv,
            cwd,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 1048576 } },
            graceMs: 20000,
            env: opts.gitStage ? { GIT_PROGRESS: '1', GIT_TERMINAL_PROMPT: '0' } : undefined,
        });
        const timer = ctx.get('timer');
        let offsetOut = 0;
        let offsetErr = 0;
        let clearIdle = null;
        let timedOut = false;
        let timedOutReason = 'absolute';
        const idleMs = typeof opts.idleMs === 'number' && opts.idleMs > 0 ? opts.idleMs : 0;
        const bumpIdle = () => {
            if (!timer || !idleMs)
                return;
            if (clearIdle)
                clearIdle();
            clearIdle = timer.timeout(() => {
                timedOut = true;
                timedOutReason = 'idle';
                try {
                    handle.terminate();
                }
                catch {
                    /* ignore */
                }
            }, idleMs);
        };
        const appendTail = (text) => {
            if (!text)
                return;
            updateState.tail = (updateState.tail + text).slice(-6000);
            bumpIdle();
            if (opts.gitStage)
                ingestGitProgress(text, opts.gitStage);
            else if (updateState.phase === 'installing')
                setProgress('installing', label || updateState.progressLabel || '\u6267\u884c\u4e2d\u2026');
        };
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
            }
            catch {
                /* ignore read races */
            }
        };
        let clearPoll;
        let clearTimeout;
        if (timer) {
            clearPoll = timer.interval(poll, 200);
            bumpIdle();
            clearTimeout = timer.timeout(() => {
                timedOut = true;
                timedOutReason = 'absolute';
                try {
                    handle.terminate();
                }
                catch {
                    /* ignore */
                }
            }, timeoutMs);
        }
        try {
            const outcome = await handle.done;
            if (timedOut) {
                const hint = timedOutReason === 'idle'
                    ? '\u957f\u65f6\u95f4\u65e0\u8f93\u51fa\uff0c\u5df2\u7ec8\u6b62'
                    : '\u8d85\u65f6\uff0c\u5df2\u7ec8\u6b62';
                throw new Error((label || '\u547d\u4ee4') + hint);
            }
            poll();
            if (outcome.exitCode !== 0) {
                const tail = updateState.tail.split(/\r|\n/).filter(Boolean).slice(-6).join('\n').slice(0, 600);
                throw new Error((label || '\u547d\u4ee4') + '\u9000\u51fa\u7801 ' + outcome.exitCode + (tail ? '\uff1a\n' + tail : ''));
            }
        }
        finally {
            if (clearPoll)
                clearPoll();
            if (clearTimeout)
                clearTimeout();
            if (clearIdle)
                clearIdle();
        }
    }

    async function runInstall(pmExe, version) {
        const sp = ctx.get('sandboxPolicy');
        const cwd = sp?.workspaceRoot || os.tmpdir();
        // Global @deepseek-ai/dsh pulls a large tree; 3min hard-kill was aborting healthy slow downloads.
        // Absolute ceiling 20min; also abort if npm goes silent for 5min (true hang).
        await runCaptured([pmExe, 'install', '-g', '@deepseek-ai/dsh@' + version, '--no-audit', '--no-fund', '--loglevel=info'], cwd, '\u6b63\u5728 npm \u5b89\u88c5\u2026', 20 * 60 * 1000, { idleMs: 5 * 60 * 1000 });
    }

    /** One-click update for source checkouts: git fetch + ff-only pull (+ optional pnpm install). */
    async function runGitSourceUpdate(root) {
        const sub = ctx.get('subprocess');
        if (!sub)
            throw new Error('subprocess service unavailable');
        let gitExe = 'git';
        try {
            gitExe = await sub.resolveExecutable('git');
        }
        catch {
            /* fall back to PATH name */
        }
        setProgress('installing', 'git fetch --progress\u2026', 22);
        updateState.message = '\u6e90\u7801\u6a21\u5f0f\uff1a\u6b63\u5728\u4ece\u8fdc\u7a0b\u62c9\u53d6\u66f4\u65b0\uff08' + root + '\uff09';
        updateState.progressSpeed = '';
        await runCaptured([gitExe, 'fetch', '--progress', '--prune', 'origin'], root, 'git fetch\u2026', 180000, { gitStage: 'fetch' });

        setProgress('installing', '\u68c0\u6d4b\u5f53\u524d\u5206\u652f\u2026', 56);
        // Resolve current branch name via a short spawn.
        let branch = 'master';
        try {
            const handle = sub.spawn({
                argv: [gitExe, 'rev-parse', '--abbrev-ref', 'HEAD'],
                cwd: root,
                stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
                graceMs: 8000,
            });
            const outcome = await handle.done;
            const text = (handle.collected?.stdout?.readFrom(0).text || '').trim();
            if (outcome.exitCode === 0 && text && text !== 'HEAD')
                branch = text;
        }
        catch {
            /* keep master */
        }

        setProgress('installing', 'git pull --ff-only --progress origin/' + branch + '\u2026', 58);
        updateState.progressSpeed = '';
        try {
            await runCaptured([gitExe, 'pull', '--ff-only', '--progress', 'origin', branch], root, 'git pull\u2026', 180000, { gitStage: 'pull' });
        }
        catch (e) {
            const div = await inspectGitDivergence(root);
            updateState.divergence = div;
            const err = new Error(formatDivergenceMessage(div) + '\n\n' + errMsg(e));
            err.code = 'DIVERGED';
            throw err;
        }
        updateState.progressSpeed = '';
        updateState.divergence = null;

        // Refresh deps when lockfile/package.json may have changed.
        await runGitDepsInstall(root);
    }

    async function runGitDepsInstall(root) {
        setProgress('installing', '\u5b89\u88c5\u4f9d\u8d56\uff08pnpm/npm\uff09\u2026', 75);
        const pm = await resolvePackageManager();
        if (pm) {
            try {
                const isPnpm = /pnpm/i.test(pm);
                const args = isPnpm
                    ? [pm, 'install', '--frozen-lockfile']
                    : [pm, 'install', '--no-audit', '--no-fund'];
                await runCaptured(args, root, '\u5b89\u88c5\u4f9d\u8d56\u2026', 300000);
            }
            catch {
                try {
                    const isPnpm = /pnpm/i.test(pm);
                    const args = isPnpm
                        ? [pm, 'install']
                        : [pm, 'install', '--no-audit', '--no-fund'];
                    await runCaptured(args, root, '\u91cd\u8bd5\u5b89\u88c5\u4f9d\u8d56\u2026', 300000);
                }
                catch (e2) {
                    appendSoftWarning('\u4f9d\u8d56\u5b89\u88c5\u672a\u5b8c\u6210\uff08\u53ef\u5ffd\u7565\uff09\uff1a' + errMsg(e2));
                }
            }
        }
        else {
            appendSoftWarning('\u672a\u627e\u5230 pnpm/npm\uff0c\u5df2\u8df3\u8fc7\u4f9d\u8d56\u5b89\u88c5');
        }
    }

    /**
     * After ff-only fails: one-click resolve that is meant to finish without
     * dumping users into a conflicted working tree.
     *
     * - merge / rebase: stash → backup branch → merge|rebase → on conflict
     *   auto-resolve (lockfiles = upstream, other files = local) → continue;
     *   if still stuck, abort and fall back to reset --hard upstream while
     *   keeping the backup branch.
     * - reset-remote: stash backup → reset --hard origin/branch
     */
    async function runGitResolve(action) {
        const system = updateState.system || await detectSystem();
        const root = system.root || (await findDshRoot(ctx));
        if (!root)
            throw new Error('\u627e\u4e0d\u5230\u6e90\u7801\u76ee\u5f55');
        const gitExe = await resolveGitExe();
        let div = updateState.divergence || await inspectGitDivergence(root);
        updateState.divergence = div;
        const branch = div.branch || 'master';
        const upstream = div.upstream || ('origin/' + branch);

        setProgress('installing', 'git fetch --progress\u2026', 12);
        updateState.progressSpeed = '';
        updateState.message = '\u6b63\u5728\u5904\u7406\u5206\u53c9\uff08' + action + '\uff09\uff1a' + root;
        await runCaptured([gitExe, 'fetch', '--progress', '--prune', 'origin'], root, 'git fetch\u2026', 180000, { gitStage: 'fetch' });
        div = await inspectGitDivergence(root);
        updateState.divergence = div;

        let stashed = false;
        if (action === 'merge' || action === 'rebase') {
            setProgress('installing', '\u6682\u5b58\u672a\u63d0\u4ea4\u6539\u52a8\uff08stash\uff09\u2026', 32);
            const st = await gitCapture(gitExe, ['stash', 'push', '-u', '-m', 'dsh-version-autoupdate'], root, 120000);
            const blob = (st.out || '') + '\n' + (st.err || '');
            stashed = st.code === 0 && !/No local changes to save/i.test(blob);
        }
        else if (action === 'reset-remote') {
            setProgress('installing', '\u5907\u4efd\u672a\u63d0\u4ea4\u5230 stash\u2026', 32);
            await gitCapture(gitExe, ['stash', 'push', '-u', '-m', 'dsh-autoupdate-before-reset'], root, 120000);
        }

        if (action === 'reset-remote') {
            setProgress('installing', 'git reset --hard ' + upstream + '\u2026', 55);
            await runCaptured([gitExe, 'reset', '--hard', upstream], root, 'git reset\u2026', 120000);
            updateState.progressSpeed = '';
            await runGitDepsInstall(root);
            updateState.divergence = null;
            installedCache = { t: 0, v: null };
            updateState.after = await getInstalled();
            setProgress('done', '\u5df2\u53ea\u4fdd\u7559\u8fdc\u7a0b', 100);
            updateState.ok = true;
            updateState.done = true;
            updateState.message = '\u5df2\u53ea\u4fdd\u7559\u8fdc\u7a0b ' + upstream
                + '\u3002\u672c\u5730\u63d0\u4ea4\u5df2\u4e22\u5f03\uff1b\u672a\u63d0\u4ea4\u6539\u52a8\u5df2\u5907\u4efd\u5728 git stash\uff08git stash list\uff09\u3002\u8bf7\u91cd\u542f dsh web\u3002';
            return;
        }

        // --- merge / rebase with auto conflict resolution ---
        const backup = 'dsh-backup/' + Date.now().toString(36);
        setProgress('installing', '\u5907\u4efd\u672c\u5730\u5230 ' + backup + '\u2026', 40);
        await gitCapture(gitExe, ['branch', backup], root);

        const isLockfile = (p) => /(^|\/|\\)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb)$/i.test(p);
        const listUnmerged = async () => {
            const u = await gitCapture(gitExe, ['diff', '--name-only', '--diff-filter=U'], root);
            return (u.code === 0 ? u.out : '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        };
        /** Prefer local feature code; lockfiles take upstream then reinstall. */
        const autoResolveUnmerged = async (mode) => {
            const files = await listUnmerged();
            for (const f of files) {
                // rebase: ours=upstream, theirs=local commit being applied
                // merge:  ours=local,   theirs=upstream
                let side;
                if (isLockfile(f))
                    side = mode === 'rebase' ? '--ours' : '--theirs';
                else
                    side = mode === 'rebase' ? '--theirs' : '--ours';
                await gitCapture(gitExe, ['checkout', side, '--', f], root);
                await gitCapture(gitExe, ['add', '--', f], root);
            }
            return files;
        };

        const mode = action === 'rebase' ? 'rebase' : 'merge';
        setProgress('installing', 'git ' + mode + ' ' + upstream + '\u2026', 48);
        let step = mode === 'rebase'
            ? await gitCapture(gitExe, ['rebase', upstream], root, 300000)
            : await gitCapture(gitExe, ['merge', '--no-edit', upstream], root, 300000);
        appendSoftWarning((step.out || step.err || '').slice(-800));

        let rounds = 0;
        let resolvedAll = [];
        while (step.code !== 0 && rounds < 25) {
            const unmerged = await listUnmerged();
            if (!unmerged.length)
                break;
            rounds += 1;
            setProgress('installing', '\u81ea\u52a8\u5904\u7406\u51b2\u7a81\uff08\u7b2c ' + rounds + ' \u8f6e\uff0c' + unmerged.length + ' \u4e2a\u6587\u4ef6\uff09\u2026', Math.min(70, 50 + rounds));
            appendSoftWarning('\u51b2\u7a81\u81ea\u52a8\u5904\u7406\uff1a' + unmerged.join(', '));
            const got = await autoResolveUnmerged(mode);
            resolvedAll = resolvedAll.concat(got);
            if (mode === 'rebase') {
                step = await gitCapture(gitExe, ['-c', 'core.editor=true', 'rebase', '--continue'], root, 180000);
            }
            else {
                step = await gitCapture(gitExe, ['-c', 'core.editor=true', 'commit', '--no-edit'], root, 120000);
                break;
            }
            appendSoftWarning((step.out || step.err || '').slice(-400));
        }

        if (step.code !== 0) {
            // Still stuck → finish the flow by aligning to remote; local kept on backup.
            setProgress('installing', '\u51b2\u7a81\u672a\u80fd\u5b8c\u5168\u81ea\u52a8\u89e3\u51b3\uff0c\u56de\u9000\u5e76\u5bf9\u9f50\u8fdc\u7a0b\u2026', 72);
            if (mode === 'rebase')
                await gitCapture(gitExe, ['rebase', '--abort'], root).catch(() => { });
            if (mode === 'merge')
                await gitCapture(gitExe, ['merge', '--abort'], root).catch(() => { });
            await runCaptured([gitExe, 'reset', '--hard', upstream], root, 'git reset\u2026', 120000);
            if (stashed)
                await gitCapture(gitExe, ['stash', 'pop'], root).catch(() => { });
            await runGitDepsInstall(root);
            updateState.divergence = null;
            installedCache = { t: 0, v: null };
            updateState.after = await getInstalled();
            setProgress('done', '\u5df2\u5bf9\u9f50\u8fdc\u7a0b\uff08\u672c\u5730\u5df2\u5907\u4efd\uff09', 100);
            updateState.ok = true;
            updateState.done = true;
            updateState.message = '\u5206\u53c9\u5df2\u5904\u7406\u5b8c\u6bd5\uff1a\u5de5\u4f5c\u533a\u5df2\u4e0e ' + upstream
                + ' \u5bf9\u9f50\u3002\u4f60\u7684\u672c\u5730\u63d0\u4ea4\u4fdd\u7559\u5728\u5206\u652f ' + backup
                + '\uff08git switch ' + backup + '\uff09\u3002\u8bf7\u91cd\u542f dsh web\u3002';
            return;
        }

        if (stashed) {
            setProgress('installing', '\u6062\u590d stash\u2026', 78);
            const pop = await gitCapture(gitExe, ['stash', 'pop'], root, 120000);
            if (pop.code !== 0)
                appendSoftWarning('stash pop \u672a\u5b8c\u5168\u6210\u529f\uff0c\u8bf7\u624b\u52a8\u68c0\u67e5\uff1a' + ((pop.err || pop.out || '').slice(0, 400)));
        }

        updateState.progressSpeed = '';
        await runGitDepsInstall(root);
        updateState.divergence = await inspectGitDivergence(root);
        installedCache = { t: 0, v: null };
        updateState.after = await getInstalled();
        setProgress('done', '\u5206\u53c9\u5904\u7406\u5b8c\u6210', 100);
        updateState.ok = true;
        updateState.done = true;
        const d = updateState.divergence;
        const autoNote = resolvedAll.length
            ? '\u5df2\u81ea\u52a8\u5904\u7406 ' + resolvedAll.length + ' \u4e2a\u51b2\u7a81\u6587\u4ef6\uff1b'
            : '';
        updateState.message = autoNote
            + (mode === 'rebase' ? '\u5df2 rebase \u5230 ' : '\u5df2 merge ')
            + upstream
            + '\uff08\u8d85\u524d ' + (d?.ahead ?? '?') + ' / \u843d\u540e ' + (d?.behind ?? '?') + '\uff09\u3002'
            + '\u5907\u4efd\u5206\u652f\uff1a' + backup + '\u3002\u8bf7\u91cd\u542f dsh web\u3002';
        if (d && d.ahead === 0 && d.behind === 0)
            updateState.divergence = null;
    }

    function appendSoftWarning(text) {
        updateState.tail = (updateState.tail + '\n' + text).slice(-6000);
    }
    async function runUpdate() {
        try {
            setProgress('detect', '\u68c0\u6d4b\u5b89\u88c5\u65b9\u5f0f\u2026', 5);
            const system = await detectSystem();
            updateState.system = system;
            const root = system.root || (await findDshRoot(ctx));
            setProgress('detect', '\u8bfb\u53d6\u5f53\u524d\u7248\u672c\u2026', 10);
            const before = await getInstalled();
            updateState.before = before;

            // ---------- git source path ----------
            if (system.installMethod === 'git') {
                if (!root) {
                    setProgress('error', '\u627e\u4e0d\u5230\u6e90\u7801\u76ee\u5f55', 5);
                    updateState.ok = false;
                    updateState.done = true;
                    updateState.running = false;
                    updateState.message = '\u68c0\u6d4b\u4e3a git \u6e90\u7801\uff0c\u4f46\u627e\u4e0d\u5230\u4ed3\u5e93\u6839\u76ee\u5f55';
                    return;
                }
                // Same gate as npm: already on registry latest → do not git pull.
                setProgress('detect', '\u67e5\u8be2\u6700\u65b0\u7248\u672c\u2026', 12);
                const gitCands = await getCandidates(true);
                const gitTarget = resolveTarget(gitCands);
                updateState.latest = gitTarget.version;
                if (before && gitTarget.version && !isNewer(before, gitTarget.version)) {
                    setProgress('done', '\u5df2\u662f\u6700\u65b0', 100);
                    updateState.ok = true;
                    updateState.after = before;
                    updateState.done = true;
                    updateState.running = false;
                    updateState.message = '\u5df2\u7ecf\u662f\u6700\u65b0\u7248\u672c v' + before + '\uff0c\u65e0\u9700 git pull';
                    return;
                }
                setProgress('installing', '\u6e90\u7801\u6a21\u5f0f\uff1agit pull\u2026', 18);
                updateState.tail = '';
                updateState.message = '\u5df2\u68c0\u6d4b\u4e3a git \u6e90\u7801\uff0c\u5f00\u59cb\u4e00\u952e\u66f4\u65b0\uff1a' + root;
                try {
                    await runGitSourceUpdate(root);
                }
                catch (e) {
                    if (e && e.code === 'DIVERGED') {
                        setProgress('diverged', '\u9700\u5904\u7406\u5206\u53c9', 42);
                        updateState.ok = false;
                        updateState.done = true;
                        updateState.running = false;
                        updateState.message = errMsg(e);
                        return;
                    }
                    throw e;
                }
                installedCache = { t: 0, v: null };
                setProgress('installing', '\u6821\u9a8c\u7248\u672c\u2026', 92);
                const after = await getInstalled();
                updateState.after = after;
                setProgress('done', '\u6e90\u7801\u66f4\u65b0\u5b8c\u6210', 100);
                updateState.ok = true;
                updateState.done = true;
                updateState.message = '\u6e90\u7801\u5df2 git pull'
                    + (before || after ? '\uff08' + (before ? 'v' + before : '?') + (after && after !== before ? ' \u2192 v' + after : '') + '\uff09' : '')
                    + '\u3002';
                maybeAutoRestart('git');
                if (!updateState.restartScheduled) {
                    updateState.message += manualRestartHint(before, after || before);
                }
                return;
            }

            // ---------- npm global path ----------
            setProgress('detect', '\u67e5\u8be2 npm \u6700\u65b0\u7248\u672c\u2026', 14);
            const cands = await getCandidates(true);
            const { version: latest, note } = resolveTarget(cands);
            updateState.latest = latest;
            if (!latest) {
                setProgress('error', '\u65e0\u6cd5\u83b7\u53d6\u6700\u65b0\u7248\u672c', 5);
                updateState.ok = false;
                updateState.done = true;
                updateState.running = false;
                updateState.message = '\u65e0\u6cd5\u83b7\u53d6\u6700\u65b0\u7248\u672c\uff08\u7f51\u7edc\u6216\u89e3\u6790\u5931\u8d25\uff09\uff0c\u672a\u6267\u884c\u66f4\u65b0';
                return;
            }
            if (before && !isNewer(before, latest)) {
                const runningNow = await runningPromise;
                updateState.after = before;
                updateState.done = true;
                updateState.ok = true;
                if (runningNow && isNewer(runningNow, before)) {
                    setProgress('done', '\u5df2\u88c5\u6700\u65b0\u00b7\u9700\u91cd\u542f', 100);
                    updateState.message = manualRestartHint(runningNow, before);
                }
                else {
                    setProgress('done', '\u5df2\u662f\u6700\u65b0', 100);
                    updateState.message = '\u5df2\u7ecf\u662f\u6700\u65b0\u7248\u672c v' + before + '\uff0c\u65e0\u9700\u66f4\u65b0';
                }
                return;
            }
            const pm = await resolvePackageManager();
            if (!pm) {
                setProgress('error', '\u672a\u627e\u5230\u5305\u7ba1\u7406\u5668', 5);
                updateState.ok = false;
                updateState.done = true;
                updateState.running = false;
                updateState.message = '\u672a\u627e\u5230 npm/pnpm/yarn \u5305\u7ba1\u7406\u5668\uff0c\u65e0\u6cd5\u81ea\u52a8\u66f4\u65b0';
                return;
            }
            setProgress('installing', '\u5b89\u88c5 @deepseek-ai/dsh@' + latest + '\u2026', 18);
            updateState.tail = '';
            updateState.message = '\u5df2\u68c0\u6d4b\u4e3a npm \u5b89\u88c5\uff0c\u6b63\u5728\u5b89\u88c5 v' + latest + (note ? ' \uff08' + note + '\uff09' : '');
            await runInstall(pm, latest);
            installedCache = { t: 0, v: null };
            setProgress('installing', '\u6821\u9a8c\u5b89\u88c5\u7ed3\u679c\u2026', 92);
            const after = await getInstalled();
            updateState.after = after;
            setProgress('done', '\u66f4\u65b0\u5b8c\u6210', 100);
            updateState.ok = true;
            updateState.done = true;
            const runningLabel = before || (await runningPromise) || null;
            updateState.message = after
                ? ('npm \u5df2\u5b89\u88c5\u5230\u672c\u5730 ' + (runningLabel ? ('v' + runningLabel + ' \u2192 ') : '') + 'v' + after + '\u3002')
                : '\u66f4\u65b0\u547d\u4ee4\u6267\u884c\u6210\u529f\u3002';
            maybeAutoRestart('npm');
            if (!updateState.restartScheduled) {
                updateState.message += manualRestartHint(runningLabel, after || latest);
            }
        }
        catch (e) {
            setProgress('error', '\u66f4\u65b0\u5931\u8d25', updateState.progress || 5);
            updateState.ok = false;
            updateState.message = errMsg(e);
            updateState.done = true;
            updateState.running = false;
        }
    }
    async function statusPayload(force = false) {
        let running = null;
        let installed = null;
        let cands = null;
        let system = updateState.system;
        try {
            running = await runningPromise;
            installed = await getInstalled();
            cands = await getCandidates(force);
            if (!system)
                system = await detectSystem();
            if (system?.installMethod === 'git' && system.root
                && (force || updateState.phase === 'diverged' || updateState.divergence)) {
                try {
                    updateState.divergence = await inspectGitDivergence(system.root);
                }
                catch { /* keep previous */ }
            }
        }
        catch {
            /* partial ok */
        }
        const { version: latest, note } = resolveTarget(cands);
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
            divergence: updateState.divergence,
            autoRestart: autoRestartEnabled(),
            platform: process.platform,
            update: { ...updateState },
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
        const rejectForbidden = (req, res) => {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, busy: false, message: '\u62d2\u7edd\u8de8\u57df\u66f4\u65b0\u8bf7\u6c42' }));
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
                const payload = await (async () => {
                    if (updateState.running)
                        return { ok: false, busy: true, message: '\u66f4\u65b0\u6b63\u5728\u8fdb\u884c\u4e2d\uff0c\u8bf7\u7a0d\u5019' };
                    updateState.running = true;
                    updateState.done = false;
                    updateState.ok = false;
                    updateState.phase = 'detect';
                    updateState.tail = '';
                    updateState.message = '';
                    updateState.progress = 0;
                    updateState.progressLabel = '\u51c6\u5907\u66f4\u65b0\u2026';
                    updateState.progressSpeed = '';
                    updateState.divergence = null;
                    updateState.startedAt = Date.now();
                    updateState.before = null;
                    updateState.after = null;
                    updateState.latest = null;
                    updateState.system = null;
                    updateState.restartScheduled = false;
                    const run = runUpdate();
                    run
                        .catch((e) => {
                        if (e && e.code === 'DIVERGED') {
                            updateState.phase = 'diverged';
                            updateState.ok = false;
                            updateState.message = errMsg(e);
                            updateState.done = true;
                            updateState.running = false;
                            return;
                        }
                        updateState.phase = 'error';
                        updateState.ok = false;
                        updateState.message = errMsg(e);
                        updateState.done = true;
                        updateState.running = false;
                    })
                        .finally(() => {
                        updateState.running = false;
                    });
                    void run;
                    return { ok: true, busy: false };
                })();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify(payload));
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
                try {
                    await readBody(req);
                }
                catch {
                    /* ignore */
                }
                if (!autoRestartEnabled()) {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({
                        ok: false,
                        skipped: true,
                        platform: process.platform,
                        message: 'Windows \u8bf7\u624b\u52a8\u5173\u95ed\u5e76\u91cd\u65b0\u542f\u52a8 dsh web\uff08\u4e0d\u652f\u6301\u8fdb\u7a0b\u5185\u81ea\u52a8\u91cd\u542f\uff09',
                    }));
                    return;
                }
                const result = scheduleProcessRestart('manual');
                res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify(result));
            },
        });
        webServer.register({
            kind: 'exact',
            path: '/dsh-version-updater/resolve-git',
            handler: async (req, res) => {
                if (!isSameOrigin(req)) {
                    rejectForbidden(req, res);
                    return;
                }
                let body = {};
                try {
                    body = await readBody(req);
                }
                catch {
                    body = {};
                }
                const action = body && typeof body.action === 'string' ? body.action : '';
                const allowed = new Set(['merge', 'rebase', 'reset-remote']);
                const payload = await (async () => {
                    if (!allowed.has(action))
                        return { ok: false, busy: false, message: '\u65e0\u6548 action\uff08merge|rebase|reset-remote\uff09' };
                    if (updateState.running)
                        return { ok: false, busy: true, message: '\u66f4\u65b0\u6b63\u5728\u8fdb\u884c\u4e2d\uff0c\u8bf7\u7a0d\u5019' };
                    updateState.running = true;
                    updateState.done = false;
                    updateState.ok = false;
                    updateState.phase = 'installing';
                    updateState.tail = '';
                    updateState.message = '';
                    updateState.progress = 5;
                    updateState.progressLabel = '\u51c6\u5907 ' + action + '\u2026';
                    updateState.progressSpeed = '';
                    updateState.startedAt = Date.now();
                    const run = runGitResolve(action);
                    run
                        .catch((e) => {
                        updateState.phase = updateState.divergence ? 'diverged' : 'error';
                        updateState.ok = false;
                        updateState.message = errMsg(e);
                        updateState.done = true;
                        updateState.running = false;
                    })
                        .finally(() => {
                        updateState.running = false;
                    });
                    void run;
                    return { ok: true, busy: false, action };
                })();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify(payload));
            },
        });
    };
    // Register the same-origin JSON API immediately; routes become active once
    // the web server listens.
    registerRoutes();
}
//# sourceMappingURL=index.js.map