/**
 * Health / port helpers used by promote-and-boot.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { describe, it } from 'node:test'
import { isHealthStatusAcceptable } from '../lib/health-check.js'
import { isPortListening } from '../lib/promote-and-boot.mjs'

describe('isHealthStatusAcceptable', () => {
  it('accepts 2xx–4xx (auth-gated hosts)', () => {
    assert.equal(isHealthStatusAcceptable(200), true)
    assert.equal(isHealthStatusAcceptable(401), true)
    assert.equal(isHealthStatusAcceptable(403), true)
    assert.equal(isHealthStatusAcceptable(404), true)
  })

  it('rejects 5xx and invalid', () => {
    assert.equal(isHealthStatusAcceptable(500), false)
    assert.equal(isHealthStatusAcceptable(0), false)
    assert.equal(isHealthStatusAcceptable(NaN), false)
  })
})

describe('isPortListening', () => {
  it('detects a bound localhost port', async () => {
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    try {
      assert.equal(await isPortListening(port), true)
      assert.equal(await isPortListening(0), false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    // Give OS a moment; then should be free
    assert.equal(await isPortListening(port), false)
  })
})
