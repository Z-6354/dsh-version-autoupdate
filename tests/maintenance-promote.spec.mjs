/**
 * Maintenance hold + promote-job path contract.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, after } from 'node:test'
import {
  writeMaintenance,
  readMaintenance,
  clearMaintenance,
  isMaintenanceHoldActive,
} from '../lib/maintenance.js'
import { promoteJobPath, maintenancePath } from '../lib/github-staging-paths.js'
import { schedulePromoteAndBoot } from '../lib/dsh-restart.mjs'

describe('maintenance hold', () => {
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('write/read/clear round-trip under DSH home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-maint-'))
    temps.push(home)
    await writeMaintenance(home, {
      active: true,
      operationId: 'op-1',
      phase: 'promoting',
      message: 'hold',
    })
    const path = maintenancePath(home)
    assert.match(path.replace(/\\/g, '/'), /version-autoupdate\/maintenance\.json$/)
    const state = await readMaintenance(home)
    assert.equal(state.active, true)
    assert.equal(state.operationId, 'op-1')
    assert.equal(isMaintenanceHoldActive(state), true)
    await clearMaintenance(home)
    assert.equal(await readMaintenance(home), null)
  })

  it('stale hold is inactive after maxAge', () => {
    const state = {
      active: true,
      updatedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    }
    assert.equal(isMaintenanceHoldActive(state, Date.now(), 45 * 60 * 1000), false)
  })
})

describe('promote job + schedulePromoteAndBoot', () => {
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('promoteJobPath lands under version-autoupdate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-job-'))
    temps.push(home)
    const job = promoteJobPath(home)
    assert.match(job.replace(/\\/g, '/'), /version-autoupdate\/promote-job\.json$/)
    await mkdir(dirname(job), { recursive: true })
    await writeFile(job, JSON.stringify({ operationId: 'test' }), 'utf8')
    assert.equal(JSON.parse(await readFile(job, 'utf8')).operationId, 'test')
  })

  it('rejects missing job file without exiting', () => {
    const result = schedulePromoteAndBoot({
      jobPath: join(tmpdir(), `missing-promote-job-${Date.now()}.json`),
      delayMs: 60_000,
    })
    assert.equal(result.ok, false)
    assert.match(String(result.message || result.error || ''), /missing|job/i)
  })
})

describe('releaseBootHold order', () => {
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes next-root before clearing maintenance', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'dsh-release-state-'))
    temps.push(isolated)
    const dshHome = join(isolated, 'dsh-home')
    const sd = isolated
    await mkdir(join(dshHome, 'version-autoupdate'), { recursive: true })
    await writeMaintenance(dshHome, {
      active: true,
      operationId: 'op-order',
      phase: 'promoting',
      message: 'hold',
    })
    assert.equal((await readMaintenance(dshHome))?.active, true)

    const { releaseBootHold } = await import('../lib/promote-and-boot.mjs')
    const result = await releaseBootHold({
      home: dshHome,
      handoff: true,
      planCwd: isolated,
      stateDir: sd,
    })
    assert.equal(result.nextRootWritten, true)
    assert.equal(result.holdCleared, true)
    const nextRootPath = join(sd, 'watchdog-web.next-root')
    assert.equal(await readFile(nextRootPath, 'utf8'), isolated)
    assert.equal(await readMaintenance(dshHome), null)
  })
  it('clears maintenance without next-root when not handoff', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'dsh-release-nohand-'))
    temps.push(isolated)
    const dshHome = join(isolated, 'dsh-home')
    await mkdir(join(dshHome, 'version-autoupdate'), { recursive: true })
    await writeMaintenance(dshHome, { active: true, phase: 'promoting' })
    const { releaseBootHold } = await import('../lib/promote-and-boot.mjs')
    const result = await releaseBootHold({
      home: dshHome,
      handoff: false,
      planCwd: isolated,
      stateDir: isolated,
    })
    assert.equal(result.nextRootWritten, false)
    assert.equal(result.holdCleared, true)
    assert.equal(await readMaintenance(dshHome), null)
  })
  it('keeps maintenance when handoff cannot write next-root', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'dsh-release-fail-'))
    temps.push(isolated)
    const dshHome = join(isolated, 'dsh-home')
    await mkdir(join(dshHome, 'version-autoupdate'), { recursive: true })
    await writeMaintenance(dshHome, { active: true, phase: 'promoting' })
    const { releaseBootHold } = await import('../lib/promote-and-boot.mjs')
    const result = await releaseBootHold({
      home: dshHome,
      handoff: true,
      planCwd: '',
      stateDir: isolated,
    })
    assert.equal(result.nextRootWritten, false)
    assert.equal(result.holdCleared, false)
    assert.equal((await readMaintenance(dshHome))?.active, true)
  })
})
