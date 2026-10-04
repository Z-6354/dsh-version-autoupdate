import * as React from 'react';
import {
  MONO,
  PANEL_GAP,
  PANEL_W,
  SCROLLBAR_CSS,
  VIEW_MARGIN,
  Z_INDEX,
} from './constants';
import { btnStyle, Row } from './components';
import { useCapsulePos } from './hooks';
import { usePanelState } from './panel-state';
import { readCollapsed, readDismissedKey, writeDismissedKey, clearDismissedKey } from './storage';
import {
  capsuleText,
  capsuleTitle,
  channelLabel,
  installMethodLabel,
  platformLabel,
  policyLabel,
  shortenPath,
  shouldAutoExpand,
  statusColor,
} from './status';
import { useVersionStatus } from './version-status';
import type { PanelLayout } from './types';

function PanelBody(props: {
  st: ReturnType<typeof useVersionStatus>['st'];
  upd: ReturnType<typeof useVersionStatus>['upd'];
  phase: string;
  running: boolean;
  waitingReconnect: boolean;
  busy: boolean;
  canInstall: boolean;
  canRestart: boolean;
  installDone: boolean;
  isGit: boolean;
  onInstall: () => void;
  onRestart: () => void;
  restartScheduled: boolean;
}): React.ReactElement {
  const { st, upd, phase, running, waitingReconnect, busy, canInstall, canRestart, installDone, isGit } = props;
  const diskVer = st?.installedVersion;
  const runVer = st?.runningVersion;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement('div', { style: { fontWeight: 600, fontSize: '10px', color: '#a1a1aa', marginBottom: '4px' } }, 'DSH'),
    React.createElement(Row, { label: '运行', value: st?.runningVersion ? `v${st.runningVersion}` : '—' }),
    diskVer && diskVer !== runVer ? React.createElement(Row, { label: '已装', value: `v${diskVer}` }) : null,
    React.createElement(Row, { label: '最新', value: st?.latestVersion ? `v${st.latestVersion}` : '—' }),
    st?.previewLatest && st.channel === 'preview' && st.previewLatest !== st.latestVersion
      ? React.createElement(Row, { label: '预览', value: `v${st.previewLatest}` })
      : null,
    st?.stableLatest ? React.createElement(Row, { label: '稳定', value: `v${st.stableLatest}` }) : null,
    !canInstall && st?.capabilities?.detectOnlyReason
      ? React.createElement('div', { style: { marginTop: '6px', color: '#fbbf24', fontSize: '10px', lineHeight: '14px' } }, st.capabilities.detectOnlyReason)
      : null,
    running || waitingReconnect
      ? React.createElement('div', { style: { marginTop: '6px', color: '#93c5fd', fontSize: '10px' } }, upd?.message || (waitingReconnect ? '重启中…' : ''))
      : null,
    phase === 'error'
      ? React.createElement('div', { style: { marginTop: '6px' } },
        upd?.message
          ? React.createElement('div', { style: { color: '#ef4444', fontSize: '10px', lineHeight: '14px' } }, upd.message)
          : null,
        upd?.tail
          ? React.createElement('pre', {
            style: {
              marginTop: '4px',
              padding: '6px 8px',
              borderRadius: '6px',
              background: 'rgba(239,68,68,0.08)',
              color: '#fca5a5',
              fontSize: '9px',
              lineHeight: '13px',
              fontFamily: MONO,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: '120px',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            },
          }, upd.tail)
          : null,
      )
      : null,
    canInstall && st?.status === 'update-available' && !installDone && !running
      ? isGit
        ? React.createElement('div', { style: { marginTop: '6px', color: '#fbbf24', fontSize: '10px', lineHeight: '14px' } },
          'git 源码安装：请手动 git pull，完成后点确认重启')
        : React.createElement('button', { onClick: props.onInstall, disabled: busy, style: btnStyle('#f59e0b', busy) }, '安装更新')
      : null,
    canRestart && installDone && !running
      ? React.createElement('button', {
        onClick: props.onRestart,
        disabled: busy || props.restartScheduled,
        style: btnStyle('#3b82f6', busy),
      }, '确认重启')
      : null,
    React.createElement('div', { style: { marginTop: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.08)' } },
      React.createElement(Row, { label: '模组', value: st?.moduleVersion ? `v${st.moduleVersion}` : '—' }),
      React.createElement(Row, {
        label: '平台',
        value: st?.system
          ? `${platformLabel(st.platform, st.system.os)} ${st.system.arch}`
          : platformLabel(st?.platform),
      }),
      React.createElement(Row, { label: '导入方式', value: installMethodLabel(st?.system?.installMethod) }),
      React.createElement(Row, { label: 'Node', value: st?.system?.node || '—' }),
      st?.system?.packageManager
        ? React.createElement(Row, {
          label: '包管理器',
          value: shortenPath(st.system.packageManager),
          title: st.system.packageManager,
        })
        : null,
      React.createElement(Row, { label: '通道', value: channelLabel(st?.channel) }),
      React.createElement(Row, { label: '策略', value: policyLabel(st) }),
    ),
  );
}

