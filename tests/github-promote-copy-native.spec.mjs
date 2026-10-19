/**
 * Promote must copy native/system entry lib (gitignored) from staging → live.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, after } from 'node:test'
import { copyHarnessBuildArtifacts, listHarnessLibDirs } from '../lib/github-promote.js'

describe('listHarnessLibDirs + copy includes native', () => {
  const temps = []
  after(async () => {
    for (const dir of temps) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists native/.../lib and copies flock.js onto live', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'dsh-copy-native-stg-'))
    const live = await mkdtemp(join(tmpdir(), 'dsh-copy-native-live-'))
    temps.push(staging, live)

    const entryLib = join(staging, 'native', 'system', 'packages', 'entry', 'lib')
    await mkdir(entryLib, { recursive: true })
    await writeFile(join(entryLib, 'flock.js'), 'export const tryLockExclusive = () => {}\n', 'utf8')
    await writeFile(join(entryLib, 'index.js'), 'export {}\n', 'utf8')

    const pkgLib = join(staging, 'packages', 'util', 'demo', 'lib')
    await mkdir(pkgLib, { recursive: true })
    await writeFile(join(pkgLib, 'index.js'), 'export {}\n', 'utf8')

    const listed = await listHarnessLibDirs(staging)
    assert.ok(listed.some((p) => /native[/\\]system[/\\]packages[/\\]entry[/\\]lib$/i.test(p)))

    const n = await copyHarnessBuildArtifacts(staging, live)
    assert.ok(n >= 2)
    const liveFlock = join(live, 'native', 'system', 'packages', 'entry', 'lib', 'flock.js')
    const body = await readFile(liveFlock, 'utf8')
    assert.match(body, /tryLockExclusive/)
  })
})
