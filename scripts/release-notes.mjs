import { execFileSync } from 'node:child_process'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

export const FRAGMENT_DIR = '.changes/entries'
export const COMPATIBILITY_NOTE =
  '适用于 DSH Desktop 0.2.x，开发测试基线为 0.2.0-rc.2。模型参数与价格通过 DSH 保存到当前配置文件；插件不会自动计算会话费用。安装和使用说明见仓库 README。'

export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (
    typeof version !== 'string' ||
    !match ||
    match[0] !== version ||
    match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')
  ) {
    throw new Error(`Invalid release version: ${version}`)
  }
  return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') }
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1
  }
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export async function readPackage(cwd) {
  const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
  parseVersion(manifest.version)
  if (
    manifest.name !== 'dsh-model-kit' ||
    lock.name !== manifest.name ||
    lock.packages?.['']?.name !== manifest.name ||
    lock.version !== manifest.version ||
    lock.packages?.['']?.version !== manifest.version
  ) {
    throw new Error('package.json and package-lock.json names/versions must agree')
  }
  return { name: manifest.name, version: manifest.version }
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  )
}

export function parseFragment(text, file) {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error(`Fragment is too large: ${file}`)
  const fragment = JSON.parse(text)
  if (
    !exactKeys(fragment, ['schemaVersion', 'changes']) ||
    fragment.schemaVersion !== 1 ||
    !Array.isArray(fragment.changes) ||
    !fragment.changes.length ||
    fragment.changes.length > 20
  ) {
    throw new Error(`Invalid change fragment: ${file}`)
  }
  for (const change of fragment.changes) {
    if (!exactKeys(change, ['zh', 'en'])) throw new Error(`Expected paired zh/en entries: ${file}`)
    for (const lang of ['zh', 'en']) {
      const value = change[lang]
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value !== value.trim() ||
        value.length > 2000 ||
        /[\u0000-\u001f\u007f\u2028\u2029]/.test(value) ||
        (lang === 'zh' ? !/\p{Script=Han}/u.test(value) : !/[A-Za-z]/.test(value))
      ) {
        throw new Error(`Expected a nonempty single-line ${lang} summary: ${file}`)
      }
    }
  }
  return fragment.changes
}

export async function collectFragments(cwd, previousTag = null) {
  let files = []
  try {
    files = await readdir(join(cwd, FRAGMENT_DIR))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (files.some((file) => !/^[a-z0-9][a-z0-9-]*\.json$/.test(file))) {
    throw new Error(`Only lower-case, hyphenated JSON fragment files are allowed in ${FRAGMENT_DIR}`)
  }
  const oldFiles = previousTag ? git(cwd, ['ls-tree', '-r', '--name-only', previousTag, '--', FRAGMENT_DIR]) : ''
  const published = new Set(oldFiles ? oldFiles.split('\n') : [])
  const current = new Map()
  for (const file of files.sort()) {
    const path = `${FRAGMENT_DIR}/${file}`
    if (!(await lstat(join(cwd, path))).isFile()) throw new Error(`Fragment must be a regular file: ${path}`)
    const text = await readFile(join(cwd, path), 'utf8')
    const changes = parseFragment(text, path)
    current.set(path, { text, changes })
  }
  for (const path of published) {
    const previous = git(cwd, ['show', `${previousTag}:${path}`])
    if (!current.has(path) || current.get(path).text.trim() !== previous) {
      throw new Error(`Published fragments cannot be edited or deleted; add a new fragment: ${path}`)
    }
  }
  const fresh = [...current].filter(([path]) => !published.has(path))
  if (!fresh.length) throw new Error('No unpublished bilingual change fragments found')
  if (fresh.length > 100) throw new Error('Too many change fragments for one release')
  return { files: fresh.map(([path]) => path), changes: fresh.flatMap(([, entry]) => entry.changes) }
}

export function renderNotes(changes) {
  return `## 更新内容\n\n${changes.map(({ zh }) => `- ${zh}`).join('\n')}\n\n## Changes\n\n${changes.map(({ en }) => `- ${en}`).join('\n')}\n\n${COMPATIBILITY_NOTE}\n`
}