function DetailPanel(props: {
  color: string;
  layout: PanelLayout;
  onClose: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const { color, layout, onClose, children } = props;
  return React.createElement(
    'div',
    {
      className: 'dsh-vau-panel',
      style: {
        position: 'absolute',
        right: 0,
        width: PANEL_W,
        maxWidth: `calc(100vw - ${VIEW_MARGIN * 2}px)`,
        maxHeight: layout.panelMaxH,
        ...(layout.openUp
          ? { bottom: `calc(100% + ${PANEL_GAP}px)` }
          : { top: `calc(100% + ${PANEL_GAP}px)` }),
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(24,24,27,0.94)',
        border: `1px solid ${color}55`,
        borderRadius: '8px',
        color: '#e4e4e7',
        fontSize: '11px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        boxSizing: 'border-box',
        overflow: 'hidden',
      },
    },
    React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 8px 4px',
          flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        },
      },
      React.createElement('span', { style: { fontWeight: 600, fontSize: '10px', color: '#a1a1aa' } }, '版本更新'),
      React.createElement('button', {
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); onClose(); },
        style: {
          border: 'none',
          background: 'transparent',
          color: '#a1a1aa',
          cursor: 'pointer',
          fontSize: '14px',
          lineHeight: 1,
          padding: '2px 4px',
          borderRadius: '4px',
        },
      }, '×'),
    ),
    React.createElement(
      'div',
      {
        className: 'dsh-vau-panel-body',
        style: {
          padding: '8px 10px',
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          scrollbarGutter: 'stable',
          flex: '1 1 auto',
          minHeight: 0,
        },
      },
      children,
    ),
  );
}

function Capsule(props: {
  color: string;
  capText: string;
  capTitle: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel?: (e: React.PointerEvent) => void;
  onLostPointerCapture?: (e: React.PointerEvent) => void;
  onToggle: () => void;
}): React.ReactElement {
  return React.createElement(
    'div',
    {
      role: 'button',
      tabIndex: 0,
      title: props.capTitle,
      onPointerDown: props.onPointerDown,
      onPointerMove: props.onPointerMove,
      onPointerUp: props.onPointerUp,
      onPointerCancel: props.onPointerCancel,
      onLostPointerCapture: props.onLostPointerCapture,
      onClick: props.onToggle,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onToggle();
        }
      },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 12px',
        borderRadius: '9999px',
        background: 'rgba(24,24,27,0.88)',
        border: `1px solid ${props.color}99`,
        color: '#fafafa',
        fontSize: '12px',
        fontFamily: MONO,
        cursor: 'grab',
        boxShadow: `0 2px 10px rgba(0,0,0,0.3), inset 0 0 0 1px ${props.color}33`,
        touchAction: 'none',
        maxWidth: '180px',
        lineHeight: '16px',
      },
    },
    React.createElement('span', {
      style: { width: '8px', height: '8px', borderRadius: '50%', background: props.color, flexShrink: 0, boxShadow: `0 0 6px ${props.color}` },
    }),
    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.capText),
  );
}

