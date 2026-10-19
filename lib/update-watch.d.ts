import { type UpdateOperationManifest, type UpdateOperationStore } from './update-operation.js';
/** Report at 1m, 5m, then every 10m from start (10m, 20m, …). */
export declare const PROGRESS_MILESTONE_MS: readonly [60000, number];
export declare const PROGRESS_EVERY_MS: number;
export declare function milestoneSchedule(upToMs: number): number[];
export declare function nextMilestoneMs(elapsedMs: number, lastReportedMilestoneMs: number): number;
export declare function progressFingerprint(operation: UpdateOperationManifest | null): string;
export interface WatchStatusSnapshot {
    ok: true;
    running: boolean;
    orphaned: boolean;
    done: boolean;
    summary: string;
    elapsedMs: number;
    milestoneMs: number | null;
    reason: 'started' | 'milestone' | 'terminal' | 'orphaned' | 'timeout' | 'idle';
    reportToUser: boolean;
    nextLastMilestoneMs: number;
    operation: UpdateOperationManifest | null;
}
export interface WatchUpdateOptions {
    store: UpdateOperationStore;
    dshHome?: string;
    /** Last milestone already reported to the user (ms since operation start). */
    lastMilestoneMs?: number;
    /** Max time to block waiting for the next report event. */
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
}
/** Block until the next chat-worthy progress event (milestone / terminal / timeout). */
export declare function watchUpdateProgress(options: WatchUpdateOptions): Promise<WatchStatusSnapshot>;
//# sourceMappingURL=update-watch.d.ts.map