import type { InstallationSource } from './source-detection.js';
export type UpdateTransport = 'mirror' | 'official' | 'unknown';
export interface UpdateCheckResult {
    source: InstallationSource;
    transport: UpdateTransport;
    currentVersion: string | null;
    latestVersion: string | null;
    available: boolean;
    error: string | null;
}
export interface UpdateServiceOptions {
    source: InstallationSource;
    currentVersion: string | null;
    queryLatest: (source: Exclude<InstallationSource, 'unknown'>) => Promise<{
        version: string;
        transport: UpdateTransport;
    }>;
    ensurePassword?: () => Promise<string | null>;
    /** Identifies and queries the active source without accepting caller-supplied evidence. */
    detectSource?: () => Promise<InstallationSource>;
}
/** Provides source-restricted, read-only version checks; credential callbacks are intentionally unused. */
export declare function createUpdateService(options: UpdateServiceOptions): {
    checkUpdate(): Promise<UpdateCheckResult>;
};
//# sourceMappingURL=update-service.d.ts.map