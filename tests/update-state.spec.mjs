import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInstallProgress } from '../lib/update-progress.js';

describe('update progress', () => {
  it('maps phases to sensible percentages', () => {
    assert.equal(estimateInstallProgress('checking', Date.now(), ''), 15);
    assert.equal(estimateInstallProgress('check-done', Date.now(), ''), 33);
    assert.equal(estimateInstallProgress('done', Date.now(), ''), 100);
    assert.equal(estimateInstallProgress('error', Date.now(), ''), 5);
    assert.equal(estimateInstallProgress('idle', Date.now(), ''), 0);
  });

  it('grows during installing with tail and time', () => {
    const started = Date.now() - 10000;
    const tail = 'line\n'.repeat(20);
    const p = estimateInstallProgress('installing', started, tail);
    assert.ok(p > 30 && p <= 92);
  });
});
