/**
 * DSH version-autoupdate — browser client (progress-aware).
 */
window.__ModuleLoader__.load({
  id: 'dsh-version-autoupdate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    async function request(pathname, body) {
      const res = await fetch(pathname, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return await res.json()
    }

    function statusColor(status) {
      switch (status) {
        case 'up-to-date': return '#22c55e'
        case 'update-available': return '#f59e0b'
        case 'update-done-restart': return '#3b82f6'
        case 'error': return '#ef4444'
        default: return '#9ca3af'
      }
    }

    function phaseLabel(phase) {
      switch (phase) {
        case 'detect': return '检测中'
        case 'installing': return '安装中'
        case 'diverged': return '需处理分叉'
        case 'done': return '完成'
        case 'error': return '失败'
        default: return phase || '准备'
      }
    }

    function btnStyle(bg, disabled) {
      return {
        flex: '1 1 auto', minWidth: '96px', padding: '7px 10px', borderRadius: '8px', border: 'none',
        cursor: disabled ? 'wait' : 'pointer', background: bg, color: '#fff',
        fontWeight: 600, fontSize: '12px', opacity: disabled ? 0.65 : 1, lineHeight: '16px',
      }
    }

    function DivergenceActions(props) {
      const { div, busy, onAction } = props
      if (!div) return null
      const commits = (div.localCommits || []).slice(0, 4)
      return React.createElement('div', { style: { marginTop: '10px' } },
        React.createElement('div', {
          style: {
            padding: '8px 10px', borderRadius: '8px', marginBottom: '8px',
            background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)',
            color: '#fde68a', fontSize: '12px', lineHeight: '18px',
          },
        },
          React.createElement('div', { style: { fontWeight: 700, marginBottom: '4px' } },
            '无法快进 · 超前 ' + (div.ahead ?? '?') + ' / 落后 ' + (div.behind ?? '?')
            + (div.dirty ? ' · 未提交 ' + div.dirty + ' 项' : '')),
          React.createElement('div', { style: { color: '#fcd34d', marginBottom: commits.length ? '6px' : 0 } },
            '分支 ' + (div.branch || '?') + ' ↔ ' + (div.upstream || 'origin')
            + '。点下面按钮会自动处理（含冲突自动解决；不行则备份本地后对齐远程）。'),
          commits.length
            ? React.createElement('div', { style: { fontFamily: MONO, fontSize: '11px', color: '#e7e5e4' } },
              commits.map((c) => React.createElement('div', { key: c.id },
                '• ' + String(c.id || '').slice(0, 8) + ' ' + (c.subject || ''))),
            )
            : null,
        ),
        React.createElement('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
        },
          React.createElement('button', {
            disabled: busy, onClick: () => onAction('merge'),
            style: btnStyle('#f59e0b', busy),
            title: '自动 merge：冲突时锁文件跟远程、代码保留本地，并继续完成',
          }, busy ? '处理中…' : '一键合并'),
          React.createElement('button', {
            disabled: busy, onClick: () => onAction('rebase'),
            style: btnStyle('#3b82f6', busy),
            title: '自动 rebase（推荐）：同样自动处理冲突，适合继续本地开发',
          }, busy ? '处理中…' : '保留本地并拉取'),
          React.createElement('button', {
            disabled: busy, onClick: () => onAction('reset-remote'),
            style: btnStyle('#ef4444', busy),
            title: '丢弃本地提交，只保留远程（未提交改动先 stash）',
          }, busy ? '处理中…' : '只保留远程'),
        ),
      )
    }

    function ProgressBlock(props) {
      const { progress, label, speed, tail, message, running } = props
      const lines = String(tail || '')
        .split(/\r|\n/).map((l) => l.trim()).filter(Boolean).slice(-8)
      const logRef = React.useRef(null)
      React.useEffect(() => {
        const el = logRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [tail])

      const pct = Math.max(0, Math.min(100, Number(progress) || 0))
      const speedText = String(speed || '').trim()
      return React.createElement('div', { style: { marginTop: '10px' } },
        React.createElement('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            gap: '8px', marginBottom: '6px',
          },
        },
          React.createElement('span', {
            style: { color: '#93c5fd', fontSize: '12px', fontWeight: 600 },
          }, label || (running ? '更新进行中…' : '进度')),
          React.createElement('span', {
            style: { fontFamily: MONO, color: '#e4e4e7', fontSize: '12px', whiteSpace: 'nowrap' },
          }, pct + '%' + (speedText ? ' · ' + speedText : '')),
        ),
        React.createElement('div', {
          style: {
            height: '8px', borderRadius: '999px',
            background: 'rgba(255,255,255,0.08)', overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.1)',
          },
        },
          React.createElement('div', {
            style: {
              height: '100%',
              width: Math.max(2, pct) + '%',
              background: running
                ? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
                : pct >= 100 ? '#22c55e' : '#ef4444',
              transition: 'width 280ms ease',
              borderRadius: '999px',
            },
          }),
        ),
        message
          ? React.createElement('div', {
            style: { marginTop: '8px', color: '#d4d4d8', fontSize: '12px', lineHeight: '18px' },
          }, message)
          : null,
        React.createElement('div', {
          ref: logRef,
          style: {
            marginTop: '8px', maxHeight: '140px', overflow: 'auto',
            padding: '8px 10px', borderRadius: '8px',
            background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)',
            fontFamily: MONO, fontSize: '11px', lineHeight: '16px', color: '#a1a1aa',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          },
        }, lines.length ? lines.join('\n') : (running ? '等待安装输出…' : '（无日志）')),
      )
    }

    function Badge() {
      const [st, setSt] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [updating, setUpdating] = React.useState(false)

      const refresh = React.useCallback(() => {
        request('/dsh-version-updater/status')
          .then((r) => setSt(r))
          .catch(() => setSt({
            runningVersion: null, installedVersion: null, latestVersion: null,
            stableLatest: null, previewLatest: null, channel: 'preview',
            status: 'error', update: null,
          }))
      }, [])

      React.useEffect(() => {
        refresh()
        const id = setInterval(refresh, 60000)
        return () => clearInterval(id)
      }, [refresh])

      const running = !!(st && st.update && st.update.running)
      React.useEffect(() => {
        if (!running) return
        setOpen(true)
        const id = setInterval(refresh, 600)
        return () => clearInterval(id)
      }, [running, refresh])

      function startUpdate() {
        if (updating || (st && st.update && st.update.running)) return
        setUpdating(true)
        setOpen(true)
        request('/dsh-version-updater/start-update')
          .then(() => refresh())
          .catch(() => refresh())
          .finally(() => setUpdating(false))
      }

      function resolveGit(action) {
        if (updating || (st && st.update && st.update.running)) return
        if (action === 'reset-remote') {
          const ok = window.confirm(
            '「只保留远程」会丢弃本地多出的提交（reset --hard）。\n未提交改动会先备份到 git stash。\n确定继续？',
          )
          if (!ok) return
        }
        setUpdating(true)
        setOpen(true)
        request('/dsh-version-updater/resolve-git', { action: action })
          .then(() => refresh())
          .catch(() => refresh())
          .finally(() => setUpdating(false))
      }

      const color = running ? '#3b82f6'
        : (st && st.update && st.update.phase === 'diverged') ? '#f59e0b'
          : statusColor(st && st.status ? st.status : '')
      const runVer = st && st.runningVersion
      const diskVer = st && st.installedVersion
      const ver = runVer || diskVer || '?'
      let text = st ? ('v' + ver) : '检查中…'
      if (st) {
        if (running) {
          const p = typeof st.update.progress === 'number' ? st.update.progress : 0
          const spd = st.update.progressSpeed ? (' · ' + st.update.progressSpeed) : ''
          text = '更新中 ' + p + '%' + spd
        } else if (st.update && st.update.phase === 'diverged') {
          const d = st.divergence || st.update.divergence
          text = d
            ? ('分叉 +' + d.ahead + '/-' + d.behind)
            : '需处理分叉'
        } else if (st.status === 'up-to-date') text = 'v' + ver + ' 最新'
        else if (st.status === 'update-available') text = 'v' + ver + ' → v' + (st.latestVersion || '?') + ' 可更新'
        else if (st.status === 'update-done-restart') {
          if (runVer && diskVer && runVer !== diskVer) text = '运行 v' + runVer + ' · 已装 v' + diskVer + ' · 需重启'
          else text = 'v' + ver + ' · 需重启生效'
        }
        else if (st.status === 'error') text = '版本检查失败'
        else text = 'v' + ver + ' · 版本未知'
      }

      const badgeStyle = {
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        padding: '6px 12px', borderRadius: '9999px',
        background: 'rgba(24,24,27,0.72)', border: '1px solid ' + color + '88',
        color: '#fafafa', fontSize: '12px', fontFamily: MONO, cursor: 'pointer',
        userSelect: 'none', whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
      }
      const panelStyle = {
        position: 'absolute', top: 'calc(100% + 8px)', right: '0',
        width: '420px', maxWidth: 'calc(100vw - 24px)',
        background: 'rgba(24,24,27,0.94)', border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: '12px', padding: '12px 14px', color: '#e4e4e7', fontSize: '13px',
        boxShadow: '0 10px 34px rgba(0,0,0,0.45)', zIndex: 9999,
      }

      const rows = [
        ['系统', st && st.system ? (st.system.os + ' ' + st.system.arch) : '—'],
        ['安装方式', (st && st.system && st.system.installMethod) || '—'],
        ['当前运行', (st && st.runningVersion) || '—'],
        ['已安装', (st && st.installedVersion) || '—'],
        ['更新通道', st ? (st.channel === 'stable' ? '稳定版·stable' : '预览版·preview') : '—'],
        ['预览最新', (st && st.previewLatest) || '—'],
        ['稳定最新', (st && st.stableLatest) || '—'],
        ['目标版本', st && st.latestVersion
          ? ('v' + st.latestVersion + (st.note && st.note !== st.channel ? '（' + st.note + '）' : ''))
          : '—'],
      ]

      const upd = st && st.update
      const div = (st && (st.divergence || (upd && upd.divergence))) || null
      const showDiverged = !!(div && ((upd && upd.phase === 'diverged') || (div.ahead > 0 && div.behind > 0)))
      let action = null
      if (upd && upd.running) {
        action = React.createElement(ProgressBlock, {
          progress: typeof upd.progress === 'number' ? upd.progress : 8,
          label: upd.progressLabel || (phaseLabel(upd.phase) + '…'),
          speed: upd.progressSpeed || '',
          tail: upd.tail || '',
          message: upd.message || '',
          running: true,
        })
      } else if (showDiverged || (upd && upd.phase === 'diverged')) {
        action = React.createElement('div', null,
          React.createElement(ProgressBlock, {
            progress: typeof upd.progress === 'number' ? upd.progress : 42,
            label: upd.progressLabel || '需处理分叉',
            speed: '',
            tail: upd.tail || '',
            message: upd.message || '',
            running: false,
          }),
          React.createElement(DivergenceActions, {
            div: div || { ahead: '?', behind: '?', branch: '?', upstream: 'origin', localCommits: [] },
            busy: updating,
            onAction: resolveGit,
          }),
        )
      } else if (upd && (upd.done || upd.phase === 'error' || upd.phase === 'done')) {
        action = React.createElement(ProgressBlock, {
          progress: typeof upd.progress === 'number' ? upd.progress : (upd.ok ? 100 : 5),
          label: upd.progressLabel || (phaseLabel(upd.phase) + (upd.running ? '…' : '')),
          speed: upd.progressSpeed || '',
          tail: upd.tail || '',
          message: upd.message || '',
          running: false,
        })
      } else if (st && st.status === 'update-available') {
        const isGit = st.system && st.system.installMethod === 'git'
        action = React.createElement('button', {
          onClick: startUpdate,
          disabled: updating,
          style: {
            marginTop: '10px', padding: '7px 14px', borderRadius: '8px', border: 'none',
            cursor: updating ? 'wait' : 'pointer', background: '#f59e0b', color: '#1c1917',
            fontWeight: 600, opacity: updating ? 0.7 : 1,
          },
        }, updating ? '启动中…' : (isGit ? '⚡ 一键更新源码 (git pull)' : '⚡ 立即更新 (npm)'))
      } else if (st && st.status === 'up-to-date') {
        action = React.createElement('div', { style: { marginTop: '10px', color: '#22c55e', fontSize: '12px' } }, '已是最新版本 ✓')
      } else if (st && st.status === 'update-done-restart') {
        const isWin = st.platform === 'win32' || st.autoRestart === false
        action = React.createElement('div', { style: { marginTop: '10px' } },
          React.createElement('div', { style: { color: '#3b82f6', fontSize: '12px', marginBottom: '8px', lineHeight: 1.45 } },
            (st.update && st.update.restartScheduled)
              ? '正在自动重启以加载新版本…'
              : (st.runningVersion && st.installedVersion && st.runningVersion !== st.installedVersion
                ? ('磁盘已是 v' + st.installedVersion + '，当前进程仍是 v' + st.runningVersion + '。' + (isWin ? '请手动关闭并重新启动 dsh web。' : '请重启 dsh web 后生效。'))
                : (isWin ? '请手动关闭并重新启动 dsh web 后生效。' : '请重启 dsh web 服务生效'))),
          !(st.update && st.update.restartScheduled) && st.autoRestart
            ? React.createElement('button', {
              onClick: () => {
                setUpdating(true)
                request('/dsh-version-updater/restart')
                  .then(() => refresh())
                  .catch(() => refresh())
                  .finally(() => setUpdating(false))
              },
              disabled: updating,
              style: {
                padding: '7px 14px', borderRadius: '8px', border: 'none',
                cursor: updating ? 'wait' : 'pointer', background: '#3b82f6', color: '#fff',
                fontWeight: 600, opacity: updating ? 0.7 : 1,
              },
            }, updating ? '重启中…' : '🔄 立即重启生效')
            : null,
        )
      } else if (st && st.status === 'error') {
        action = React.createElement('div', { style: { marginTop: '10px', color: '#ef4444', fontSize: '12px' } },
          (st.update && st.update.message) || '检查失败')
      } else if (st && st.status === 'unknown') {
        action = React.createElement('div', { style: { marginTop: '10px', color: '#9ca3af', fontSize: '12px' } }, '无法获取最新版本')
      }

      const panel = open
        ? React.createElement('div', null,
          React.createElement('div', {
            onClick: () => setOpen(false),
            style: { position: 'fixed', inset: '0', zIndex: 9998 },
          }),
          React.createElement('div', { style: panelStyle },
            React.createElement('div', { style: { fontWeight: 600, fontSize: '14px', marginBottom: '8px' } }, 'DSH 版本'),
            rows.map((r) => React.createElement('div', {
              key: r[0],
              style: { display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '3px 0' },
            },
              React.createElement('span', { style: { color: '#a1a1aa' } }, r[0]),
              React.createElement('span', { style: { fontFamily: MONO, color: '#fafafa' } }, r[1]),
            )),
            action,
          ),
        )
        : null

      return React.createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
        React.createElement('div', { style: badgeStyle, onClick: () => setOpen(!open) },
          React.createElement('span', {
            style: {
              width: '8px', height: '8px', borderRadius: '50%', background: color,
              display: 'inline-block',
              boxShadow: running ? ('0 0 0 3px ' + color + '33') : undefined,
            },
          }),
          React.createElement('span', null, text),
        ),
        panel,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('conversation.session.header.utilities', () =>
        slots.register(
          { name: 'conversation.session.header.utilities', id: 'dsh-version-autoupdate', order: 20 },
          () => React.createElement(Badge, null),
        ),
      )
    }

    exports.apply = apply
    return module.exports
  },
})
