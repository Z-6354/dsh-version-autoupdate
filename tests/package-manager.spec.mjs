import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildGlobalInstallArgv,
  buildInstallEnv,
  lowMemoryInstallWarning,
  nodePrefixFromDshRoot,
  packageManagerSearchPaths,
  runningNodeSatisfiesDsh,
  globalRootArgv,
  globalDshRoot,
} from '../lib/package-manager.js';

describe('package-manager', () => {
  it('derives node prefix from global dsh root', () => {
    const root = '/home/ubuntu/.local/node-v22.19.0/lib/node_modules/@deepseek-ai/dsh';
    assert.equal(nodePrefixFromDshRoot(root), '/home/ubuntu/.local/node-v22.19.0');
    assert.equal(nodePrefixFromDshRoot('/other/path'), null);
  });

  it('searches npm beside running node first', () => {
    const paths = packageManagerSearchPaths({
      dshRoot: '/opt/node/lib/node_modules/@deepseek-ai/dsh',
      pm: 'npm',
      nodeBinDir: '/opt/node/bin',
      platform: 'linux',
    });
    assert.equal(paths[0], join('/opt/node/bin', 'npm'));
    assert.ok(paths.some((p) => p.replace(/\\/g, '/').endsWith('/bin/npm')));
  });

  it('prepends node bin dir to PATH in install env', () => {
    const env = buildInstallEnv('/opt/node/bin');
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    assert.ok(String(env[key]).startsWith('/opt/node/bin'));
  });

  it('rejects low memory when below threshold', () => {
    assert.match(lowMemoryInstallWarning(200, 400) ?? '', /可用内存/);
    assert.equal(lowMemoryInstallWarning(500, 400), null);
    assert.equal(lowMemoryInstallWarning(null, 400), null);
  });

  it('checks minimum node for dsh', () => {
    assert.equal(runningNodeSatisfiesDsh('v22.19.0').ok, true);
    assert.equal(runningNodeSatisfiesDsh('v20.0.0').ok, false);
  });

  it('rejects Node 23 and malformed versions while accepting supported releases', () => {
    for (const v of ['v23.0.0', 'v22.18.0', 'garbage', 'v24.0.0-rc.1']) {
      assert.equal(runningNodeSatisfiesDsh(v).ok, false, v);
    }
    for (const v of ['v22.20.0', 'v24.0.0', 'v25.0.0']) {
      assert.equal(runningNodeSatisfiesDsh(v).ok, true, v);
    }
  });

  it('builds npm global install argv with optional omit and retries', () => {
    const argv = buildGlobalInstallArgv('/usr/bin/npm', '0.1.0-rc.8');
    assert.deepEqual(argv.slice(0, 4), ['/usr/bin/npm', 'install', '-g', '@deepseek-ai/dsh@0.1.0-rc.8']);
    assert.ok(argv.includes('--omit=optional'));
    assert.ok(argv.includes('--fetch-timeout=300000'));
  });

  it('locates each supported package manager global root without installing', () => {
    assert.deepEqual(globalRootArgv('C:\\node\\npm.cmd'), ['C:\\node\\npm.cmd', 'root', '-g']);
    assert.deepEqual(globalRootArgv('pnpm'), ['pnpm', 'root', '-g']);
    assert.deepEqual(globalRootArgv('yarn'), ['yarn', 'global', 'dir']);
    assert.equal(globalDshRoot('npm', '/prefix/node_modules\n'), join('/prefix/node_modules', '@deepseek-ai', 'dsh'));
    assert.equal(globalDshRoot('yarn', '/yarn/global\n'), join('/yarn/global', 'node_modules', '@deepseek-ai', 'dsh'));
    assert.equal(globalDshRoot('npm', 'not a path'), null);
  });
});
