export type MaintenanceState = {
    active: boolean;
    operationId?: string | null;
    phase?: string | null;
    updatedAt: string;
    message?: string | null;
};
export declare function writeMaintenance(home: string | undefined, state: {
    active: boolean;
    operationId?: string;
    phase?: string;
    message?: string;
}): Promise<MaintenanceState>;
export declare function readMaintenance(home?: string): Promise<MaintenanceState | null>;
export declare function clearMaintenance(home?: string): Promise<void>;
export declare function isMaintenanceHoldActive(state: MaintenanceState | null | undefined, now?: number, maxAgeMs?: number): boolean;
