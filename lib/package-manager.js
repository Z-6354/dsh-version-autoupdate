import { existsSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { versionCompare } from './semver.js';
/** Minimum Node for DSH global installs (matches harness engine floor). */
export const MIN_NODE_FOR_DSH = '22.19.0';
const DSH_PKG_SUFFIX = '/lib/node_modules/@deepseek-ai/dsh';
function pathApi(platform) {
    return platform === 'win32' ? win32 : posix;
}
function joinPath(platform, ...parts) {
    return pathApi(platform).join(...parts);
}
/** Derive the Node install prefix from a global @deepseek-ai/dsh package root. */
export function nodePrefixFromDshRoot(root) {
    const normalized = root.replace(/\\/g, '/');
    if (!normalized.endsWith(DSH_PKG_SUFFIX))
        return null;
    // Preserve original path separators for the returned prefix (Windows callers).
    return root.slice(0, root.length - DSH_PKG_SUFFIX.length);
}
function resolveHome(opts) {
    if (opts.home !== undefined)
        return opts.home;
    const env = opts.env ?? process.env;
    return env.HOME?.trim() || env.USERPROFILE?.trim() || (() => {
        try {
            return homedir();
        }
        catch {
            return null;
        }
    })();
}
/**
 * Extra bin directories that interactive shells often have on PATH,
 * but GUI / Watchdog-launched DSH Host may not (Windows + Linux + macOS).
 */
export function packageManagerExtraBinDirs(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const env = opts.env ?? process.env;
    const dirs = [];
    const push = (dir) => {
        const value = dir?.trim();
        if (value && !dirs.includes(value))
            dirs.push(value);
    };
    if (platform === 'win32') {
        const appData = opts.appData !== undefined ? opts.appData : env.APPDATA;
        const localAppData = opts.localAppData !== undefined ? opts.localAppData : env.LOCALAPPDATA;
        if (appData)
            push(joinPath(platform, appData, 'npm'));
        // pnpm standalone installer default + PNPM_HOME
        if (env.PNPM_HOME)
            push(env.PNPM_HOME);
        if (localAppData)
            push(joinPath(platform, localAppData, 'pnpm'));
        return dirs;
    }
    const home = resolveHome(opts);
    if (env.PNPM_HOME)
        push(env.PNPM_HOME);
    if (home) {
        // Official pnpm standalone / setup script locations
        push(joinPath(platform, home, '.local', 'share', 'pnpm'));
        push(joinPath(platform, home, '.local', 'bin'));
        // npm prefix -g on many Linux/macOS user installs
        push(joinPath(platform, home, '.npm-global', 'bin'));
    }
    // Common system locations (still tried via absolute path before PATH)
    push('/usr/local/bin');
    push('/usr/bin');
    return dirs;
}
/** Ordered executable paths to try before falling back to PATH lookup. */
export function packageManagerSearchPaths(opts) {
    const paths = [];
    const win = opts.platform === 'win32';
    const ext = win ? '.cmd' : '';
    const seen = new Set();
    const push = (path) => {
        if (!seen.has(path)) {
            seen.add(path);
            paths.push(path);
        }
    };
    push(joinPath(opts.platform, opts.nodeBinDir, opts.pm + ext));
    if (win)
        push(joinPath(opts.platform, opts.nodeBinDir, opts.pm + '.exe'));
    if (opts.dshRoot) {
        const prefix = nodePrefixFromDshRoot(opts.dshRoot);
        if (prefix)
            push(joinPath(opts.platform, prefix, 'bin', opts.pm + ext));
    }
    for (const dir of packageManagerExtraBinDirs(opts)) {
        push(joinPath(opts.platform, dir, opts.pm + ext));
        if (win)
            push(joinPath(opts.platform, dir, opts.pm + '.exe'));
    }
    return paths;
}
/** Prefer an existing PYTHON, else common Windows installs (node-gyp / pnpm rebuild). */
export function resolveWindowsPythonPath(env = process.env, fileExists = existsSync) {
    const explicit = env.PYTHON?.trim();
    if (explicit && fileExists(explicit))
        return explicit;
    const local = env.LOCALAPPDATA?.trim();
    const candidates = [
        local ? joinPath('win32', local, 'Programs', 'Python', 'Python313', 'python.exe') : null,
        local ? joinPath('win32', local, 'Programs', 'Python', 'Python312', 'python.exe') : null,
        local ? joinPath('win32', local, 'Programs', 'Python', 'Python311', 'python.exe') : null,
        'C:\\Python313\\python.exe',
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe',
    ];
    for (const candidate of candidates) {
        if (candidate && fileExists(candidate))
            return candidate;
    }
    return null;
}
/** Build subprocess env so package managers prefer the Node that runs DSH. */
export function buildInstallEnv(nodeBinDir = dirname(process.execPath), opts = {}) {
    const platform = opts.platform ?? process.platform;
    const env = opts.env ?? process.env;
    const sep = platform === 'win32' ? ';' : ':';
    const pathKey = platform === 'win32' ? 'Path' : 'PATH';
    const existing = env[pathKey] ?? env.PATH ?? '';
    const prefixes = [nodeBinDir, ...packageManagerExtraBinDirs({ ...opts, platform, env })];
    const head = prefixes.join(sep);
    const next = {
        ...env,
        [pathKey]: existing ? `${head}${sep}${existing}` : head,
    };
    // Host / Watchdog PATH often omits Python; fs-ext and other native addons need it on rebuild.
    if (platform === 'win32' && !next.PYTHON?.trim()) {
        const python = resolveWindowsPythonPath(env);
        if (python) {
            next.PYTHON = python;
            const pyDir = dirname(python);
            next[pathKey] = `${pyDir}${sep}${next[pathKey]}`;
        }
    }
    return next;
}
export function isCorepackInvocation(pnpm) {
    const base = pnpm.exe.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    if (base === 'corepack' || base === 'corepack.cmd' || base === 'corepack.exe')
        return true;
    // After Windows unwrap: node …/corepack.js pnpm …
    return pnpm.prefixArgs.some((arg) => /corepack\.(js|cjs|mjs)$/i.test(arg.replace(/\\/g, '/')));
}
/**
 * Locate the Node entry script behind an npm-global Windows `.cmd` shim.
 * Node 20+ refuses to spawn `.cmd`/`.bat` without a shell (EINVAL); DSH Host
 * subprocess never uses a shell, so we must unwrap to `node + script`.
 */
export function resolveWindowsCmdNodeEntry(cmdPath, fileExists = existsSync) {
    const dir = dirname(cmdPath);
    const base = cmdPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    const tryRel = (...parts) => {
        const candidate = win32.join(dir, ...parts);
        return fileExists(candidate) ? candidate : null;
    };
    if (base.startsWith('pnpm')) {
        return tryRel('node_modules', 'pnpm', 'bin', 'pnpm.mjs')
            ?? tryRel('node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    }
    if (base.startsWith('corepack')) {
        return tryRel('node_modules', 'corepack', 'dist', 'corepack.js')
            ?? tryRel('node_modules', 'corepack', 'dist', 'corepack.cjs');
    }
    if (base === 'npm.cmd' || base === 'npm.bat') {
        return tryRel('node_modules', 'npm', 'bin', 'npm-cli.js');
    }
    return null;
}
/** True when argv[0] is a Windows batch shim that Node/Host cannot spawn without a shell. */
export function isWindowsBatchShim(exe) {
    if (!exe)
        return false;
    return /\.(cmd|bat)$/i.test(exe.trim());
}
/**
 * Host subprocess never shell-interprets argv (see dsh-subprocess types).
 * Calling this before every Host spawn turns cryptic `spawn EINVAL` into an actionable error.
 */
export function assertHostSpawnableArgv(argv, platform = process.platform) {
    if (platform !== 'win32')
        return;
    const exe = argv[0];
    if (!isWindowsBatchShim(exe))
        return;
    throw new Error(`Host subprocess cannot spawn Windows batch shim as argv[0]: ${exe}. ` +
        'Node 20+ returns EINVAL without a shell. Unwrap to node+script (formatToolArgv / makeSpawnablePnpm) or spawn ComSpec first.');
}
/**
 * Convert a resolved pnpm/corepack invocation into something Host subprocess
 * can spawn on Windows (no shell) and Linux.
 */
export function makeSpawnablePnpm(pnpm, opts = {}) {
    const platform = opts.platform ?? process.platform;
    if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(pnpm.exe))
        return pnpm;
    const entry = resolveWindowsCmdNodeEntry(pnpm.exe, opts.fileExists ?? existsSync);
    if (entry) {
        return {
            exe: opts.nodeExe ?? process.execPath,
            prefixArgs: [entry, ...pnpm.prefixArgs],
        };
    }
    // Last resort: spawn ComSpec (an .exe) which can run the .cmd shim.
    return {
        exe: opts.comSpec ?? process.env.ComSpec ?? 'cmd.exe',
        prefixArgs: ['/d', '/s', '/c', pnpm.exe, ...pnpm.prefixArgs],
    };
}
export function formatPnpmArgv(pnpm, args, opts = {}) {
    const spawnable = makeSpawnablePnpm(pnpm, opts);
    const argv = [spawnable.exe, ...spawnable.prefixArgs, ...args];
    assertHostSpawnableArgv(argv, opts.platform ?? process.platform);
    return argv;
}
/** Spawn argv for an arbitrary Windows .cmd tool (e.g. corepack prepare / npm.cmd). */
export function formatToolArgv(exe, args, opts = {}) {
    return formatPnpmArgv({ exe, prefixArgs: [] }, args, opts);
}
/** User-facing remediation when pnpm cannot be resolved or verified (Windows + Linux). */
export function formatPnpmRemediationError(input) {
    const platform = input.platform ?? process.platform;
    const lines = [
        'GitHub 源更新需要可用的 pnpm（staging 内执行 install + build:lib:host + build:lib:client + build:web；不是 npm 全局安装）。',
    ];
    if (input.detail)
        lines.push(`详情：${input.detail}`);
    if (input.tried && input.tried.length > 0) {
        lines.push(`已尝试：${input.tried.slice(0, 8).join(' → ')}${input.tried.length > 8 ? ' …' : ''}`);
    }
    if (platform === 'win32') {
        lines.push('修复建议：1) 在与 DSH 相同的 Node 下执行 `corepack enable` 后 `corepack prepare pnpm@latest --activate`；', '2) 或 `npm install -g pnpm`（确保 %APPDATA%\\npm 在 PATH）；', '3) 或在插件配置 packageManagerPath 指向 pnpm.cmd 绝对路径后重启 DSH。');
    }
    else {
        lines.push('修复建议：1) `corepack enable && corepack prepare pnpm@latest --activate`；', '2) 或安装 standalone pnpm 并保证 ~/.local/share/pnpm 或 ~/.local/bin 在 PATH；', '3) 或在插件配置 packageManagerPath 指向 pnpm 绝对路径后重启 DSH。');
    }
    return lines.join(' ');
}
function pnpmNotFoundMessage(platform) {
    return formatPnpmRemediationError({ platform, detail: '未找到 pnpm / corepack 可执行文件' });
}
async function probePnpmVersion(pnpm, spawn, env, opts = {}) {
    try {
        const result = await spawn(formatPnpmArgv(pnpm, ['--version'], opts), env);
        const text = `${result.stdout}\n${result.stderr}`.trim();
        const version = (result.stdout || result.stderr).trim().split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+\.\d+/.test(l));
        if (result.exitCode === 0 && version)
            return { ok: true, version };
        return { ok: false, error: text.slice(0, 400) || `exit ${result.exitCode}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
async function resolveCorepackExe(input) {
    const names = input.platform === 'win32'
        ? [
            joinPath(input.platform, input.nodeBinDir, 'corepack.cmd'),
            joinPath(input.platform, input.nodeBinDir, 'corepack.exe'),
            'corepack.cmd',
            'corepack',
        ]
        : [joinPath(input.platform, input.nodeBinDir, 'corepack'), 'corepack'];
    for (const name of names) {
        try {
            return await input.resolveExecutable(name, input.installEnv);
        }
        catch {
            /* next */
        }
    }
    return null;
}
/**
 * Resolve + verify pnpm. If corepack exists but pnpm is inactive, run
 * `corepack prepare pnpm@latest --activate` once and re-resolve.
 * Call this before downloading a GitHub archive (fail fast).
 */
export async function ensurePnpmReady(input) {
    const platform = input.platform ?? process.platform;
    const nodeBinDir = input.nodeBinDir ?? dirname(process.execPath);
    const envOpts = {
        platform,
        env: input.env ?? process.env,
        home: input.home,
        appData: input.appData,
        localAppData: input.localAppData,
    };
    const spawnOpts = {
        platform,
        nodeExe: input.nodeExe,
        comSpec: input.comSpec,
        fileExists: input.fileExists,
    };
    const installEnv = buildInstallEnv(nodeBinDir, envOpts);
    const tried = [];
    const note = async (message) => {
        tried.push(message);
        await input.onProgress?.(message);
    };
    const accept = async (candidate, label) => {
        const ready = makeSpawnablePnpm(candidate, spawnOpts);
        const probe = await probePnpmVersion(ready, input.spawn, installEnv, spawnOpts);
        if (!probe.ok) {
            await note(`${label} failed: ${probe.error}`);
            return null;
        }
        await note(`${label}: pnpm ${probe.version} via ${formatPnpmArgv(ready, [], spawnOpts).join(' ')}`);
        return { ...ready, version: probe.version };
    };
    let pnpm;
    try {
        pnpm = await resolvePnpmExecutable({
            resolveExecutable: input.resolveExecutable,
            explicitPath: input.explicitPath,
            nodeBinDir,
            platform: platform,
            env: envOpts.env,
            home: envOpts.home,
            appData: envOpts.appData,
            localAppData: envOpts.localAppData,
        });
    }
    catch (error) {
        throw new Error(formatPnpmRemediationError({
            platform,
            detail: error instanceof Error ? error.message : String(error),
            tried,
        }));
    }
    await note(`resolved ${formatPnpmArgv(pnpm, [], spawnOpts).join(' ')}`);
    const first = await accept(pnpm, 'version check');
    if (first)
        return first;
    // Wrong explicit path / broken shim — try discovery without explicit, then corepack prepare.
    if (input.explicitPath?.trim()) {
        await note('explicit packageManagerPath failed; retrying auto-discovery');
        try {
            pnpm = await resolvePnpmExecutable({
                resolveExecutable: input.resolveExecutable,
                explicitPath: null,
                nodeBinDir,
                platform: platform,
                env: envOpts.env,
                home: envOpts.home,
                appData: envOpts.appData,
                localAppData: envOpts.localAppData,
            });
            const second = await accept(pnpm, 'auto-discovery');
            if (second)
                return second;
        }
        catch {
            /* continue to corepack prepare */
        }
    }
    const corepack = await resolveCorepackExe({
        resolveExecutable: input.resolveExecutable,
        nodeBinDir,
        platform,
        installEnv,
    });
    if (corepack) {
        await note('running corepack prepare pnpm@latest --activate');
        const prepare = await input.spawn(formatToolArgv(corepack, ['prepare', 'pnpm@latest', '--activate'], spawnOpts), installEnv);
        if (prepare.exitCode !== 0) {
            await note(`corepack prepare failed: ${(prepare.stderr || prepare.stdout).trim().slice(0, 300)}`);
        }
        else {
            try {
                pnpm = await resolvePnpmExecutable({
                    resolveExecutable: input.resolveExecutable,
                    explicitPath: null,
                    nodeBinDir,
                    platform: platform,
                    env: envOpts.env,
                    home: envOpts.home,
                    appData: envOpts.appData,
                    localAppData: envOpts.localAppData,
                });
                const afterPrepare = await accept(pnpm, 'after corepack prepare');
                if (afterPrepare)
                    return afterPrepare;
            }
            catch (error) {
                await note(error instanceof Error ? error.message : String(error));
            }
        }
        const viaCorepack = await accept({ exe: corepack, prefixArgs: ['pnpm'] }, 'corepack pnpm');
        if (viaCorepack)
            return viaCorepack;
    }
    else {
        await note('corepack not found; cannot auto-activate pnpm');
    }
    throw new Error(formatPnpmRemediationError({
        platform,
        detail: 'pnpm 探测失败',
        tried,
    }));
}
/**
 * Resolve a pnpm invocation for GitHub staging builds.
 * Works on Windows and Linux/macOS: node-adjacent shims, user global bins, PNPM_HOME, then corepack.
 */
export async function resolvePnpmExecutable(input) {
    const platform = input.platform ?? process.platform;
    const nodeBinDir = input.nodeBinDir ?? dirname(process.execPath);
    const envOpts = {
        platform,
        env: input.env ?? process.env,
        home: input.home,
        appData: input.appData,
        localAppData: input.localAppData,
    };
    const installEnv = buildInstallEnv(nodeBinDir, envOpts);
    const explicit = input.explicitPath?.trim();
    if (explicit) {
        try {
            return { exe: await input.resolveExecutable(explicit), prefixArgs: [] };
        }
        catch {
            /* fall through to discovery */
        }
    }
    for (const candidate of packageManagerSearchPaths({
        dshRoot: null,
        pm: 'pnpm',
        nodeBinDir,
        platform,
        ...envOpts,
    })) {
        try {
            return { exe: await input.resolveExecutable(candidate), prefixArgs: [] };
        }
        catch {
            /* try next */
        }
    }
    const names = platform === 'win32' ? ['pnpm.cmd', 'pnpm'] : ['pnpm'];
    for (const name of names) {
        try {
            return {
                exe: await input.resolveExecutable(name, installEnv),
                prefixArgs: [],
            };
        }
        catch {
            /* try next */
        }
    }
    // Corepack ships with Node 16+; common on Linux CI / servers without a global pnpm shim.
    const corepackNames = platform === 'win32'
        ? [
            joinPath(platform, nodeBinDir, 'corepack.cmd'),
            joinPath(platform, nodeBinDir, 'corepack.exe'),
            'corepack.cmd',
            'corepack',
        ]
        : [joinPath(platform, nodeBinDir, 'corepack'), 'corepack'];
    for (const name of corepackNames) {
        try {
            const exe = await input.resolveExecutable(name, installEnv);
            return { exe, prefixArgs: ['pnpm'] };
        }
        catch {
            /* try next */
        }
    }
    throw new Error(pnpmNotFoundMessage(platform));
}
export function runningNodeSatisfiesDsh(version = process.version) {
    const normalized = version.replace(/^v/i, '');
    if (versionCompare(normalized, MIN_NODE_FOR_DSH) < 0) {
        return {
            ok: false,
            version,
            message: `当前运行 Node ${version} 不满足 DSH 要求 (>= v${MIN_NODE_FOR_DSH})，请先切换到正确 Node 后再更新。`,
        };
    }
    return { ok: true, version };
}
/** argv for `npm|pnpm|yarn install -g @deepseek-ai/dsh@<version>`. */
export function buildGlobalInstallArgv(pmExe, version) {
    const spec = '@deepseek-ai/dsh@' + version;
    const base = pmExe.replace(/\\/g, '/');
    const name = base.split('/').pop()?.replace(/\.(cmd|exe)$/i, '') ?? pmExe;
    if (name === 'pnpm') {
        return [pmExe, 'add', '-g', spec, '--no-optional'];
    }
    if (name === 'yarn') {
        return [pmExe, 'global', 'add', spec, '--ignore-optional'];
    }
    return [
        pmExe,
        'install',
        '-g',
        spec,
        '--no-audit',
        '--no-fund',
        '--omit=optional',
        '--fetch-retries=5',
        '--fetch-retry-mintimeout=20000',
        '--fetch-retry-maxtimeout=120000',
        '--fetch-timeout=300000',
        '--maxsockets=8',
        '--loglevel=info',
    ];
}
/** Rough preflight for npm global install on small VPS hosts (Linux only). */
export function lowMemoryInstallWarning(availableMb, thresholdMb = 400) {
    if (availableMb === null)
        return null;
    if (availableMb >= thresholdMb)
        return null;
    return (`可用内存仅约 ${availableMb} MB，npm 全局安装可能被 OOM 终止并损坏 dsh。` +
        ' 建议先加 swap 或释放内存后再更新。');
}
//# sourceMappingURL=package-manager.js.map