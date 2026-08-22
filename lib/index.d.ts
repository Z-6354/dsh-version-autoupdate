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
export declare const name = "dsh-version-autoupdate";
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
    /**
     * After a successful update, spawn a detached helper and exit so the web
     * process reloads the new build. Default true.
     */
    autoRestart?: boolean;
    /** Delay before process.exit so the UI can show “restarting…”. Default 2000. */
    restartDelayMs?: number;
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
export interface UpdateState {
    running: boolean;
    phase: 'idle' | 'detect' | 'installing' | 'done' | 'error';
    done: boolean;
    ok: boolean;
    message: string;
    tail: string;
    /** 0–100 estimated progress for the UI progress bar. */
    progress: number;
    /** Short human-readable step label. */
    progressLabel: string;
    /** Epoch ms when the current update started. */
    startedAt: number | null;
    system: {
        os: string;
        arch: string;
        node: string;
        installMethod: string;
    } | null;
    before: string | null;
    after: string | null;
    latest: string | null;
    /** True once a restart helper has been spawned. */
    restartScheduled?: boolean;
}
/** Registry-derived candidates. */
export interface VersionCandidates {
    /** Highest version with no pre-release suffix. */
    stableMax: string | null;
    /** Highest version overall (pre-releases included). */
    previewMax: string | null;
}
/** Minimal semver compare specialised for DSH versions (x.y.z and -rc.N). */
export declare function versionCompare(a: string, b: string): number;
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