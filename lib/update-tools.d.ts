import type { Context } from '@deepseek-ai/cordis';
import type { UpdateCapabilities } from './platform-policy.js';
import { UpdateOperationStore } from './update-operation.js';
/** Strip undefined so harness lossless-JSON snapshot succeeds. */
export declare function losslessJson<T>(value: T): T;
export interface UpdateToolsHost {
    ctx: Context;
    capabilities: UpdateCapabilities;
    store: UpdateOperationStore;
    dshHome?: string;
    runNpmInstall: (targetVersion: string, beforeVersion: string | null) => Promise<{
        afterVersion: string | null;
        tail: string;
    }>;
    runGithubUpdate: (input: {
        targetVersion: string;
        targetTag?: string;
        transport: 'mirror' | 'official' | 'auto';
        restart?: boolean;
        mirrorPassword?: string | null;
    }) => Promise<void>;
    runGithubRollback?: (operation: NonNullable<ReturnType<UpdateOperationStore["snapshot"]>>) => Promise<{ ok: boolean; message?: string }>;
    scheduleRestart: (override?: {
        operationId?: string;
        outcomeFile?: string;
        liveRoot?: string;
    }) => {
        ok: boolean;
        message: string;
        restartScheduled?: boolean;
    };
    invalidateInstalledCache: () => void;
}
export declare function registerUpdateTools(host: UpdateToolsHost): Array<() => void>;
//# sourceMappingURL=update-tools.d.ts.map