const ui = {
    pollActive: false,
    panelOpen: false,
    waitingReconnect: false,
    restartWatch: false,
};
const listeners = new Set();
export function getClientUiState() {
    return ui;
}
export function patchClientUiState(patch) {
    let changed = false;
    for (const key of Object.keys(patch)) {
        if (patch[key] !== undefined && ui[key] !== patch[key]) {
            ui[key] = patch[key];
            changed = true;
        }
    }
    if (changed)
        for (const fn of listeners)
            fn();
}
export function subscribeClientUiState(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
//# sourceMappingURL=client-state.js.map