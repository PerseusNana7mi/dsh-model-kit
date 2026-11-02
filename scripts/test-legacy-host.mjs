import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { legacyManifest, LEGACY_HOST } from './host-versions.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.some((arg) => !['--update-lock', '--ui'].includes(arg))) throw new Error('Unknown legacy test option')
const updateLock = args.includes('--update-lock')
const lockPath = join(root, 'compat/legacy-package-lock.json')
const manifest = legacyManifest(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
const lock = JSON.parse(await readFile(lockPath, 'utf8'))
if (!updateLock) {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'engines']) {
    if (!isDeepStrictEqual(lock.packages[''][key], manifest[key])) {
      throw new Error(`Legacy lock ${key} is stale; run npm run test:legacy -- --update-lock`)
    }
  }
}
// Version-only releases do not require resolving a different dependency graph.
lock.name = lock.packages[''].name = manifest.name
lock.version = lock.packages[''].version = manifest.version
await mkdir(join(root, 'work'), { recursive: true })
const cwd = await mkdtemp(join(root, 'work', 'host-legacy-'))
console.log(`DSH ${LEGACY_HOST} isolated test workspace: ${cwd}`)
for (const path of [
  'src',
  'scripts',
  'test',
  'compat',
  'docs',
  'assets',
  'locale',
  '.changes',
  '.github',
  'tsconfig.json',
  'tsconfig.test.json',
  'eslint.config.mjs',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  '.gitignore',
])
  await cp(join(root, path), join(cwd, path), { recursive: true })
await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(join(cwd, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
function npm(args) {
  // npm run provides its CLI path: no shell interpolation, including on Windows.
  if (!process.env.npm_execpath) throw new Error('Run this script through npm run test:legacy')
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status})`)
}
if (updateLock) {
  npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
  await cp(join(cwd, 'package-lock.json'), lockPath)
  console.log('Updated the legacy lock only; no tests were run.')
} else {
  npm(['ci', '--no-audit', '--no-fund'])
  npm(['run', 'verify'])
  if (args.includes('--ui')) npm(['run', 'test:ui'])
}
