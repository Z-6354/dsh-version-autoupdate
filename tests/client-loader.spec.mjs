import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

it('loads the client through ModuleLoader and disposes the capsule with its context', () => {
  let plugin;
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(row) {
      assert.equal(row.id, 'dsh-version-autoupdate');
      plugin = row.factory((name) => {
        assert.equal(name, 'react');
        return {};
      });
    } } },
    console,
  });
  let mounted = false;
  const disposers = [];
  const slots = {
    inject(key, cb) { assert.equal(key, 'shell.overlay'); return cb(); },
    register(options, component) {
      assert.equal(options.id, 'dsh-version-autoupdate');
      assert.equal(typeof component, 'function');
      mounted = true;
      return () => { mounted = false; };
    },
  };
  const ctx = {
    get(key) { assert.equal(key, 'slots'); return slots; },
    effect(fn) { assert.equal(this, ctx); disposers.push(fn()); },
  };
  plugin.apply(ctx);
  assert.equal(mounted, true);
  for (const dispose of disposers) dispose();
  assert.equal(mounted, false);
});
