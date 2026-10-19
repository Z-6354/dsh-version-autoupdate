/**
 * Detached promote/restart helpers must not be treated as orphaned mid-flight.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isDetachedHelperActive,
  isOperationInFlight,
  isOperationOrphaned,
  summarizeOperation,
} from '../lib/update-operation.js'

function op(partial) {
  return {
    id: 'op-1',
    source: 'github',
    transport: 'mirror',
    phase: 'promoting',
    currentVersion: '0.1.0',
    targetVersion: '0.1.1',
    backupVersion: null,
    progress: { message: 'Promoting…', percent: 97 },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    tail: '',
    ...partial,
  }
}

describe('detached helper vs orphan', () => {
  it('fresh promoting is in-flight, not orphaned', () => {
    const operation = op({ phase: 'promoting' })
    assert.equal(isDetachedHelperActive(operation), true)
    assert.equal(isOperationInFlight(operation, false), true)
    assert.equal(isOperationOrphaned(operation, false), false)
    assert.match(summarizeOperation(operation, false), /helper/)
    assert.doesNotMatch(summarizeOperation(operation, false), /interrupted/)
  })

  it('fresh restarting is in-flight, not orphaned', () => {
    const operation = op({ phase: 'restarting', progress: { message: 'Health…', percent: 99 } })
    assert.equal(isOperationOrphaned(operation, false), false)
    assert.equal(isOperationInFlight(operation, false), true)
  })

  it('stale promoting is orphaned', () => {
    const operation = op({
      phase: 'promoting',
      updatedAt: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    })
    assert.equal(isDetachedHelperActive(operation), false)
    assert.equal(isOperationOrphaned(operation, false), true)
    assert.match(summarizeOperation(operation, false), /interrupted/)
  })

  it('installing without running is orphaned immediately', () => {
    const operation = op({ phase: 'installing' })
    assert.equal(isOperationOrphaned(operation, false), true)
    assert.equal(isOperationInFlight(operation, false), false)
    assert.equal(isOperationInFlight(operation, true), true)
  })
})
