import type { DshStatus } from './types';
export interface RefreshResult {
    next: DshStatus;
    waiting: boolean;
    shouldExpand: boolean;
    resetKey: string;
}
export declare function useVersionStatus(userDismissed: boolean): {
    st: any;
    busy: any;
    upd: any;
    phase: any;
    running: boolean;
    waitingReconnect: any;
    needsFastPoll: any;
    refresh: any;
    postStep: any;
    lastRefresh: any;
    dismissKeyRef: any;
};
//# sourceMappingURL=version-status.d.ts.map