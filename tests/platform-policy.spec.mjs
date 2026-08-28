import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUpdateCapabilities } from '../lib/platform-policy.js';

describe('platform policy', () => {
  it('windows gets full update', () => {
    const c = resolveUpdateCapabilities('win32', 'platform');
    assert.equal(c.canDetect, true);
    assert.equal(c.canInstall, true);
    assert.equal(c.canRestart, true);
  });

  it('linux gets detect-only by default', () => {
    const c = resolveUpdateCapabilities('linux', 'platform');
    assert.equal(c.canDetect, true);
    assert.equal(c.canInstall, false);
    assert.equal(c.canRestart, false);
    assert.ok(c.detectOnlyReason.includes('Linux'));
  });

  it('detect-only policy blocks everywhere', () => {
    const c = resolveUpdateCapabilities('win32', 'detect-only');
    assert.equal(c.canInstall, false);
  });

  it('full policy allows everywhere', () => {
    const c = resolveUpdateCapabilities('linux', 'full');
    assert.equal(c.canInstall, true);
  });
});
