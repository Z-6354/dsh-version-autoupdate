import type { InstallationSource } from './source-detection.js';
export type OperationPhase = 'idle' | 'checking' | 'downloading' | 'installing' | 'promoting' | 'restarting' | 'succeeded' | 'failed' | 'rolled_back';
export interface UpdateProgress {
    /** Short human/agent-facing status line (e.g. "Downloading 12.3 / 48.0 MiB (26%)"). */
    message: string;
    bytesDownloaded?: number;
    bytesTotal?: number | null;
    percent?: number | null;
}
export interface UpdateOperationManifest {
    id: string;
    source: InstallationSource | 'unknown';
    transport: 'mirror' | 'official' | 'auto' | 'unknown';
    phase: OperationPhase;
    currentVersion: string | null;
    targetVersion: string | null;
    backupVersion: string | null;
    targetTag?: string | null;
    liveRoot?: string | null;
    stagingPath?: string | null;
    backupPath?: string | null;
    promotedRoot?: string | null;
    /** Live progress for MCP polling (download bytes, build steps, etc.). */
    progress?: UpdateProgress | null;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    error: string | null;
    tail: string;
}
export declare function isActiveOperationPhase(phase: OperationPhase): boolean;
export declare function isDetachedHelperPhase(phase: OperationPhase | string | null | undefined): boolean;
export declare function isDetachedHelperActive(operation: UpdateOperationManifest | null | undefined, options?: {
    nowMs?: number;
    staleMs?: number;
}): boolean;
export declare function isOperationInFlight(operation: UpdateOperationManifest | null | undefined, running: boolean, options?: {
    nowMs?: number;
    staleMs?: number;
}): boolean;
export declare function isOperationOrphaned(operation: UpdateOperationManifest | null | undefined, running: boolean, options?: {
    nowMs?: number;
    staleMs?: number;
}): boolean;
export declare const DETACHED_HELPER_STALE_MS: {
    readonly promoting: number;
    readonly restarting: number;
};
export declare function formatBytes(bytes: number): string;
export declare function formatDownloadProgress(bytesDownloaded: number, bytesTotal: number | null | undefined, channel?: 'mirror' | 'official' | string | null): UpdateProgress;
export declare function summarizeOperation(operation: UpdateOperationManifest | null, running: boolean): string;
/** Tracks one active same-source update operation for MCP tools. */
export declare class UpdateOperationStore {
    private manifest;
    private running;
    private lastProgressPersistAt;
    private readonly home;
    private readonly progressPersistMinMs;
    /** Serialize disk writes so concurrent progress/status patches cannot race rename. */
    private persistQueue;
    constructor(home?: string, options?: {
        progressPersistMinMs?: number;
    });
    snapshot(): UpdateOperationManifest | null;
    isRunning(): boolean;
    load(): Promise<void>;
    persist(): Promise<void>;
    begin(input: Pick<UpdateOperationManifest, 'source' | 'transport' | 'currentVersion' | 'targetVersion'>): UpdateOperationManifest;
    /** begin() then durable write. On persist failure, clear busy so callers are not stuck. */
    beginPersisted(input: Pick<UpdateOperationManifest, 'source' | 'transport' | 'currentVersion' | 'targetVersion'>): Promise<UpdateOperationManifest>;
    /**
     * After process restart, mid-flight ops stay on disk without `running`.
     * Mark them failed so a new dsh_update can start and the capsule is not stuck.
     *
     * `restarting` is special: the detached helper writes restart-outcome.json after
     * the new process boots. Callers must run applyRestartOutcome() FIRST. This method
     * only clears `restarting` when it is stale (no outcome for a long time).
     */
    clearOrphanedIfNeeded(reason?: string, options?: {
        restartingStaleMs?: number;
        nowMs?: number;
    }): Promise<UpdateOperationManifest | null>;
    patch(partial: Partial<UpdateOperationManifest>): Promise<UpdateOperationManifest>;
    /** Persist live progress for MCP polls. Throttled so download chunks do not thrash disk. */
    reportProgress(progress: UpdateProgress, options?: {
        force?: boolean;
    }): Promise<void>;
    appendTail(text: string): void;
    finish(phase: Exclude<OperationPhase, 'idle'>, error?: string | null): Promise<UpdateOperationManifest>;
}
//# sourceMappingURL=update-operation.d.ts.map