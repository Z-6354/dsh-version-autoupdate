import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readLinuxMemTotalMb,
  shouldUseOfflineInstall,
  buildOfflineInstallShell,
} from '../lib/offline-install.mjs';

describe('offline install', () => {
  it('detects 2G class host for auto mode', () => {
    const linux = process.platform === 'linux';
    assert.equal(shouldUseOfflineInstall({ offlineInstall: 'auto' }, 2048), linux);
    assert.equal(shouldUseOfflineInstall({ offlineInstall: 'auto' }, 4096), false);
    assert.equal(shouldUseOfflineInstall({ offlineInstall: 'never' }, 1024), false);
    if (linux) assert.equal(shouldUseOfflineInstall({ offlineInstall: 'always' }, 8192), true);
  });

  it('reads mem total on linux when available', () => {
    const mb = readLinuxMemTotalMb();
    if (process.platform === 'linux') assert.ok(mb === null || mb > 0);
    else assert.equal(mb, null);
  });

  it('shell uses sudo-aware systemctl and dsh fallback', () => {
    const sh = buildOfflineInstallShell({
      unit: 'dsh-web.service',
      npmCmd: 'npm install -g @deepseek-ai/dsh@1.0.0',
      version: '1.0.0',
      dshPid: 12345,
      logFile: '/tmp/offline.log',
      stateFile: '/tmp/offline.json',
      plan: { exe: '/usr/bin/node', args: ['/x/bin.js', 'web', '--no-open'], cwd: '/tmp', port: 3080, mode: 'dsh-binjs' },
      nodeBin: '/usr/bin',
    });
    assert.match(sh, /pick_systemctl/);
    assert.match(sh, /sudo -n systemctl/);
    assert.match(sh, /command -v dsh/);
    assert.match(sh, /write_state_done/);
  });
});
