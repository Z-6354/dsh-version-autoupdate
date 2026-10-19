import { dirname, join } from 'node:path';
import { readTextAt } from './fs-path.js';
export { detectInstallationSource, normalizeGitHubTag } from './source-detection.js';
const KNOWN_DEPLOYMENT_ROOTS = [
    '/home/ubuntu/.local/node-v22.19.0/lib/node_modules/@deepseek-ai/dsh',
];
const HARNESS_CLI_MARKERS = ['/apps/cli/src/bin.ts', '/apps/cli/lib/bin.js', '/apps/cli/src/bin.js'];
const DSH_PACKAGE_NAMES = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-root']);
function pushRoot(roots, p) {
    if (typeof p === 'string' && p.trim())
        roots.push(p.trim());
}
function isDshPackage(pkg) {
    return (!!pkg &&
        typeof pkg.name === 'string' &&
        DSH_PACKAGE_NAMES.has(pkg.name) &&
        typeof pkg.version === 'string' &&
        pkg.version.length > 0);
}
/** Map a resolved `dsh` executable path to the installed package root. */
export function dshRootFromExecutable(exe) {
    const norm = exe.replace(/\\/g, '/');
    if (norm.includes('/node_modules/@deepseek-ai/dsh/')) {
        return norm.slice(0, norm.indexOf('/node_modules/@deepseek-ai/dsh/') + '/node_modules/@deepseek-ai/dsh'.length);
    }
    if (norm.endsWith('/bin/dsh.cmd')) {
        return norm.slice(0, -'/bin/dsh.cmd'.length) + '/lib/node_modules/@deepseek-ai/dsh';
    }
    if (norm.endsWith('/bin/dsh')) {
        return norm.slice(0, -'/bin/dsh'.length) + '/lib/node_modules/@deepseek-ai/dsh';
    }
    if (norm.toLowerCase().endsWith('/dsh.cmd') || norm.endsWith('/dsh')) {
        return join(dirname(exe), 'node_modules', '@deepseek-ai', 'dsh');
    }
    if (norm.endsWith('/lib/bin.js')) {
        return norm.slice(0, -'/lib/bin.js'.length);
    }
    return null;
}
/** Locate the installed DSH package root (global npm, harness checkout, or known deploy paths). */
export async function findDshRoot(ctx) {
    const fsSvc = ctx.get('fs');
    if (!fsSvc)
        return null;
    const roots = [];
    for (const arg of process.argv) {
        const norm = String(arg).replace(/\\/g, '/');
        if (norm.includes('/node_modules/@deepseek-ai/dsh/'))
            pushRoot(roots, dshRootFromExecutable(norm));
        for (const marker of HARNESS_CLI_MARKERS) {
            const i = norm.indexOf(marker);
            if (i > 0)
                pushRoot(roots, norm.slice(0, i));
        }
    }
    const sub = ctx.get('subprocess');
    if (sub) {
        try {
            const exe = (await sub.resolveExecutable('dsh')).replace(/\\/g, '/');
            const fromExe = dshRootFromExecutable(exe);
            if (fromExe)
                pushRoot(roots, fromExe);
        }
        catch {
            /* ignore */
        }
    }
    try {
        pushRoot(roots, join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
        pushRoot(roots, join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'));
        pushRoot(roots, join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
    }
    catch {
        /* ignore */
    }
    try {
        pushRoot(roots, process.cwd());
    }
    catch {
        /* ignore */
    }
    for (const root of KNOWN_DEPLOYMENT_ROOTS)
        pushRoot(roots, root);
    const sp = ctx.get('sandboxPolicy');
    if (sp?.workspaceRoot)
        pushRoot(roots, sp.workspaceRoot);
    const seen = new Set();
    for (const root of roots) {
        if (!root || seen.has(root))
            continue;
        seen.add(root);
        const candidates = [root, join(root, 'apps', 'cli')];
        for (const candidate of candidates) {
            const text = await readTextAt(fsSvc, join(candidate, 'package.json'));
            if (!text)
                continue;
            try {
                const pkg = JSON.parse(text);
                if (isDshPackage(pkg))
                    return candidate;
            }
            catch {
                /* try next */
            }
        }
    }
    return null;
}
//# sourceMappingURL=dsh-root.js.map