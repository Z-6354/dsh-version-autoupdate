import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { dshStateDir, offlineLogFile } from '../lib/offline-install.mjs';

it('uses DSH_HOME for offline state instead of the default home', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-home-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    assert.equal(dshStateDir(), resolve(dir));
    assert.equal(offlineLogFile(), join(dir, 'version-autoupdate-offline.log'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('treats a blank DSH_HOME as unset', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '   ';
  try { assert.equal(dshStateDir(), join(homedir(), '.dsh')); }
  finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
