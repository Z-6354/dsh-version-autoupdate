import type { Context } from '@deepseek-ai/cordis';
import { dirname, join } from 'node:path';

const KNOWN_DEPLOYMENT_ROOTS = [
  '/home/ubuntu/.local/node-v22.19.0/lib/node_modules/@deepseek-ai/dsh',
];

const HARNESS_CLI_MARKERS = ['/apps/cli/src/bin.ts', '/apps/cli/lib/bin.js', '/apps/cli/src/bin.js'];

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

/** Locate the installed DSH package root (global npm, harness checkout, or known deploy paths). */
export async function findDshRoot(ctx: Context): Promise<string | null> {
  const fsSvc = ctx.get('fs') as
    | {
        resolve(path: string): Promise<unknown>;
        readText(target: unknown): Promise<string>;
      }
    | undefined;
  if (!fsSvc) return null;

  const roots: string[] = [];

  for (const arg of process.argv) {
    const norm = String(arg).replace(/\\/g, '/');
    for (const marker of HARNESS_CLI_MARKERS) {
      const i = norm.indexOf(marker);
      if (i > 0) pushRoot(roots, norm.slice(0, i));
    }
  }

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
    pushRoot(roots, join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
    pushRoot(roots, join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'));
    pushRoot(roots, join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  } catch {
    /* ignore */
  }

  for (const root of KNOWN_DEPLOYMENT_ROOTS) pushRoot(roots, root);

  const seen = new Set<string>();
  for (const root of roots) {
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
