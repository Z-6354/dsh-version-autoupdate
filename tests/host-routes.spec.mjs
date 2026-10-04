import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../lib/index.js';

function fixture() {
  const routes = new Map();
  const disposers = [];
  let webCalls = 0;
  const ctx = {
    effect(fn) { disposers.push(fn()); },
    get(key) {
      if (key === 'webServer') return {
        register(route) {
          assert.equal(routes.has(route.path), false, 'duplicate route');
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      };
      if (key === 'web') return { fetch: () => {
        if (++webCalls === 1) return new Promise(() => {});
        return Promise.resolve({ statusCode: 200, body: { content: JSON.stringify({ versions: { '0.2.0-rc.2': {} } }) } });
      } };
      return undefined;
    },
  };
  async function request(path, method = 'POST') {
    const req = new EventEmitter();
    req.method = method;
    req.headers = { host: 'localhost' };
    const res = {
      writeHead(code, headers) { this.code = code; this.headers = headers; },
      end(body) { this.body = JSON.parse(body); },
    };
    const pending = routes.get(path).handler(req, res);
    req.emit('end');
    await pending;
    return res;
  }
  return { ctx, routes, disposers, request };
}

it('removes host routes on disposal and permits reactivation', () => {
  const f = fixture();
  apply(f.ctx);
  assert.equal(f.routes.size, 5);
  for (const dispose of f.disposers) dispose();
  assert.equal(f.routes.size, 0);
  apply(f.ctx);
  assert.equal(f.routes.size, 5);
});

it('requires POST for write endpoints and GET for status', async () => {
  const f = fixture();
  apply(f.ctx);
  for (const p of ['check', 'install', 'start-update', 'restart']) {
    const res = await f.request('/dsh-version-updater/' + p, 'GET');
    assert.equal(res.code, 405, p);
    assert.equal(res.headers.Allow, 'POST');
  }
  assert.equal((await f.request('/dsh-version-updater/status', 'POST')).code, 405);
});

it('rejects concurrent actions before resetting the running update', async () => {
  const f = fixture();
  apply(f.ctx);
  assert.equal((await f.request('/dsh-version-updater/check')).body.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  const before = (await f.request('/dsh-version-updater/status', 'GET')).body.update;
  for (const p of ['check', 'start-update', 'restart']) {
    const res = await f.request('/dsh-version-updater/' + p);
    assert.equal(res.body.busy, true, p);
  }
  const after = (await f.request('/dsh-version-updater/status', 'GET')).body.update;
  assert.equal(after.message, before.message);
  assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.phase, before.phase);
});
