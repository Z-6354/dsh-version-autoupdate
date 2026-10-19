/** Shared operation-view helpers for Host JSON + client capsule (keep isomorphic). */
export interface OperationProgressView {
    message?: string;
    percent?: number | null;
}
export interface OperationView {
    id?: string;
    phase?: string;
    progress?: OperationProgressView | null;
}
export interface StatusWithOperation {
    operationRunning?: boolean;
    operationOrphaned?: boolean;
    updateAvailable?: boolean;
    status?: string;
    error?: string | null;
    operation?: OperationView | null;
}
export declare function isOperationActive(st: StatusWithOperation | null | undefined): boolean;
export declare function operationPercent(st: StatusWithOperation | null | undefined): number | null;
//# sourceMappingURL=operation-view.d.ts.map