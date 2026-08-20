import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

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

/**
 * Services the host half depends on. Declaring `inject` tells DSH/Cordis to
 * activate this plugin only once these are ready and to expose them on the
 * context — most importantly `webServer`, without which the HTTP routes would
 * be registered too early (before the web server listens) and never serve.
 * `web` is deliberately NOT injected: this deployment has no fetch provider,
 * and the plugin falls back to a subprocess fetch when it is absent.
 */
export const inject = ['webServer', 'subprocess', 'fs', 'sandboxPolicy', 'timer'];

/** Package description shown by the DSH plugin inventory. */
export type Channel = 'stable' | 'preview';

export interface Config {
  /** Package manager used to update DSH. Defaults to discovering npm/pnpm/yarn. */
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'auto';
  /** Regenerate everything from the registry on status even after a cache hit. */
  force?: boolean;
  /**
   * Which version the updater targets.
   *  - 'preview' (default): the highest published version, including
   *    pre-release builds (e.g. 0.1.0-rc.8, a future 0.6.0-rc.N).
   *  - 'stable': only the highest version without a pre-release suffix.
   * Coverage starts at DSH 0.1.0-rc.6 and up; the target is always the
   * semantic maximum published to the registry, never the `latest` dist-tag
   * (which historically lags the true highest version).
   */
  channel?: Channel;
  /**
   * Extra hostnames allowed to POST to the update endpoint (CSRF allow-list),
   * for installations reached through a reverse proxy whose Host header is
   * rewritten to loopback. Loopback and the request's own Host are always
   * allowed. Only the bare hostname is compared.
   */
  trustedOrigins?: string[];
}

/** Schemastery schema consumed by Cordis/DSH plugin loaders. */
export const Config: z<Config> = z.object({
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
});

const KNOWN_DEPLOYMENT_ROOTS = [
  '/home/ubuntu/.local/node-v22.19.0/lib/node_modules/@deepseek-ai/dsh',
];

export interface DshVersionInfo {
  runningVersion: string | null;
  installedVersion: string | null;
  /** Highest published version included by the active channel (update target). */
  latestVersion: string | null;
  /** Highest published stable version (no pre-release suffix). */
  stableLatest: string | null;
  /** Highest published version including pre-releases. */
  previewLatest: string | null;
  /** The active channel. */
  channel: Channel;
  /** Why we picked the target, for the UI. */
  note?: string;
  status: 'up-to-date' | 'update-available' | 'update-done-restart' | 'unknown';
}

export interface UpdateState {
  running: boolean;
  phase: 'idle' | 'detect' | 'installing' | 'done' | 'error';
  done: boolean;
  ok: boolean;
  message: string;
  tail: string;
  system: { os: string; arch: string; node: string; installMethod: string } | null;
  before: string | null;
  after: string | null;
  latest: string | null;
}

/** Registry-derived candidates. */
export interface VersionCandidates {
  /** Highest version with no pre-release suffix. */
  stableMax: string | null;
  /** Highest version overall (pre-releases included). */
  previewMax: string | null;
}

const NODE_INFO_SCRIPT =
  'console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }));';

const NODE_FETCH_SCRIPT = [
  '(async () => {',
  "  const r = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh', { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/vnd.npm.install-v1+json' } });",
  '  console.log(JSON.stringify({ status: r.status, body: await r.text() }));',
  '})().catch((e) => { console.log(JSON.stringify({ status: 0, body: String((e && e.message) || e) })); });',
].join('\n');

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Extract a bare hostname (no scheme/port/path) from a URL or Host header value. */
function hostnameOf(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    // Origin/Referer are absolute URLs; Host is a bare authority.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'http://' + v;
    const host = new URL(withScheme).hostname;
    return host.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function semverParts(s: string): { nums: number[]; pre: string[] } | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^v/i, '');
  const dash = t.indexOf('-');
  const main = dash >= 0 ? t.slice(0, dash) : t;
  const pre = dash >= 0 ? t.slice(dash + 1).split('.') : [];
  const nums = main.split('.').map((x) => parseInt(x, 10));
  if (nums.length === 0 || nums.some((x) => Number.isNaN(x))) return null;
  return { nums, pre };
}

