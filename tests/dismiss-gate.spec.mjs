import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * Mirrors widget auto-expand gate with persisted dismiss key.
 */
function decideExpand(opts) {
  const {
    resetKey, dismissKey, persisted, userDismissed, warrantExpand, force,
  } = opts
  const isNewKey = Boolean(resetKey && resetKey !== dismissKey)
  if (isNewKey) {
    if (resetKey && resetKey === persisted) {
      return { expand: false, stayDismissed: true }
    }
    if (force || warrantExpand) return { expand: true, stayDismissed: false }
    return { expand: false, stayDismissed: false }
  }
  if (userDismissed || (resetKey && resetKey === persisted)) {
    return { expand: false, stayDismissed: true }
  }
  return { expand: warrantExpand, stayDismissed: false }
}

describe('autoupdate dismiss gate', () => {
  it('does not reopen same update-available after dismiss (stale shouldExpand)', () => {
    const r = decideExpand({
      resetKey: 'avail:2.0.0',
      dismissKey: 'avail:2.0.0',
      persisted: 'avail:2.0.0',
      userDismissed: true,
      warrantExpand: true,
      force: false,
    })
    assert.equal(r.expand, false)
  })

  it('does not expand on restart when persisted dismiss matches', () => {
    const r = decideExpand({
      resetKey: 'avail:2.0.0',
      dismissKey: '',
      persisted: 'avail:2.0.0',
      userDismissed: true,
      warrantExpand: true,
      force: false,
    })
    assert.equal(r.expand, false)
    assert.equal(r.stayDismissed, true)
  })

  it('reopens when latest version key changes', () => {
    const r = decideExpand({
      resetKey: 'avail:2.0.1',
      dismissKey: 'avail:2.0.0',
      persisted: 'avail:2.0.0',
      userDismissed: true,
      warrantExpand: true,
      force: false,
    })
    assert.equal(r.expand, true)
  })
})
