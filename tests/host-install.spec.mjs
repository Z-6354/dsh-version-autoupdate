import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

for (const matches of [false, true]) {
  it(matches ? 'installs only into the verified running global package' : 'rejects a different global installation before running install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-install-test-'));
    const root = join(dir, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(root, { recursive: true });
    const pkgFile = join(root, 'package.json');
    const pkg = version => JSON.stringify({ name: '@deepseek-ai/dsh', version });
    await writeFile(pkgFile, pkg('0.1.0-rc.8'));
    const previousArgv = process.argv;
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(dir, 'home');
    process.argv = [process.execPath, join(root, 'lib', 'bin.js'), 'web'];
    const commands = [];
    const routes = new Map();
    const disposers = [];
    const ctx = {
      effect(fn) { disposers.push(fn()); },
      get(name) {
        if (name === 'fs') return { resolve: async p => p, readText: p => readFile(p, 'utf8') };
        if (name === 'web') return { fetch: async () => ({ statusCode: 200, body: { content: JSON.stringify({ versions: { '0.2.0-rc.2': {} } }) } }) };
        if (name === 'webServer') return { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } };
        if (name === 'timer') return { interval: () => () => {}, timeout: () => () => {} };
        if (name === 'subprocess') return {
          resolveExecutable: async () => 'npm',
          spawn(spec) {
            commands.push(spec.argv);
            const isRoot = spec.argv[1] === 'root';
            const output = isRoot ? join(dir, matches ? 'node_modules' : 'other-global') : '';
            return {
              done: isRoot ? Promise.resolve({ exitCode: 0 }) : writeFile(pkgFile, pkg('0.2.0-rc.2')).then(() => ({ exitCode: 0 })),
              terminate() { throw new Error('unexpected termination'); },
              collected: { stdout: { readFrom: () => ({ text: output, nextOffset: output.length }) } },
            };
          },
        };
      },
    };
    async function request(path, method = 'POST') {
      const req = new EventEmitter();
      req.method = method;
      req.headers = { host: 'localhost' };
      const res = { writeHead() {}, end(body) { this.body = JSON.parse(body); } };
      const pending = routes.get('/dsh-version-updater/' + path).handler(req, res);
      req.emit('end');
      await pending;
      return res.body;
    }
    async function settled() {
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        const status = await request('status', 'GET');
        if (!status.update.running) return status.update;
      }
      throw new Error('mock update did not settle');
    }
    try {
      apply(ctx, { packageManager: 'npm', updatePolicy: 'full', minAvailableMemoryMb: 0, offlineInstall: 'never' });
      await request('check');
      assert.equal((await settled()).phase, 'check-done');
      await request('install');
      const state = await settled();
      assert.equal(state.phase, matches ? 'install-done' : 'error');
      assert.equal(commands.filter(argv => argv[1] === 'install').length, matches ? 1 : 0);
      if (!matches) assert.match(state.message, /安装位置不一致/);
    } finally {
      for (const dispose of disposers) dispose();
      process.argv = previousArgv;
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
