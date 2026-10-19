const clientUi = {
    pollActive: false,
    panelOpen: false,
    waitingReconnect: false,
    restartWatch: false,
};
const uiListeners = new Set();
export function getClientUiState() {
    return clientUi;
}
export function patchClientUiState(patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
        if (patch[k] !== undefined && clientUi[k] !== patch[k]) {
            clientUi[k] = patch[k];
            changed = true;
        }
    }
    if (changed)
        for (const fn of uiListeners)
            fn();
}
export function subscribeClientUiState(fn) {
    uiListeners.add(fn);
    return () => uiListeners.delete(fn);
}
//# sourceMappingURL=ui-store.js.map