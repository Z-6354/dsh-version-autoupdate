import { it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findDshRoot } from '../lib/dsh-root.js';

function mockCtx(packages, workspaceRoot, executable) {
  return {
    get(name) {
      if (name === 'fs') {
        return {
          async resolve(p) {
            return String(p).replace(/\\/g, '/');
          },
          async readText(target) {
            if (!packages.has(target)) throw new Error('ENOENT');
            return JSON.stringify(packages.get(target));
          },
        };
      }
      if (name === 'sandboxPolicy') return { workspaceRoot };
      if (name === 'subprocess') return { async resolveExecutable() { return executable; } };
      return undefined;
    },
  };
}

it('finds a harness checkout without machine-specific files', async () => {
  const root = '/fixture/harness';
  const packages = new Map([[root + '/package.json', { name: '@deepseek-ai/dsh-root', version: '0.2.0-rc.2' }]]);
  assert.equal(await findDshRoot(mockCtx(packages, root)), root);
});

it('prefers the running npm entry over workspace and PATH installations', async () => {
  const previous = process.argv;
  const root = '/fixture/npx/node_modules/@deepseek-ai/dsh';
  const other = '/fixture/harness';
  process.argv = [process.execPath, root + '/lib/bin.js', 'web'];
  try {
    const packages = new Map([root, other].map(p => [
      join(p, 'package.json').replace(/\\/g, '/'),
      { name: p === root ? '@deepseek-ai/dsh' : '@deepseek-ai/dsh-root', version: '0.2.0-rc.2' },
    ]));
    assert.equal(await findDshRoot(mockCtx(packages, other, '/other/bin/dsh')), root);
  } finally { process.argv = previous; }
});

it('does not report another installation when the running package cannot be read', async () => {
  const previous = process.argv;
  process.argv = [process.execPath, '/missing/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web'];
  try {
    const packages = new Map([['/other/package.json', { name: '@deepseek-ai/dsh-root', version: '9.0.0' }]]);
    assert.equal(await findDshRoot(mockCtx(packages, '/other')), null);
  } finally { process.argv = previous; }
});
