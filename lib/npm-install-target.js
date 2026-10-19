import { realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInstallEnv, formatToolArgv, assertHostSpawnableArgv } from './package-manager.js';
import { versionCompare } from './semver.js';
export async function verifyNpmInstallTarget(ctx, pm, runningRoot) {
    if (!runningRoot) throw new Error('Current DSH root is unknown');
    const manager = pm.replace(/\\/g, '/').split('/').pop().replace(/\.(cmd|exe)$/i, '');
    const argv = formatToolArgv(pm, manager === 'yarn' ? ['global', 'dir'] : ['root', '-g']);
    assertHostSpawnableArgv(argv);
    const sub = ctx.get('subprocess');
    const timer = ctx.get('timer');
    if (!sub || !timer) throw new Error('Cannot verify package manager global root');
    const handle = sub.spawn({ argv, cwd: process.cwd(), env: buildInstallEnv(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }, graceMs: 5000 });
    let timedOut = false;
    const clear = timer.timeout(() => { timedOut = true; try { handle.terminate(); } catch {} }, 15000);
    try {
        const result = await handle.done;
        if (timedOut || result.exitCode !== 0) throw new Error('Global root query failed or timed out');
        const globalRoot = (handle.collected?.stdout?.readFrom(0).text ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
        if (!globalRoot || !/^(?:[a-z]:[/\\]|[/\\]{1,2})/i.test(globalRoot)) throw new Error('Invalid global root');
        const target = join(globalRoot, ...(manager === 'yarn' ? ['node_modules'] : []), '@deepseek-ai', 'dsh');
        const normalize = p => { const v = realpathSync(p).replace(/\\/g, '/'); return process.platform === 'win32' ? v.toLowerCase() : v; };
        if (normalize(runningRoot) !== normalize(target))
            throw new Error('Package manager global root differs from running DSH; configure the original packageManagerPath');
        return runningRoot;
    } finally { clear(); }
}
export function readVerifiedInstalledVersion(root, targetVersion) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== '@deepseek-ai/dsh' || typeof pkg.version !== 'string' || versionCompare(pkg.version, targetVersion) !== 0)
        throw new Error(`Installed target mismatch: expected ${targetVersion}, actual ${pkg.version ?? 'unreadable'}`);
    return pkg.version;
}
