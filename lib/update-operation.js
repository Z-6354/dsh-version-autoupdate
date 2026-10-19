import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeJsonFileAtomic } from './atomic-json-write.js';
const ACTIVE_PHASES = new Set(['checking', 'downloading', 'installing', 'promoting', 'restarting']);
/** Phases owned by detached promote-and-boot / restart helper after host exit. */
const DETACHED_HELPER_PHASES = new Set(['promoting', 'restarting']);
export const DETACHED_HELPER_STALE_MS = {
    promoting: 45 * 60 * 1000,
    restarting: 30 * 60 * 1000,
};
export function isActiveOperationPhase(phase) {
    return ACTIVE_PHASES.has(phase);
}
export function isDetachedHelperPhase(phase) {
    return DETACHED_HELPER_PHASES.has(phase);
}
/**
 * Fresh promoting/restarting is helper-owned, not "orphaned by process death".
 * Only becomes orphaned after the same stale window clearOrphanedIfNeeded uses.
 */
export function isDetachedHelperActive(operation, options) {
    if (!operation || operation.finishedAt || !isDetachedHelperPhase(operation.phase))
        return false;
    const staleMs = options?.staleMs
        ?? DETACHED_HELPER_STALE_MS[operation.phase]
        ?? DETACHED_HELPER_STALE_MS.restarting;
    const updated = Date.parse(operation.updatedAt || '');
    const now = options?.nowMs ?? Date.now();
    if (!Number.isFinite(updated))
        return true;
    return (now - updated) < staleMs;
}
/** True when an update is still in flight (in-process worker OR detached helper). */
export function isOperationInFlight(operation, running, options) {
    if (!operation || operation.finishedAt || !isActiveOperationPhase(operation.phase))
        return false;
    if (running)
        return true;
    return isDetachedHelperActive(operation, options);
}
/** Mid-flight op with no worker and no fresh detached helper. */
export function isOperationOrphaned(operation, running, options) {
    if (!operation || operation.finishedAt || running)
        return false;
    if (!isActiveOperationPhase(operation.phase))
        return false;
    if (isDetachedHelperActive(operation, options))
        return false;
    return true;
}
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '0 B';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function formatDownloadProgress(bytesDownloaded, bytesTotal, channel) {
    const total = bytesTotal != null && Number.isFinite(bytesTotal) && bytesTotal > 0 ? bytesTotal : null;
    const percent = total ? Math.min(100, Math.round((bytesDownloaded / total) * 1000) / 10) : null;
    const via = channel === 'mirror' ? 'via mirror' : channel === 'official' ? 'via official' : '';
    const prefix = via ? `Downloading ${via} ` : 'Downloading ';
    const message = total
        ? `${prefix}${formatBytes(bytesDownloaded)} / ${formatBytes(total)} (${percent}%)`
        : `${prefix}${formatBytes(bytesDownloaded)} (size unknown)`;
    return { message, bytesDownloaded, bytesTotal: total, percent };
}
export function summarizeOperation(operation, running) {
    if (!operation)
        return 'No update operation recorded.';
    if (isOperationOrphaned(operation, running)) {
        return `Previous update was interrupted while ${operation.phase} (process restart). Start a new dsh_update.`;
    }
    if (isDetachedHelperActive(operation) && !running) {
        const msg = operation.progress?.message;
        return msg
            ? `${operation.phase} (helper): ${msg}`
            : `${operation.phase} (detached helper in progress)`;
    }
    if (operation.progress?.message) {
        return `${operation.phase}: ${operation.progress.message}`;
    }
    if (operation.phase === 'failed' && operation.error)
        return `failed: ${operation.error}`;
    if (operation.phase === 'succeeded')
        return 'succeeded';
    return `${operation.phase}${running ? ' (running)' : ''}`;
}
function resolveOperationHome(explicit, env = process.env) {
    return resolve(explicit?.trim() || env.DSH_HOME?.trim() || join(homedir(), '.dsh'));
}
function operationPath(home) {
    return join(resolve(home), 'version-autoupdate', 'operation.json');
}
/** Tracks one active same-source update operation for MCP tools. */
export class UpdateOperationStore {
    manifest = null;
    running = false;
    lastProgressPersistAt = 0;
    home;
    progressPersistMinMs;
    /** Serialize disk writes so concurrent progress/status patches cannot race rename. */
    persistQueue = Promise.resolve();
    constructor(home = resolveOperationHome(), options) {
        this.home = home;
        this.progressPersistMinMs = options?.progressPersistMinMs ?? 500;
    }
    snapshot() {
        if (!this.manifest)
            return null;
        return {
            ...this.manifest,
            progress: this.manifest.progress ? { ...this.manifest.progress } : this.manifest.progress,
        };
    }
    isRunning() {
        return this.running;
    }
    async load() {
        // Never clobber an in-flight in-memory op with a staler disk snapshot
        // (status/watch polls race throttled progress writes).
        if (this.running)
            return;
        try {
            const parsed = JSON.parse(await readFile(operationPath(this.home), 'utf8'));
            if (parsed && typeof parsed.id === 'string')
                this.manifest = parsed;
        }
        catch {
            /* absent file is normal */
        }
    }
    async persist() {
        const run = async () => {
            if (!this.manifest)
                return;
            const dir = join(resolve(this.home), 'version-autoupdate');
            await mkdir(dir, { recursive: true });
            await writeJsonFileAtomic(operationPath(this.home), this.manifest);
        };
        const next = this.persistQueue.then(run, run);
        this.persistQueue = next.then(() => undefined, () => undefined);
        return next;
    }
    begin(input) {
        if (this.running)
            throw new Error('update operation already running');
        const now = new Date().toISOString();
        this.running = true;
        this.lastProgressPersistAt = 0;
        this.manifest = {
            id: randomUUID(),
            source: input.source,
            transport: input.transport,
            phase: 'checking',
            currentVersion: input.currentVersion,
            targetVersion: input.targetVersion,
            backupVersion: input.currentVersion,
            progress: { message: 'Starting update…' },
            startedAt: now,
            updatedAt: now,
            finishedAt: null,
            error: null,
            tail: '',
        };
        return { ...this.manifest };
    }
    /** begin() then durable write. On persist failure, clear busy so callers are not stuck. */
    async beginPersisted(input) {
        const started = this.begin(input);
        try {
            await this.persist();
            return started;
        }
        catch (error) {
            this.running = false;
            this.manifest = {
                ...started,
                phase: 'failed',
                error: error instanceof Error ? error.message : String(error),
                progress: { message: 'Update failed: could not persist operation state' },
                finishedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            throw error;
        }
    }
    /**
     * After process restart, mid-flight ops stay on disk without `running`.
     * Mark them failed so a new dsh_update can start and the capsule is not stuck.
     *
     * `restarting` is special: the detached helper writes restart-outcome.json after
     * the new process boots. Callers must run applyRestartOutcome() FIRST. This method
     * only clears `restarting` when it is stale (no outcome for a long time).
     */
    async clearOrphanedIfNeeded(reason = 'previous update was interrupted (process restart)', options) {
        if (this.running)
            return null;
        await this.load();
        const operation = this.manifest;
        if (!operation || operation.finishedAt || !isActiveOperationPhase(operation.phase))
            return null;
        if (operation.phase === 'restarting' || operation.phase === 'promoting') {
            const staleMs = options?.restartingStaleMs
                ?? DETACHED_HELPER_STALE_MS[operation.phase]
                ?? DETACHED_HELPER_STALE_MS.restarting;
            const updated = Date.parse(operation.updatedAt);
            const now = options?.nowMs ?? Date.now();
            if (!Number.isFinite(updated) || now - updated < staleMs)
                return null;
            return this.finish('failed', `${reason} (${operation.phase} timed out waiting for helper)`);
        }
        return this.finish('failed', reason);
    }
    async patch(partial) {
        if (!this.manifest)
            throw new Error('no active update operation');
        this.manifest = {
            ...this.manifest,
            ...partial,
            updatedAt: new Date().toISOString(),
        };
        await this.persist();
        return { ...this.manifest };
    }
    /** Persist live progress for MCP polls. Throttled so download chunks do not thrash disk. */
    async reportProgress(progress, options) {
        if (!this.manifest)
            return;
        this.manifest.progress = { ...progress };
        this.manifest.updatedAt = new Date().toISOString();
        const now = Date.now();
        if (options?.force || now - this.lastProgressPersistAt >= this.progressPersistMinMs) {
            this.lastProgressPersistAt = now;
            try {
                await this.persist();
            }
            catch {
                // Progress is best-effort: a Windows lock must not abort the download/build.
            }
        }
    }
    appendTail(text) {
        if (!this.manifest || !text)
            return;
        this.manifest.tail = (this.manifest.tail + text).slice(-6000);
        this.manifest.updatedAt = new Date().toISOString();
    }
    async finish(phase, error = null) {
        if (!this.manifest)
            throw new Error('no active update operation');
        this.running = false;
        const message = phase === 'succeeded'
            ? 'Update succeeded'
            : phase === 'failed'
                ? (error ? `Update failed: ${error}` : 'Update failed')
                : phase === 'rolled_back'
                    ? 'Update rolled back'
                    : phase;
        return this.patch({
            phase,
            error,
            progress: { message },
            finishedAt: new Date().toISOString(),
        });
    }
}
//# sourceMappingURL=update-operation.js.map