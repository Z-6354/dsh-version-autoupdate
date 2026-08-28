import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dshRootFromExecutable } from '../lib/dsh-root.js';

describe('dshRootFromExecutable', () => {
  it('resolves npm global shim on Windows', () => {
    const exe = 'C:/Users/me/AppData/Roaming/npm/dsh.cmd';
    assert.equal(
      dshRootFromExecutable(exe).replace(/\\/g, '/'),
      'C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh',
    );
  });

  it('resolves node_modules layout', () => {
    const exe = '/usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh';
    assert.equal(dshRootFromExecutable(exe), '/usr/local/lib/node_modules/@deepseek-ai/dsh');
  });

  it('resolves lib/bin.js layout', () => {
    const exe = 'D:/npm/global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
    assert.equal(dshRootFromExecutable(exe), 'D:/npm/global/lib/node_modules/@deepseek-ai/dsh');
  });
});
