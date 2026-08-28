import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findDshRoot } from '../lib/dsh-root.js';

const HARNESS_ROOT = resolve('d:/0HAN/Work/deepseek-harness');

function mockCtx(workspaceRoot) {
  return {
    get(name) {
      if (name === 'fs') {
        return {
          async resolve(p) {
            return p;
          },
          async readText(target) {
            return readFile(String(target), 'utf8');
          },
        };
      }
      if (name === 'sandboxPolicy') return { workspaceRoot };
      return undefined;
    },
  };
}

describe('findDshRoot', () => {
  it('finds harness monorepo from workspace root', async () => {
    const root = await findDshRoot(mockCtx(HARNESS_ROOT));
    assert.ok(root, 'expected a DSH root');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.ok(['@deepseek-ai/dsh', '@deepseek-ai/dsh-root'].includes(pkg.name));
    assert.equal(typeof pkg.version, 'string');
    assert.ok(pkg.version.length > 0);
  });
});
