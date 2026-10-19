/**
 * Promote post-checkout failure must roll back git HEAD and restore snapshotted
 * lib/dist (gitignored in Harness).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, after } from 'node:test'
import { promoteGithubStagingToLive, rollbackLiveToPreviousRef } from '../lib/github-promote.js'

async function writePkg(root, relDir, pkg) {
  const dir = join(root, relDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  return dir
}

async function writeLib(root, relPkg, marker) {
  const dir = await writePkg(root, relPkg, {
    name: `@deepseek-ai/${relPkg.split('/').pop()}`,
    main: 'lib/index.js',
  })
  await mkdir(join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'lib', 'index.js'), `export const marker = ${JSON.stringify(marker)}\n`, 'utf8')
  return dir
}

async function writeCliBin(root, marker) {
  const dir = join(root, 'apps', 'cli', 'lib')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'bin.js'), `export const marker = ${JSON.stringify(marker)}\n`, 'utf8')
}

async function writeWebDist(root, html) {
  await mkdir(join(root, 'apps', 'web', 'dist'), { recursive: true })
  await writeFile(join(root, 'apps', 'web', 'dist', 'index.html'), html, 'utf8')
}

describe('promoteGithubStagingToLive rollback', () => {
  /** @type {string[]} */
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('on post-checkout failure: checkout -f previousRef and restore lib snapshot', async () => {
    const live = await mkdtemp(join(tmpdir(), 'dsh-promo-live-'))
    const staging = await mkdtemp(join(tmpdir(), 'dsh-promo-stg-'))
    const backup = await mkdtemp(join(tmpdir(), 'dsh-promo-bak-'))
    temps.push(live, staging, backup)

    await writeLib(live, 'packages/client/ui-open-in-app', 'LIVE_OLD')
    await writeCliBin(live, 'LIVE_BIN')
    await writeWebDist(live, '<html>old</html>\n')

    await writeLib(staging, 'packages/client/ui-open-in-app', 'STAGING_NEW')
    await writeCliBin(staging, 'STAGING_BIN')
    await writeWebDist(staging, '<html>new</html>\n')

    /** @type {string[][]} */
    const gitCalls = []
    let head = 'abc123oldref000000000000000000000000'
    const runGit = async (args, cwd) => {
      assert.equal(cwd, live)
      gitCalls.push(args.slice())
      const key = args.join(' ')
      if (key === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${head}\n`, stderr: '' }
      }
      if (key.startsWith('fetch ')) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'checkout' && args[1] === '-f') {
        head = args[2]
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await assert.rejects(
      () =>
        promoteGithubStagingToLive({
          liveRoot: live,
          stagingRoot: staging,
          targetVersion: '0.9.9',
          targetTag: 'dsh-v0.9.9',
          artifactBackupRoot: backup,
          runGit,
          relinkLive: async () => {
            throw new Error('relink boom')
          },
        }),
      /rolled back git to abc123oldref|relink boom|restored \d+ prior lib/,
    )

    const checkoutCalls = gitCalls.filter((a) => a[0] === 'checkout' && a[1] === '-f')
    assert.equal(checkoutCalls.length, 2)
    assert.equal(checkoutCalls[0][2], 'dsh-v0.9.9')
    assert.equal(checkoutCalls[1][2], 'abc123oldref000000000000000000000000')
    assert.equal(head, 'abc123oldref000000000000000000000000')

    const restored = await readFile(
      join(live, 'packages', 'client', 'ui-open-in-app', 'lib', 'index.js'),
      'utf8',
    )
    assert.match(restored, /LIVE_OLD/)
    assert.doesNotMatch(restored, /STAGING_NEW/)
    const html = await readFile(join(live, 'apps', 'web', 'dist', 'index.html'), 'utf8')
    assert.match(html, /old/)
    const bin = await readFile(join(live, 'apps', 'cli', 'lib', 'bin.js'), 'utf8')
    assert.match(bin, /LIVE_BIN/)
  })
})

describe('rollbackLiveToPreviousRef', () => {
  /** @type {string[]} */
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('checks out previousRef and restores artifact snapshot', async () => {
    const live = await mkdtemp(join(tmpdir(), 'dsh-rb-live-'))
    const backup = await mkdtemp(join(tmpdir(), 'dsh-rb-bak-'))
    temps.push(live, backup)

    await writeLib(live, 'packages/client/ui-open-in-app', 'BROKEN_NEW')
    await writeCliBin(live, 'BROKEN_BIN')
    await writeWebDist(live, '<html>broken</html>\n')

    await writeLib(backup, 'packages/client/ui-open-in-app', 'PRIOR_OK')
    await writeCliBin(backup, 'PRIOR_BIN')
    await writeWebDist(backup, '<html>prior</html>\n')

    /** @type {string[][]} */
    const gitCalls = []
    const runGit = async (args, cwd) => {
      assert.equal(cwd, live)
      gitCalls.push(args.slice())
      if (args[0] === 'checkout' && args[1] === '-f') {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
    }

    const result = await rollbackLiveToPreviousRef({
      liveRoot: live,
      previousRef: 'def456priorref00000000000000000000000',
      artifactBackupRoot: backup,
      runGit,
    })
    assert.equal(result.previousRef, 'def456priorref00000000000000000000000')
    assert.ok(result.artifactsRestored >= 1)
    assert.equal(gitCalls.length, 1)
    assert.deepEqual(gitCalls[0], ['checkout', '-f', 'def456priorref00000000000000000000000'])

    const restored = await readFile(
      join(live, 'packages', 'client', 'ui-open-in-app', 'lib', 'index.js'),
      'utf8',
    )
    assert.match(restored, /PRIOR_OK/)
    const html = await readFile(join(live, 'apps', 'web', 'dist', 'index.html'), 'utf8')
    assert.match(html, /prior/)
  })

  it('rejects missing previousRef', async () => {
    await assert.rejects(
      () =>
        rollbackLiveToPreviousRef({
          liveRoot: tmpdir(),
          previousRef: '',
          runGit: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }),
      /previousRef/,
    )
  })
})
