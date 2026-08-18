/**
 * DSH version-badge browser half (shipped `exports["./client"]`).
 *
 * Renders a small status badge in the conversation-session header toolbar and
 * calls the same-origin HTTP JSON API exposed by the host half.
 *
 * Verification note: this file follows DSH's shipped client-plugin layout
 * (`dsh.client` + `exports["./client"]`). Slot wiring mirrors the client-side
 * `slots` service; adjust to the DSH release you integrate against.
 */
import * as React from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

interface DshStatus {
  runningVersion: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  status: string;
  system?: { os: string; arch: string; node: string; installMethod: string } | null;
  update?: {
    phase: string;
    running: boolean;
    done: boolean;
    ok: boolean;
    message: string;
    tail: string;
  } | null;
}

async function request(pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as unknown;
}

function statusColor(status: string): string {
  switch (status) {
    case 'up-to-date':
      return '#22c55e';
    case 'update-available':
      return '#f59e0b';
    case 'update-done-restart':
      return '#3b82f6';
    case 'error':
      return '#ef4444';
    default:
      return '#9ca3af';
  }
}

function Badge(): React.ReactElement {
  const [st, setSt] = React.useState<DshStatus | null>(null);
  const [open, setOpen] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);

  const refresh = () => {
    request('/dsh-version-updater/status')
      .then((r) => setSt(r as DshStatus))
      .catch(() =>
        setSt({ runningVersion: null, installedVersion: null, latestVersion: null, status: 'error', update: null }),
      );
  };

  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60000);
    return () => {
      clearInterval(id);
    };
  }, []);

  const startUpdate = () => {
    if (updating || (st?.update && st.update.running)) return;
    setUpdating(true);
    request('/dsh-version-updater/start-update')
      .then(() => refresh())
      .catch(() => refresh())
      .finally(() => setUpdating(false));
  };

  const color = st?.update?.running ? '#3b82f6' : statusColor(st?.status ?? '');
  const ver = st?.installedVersion || st?.runningVersion || '?';
  let text = st ? `v${ver}` : '\u68c0\u67e5\u4e2d\u2026';
  if (st) {
    if (st.update?.running) text = '\u66f4\u65b0\u4e2d\u2026';
    else if (st.status === 'up-to-date') text = `v${ver} \u6700\u65b0`;
    else if (st.status === 'update-available') text = `v${ver} \u2192 v${st.latestVersion || '?'} \u53ef\u66f4\u65b0`;
    else if (st.status === 'update-done-restart') text = `\u5df2\u66f4\u65b0 v${ver} \u00b7 \u91cd\u542f\u751f\u6548`;
    else if (st.status === 'error') text = '\u7248\u672c\u68c0\u67e5\u5931\u8d25';
    else text = `v${ver} \u00b7 \u7248\u672c\u672a\u77e5`;
  }

  const badgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '6px 12px',
    borderRadius: '9999px',
    background: 'rgba(24,24,27,0.72)',
    border: `1px solid ${color}88`,
    color: '#fafafa',
    fontSize: '12px',
    fontFamily: MONO,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
  };

  const panelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: '0',
    width: '320px',
    maxWidth: 'calc(100vw - 24px)',
    background: 'rgba(24,24,27,0.94)',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '12px',
    padding: '12px 14px',
    color: '#e4e4e7',
    fontSize: '13px',
    boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
    zIndex: 9999,
  };

  const rows = [
    ['\u7cfb\u7edf', st?.system ? `${st.system.os} ${st.system.arch}` : '\u2014'],
    ['\u5b89\u88c5\u65b9\u5f0f', st?.system?.installMethod ?? '\u2014'],
    ['\u5f53\u524d\u8fd0\u884c', st?.runningVersion ?? '\u2014'],
    ['\u5df2\u5b89\u88c5', st?.installedVersion ?? '\u2014'],
    ['\u6700\u65b0\u7248\u672c', st?.latestVersion ?? '\u2014'],
  ];

  let action: React.ReactElement | null = null;
  if (st?.update?.running) {
    action = React.createElement(
      'div',
      { style: { color: '#3b82f6', fontSize: '12px', paddingTop: '4px' } },
      st.update.phase + '\u2026',
    );
  } else if (st?.status === 'update-available') {
    action = React.createElement(
      'button',
      {
        onClick: startUpdate,
        style: {
          marginTop: '10px',
          padding: '7px 14px',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: '#f59e0b',
          color: '#1c1917',
          fontWeight: 600,
        },
      },
      '\u26a1 \u7acb\u5373\u66f4\u65b0',
    );
  } else if (st?.status === 'up-to-date') {
    action = React.createElement('div', { style: { marginTop: '10px', color: '#22c55e', fontSize: '12px' } }, '\u5df2\u662f\u6700\u65b0\u7248\u672c \u2713');
  } else if (st?.status === 'update-done-restart') {
    action = React.createElement('div', { style: { marginTop: '10px', color: '#3b82f6', fontSize: '12px' } }, '\u8bf7\u91cd\u542f dsh web \u670d\u52a1\u751f\u6548');
  } else if (st?.status === 'error') {
    action = React.createElement('div', { style: { marginTop: '10px', color: '#ef4444', fontSize: '12px' } }, st.update?.message ?? '\u68c0\u67e5\u5931\u8d25');
  } else if (st?.status === 'unknown') {
    action = React.createElement('div', { style: { marginTop: '10px', color: '#9ca3af', fontSize: '12px' } }, '\u65e0\u6cd5\u83b7\u53d6\u6700\u65b0\u7248\u672c');
  }

  const panel = open
    ? React.createElement(
        'div',
        null,
        React.createElement('div', { onClick: () => setOpen(false), style: { position: 'fixed', inset: '0', zIndex: 9998 } }),
        React.createElement(
          'div',
          { style: panelStyle },
          React.createElement('div', { style: { fontWeight: 600, fontSize: '14px', marginBottom: '8px' } }, 'DSH \u7248\u672c'),
          rows.map((r) =>
            React.createElement(
              'div',
              { key: r[0], style: { display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '3px 0' } },
              React.createElement('span', { style: { color: '#a1a1aa' } }, r[0]),
              React.createElement('span', { style: { fontFamily: MONO, color: '#fafafa' } }, r[1]),
            ),
          ),
          action,
        ),
      )
    : null;

  return React.createElement(
    'div',
    { style: { position: 'relative', display: 'inline-flex' } },
    React.createElement(
      'div',
      { style: badgeStyle, onClick: () => setOpen(!open) },
      React.createElement('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: color, display: 'inline-block' } }),
      React.createElement('span', null, text),
    ),
    panel,
  );
}

/**
 * Lightweight slot registry duck-typed from the client `slots` service so the
 * source compiles standalone. Reconcile with the target DSH release's typing.
 */
interface ClientSlotLike {
  inject(key: string, cb: () => unknown): unknown;
  register(opts: { name: string; id?: string; key?: string; order?: number }, render: (props: Record<string, unknown>) => unknown): unknown;
}

/**
 * Browser plugin entry. Registers the version badge as a conversation header
 * utility slot entry (a fresh id joins existing utilities rather than
 * replacing them).
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots') as ClientSlotLike | undefined;
  if (!slots) return;
  slots.inject('conversation.session.header.utilities', () =>
    slots.register(
      { name: 'conversation.session.header.utilities', id: 'dsh-version-autoupdate', order: 20 },
      () => React.createElement(Badge, null),
    ),
  );
}
