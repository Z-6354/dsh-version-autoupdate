export function shouldAutoExpand(st, waiting, userDismissed) {
    if (!st || userDismissed)
        return false;
    if (waiting || st.update?.running)
        return true;
    if (st.update?.restartScheduled
        || st.update?.phase === 'restarting'
        || st.update?.phase === 'promoting')
        return true;
    if (st.status === 'update-available' || st.status === 'update-done-restart' || st.status === 'updating')
        return true;
    if (st.moduleUpdateAvailable)
        return true;
    return false;
}
export function autoExpandResetKey(st, waiting) {
    if (!st)
        return '';
    if (waiting)
        return 'waiting';
    if (st.update?.running)
        return `run:${st.update?.phase ?? 'run'}`;
    if (st.update?.restartScheduled
        || st.update?.phase === 'restarting'
        || st.update?.phase === 'promoting')
        return 'restart';
    if (st.status === 'updating')
        return `updating:${st.update?.phase ?? ''}`;
    if (st.status === 'update-available')
        return `avail:${st.latestVersion ?? ''}`;
    if (st.status === 'update-done-restart')
        return `done:${st.installedVersion ?? ''}`;
    if (st.moduleUpdateAvailable)
        return `mod:${st.moduleLatestVersion ?? ''}`;
    return '';
}
export function statusColor(status, running, waiting, moduleUpdate) {
    if (waiting || running)
        return '#3b82f6';
    if (moduleUpdate)
        return '#a855f7';
    switch (status) {
        case 'up-to-date': return '#22c55e';
        case 'update-available': return '#f59e0b';
        case 'update-done-restart': return '#8b5cf6';
        case 'error': return '#ef4444';
        default: return '#9ca3af';
    }
}
export function capsuleText(st, running, waiting) {
    if (!st)
        return '…';
    if (waiting)
        return '重启中';
    if (running)
        return `${st.update?.progress ?? 0}%`;
    const v = st.runningVersion || '?';
    if (st.status === 'update-available')
        return `v${v} ↑`;
    return `v${v}`;
}
export function capsuleTitle(st, running, waiting) {
    if (!st)
        return '正在检测版本';
    const run = st.runningVersion || '?';
    const latest = st.latestVersion || '?';
    if (waiting)
        return '正在重启 DSH';
    if (running)
        return `DSH 更新中 ${st.update?.progress ?? 0}%`;
    if (st.status === 'up-to-date')
        return `DSH v${run} 已是最新`;
    if (st.status === 'update-available')
        return `DSH v${run} → v${latest} 可更新`;
    if (st.moduleUpdateAvailable)
        return `模组有新版本 v${st.moduleLatestVersion}`;
    return `DSH v${run}`;
}
export function platformLabel(platform, os) {
    const p = (platform || os || '').toLowerCase();
    if (p === 'win32')
        return 'Windows';
    if (p === 'linux')
        return 'Linux';
    if (p === 'darwin')
        return 'macOS';
    return platform || os || '—';
}
export function installMethodLabel(method) {
    if (!method)
        return '—';
    if (method === 'npm')
        return 'npm 全局包';
    if (method === 'git')
        return 'git 源码';
    if (method === 'unknown')
        return '未知';
    return method;
}
export function channelLabel(ch) {
    if (ch === 'stable')
        return '稳定版';
    if (ch === 'preview')
        return '预览版';
    return ch || '—';
}
export function shortenPath(p, max = 34) {
    if (p.length <= max)
        return p;
    return '…' + p.slice(-(max - 1));
}
export function policyLabel(st) {
    if (!st?.capabilities)
        return '—';
    if (st.capabilities.canInstall && st.capabilities.canRestart)
        return '完整更新';
    if (st.capabilities.canInstall)
        return '可安装';
    return '仅检测';
}
//# sourceMappingURL=status.js.map