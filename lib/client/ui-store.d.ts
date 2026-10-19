export interface ClientUiState {
    pollActive: boolean;
    panelOpen: boolean;
    waitingReconnect: boolean;
    restartWatch: boolean;
}
export declare function getClientUiState(): ClientUiState;
export declare function patchClientUiState(patch: Partial<ClientUiState>): void;
export declare function subscribeClientUiState(fn: () => void): () => void;
//# sourceMappingURL=ui-store.d.ts.map