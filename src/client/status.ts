import type { DshStatus } from './types';

export function shouldAutoExpand(st: DshStatus | null, waiting: boolean, userDismissed: boolean): boolean {
  if (!st || userDismissed) return false;
  if (waiting || st.update?.running) return true;
  if (st.update?.restartScheduled || st.update?.phase === 'restarting') return true;
  if (st.status === 'update-available' || st.status === 'update-done-restart') return true;
  if (st.moduleUpdateAvailable) return true;
  return false;
}

export function autoExpandResetKey(st: DshStatus | null, waiting: boolean): string {
  if (!st) return '';
  if (waiting) return 'waiting';
  if (st.update?.running) return `run:${st.update?.phase ?? 'run'}`;
  if (st.update?.restartScheduled || st.update?.phase === 'restarting') return 'restart';
  if (st.status === 'update-available') return `avail:${st.latestVersion ?? ''}`;
  if (st.status === 'update-done-restart') return `done:${st.installedVersion ?? ''}`;
  if (st.moduleUpdateAvailable) return `mod:${st.moduleLatestVersion ?? ''}`;
  return '';
}

export function statusColor(status: string, running: boolean, waiting: boolean, moduleUpdate?: boolean): string {
  if (waiting || running) return '#3b82f6';
  if (moduleUpdate) return '#a855f7';
  switch (status) {
    case 'up-to-date': return '#22c55e';
    case 'update-available': return '#f59e0b';
    case 'update-done-restart': return '#8b5cf6';
    case 'error': return '#ef4444';
    default: return '#9ca3af';
  }
}

export function capsuleText(st: DshStatus | null, running: boolean, waiting: boolean): string {
  if (!st) return '…';
  if (waiting) return '重启中';
  if (running) return `${st.update?.progress ?? 0}%`;
  const v = st.runningVersion || '?';
  if (st.status === 'update-available') return `v${v} ↑`;
  return `v${v}`;
}

export function capsuleTitle(st: DshStatus | null, running: boolean, waiting: boolean): string {
  if (!st) return '正在检测版本';
  const run = st.runningVersion || '?';
  const latest = st.latestVersion || '?';
  if (waiting) return '正在重启 DSH';
  if (running) return `DSH 更新中 ${st.update?.progress ?? 0}%`;
  if (st.status === 'up-to-date') return `DSH v${run} 已是最新`;
  if (st.status === 'update-available') return `DSH v${run} → v${latest} 可更新`;
  if (st.moduleUpdateAvailable) return `模组有新版本 v${st.moduleLatestVersion}`;
  return `DSH v${run}`;
}

export function platformLabel(platform?: string, os?: string): string {
  const p = (platform || os || '').toLowerCase();
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  if (p === 'darwin') return 'macOS';
  return platform || os || '—';
}

export function installMethodLabel(method?: string): string {
  if (!method) return '—';
  if (method === 'npm') return 'npm 全局包';
  if (method === 'git') return 'git 源码';
  if (method === 'unknown') return '未知';
  return method;
}

export function channelLabel(ch?: string): string {
  if (ch === 'stable') return '稳定版';
  if (ch === 'preview') return '预览版';
  return ch || '—';
}

export function shortenPath(p: string, max = 34): string {
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

export function policyLabel(st: DshStatus | null): string {
  if (!st?.capabilities) return '—';
  if (st.capabilities.canInstall && st.capabilities.canRestart) return '完整更新';
  if (st.capabilities.canInstall) return '可安装';
  return '仅检测';
}
