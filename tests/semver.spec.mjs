import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, isPrereleaseVersion, semverParts, versionCompare } from '../lib/semver.js';

describe('semver', () => {
  it('compares release versions', () => {
    assert.equal(versionCompare('0.1.0', '0.2.0'), -1);
    assert.equal(versionCompare('0.2.0', '0.1.0'), 1);
    assert.equal(versionCompare('1.0.0', '1.0.0'), 0);
  });

  it('treats prerelease lower than release at same x.y.z', () => {
    assert.equal(versionCompare('0.1.0-rc.1', '0.1.0'), -1);
    assert.equal(versionCompare('0.1.0', '0.1.0-rc.9'), 1);
  });

  it('compares prerelease segments', () => {
    assert.equal(versionCompare('0.1.0-rc.1', '0.1.0-rc.2'), -1);
    assert.equal(versionCompare('0.1.0-rc.10', '0.1.0-rc.2'), 1);
  });

  it('isNewer detects update target', () => {
    assert.equal(isNewer('0.1.0-rc.6', '0.1.0-rc.8'), true);
    assert.equal(isNewer('0.2.0', '0.1.0'), false);
  });

  it('parses prerelease flag', () => {
    assert.equal(isPrereleaseVersion('0.1.0-rc.1'), true);
    assert.equal(isPrereleaseVersion('0.1.0'), false);
    assert.equal(semverParts('bad'), null);
  });
});
