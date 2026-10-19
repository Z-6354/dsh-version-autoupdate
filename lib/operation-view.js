/** Shared operation-view helpers for Host JSON + client capsule (keep isomorphic). */
export function isOperationActive(st) {
    if (!st)
        return false;
    // Interrupted ops after process restart are not "in progress".
    if (st.operationOrphaned)
        return false;
    if (st.operationRunning)
        return true;
    if (st.status === 'updating')
        return true;
    const phase = st.operation?.phase;
    return phase === 'checking'
        || phase === 'downloading'
        || phase === 'installing'
        || phase === 'promoting'
        || phase === 'restarting';
}
export function operationPercent(st) {
    const percent = st?.operation?.progress?.percent;
    if (typeof percent === 'number' && Number.isFinite(percent))
        return Math.max(0, Math.min(100, percent));
    if (!isOperationActive(st))
        return null;
    const phase = st?.operation?.phase;
    if (phase === 'checking')
        return 5;
    if (phase === 'downloading')
        return null;
    if (phase === 'installing')
        return 70;
    if (phase === 'promoting')
        return 96;
    if (phase === 'restarting')
        return 95;
    return null;
}
//# sourceMappingURL=operation-view.js.map