import type { Context } from '@deepseek-ai/cordis';
import { dirname, join } from 'node:path';

const HARNESS_CLI_MARKERS = ['/apps/cli/src/bin.ts', '/apps/cli/lib/bin.js', '/apps/cli/src/bin.js'];

export function detectDshInstallMethod(root: string | null, argv = process.argv, electron = process.versions.electron): string {
  if (electron || argv.some(arg => /[/\\]dsh-desktop-host[/\\]/.test(arg))) return 'desktop';
  if (!root) return 'unknown';
  const normalized = root.replace(/\\/g, '/');
  if (normalized.includes('/_npx/')) return 'npx';
  return normalized.includes('/node_modules/') ? 'npm' : 'git';
}

const DSH_PACKAGE_NAMES = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-root']);

function pushRoot(roots: string[], p: string | null | undefined): void {
  if (typeof p === 'string' && p.trim()) roots.push(p.trim());
}

function isDshPackage(pkg: { name?: string; version?: string } | null | undefined): pkg is { name: string; version: string } {
  return (
    !!pkg &&
    typeof pkg.name === 'string' &&
    DSH_PACKAGE_NAMES.has(pkg.name) &&
    typeof pkg.version === 'string' &&
    pkg.version.length > 0
  );
}

/** Map a resolved `dsh` executable path to the installed package root. */
export function dshRootFromExecutable(exe: string): string | null {
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

/** Locate the running DSH package; use installation discovery only without a recognized entry. */
export async function findDshRoot(ctx: Context): Promise<string | null> {
  const fsSvc = ctx.get('fs') as
    | {
        resolve(path: string): Promise<unknown>;
        readText(target: unknown): Promise<string>;
      }
    | undefined;
  if (!fsSvc) return null;

  const roots: string[] = [];

  const desktopEntry = process.argv.findIndex(arg => /[/\\]dsh-desktop-host[/\\]/.test(arg));
  if (desktopEntry >= 0 && process.argv[desktopEntry + 1]) {
    pushRoot(roots, join(process.argv[desktopEntry + 1]!, 'node_modules', '@deepseek-ai', 'dsh'));
  }

  for (const arg of process.argv) {
    const norm = String(arg).replace(/\\/g, '/');
    // Resolve the running CLI before unrelated workspace/PATH installations.
    if (norm.endsWith('/lib/bin.js') && norm.includes('/node_modules/@deepseek-ai/dsh/')) {
      pushRoot(roots, dshRootFromExecutable(norm));
    }
    for (const marker of HARNESS_CLI_MARKERS) {
      const i = norm.indexOf(marker);
      if (i > 0) pushRoot(roots, norm.slice(0, i));
    }
  }
  const runningRootCount = roots.length;

  const sp = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined;
  if (sp?.workspaceRoot) pushRoot(roots, sp.workspaceRoot);

  try {
    pushRoot(roots, process.cwd());
  } catch {
    /* ignore */
  }

  const sub = ctx.get('subprocess') as { resolveExecutable(cmd: string): Promise<string> } | undefined;
  if (sub) {
    try {
      const exe = (await sub.resolveExecutable('dsh')).replace(/\\/g, '/');
      const fromExe = dshRootFromExecutable(exe);
      if (fromExe) pushRoot(roots, fromExe);
    } catch {
      /* ignore */
    }
  }

  try {
    if (process.env.APPDATA) pushRoot(roots, join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
    pushRoot(roots, join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'));
    pushRoot(roots, join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  } catch {
    /* ignore */
  }

  const seen = new Set<string>();
  // An unreadable running package is unknown, never a different PATH install.
  for (const root of runningRootCount ? roots.slice(0, runningRootCount) : roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);

    const candidates = [root, join(root, 'apps', 'cli')];
    for (const candidate of candidates) {
      try {
        const target = await fsSvc.resolve(join(candidate, 'package.json'));
        const text = await fsSvc.readText(target);
        const pkg = JSON.parse(text) as { name?: string; version?: string };
        if (isDshPackage(pkg)) return candidate;
      } catch {
        /* try next */
      }
    }
  }

  return null;
}
