import type { Context } from '@deepseek-ai/cordis';
import { type InstallationSource } from './source-detection.js';
import { type UpdateTransport } from './update-service.js';
export interface SourceAwareStatus {
    source: InstallationSource;
    transport: UpdateTransport;
    currentVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    error: string | null;
    checkedAt: string | null;
}
/** Source-restricted read-only version check for Host /status and /check. */
export declare function runSourceAwareCheck(ctx: Context): Promise<SourceAwareStatus & {
    runningVersion: string | null;
}>;
//# sourceMappingURL=source-aware-check.d.ts.map