export function Widget(): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const panel = usePanelState(!readCollapsed());
  const version = useVersionStatus(panel.userDismissed);
  const {
    pos, layout, onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
    onLostPointerCapture, wasDragged, resetDrag,
  } = useCapsulePos(panel.expanded);

  // Auto-expand only for a *new* warrant key. Persisted dismiss key survives restart
  // so the same update-available does not reopen the panel every boot.
  const { expandPanel, setUserDismissed, collapsePanel, userDismissed, setWarrantKey } = panel;
  React.useEffect(() => {
    const result = version.lastRefresh;
    if (!result) return;
    const key = result.resetKey || '';
    setWarrantKey(key);

    const persisted = readDismissedKey();
    const isNewKey = Boolean(key && key !== version.dismissKeyRef.current);

    const force = result.waiting || !!result.next.update?.running
      || result.next.update?.restartScheduled
      || result.next.update?.phase === 'restarting';

    if (isNewKey) {
      version.dismissKeyRef.current = key;
      // Same key user already dismissed before restart → stay collapsed (unless force).
      if (key && key === persisted && !force) {
        setUserDismissed(true);
        return;
      }
      if (force || shouldAutoExpand(result.next, result.waiting, false)) {
        clearDismissedKey();
        setUserDismissed(false);
        expandPanel();
      }
      return;
    }

    // Same key: critical phases still surface even after dismiss.
    if (force) {
      clearDismissedKey();
      setUserDismissed(false);
      expandPanel();
      return;
    }

    if (userDismissed || (key && key === persisted)) return;
    if (result.shouldExpand) expandPanel();
  }, [version.lastRefresh, userDismissed, expandPanel, setUserDismissed, setWarrantKey, version.dismissKeyRef]);

  React.useEffect(() => {
    if (!panel.expanded) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) collapsePanel(true);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [panel.expanded, collapsePanel]);

  const color = statusColor(version.st?.status ?? '', version.running, version.waitingReconnect, version.st?.moduleUpdateAvailable);
  const canInstall = !!version.st?.capabilities?.canInstall;
  const canRestart = !!version.st?.capabilities?.canRestart;
  const diskVer = version.st?.installedVersion;
  const runVer = version.st?.runningVersion;
  const isGit = version.st?.system?.installMethod === 'git';
  const installDone = version.phase === 'install-done' || version.phase === 'restarting' || version.phase === 'done' ||
    (version.st?.status === 'update-done-restart' && !!diskVer && !!runVer && diskVer !== runVer);

  const rootStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos.left,
    top: pos.top,
    zIndex: Z_INDEX,
    pointerEvents: 'auto',
    userSelect: 'none',
  };

  return React.createElement(
    'div',
    { ref: rootRef, style: rootStyle },
    React.createElement('style', null, SCROLLBAR_CSS),
    React.createElement(Capsule, {
      color,
      capText: capsuleText(version.st, version.running, version.waitingReconnect),
      capTitle: capsuleTitle(version.st, version.running, version.waitingReconnect),
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onToggle: () => panel.toggleExpanded(wasDragged(), resetDrag),
    }),
    panel.expanded
      ? React.createElement(DetailPanel, {
        color,
        layout,
        onClose: () => panel.collapsePanel(true),
      }, React.createElement(PanelBody, {
        st: version.st,
        upd: version.upd,
        phase: version.phase,
        running: version.running,
        waitingReconnect: version.waitingReconnect,
        busy: version.busy,
        canInstall,
        canRestart,
        installDone,
        isGit,
        restartScheduled: !!version.upd?.restartScheduled,
        onInstall: () => version.postStep('/dsh-version-updater/install', panel.expandPanel),
        onRestart: () => {
          if (!window.confirm('确认重启 DSH web？')) return;
          panel.expandPanel();
          version.postStep('/dsh-version-updater/restart', panel.expandPanel, true);
        },
      }))
      : null,
  );
}
