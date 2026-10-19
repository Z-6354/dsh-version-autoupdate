import type { UpdateOperationStore } from './update-operation.js';
export interface RestartOutcome {
    ok: boolean;
    phase: 'succeeded' | 'failed' | 'rolled_back';
    rolledBack?: boolean;
    operationId?: string;
    error?: string;
    at?: string;
}
/** Finalize a restarting operation once the detached restart helper writes its outcome. */
export declare function applyRestartOutcome(store: UpdateOperationStore, home?: string): Promise<RestartOutcome | null>;
//# sourceMappingURL=restart-outcome.d.ts.map