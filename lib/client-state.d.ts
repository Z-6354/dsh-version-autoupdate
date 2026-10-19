/** Process-wide client UI state (survives session switches / component remount). */
export interface ClientUiState {
    pollActive: boolean;
    panelOpen: boolean;
    waitingReconnect: boolean;
    restartWatch: boolean;
}
export declare function getClientUiState(): Readonly<ClientUiState>;
export declare function patchClientUiState(patch: Partial<ClientUiState>): void;
export declare function subscribeClientUiState(fn: () => void): () => void;
//# sourceMappingURL=client-state.d.ts.map