/** Minimal semver compare specialised for DSH versions (x.y.z and -rc.N). */
export function versionCompare(a: string, b: string): number {
  const x = semverParts(a);
  const y = semverParts(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  const n = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < n; i++) {
    const xv = x.nums[i] || 0;
    const yv = y.nums[i] || 0;
    if (xv !== yv) return xv < yv ? -1 : 1;
  }
  if (x.pre.length && !y.pre.length) return -1;
  if (!x.pre.length && y.pre.length) return 1;
  const m = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < m; i++) {
    const xp = x.pre[i] || '';
    const yp = y.pre[i] || '';
    if (xp !== yp) return xp < yp ? -1 : 1;
  }
  return 0;
}

function isNewer(installed: string, latest: string): boolean {
  return versionCompare(installed, latest) < 0;
}

interface CollectHandle {
  pid: number;
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  collected?: { stdout?: { readFrom(o: number): { text: string; nextOffset: number } } };
  terminate(): void;
}

/** Pick the highest version from a list, optionally filtering pre-releases (those carrying a `-` suffix). */
function maxVersion(versions: string[], includePrerelease: boolean): string | null {
  let best: string | null = null;
  for (const v of versions) {
    const parts = semverParts(v);
    if (!parts) continue;
    if (!includePrerelease && parts.pre.length > 0) continue;
    if (best === null || versionCompare(v, best) > 0) best = v;
  }
  return best;
}

/** Reduce a registry version-manifest to the stable and preview maxima. */
function candidatesFromVersions(versions: string[]): VersionCandidates {
  const stableMax = maxVersion(versions, false);
  const previewMax = maxVersion(versions, true);
  return { stableMax, previewMax };
}

/** Wrap a fetch to npm registry. Prefers the host web service, falls back to a node subprocess. */
async function fetchVersionCandidates(ctx: Context): Promise<VersionCandidates | null> {
  const body = await fetchRegistryBody(ctx);
  if (!body) return null;
  try {
    const pkg = JSON.parse(body) as { versions?: Record<string, unknown> };
    if (!pkg || typeof pkg.versions !== 'object' || pkg.versions === null) return null;
    return candidatesFromVersions(Object.keys(pkg.versions));
  } catch {
    return null;
  }
}

/** Fetch the raw @deepseek-ai/dsh registry manifest, via web service then node subprocess. */
async function fetchRegistryBody(ctx: Context): Promise<string | null> {
  // 1. Prefer the web service if present.
  const webSvc = ctx.get('web') as
    | { fetch(req: { url: string }): Promise<{ statusCode: number; body: { kind: string; content: string } }> }
    | undefined;
  if (webSvc) {
    try {
      const res = await webSvc.fetch({ url: 'https://registry.npmjs.org/@deepseek-ai/dsh' });
      if (res && res.statusCode === 200 && typeof res.body?.content === 'string') {
        return res.body.content;
      }
    } catch {
      /* fall through */
    }
  }

  // 2. Fallback: node subprocess performing the same fetch.
  const sub = ctx.get('subprocess') as
    | {
        resolveExecutable(cmd: string): Promise<string>;
        spawn(spec: {
          argv: string[];
          cwd: string;
          stdio: {
            stdin: string;
            stdout: { maxBytes: number };
            stderr: { maxBytes: number };
          };
          graceMs: number;
        }): CollectHandle;
      }
    | undefined;
  if (!sub) return null;
  let nodeExe = 'node';
  try {
    nodeExe = await sub.resolveExecutable('node');
  } catch {
    /* keep default */
  }
  const sp = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined;
  const cwd = sp?.workspaceRoot || '/tmp';
  let handle: CollectHandle | undefined;
  try {
    handle = sub.spawn({
      argv: [nodeExe, '-e', NODE_FETCH_SCRIPT],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } },
      graceMs: 25000,
    });
  } catch {
    return null;
  }
  const timer = ctx.get('timer') as { timeout(fn: () => void, ms: number): () => void } | undefined;
  let clearTimer: (() => void) | undefined;
  if (timer) clearTimer = timer.timeout(() => handle?.terminate(), 25000);
  try {
    const outcome = await handle.done;
    const text = handle.collected?.stdout?.readFrom(0).text ?? '';
    if (outcome.exitCode !== 0) return null;
    const line = text.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
    const data = JSON.parse(line) as { status?: number; body?: string };
    if (data.status === 200 && typeof data.body === 'string') return data.body;
  } catch {
    return null;
  } finally {
    if (clearTimer) clearTimer();
  }
  return null;
}

