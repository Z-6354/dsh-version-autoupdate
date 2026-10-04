import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { semverParts, versionCompare } from './semver.js';

/** Minimum Node for DSH global installs (matches harness engine floor). */
export const MIN_NODE_FOR_DSH = '22.19.0';
export const NODE_RANGE_FOR_DSH = '^22.19.0 || >=24.0.0';

const DSH_PKG_SUFFIX = '/lib/node_modules/@deepseek-ai/dsh';

function packageManagerName(pmExe: string): string {
  return pmExe.replace(/\\/g, '/').split('/').pop()?.replace(/\.(cmd|exe)$/i, '') ?? pmExe;
}

/** Read-only command locating the global package directory used by this manager. */
export function globalRootArgv(pmExe: string): string[] {
  return packageManagerName(pmExe) === 'yarn'
    ? [pmExe, 'global', 'dir']
    : [pmExe, 'root', '-g'];
}

export function globalDshRoot(pmExe: string, output: string): string | null {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const root = lines.at(-1)?.trim();
  if (!root || !/^(?:[a-z]:[/\\]|[/\\]{1,2})/i.test(root)) return null;
  const base = packageManagerName(pmExe) === 'yarn' ? join(root, 'node_modules') : root;
  return join(base, '@deepseek-ai', 'dsh');
}

/** Compare real paths so symlinked installs work and unrelated globals cannot be upgraded. */
export function isSameInstallation(runningRoot: string, targetRoot: string): boolean {
  try {
    const normalize = (p: string) => {
      const path = realpathSync(p).replace(/\\/g, '/');
      return process.platform === 'win32' ? path.toLowerCase() : path;
    };
    return normalize(runningRoot) === normalize(targetRoot);
  } catch { return false; }
}

/** Derive the Node install prefix from a global @deepseek-ai/dsh package root. */
export function nodePrefixFromDshRoot(root: string): string | null {
  if (!root.endsWith(DSH_PKG_SUFFIX)) return null;
  return root.slice(0, -DSH_PKG_SUFFIX.length);
}

export interface PackageManagerSearchOpts {
  dshRoot: string | null;
  pm: string;
  nodeBinDir: string;
  platform: string;
}

/** Ordered executable paths to try before falling back to PATH lookup. */
export function packageManagerSearchPaths(opts: PackageManagerSearchOpts): string[] {
  const paths: string[] = [];
  const win = opts.platform === 'win32';
  const ext = win ? '.cmd' : '';

  paths.push(join(opts.nodeBinDir, opts.pm + ext));
  if (win) paths.push(join(opts.nodeBinDir, opts.pm + '.exe'));

  if (opts.dshRoot) {
    const prefix = nodePrefixFromDshRoot(opts.dshRoot);
    if (prefix) paths.push(join(prefix, 'bin', opts.pm + ext));
  }

  return paths;
}

/** Build subprocess env so package managers prefer the Node that runs DSH. */
export function buildInstallEnv(nodeBinDir = dirname(process.execPath)): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const existing = process.env[pathKey] ?? '';
  return {
    ...process.env,
    [pathKey]: existing ? `${nodeBinDir}${sep}${existing}` : nodeBinDir,
  };
}

export function runningNodeSatisfiesDsh(version = process.version): { ok: true; version: string } | { ok: false; version: string; message: string } {
  const normalized = version.replace(/^v/i, '');
  const parsed = semverParts(normalized);
  if (!parsed || parsed.pre.length > 0 || !(parsed.nums[0]! >= 24 ||
    (parsed.nums[0] === 22 && versionCompare(normalized, MIN_NODE_FOR_DSH) >= 0))) {
    return {
      ok: false,
      version,
      message: `当前运行 Node ${version} 不满足 DSH 要求 (${NODE_RANGE_FOR_DSH})，请先切换到正确 Node 后再更新。`,
    };
  }
  return { ok: true, version };
}

/** argv for `npm|pnpm|yarn install -g @deepseek-ai/dsh@<version>`. */
export function buildGlobalInstallArgv(pmExe: string, version: string): string[] {
  const spec = '@deepseek-ai/dsh@' + version;
  const name = packageManagerName(pmExe);
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
export function lowMemoryInstallWarning(availableMb: number | null, thresholdMb = 400): string | null {
  if (availableMb === null) return null;
  if (availableMb >= thresholdMb) return null;
  return (
    `可用内存仅约 ${availableMb} MB，npm 全局安装可能被 OOM 终止并损坏 dsh。` +
    ' 建议先加 swap 或释放内存后再更新。'
  );
}
