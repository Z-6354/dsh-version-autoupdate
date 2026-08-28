import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type UpdatePolicy } from './platform-policy.js';
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
export declare const name = "dsh-version-autoupdate";
export { versionCompare } from './semver.js';
/**
 * Services the host half depends on. Declaring `inject` tells DSH/Cordis to
 * activate this plugin only once these are ready and to expose them on the
 * context — most importantly `webServer`, without which the HTTP routes would
 * be registered too early (before the web server listens) and never serve.
 * `web` is deliberately NOT injected: this deployment has no fetch provider,
 * and the plugin falls back to a subprocess fetch when it is absent.
 */
export declare const inject: string[];
/** Package description shown by the DSH plugin inventory. */
export type Channel = 'stable' | 'preview';
export interface Config {
    /** Package manager used to update DSH. Defaults to npm from the running dsh Node install. */
    packageManager?: 'npm' | 'pnpm' | 'yarn' | 'auto';
    /**
     * Absolute path to the package manager executable (e.g. /home/ubuntu/.local/node-v22.19.0/bin/npm).
     * When set, overrides PATH discovery entirely.
     */
    packageManagerPath?: string;
    /** Block npm update when Linux MemAvailable is below this many MB. Set 0 to disable. */
    minAvailableMemoryMb?: number;
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
    /** Linux/macOS: auto-restart after install (default off; use step ③ button instead). */
    autoRestart?: boolean;
    /** Delay before process.exit during auto-restart (ms). */
    restartDelayMs?: number;
    /** Max wait for global install subprocess (ms). Default 20 min. */
    installTimeoutMs?: number;
    /** Kill install when no stdout/stderr for this long (ms). Default 0 = disabled (npm often silent while fetching). */
    installIdleTimeoutMs?: number;
    /** Grace period after SIGTERM before force-kill (ms). */
    installGraceMs?: number;
    /**
     * Low-memory VPS install strategy.
     *  - 'auto' (default): Linux with MemTotal <= offlineInstallMaxMemMb → stop DSH, npm in background, restart
     *  - 'always' | 'never'
     */
    offlineInstall?: 'auto' | 'always' | 'never';
    /** MemTotal threshold (MB) for auto offline install. Default 2560 (2G class VPS). */
    offlineInstallMaxMemMb?: number;
    /** systemd unit to stop/start around offline install (default dsh-web.service). */
    systemdUnit?: string;
    /**
     * Update capability policy.
     *  - 'platform' (default): Windows → install+restart; Linux/macOS → detect-only
     *  - 'full' | 'detect-only'
     */
    updatePolicy?: UpdatePolicy;
}
/** Schemastery schema consumed by Cordis/DSH plugin loaders. */
export declare const Config: z<Config>;
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
export type { UpdateState } from './update-types.js';
export { estimateInstallProgress } from './update-progress.js';
/** Registry-derived candidates. */
export interface VersionCandidates {
    /** Highest version with no pre-release suffix. */
    stableMax: string | null;
    /** Highest version overall (pre-releases included). */
    previewMax: string | null;
}
/**
 * Install the plugin.
 *
 * Host half: computes DSH version status and exposes a same-origin JSON API
 * via `ctx.webServer` so the browser half can query status and trigger a
 * package-manager update. The runtime side only touches verified DSH services
 * (`fs`, `subprocess`, `web`, `sandboxPolicy`, `timer`, `webServer`).
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map