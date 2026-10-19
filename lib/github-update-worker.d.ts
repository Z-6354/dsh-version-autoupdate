import type { Context } from '@deepseek-ai/cordis';
import { type MirrorClient } from './mirror-client.js';
import { type ExtractTarGz } from './github-archive.js';
import { type UpdateOperationStore } from './update-operation.js';
export interface RestartPlan {
    exe: string;
    args: string[];
    cwd: string;
    port?: number;
    mode?: string;
}
export interface GithubUpdateWorkerHost {
    ctx: Context;
    store: UpdateOperationStore;
    targetVersion: string;
    targetTag?: string;
    transport: 'mirror' | 'official' | 'auto';
    /** When true, schedule restart into staging after build. When omitted, auto-restart if target ≠ current. */
    restart?: boolean;
    dshHome?: string;
    /** Explicit mirror password from credential resolution (preferred over disk re-read). */
    mirrorPassword?: string | null;
    /** Optional absolute path to pnpm (plugin config packageManagerPath). */
    pnpmPath?: string | null;
    extractTarGz?: ExtractTarGz;
    runBuild?: (checkoutRoot: string) => Promise<void>;
    resolvePlans?: (checkoutRoot: string) => {
        next: RestartPlan;
        rollback: RestartPlan;
    };
    /** Test seam: inject a MirrorClient instead of building one from context. */
    mirror?: MirrorClient;
    /** Heartbeat interval while waiting on network/build (ms). */
    heartbeatMs?: number;
}
/** Same-source GitHub update: download → validate → build in staging → restart → health rollback. */
export declare function runGithubUpdate(host: GithubUpdateWorkerHost): Promise<void>;
//# sourceMappingURL=github-update-worker.d.ts.map
export declare function scheduleGithubRollback(host: { store: UpdateOperationStore; previousOperation: NonNullable<ReturnType<UpdateOperationStore["snapshot"]>>; dshHome?: string; schedule?: (options: { jobPath: string; delayMs: number }) => { ok: boolean; message?: string } }): Promise<{ ok: boolean; message?: string }>;