/** Locate the installed DSH package root and read its installed package version. */
async function findDshRoot(ctx: Context): Promise<string | null> {
  const fsSvc = ctx.get('fs') as
    | {
        resolve(path: string): Promise<unknown>;
        readText(target: unknown): Promise<string>;
      }
    | undefined;
  if (!fsSvc) return null;
  const roots: string[] = [];
  const sub = ctx.get('subprocess') as { resolveExecutable(cmd: string): Promise<string> } | undefined;
  if (sub) {
    try {
      const exe = await sub.resolveExecutable('dsh');
      if (exe.endsWith('/bin/dsh')) {
        roots.push(exe.slice(0, -'/bin/dsh'.length) + '/lib/node_modules/@deepseek-ai/dsh');
      } else if (exe.endsWith('/lib/bin.js')) {
        roots.push(exe.slice(0, -'/lib/bin.js'.length));
      }
    } catch {
      /* ignore */
    }
  }
  roots.push(...KNOWN_DEPLOYMENT_ROOTS);
  for (const root of roots) {
    if (!root) continue;
    try {
      const target = await fsSvc.resolve(root + '/package.json');
      const text = await fsSvc.readText(target);
      const pkg = JSON.parse(text) as { name?: string; version?: string };
      if (pkg?.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string' && pkg.version) {
        return root;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function readInstalledVersion(ctx: Context): Promise<string | null> {
  const fsSvc = ctx.get('fs') as
    | { resolve(path: string): Promise<unknown>; readText(target: unknown): Promise<string> }
    | undefined;
  if (!fsSvc) return null;
  const root = await findDshRoot(ctx);
  if (!root) return null;
  try {
    const target = await fsSvc.resolve(root + '/package.json');
    const text = await fsSvc.readText(target);
    const pkg = JSON.parse(text) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function computeStatus(
  running: string | null,
  installed: string | null,
  latest: string | null,
): DshVersionInfo['status'] {
  if (!latest || !installed) return 'unknown';
  if (isNewer(installed, latest)) return 'update-available';
  if (running && isNewer(running, installed)) return 'update-done-restart';
  return 'up-to-date';
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as unknown) : {});
      } catch (e) {
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
export function apply(ctx: Context, config: Config = {}): void {
  const cfg = config || {};

  // Caches.
  let versionCache: { t: number; v: VersionCandidates | null } = { t: 0, v: null };
  let installedCache: { t: number; v: string | null } = { t: 0, v: null };
  const runningPromise: Promise<string | null> = readInstalledVersion(ctx).catch(() => null);

  const channel: Channel = cfg.channel === 'stable' ? 'stable' : 'preview';

  // Update state machine.
  const updateState: UpdateState = {
    running: false,
    phase: 'idle',
    done: false,
    ok: false,
    message: '',
    tail: '',
    system: null,
    before: null,
    after: null,
    latest: null,
  };

  const getCandidates = async (force = false): Promise<VersionCandidates | null> => {
    const now = Date.now();
    if (!force && versionCache.v !== null && now - versionCache.t < 120000) return versionCache.v;
    const v = await fetchVersionCandidates(ctx);
    versionCache = { t: now, v };
    return v;
  };

  /** Resolve the update target for the active channel, falling back across channels. */
  const resolveTarget = (cands: VersionCandidates | null): { version: string | null; note: string } => {
    if (!cands) return { version: null, note: '' };
    const pick = channel === 'stable' ? cands.stableMax : cands.previewMax;
    if (pick) return { version: pick, note: channel === 'stable' ? 'stable' : 'preview' };
    // Chosen channel has nothing (e.g. stable with only pre-releases) → fall back.
    const fb = channel === 'stable' ? cands.previewMax : cands.stableMax;
    return fb ? { version: fb, note: (channel === 'stable' ? 'preview' : 'stable') + '\uff08\u56de\u9000\uff09' } : { version: null, note: '' };
  };

  const getInstalled = async (): Promise<string | null> => {
    const now = Date.now();
    if (installedCache.v !== null && now - installedCache.t < 10000) return installedCache.v;
    const v = await readInstalledVersion(ctx);
    installedCache = { t: now, v };
    return v;
  };

  async function detectSystem(): Promise<NonNullable<UpdateState['system']>> {
    const sys = { os: 'unknown', arch: 'unknown', node: '', installMethod: 'unknown' };
    const sub = ctx.get('subprocess') as
      | { resolveExecutable(cmd: string): Promise<string>; spawn(spec: unknown): CollectHandle }
      | undefined;
    if (sub) {
      try {
        const nodeExe = await sub.resolveExecutable('node').catch(() => 'node');
        const sp = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined;
        const cwd = sp?.workspaceRoot || '/tmp';
        const handle = sub.spawn({
          argv: [nodeExe, '-e', NODE_INFO_SCRIPT],
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } },
          graceMs: 10000,
        } as never);
        const outcome = await handle.done;
        if (outcome.exitCode === 0) {
          const text = handle.collected?.stdout?.readFrom(0).text ?? '';
          const d = JSON.parse(text.trim()) as { platform?: string; arch?: string; node?: string };
          if (d.platform) sys.os = d.platform;
          if (d.arch) sys.arch = d.arch;
          if (d.node) sys.node = d.node;
        }
      } catch {
        /* keep defaults */
      }
    }
    const root = await findDshRoot(ctx);
    if (root) sys.installMethod = root.includes('/node_modules/') ? 'npm' : 'git';
    return sys;
  }

  async function resolvePackageManager(): Promise<string | null> {
    const sub = ctx.get('subprocess') as { resolveExecutable(cmd: string): Promise<string> } | undefined;
    if (!sub) return null;
    const wanted = cfg.packageManager === 'auto' ? ['npm', 'pnpm', 'yarn'] : [cfg.packageManager!];
    for (const name of wanted) {
      try {
        return await sub.resolveExecutable(name);
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async function runInstall(pmExe: string, version: string): Promise<void> {
    const sub = ctx.get('subprocess') as { spawn(spec: Record<string, unknown>): CollectHandle } | undefined;
    if (!sub) throw new Error('subprocess service unavailable');
    const sp = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined;
    const cwd = sp?.workspaceRoot || '/tmp';
    const handle = sub.spawn({
      argv: [pmExe, 'install', '-g', '@deepseek-ai/dsh@' + version, '--no-audit', '--no-fund', '--loglevel=info'],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } },
      graceMs: 20000,
    });

    const timer = ctx.get('timer') as
      | { interval(fn: () => void, ms: number): () => void; timeout(fn: () => void, ms: number): () => void }
      | undefined;
    let offsetOut = 0;
    let offsetErr = 0;
    const appendTail = (text: string) => {
      if (!text) return;
      updateState.tail = (updateState.tail + text).slice(-1200);
    };
    const poll = () => {
      try {
        const ro = handle.collected?.stdout?.readFrom(offsetOut);
        if (ro && ro.text) {
          offsetOut = ro.nextOffset;
          appendTail(ro.text);
        }
        const re = handle.collected?.stdout?.readFrom(offsetErr);
        if (re && re.text) {
          offsetErr = re.nextOffset;
          appendTail(re.text);
        }
      } catch {
        /* ignore read races */
      }
    };

    let clearPoll: (() => void) | undefined;
    let clearTimeout: (() => void) | undefined;
    let timedOut = false;
    if (timer) {
      clearPoll = timer.interval(poll, 250);
      clearTimeout = timer.timeout(() => {
        timedOut = true;
        try {
          handle.terminate();
        } catch {
          /* ignore */
        }
      }, 180000);
    }
    try {
      const outcome = await handle.done;
      if (timedOut) throw new Error('\u66f4\u65b0\u8d85\u65f6\uff08180 \u79d2\uff09\uff0c\u5df2\u7ec8\u6b62');
      poll();
      if (outcome.exitCode !== 0) {
        const tail = updateState.tail.split('\n').filter(Boolean).slice(-4).join('\n').slice(0, 500);
        throw new Error('\u5b89\u88c5\u547d\u4ee4\u9000\u51fa\u7801 ' + outcome.exitCode + (tail ? '\uff1a' + tail : ''));
      }
    } finally {
      if (clearPoll) clearPoll();
      if (clearTimeout) clearTimeout();
    }
  }

  async function runUpdate(): Promise<void> {
    try {
      updateState.phase = 'detect';
      const system = await detectSystem();
      updateState.system = system;
      const before = await getInstalled();
      updateState.before = before;
      const cands = await getCandidates(true);
      const { version: latest, note } = resolveTarget(cands);
      updateState.latest = latest;
      if (!latest) {
        updateState.phase = 'error';
        updateState.ok = false;
        updateState.done = true;
        updateState.running = false;
        updateState.message = '\u65e0\u6cd5\u83b7\u53d6\u6700\u65b0\u7248\u672c\uff08\u7f51\u7edc\u6216\u89e3\u6790\u5931\u8d25\uff09\uff0c\u672a\u6267\u884c\u66f4\u65b0';
        return;
      }
      if (before && !isNewer(before, latest)) {
        updateState.phase = 'done';
        updateState.ok = true;
        updateState.after = before;
        updateState.message = '\u5df2\u7ecf\u662f\u6700\u65b0\u7248\u672c v' + before + '\uff0c\u65e0\u9700\u66f4\u65b0';
        return;
      }
      const pm = await resolvePackageManager();
      if (!pm) {
        updateState.phase = 'error';
        updateState.ok = false;
        updateState.done = true;
        updateState.running = false;
        updateState.message = '\u672a\u627e\u5230 npm/pnpm/yarn \u5305\u7ba1\u7406\u5668\uff0c\u65e0\u6cd5\u81ea\u52a8\u66f4\u65b0';
        return;
      }
      if (system.installMethod === 'git') {
        updateState.phase = 'error';
        updateState.ok = false;
        updateState.done = true;
        updateState.running = false;
        updateState.message = '\u68c0\u6d4b\u4e3a git \u6e90\u7801\u5b89\u88c5\uff0c\u8bf7\u624b\u52a8\u6267\u884c git pull \u66f4\u65b0';
        return;
      }
      updateState.phase = 'installing';
      updateState.tail = '';
      await runInstall(pm, latest);
      installedCache = { t: 0, v: null };
      const after = await getInstalled();
      updateState.after = after;
      updateState.phase = 'done';
      updateState.ok = true;
      updateState.message = after
        ? '\u66f4\u65b0\u5b8c\u6210\uff1a' + (before ? 'v' + before + ' \u2192 ' : '') + 'v' + after + '\u3002\u8bf7\u91cd\u542f dsh web \u670d\u52a1\u540e\u751f\u6548\u3002'
        : '\u66f4\u65b0\u547d\u4ee4\u6267\u884c\u6210\u529f\uff0c\u8bf7\u91cd\u542f dsh \u670d\u52a1\u540e\u786e\u8ba4\u7248\u672c\u3002';
    } catch (e) {
      updateState.phase = 'error';
      updateState.ok = false;
      updateState.message = errMsg(e);
      updateState.done = true;
      updateState.running = false;
    }
  }

  async function statusPayload(force = false): Promise<DshVersionInfo & { update: UpdateState; system: UpdateState['system'] }> {
    let running: string | null = null;
    let installed: string | null = null;
    let cands: VersionCandidates | null = null;
    try {
      running = await runningPromise;
      installed = await getInstalled();
      cands = await getCandidates(force);
    } catch {
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
      system: updateState.system,
      update: { ...updateState },
    };
  }

  const webServer = ctx.get('webServer') as
    | {
        register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void;
      }
    | undefined;

  const registerRoutes = () => {
    if (!webServer) return;
    const trustedOrigins: string[] = Array.isArray(cfg.trustedOrigins)
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
    const isSameOrigin = (req: IncomingMessage): boolean => {
      const origin = req.headers.origin ?? req.headers.referer;
      if (!origin) return true;
      const host = req.headers.host;
      const originHost = hostnameOf(origin);
      if (originHost === null) return false;
      const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(originHost);
      if (loopback) return true;
      if (host) {
        const hostName = hostnameOf(host);
        if (hostName !== null && hostName === originHost) return true;
      }
      if (trustedOrigins.includes(originHost)) return true;
      return false;
    };

    const rejectForbidden = (req: IncomingMessage, res: ServerResponse) => {
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
        } catch (e) {
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
        } catch {
          /* ignore body parse */
        }
        const payload: { ok: boolean; busy: boolean; message?: string } | undefined = await (async () => {
          if (updateState.running)
            return { ok: false, busy: true, message: '\u66f4\u65b0\u6b63\u5728\u8fdb\u884c\u4e2d\uff0c\u8bf7\u7a0d\u5019' };
          updateState.running = true;
          updateState.done = false;
          updateState.ok = false;
          updateState.phase = 'detect';
          updateState.tail = '';
          updateState.message = '';
          updateState.before = null;
          updateState.after = null;
          updateState.latest = null;
          updateState.system = null;
          const run = runUpdate();
          run
            .catch((e) => {
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
  };

  // Register the same-origin JSON API immediately; routes become active once
  // the web server listens.
  registerRoutes();
}
