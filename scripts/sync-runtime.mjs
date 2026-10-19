/**
 * Lib-first sync for local development when full TypeScript src is not present.
 * Prefer src/dsh-restart.mjs and src/offline-install.mjs as editable sources.
 * Copy them into lib/ for runtime and pack.
 * Skip tsc unless host .ts files exist under src (client.tsx excluded).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function syncMjs(name) {
  const fromSrc = join(srcDir, name)
  const fromLib = join(libDir, name)
  if (existsSync(fromSrc)) {
    ensureDir(libDir)
    copyFileSync(fromSrc, fromLib)
    console.log(`sync ${name}: src → lib`)
    return
  }
  if (existsSync(fromLib)) {
    ensureDir(srcDir)
    copyFileSync(fromLib, fromSrc)
    console.log(`sync ${name}: lib → src (seed)`)
    copyFileSync(fromSrc, fromLib)
    return
  }
  throw new Error(`missing both src/${name} and lib/${name}`)
}

function listTsSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      listTsSources(p, out)
      continue
    }
    if (ent.name === 'client.tsx') continue
    if (/\.tsx?$/.test(ent.name)) out.push(p)
  }
  return out
}

syncMjs('dsh-restart.mjs')
syncMjs('offline-install.mjs')

const tsFiles = listTsSources(srcDir)
if (tsFiles.length > 0) {
  console.log(`found ${tsFiles.length} TypeScript source(s); run tsc separately if needed`)
} else {
  console.log('no host TypeScript sources under src/ (lib/*.js is the maintained host surface)')
}

console.log('sync-runtime ok')
