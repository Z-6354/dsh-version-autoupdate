/**
 * Restart helper must not mark update succeeded on a brief listen+HTTP blip:
 * plugin boot can still crash ~15–20s later (missing client lib).
 * Also: 401/403 = ready (auth-gated); Watchdog handoff writes next-root.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  buildWindowsRestartScript,
  detectWatchdogHandoff,
  writeWatchdogNextRoot,
  WATCHDOG_NEXT_ROOT_NAME,
} from '../lib/dsh-restart.mjs'

describe('buildWindowsRestartScript health stability', () => {
  it('requires a post-health dwell before writing succeeded', () => {
    const script = buildWindowsRestartScript({
      logFile: 'C:\\tmp\\restart.log',
      pid: 1234,
      port: 3080,
      plan: { exe: 'D:\\nodejs\\node.exe', cwd: 'D:\\repo', args: ['bin.js', 'web'] },
      healthUrl: 'http://127.0.0.1:3080/',
      outcomeFile: 'C:\\tmp\\outcome.json',
      operationId: 'op-1',
      handoffWatchdog: true,
    })
    assert.equal(typeof script, 'string')

    assert.match(script, /health ok/)
    assert.match(script, /Write-Outcome 'succeeded'/)
    assert.match(script, /\$stabilitySec\s*=\s*25/)
    const firstOk = script.search(/health ok/i)
    const succeeded = script.indexOf("Write-Outcome 'succeeded'")
    assert.ok(firstOk >= 0 && succeeded > firstOk)
    const afterOk = script.slice(firstOk)
    assert.match(afterOk, /dwell|stable/i)
    assert.ok(
      afterOk.search(/dwell|stable/i) < afterOk.indexOf("Write-Outcome 'succeeded'"),
      'stability wait must sit between first health ok and succeeded',
    )
  })

  it('accepts auth-gated 2xx–4xx via Get-HealthStatus (PS 5.1 safe)', () => {
    const script = buildWindowsRestartScript({
      logFile: 'C:\\tmp\\restart.log',
      pid: 1234,
      port: 3080,
      plan: { exe: 'D:\\nodejs\\node.exe', cwd: 'D:\\repo', args: ['bin.js', 'web'] },
      healthUrl: 'http://127.0.0.1:3080/',
      outcomeFile: 'C:\\tmp\\outcome.json',
      operationId: 'op-1',
      handoffWatchdog: true,
    })
    assert.match(script, /function Get-HealthStatus/)
    assert.match(script, /Test-HealthAcceptable/)
    assert.match(script, /Exception\.Response/)
    assert.match(script, /StatusCode\.value__/)
    assert.doesNotMatch(script, /\$hr = Invoke-WebRequest[^\n]*\n[^\n]*\$hr\.StatusCode -ge 200/)
  })
})

describe('writeWatchdogNextRoot', () => {
  it('writes trimmed absolute path for Watchdog one-shot override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-next-root-'))
    try {
      const path = writeWatchdogNextRoot(`  ${join(dir, 'staging')}  `, dir)
      assert.ok(path)
      assert.equal(path, join(dir, WATCHDOG_NEXT_ROOT_NAME))
      assert.equal(readFileSync(path, 'utf8'), join(dir, 'staging'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for empty root', () => {
    assert.equal(writeWatchdogNextRoot(''), null)
    assert.equal(writeWatchdogNextRoot('   '), null)
  })
})

describe('detectWatchdogHandoff', () => {
  it('returns handoff false when lock missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wd-lock-'))
    try {
      const r = detectWatchdogHandoff(dir)
      assert.equal(r.handoff, false)
      assert.equal(r.watchdogPid, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns handoff false for dead lock pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wd-dead-'))
    try {
      writeFileSync(join(dir, 'watchdog-web.lock'), '1\n', 'utf8')
      const r = detectWatchdogHandoff(dir)
      assert.equal(r.handoff, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats live self pid as handoff candidate (cmdline check on win32)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-wd-self-'))
    try {
      writeFileSync(join(dir, 'watchdog-web.lock'), `${process.pid}\n`, 'utf8')
      const r = detectWatchdogHandoff(dir)
      // Current node test runner is not watch-dsh-web.ps1 → win32 must reject;
      // other platforms only check kill(0) so handoff may be true.
      if (process.platform === 'win32') {
        assert.equal(r.handoff, false)
        assert.equal(r.reason, 'pid-not-watchdog')
      } else {
        assert.equal(r.handoff, true)
        assert.equal(r.watchdogPid, process.pid)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
