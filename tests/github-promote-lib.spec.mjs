/**
 * Promote must refuse to ship a checkout whose packages declare lib entrypoints
 * that were never built (host-only staging left client packages without lib/).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, after } from 'node:test'
import { assertHarnessLibEntrypoints } from '../lib/github-promote.js'

async function writePkg(root, relDir, pkg) {
  const dir = join(root, relDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  return dir
}

describe('assertHarnessLibEntrypoints', () => {
  /** @type {string[]} */
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes when every main/exports default lib entry exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-promote-lib-ok-'))
    temps.push(root)
    const dir = await writePkg(root, 'packages/client/ui-open-in-app', {
      name: '@deepseek-ai/dsh-client-ui-open-in-app',
      main: 'lib/index.js',
      exports: { '.': { default: './lib/index.js' } },
    })
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'lib', 'index.js'), 'export {}\n', 'utf8')
    await assertHarnessLibEntrypoints(root)
  })

  it('fails when a package main points at missing lib/index.js', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-promote-lib-missing-'))
    temps.push(root)
    await writePkg(root, 'packages/client/ui-open-in-app', {
      name: '@deepseek-ai/dsh-client-ui-open-in-app',
      main: 'lib/index.js',
    })
    await assert.rejects(
      () => assertHarnessLibEntrypoints(root),
      /missing lib entry|dsh-client-ui-open-in-app|lib\/index\.js/,
    )
  })

  it('ignores packages without a lib entrypoint contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-promote-lib-skip-'))
    temps.push(root)
    await writePkg(root, 'packages/client/ui-open-in-app', {
      name: '@deepseek-ai/dsh-client-ui-open-in-app',
      main: 'src/index.ts',
    })
    await assertHarnessLibEntrypoints(root)
  })

  it('ignores @fixture packages and tests/fixtures trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-promote-lib-fixture-'))
    temps.push(root)
    await writePkg(root, 'packages/typert/generator/tests/fixtures/type-model/packages/client', {
      name: '@fixture/client',
      main: 'lib/index.js',
    })
    await writePkg(root, 'packages/real/needs-lib', {
      name: '@deepseek-ai/real-needs-lib',
      main: 'lib/index.js',
    })
    await assert.rejects(
      () => assertHarnessLibEntrypoints(root),
      /real-needs-lib/,
    )
  })

  it('checks native packages with subpath exports (no main)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-promote-lib-native-'))
    temps.push(root)
    await writePkg(root, 'native/system/packages/entry', {
      name: '@deepseek-ai/node-addon-system',
      exports: {
        './flock': { default: './lib/flock.js' },
        './landlock-run': { default: './lib/index.js' },
      },
    })
    await assert.rejects(
      () => assertHarnessLibEntrypoints(root),
      /node-addon-system|lib\/flock\.js|lib\/index\.js/,
    )
  })
})
