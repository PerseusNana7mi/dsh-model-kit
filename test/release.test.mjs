import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectFragments,
  compareVersions,
  git,
  parseFragment,
  parseVersion,
  readPackage,
  renderNotes,
} from '../scripts/release-notes.mjs'
import { createPlan, publishBundle, sealBundle, verifyBundle } from '../scripts/release.mjs'

const fragment = (zh = '修复模型价格保存。', en = 'Fixed model price persistence.') =>
  `${JSON.stringify({ schemaVersion: 1, changes: [{ zh, en }] }, null, 2)}\n`
const released = [{ tag_name: 'v0.1.4', draft: false }]

async function put(cwd, path, value) {
  await mkdir(dirname(join(cwd, path)), { recursive: true })
  await writeFile(join(cwd, path), value)
}

async function version(cwd, value) {
  await put(cwd, 'package.json', JSON.stringify({ name: 'dsh-model-kit', version: value }))
  await put(
    cwd,
    'package-lock.json',
    JSON.stringify({
      name: 'dsh-model-kit',
      version: value,
      packages: { '': { name: 'dsh-model-kit', version: value } },
    }),
  )
}

function commit(cwd) {
  git(cwd, ['add', '.'])
  git(cwd, ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', 'commit', '-m', 'fixture'])
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-release-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(cwd)), resolve(tmpdir()))
    assert.ok(basename(cwd).startsWith('dsh-release-test-'))
    await rm(cwd, { recursive: true, force: true })
  })
  git(cwd, ['init', '--quiet'])
  await put(cwd, '.gitignore', 'work/\n')
  await version(cwd, '0.1.4')
  await put(cwd, '.changes/entries/published.json', fragment('之前发布的修复。', 'Previously released fix.'))
  commit(cwd)
  git(cwd, ['tag', 'v0.1.4'])
  await version(cwd, '0.1.5')
  await put(cwd, '.changes/entries/new-fix.json', fragment())
  commit(cwd)
  return cwd
}

async function bundle(cwd, plan) {
  await put(cwd, 'work/release/manifest.json', JSON.stringify(plan.manifest))
  await put(cwd, 'work/release/notes.md', plan.notes)
  await put(
    cwd,
    'work/archive/package/package.json',
    JSON.stringify({ name: 'dsh-model-kit', version: plan.manifest.version }),
  )
  for (const file of ['lib/index.js', 'lib/client.js', 'LICENSE']) {
    await put(cwd, `work/archive/package/${file}`, 'fixture')
  }
  execFileSync('tar', [
    '-czf',
    join(cwd, `work/release/dsh-model-kit-${plan.manifest.version}.tgz`),
    '-C',
    join(cwd, 'work/archive'),
    'package',
  ])
  return sealBundle(cwd)
}

test('release versions use numeric SemVer ordering, including prerelease identifiers', () => {
  for (const invalid of ['v0.1.5', '01.2.3', '1.2', '1.2.3-beta.01', '1.2.3+build', '1.2.3\n']) {
    assert.throws(() => parseVersion(invalid))
  }
  for (const [a, b] of [
    ['0.1.9', '0.1.10'],
    ['1.0.0-beta.2', '1.0.0-beta.10'],
    ['1.0.0-1', '1.0.0-beta'],
    ['1.0.0-rc.1', '1.0.0'],
  ]) {
    assert.equal(compareVersions(a, b), -1)
    assert.equal(compareVersions(b, a), 1)
  }
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

test('release fragments require paired, bounded, single-line translations', () => {
  assert.equal(parseFragment(fragment(), 'fix.json').length, 1)
  for (const value of [
    fragment('', 'Fixed'),
    fragment('修复', ''),
    fragment('修复\n正文', 'Fixed'),
    fragment('修复', 'a'.repeat(2001)),
    JSON.stringify({ schemaVersion: 1, changes: [{ zh: '修复' }] }),
    JSON.stringify({ schemaVersion: 2, changes: [] }),
  ]) {
    assert.throws(() => parseFragment(value, 'bad.json'))
  }
})

test('notes include only new entries, ordered deterministically, with matching bilingual bullets', async (t) => {
  const cwd = await fixture(t)
  await put(cwd, '.changes/entries/another-fix.json', fragment('新增检查。', 'Added validation.'))
  const collected = await collectFragments(cwd, 'v0.1.4')
  assert.deepEqual(collected.files, ['.changes/entries/another-fix.json', '.changes/entries/new-fix.json'])
  const notes = renderNotes(collected.changes)
  assert.match(notes, /^## 更新内容\n\n- 新增检查。\n- 修复模型价格保存。\n\n## Changes\n/)
  assert.match(notes, /- Added validation.\n- Fixed model price persistence./)
  assert.match(notes, /适用于 DSH Desktop 0.2.x/)
  assert.doesNotMatch(notes, /Previously released/)
})

test('editing or deleting published fragments is rejected', async (t) => {
  const cwd = await fixture(t)
  await put(cwd, '.changes/entries/published.json', fragment())
  await assert.rejects(collectFragments(cwd, 'v0.1.4'), /cannot be edited or deleted/)
  await rm(join(cwd, '.changes/entries/published.json'))
  await assert.rejects(collectFragments(cwd, 'v0.1.4'), /cannot be edited or deleted/)
})

test('empty releases and invalid fragment paths are rejected', async (t) => {
  const cwd = await fixture(t)
  await rm(join(cwd, '.changes/entries/new-fix.json'))
  await assert.rejects(collectFragments(cwd, 'v0.1.4'), /No unpublished/)
  await put(cwd, '.changes/entries/Bad-Name.json', fragment())
  await assert.rejects(collectFragments(cwd, 'v0.1.4'), /lower-case/)
})

test('package and lockfile versions must match before preparing a release', async (t) => {
  const cwd = await fixture(t)
  await put(cwd, 'package.json', JSON.stringify({ name: 'dsh-model-kit', version: '0.1.6' }))
  await assert.rejects(readPackage(cwd), /must agree/)
})

test('release plans pin the tested commit and reject existing tags, drafts and published versions', async (t) => {
  const cwd = await fixture(t)
  const plan = await createPlan(cwd, released)
  assert.equal(plan.manifest.targetSha, git(cwd, ['rev-parse', 'HEAD']))
  assert.equal(plan.manifest.previousTag, 'v0.1.4')
  assert.equal(plan.manifest.tag, 'v0.1.5')
  assert.equal(plan.manifest.prerelease, false)
  await assert.rejects(createPlan(cwd, [...released, { tag_name: 'v0.1.5', draft: true }]), /draft already exists/)
  await assert.rejects(createPlan(cwd, [...released, { tag_name: 'v0.1.6', draft: false }]), /must be newer/)
  git(cwd, ['tag', 'v0.1.5'])
  await assert.rejects(createPlan(cwd, released), /Tag already exists/)
})

test('dry runs can preview changes after the current published version without overwriting it', async (t) => {
  const cwd = await fixture(t)
  await version(cwd, '0.1.4')
  const plan = await createPlan(cwd, released, true)
  assert.equal(plan.manifest.tag, 'v0.1.4')
  assert.deepEqual(plan.manifest.fragmentFiles, ['.changes/entries/new-fix.json'])
  await assert.rejects(createPlan(cwd, released), /already exists/)
})

test('missing or divergent release baselines fail instead of silently duplicating notes', async (t) => {
  const cwd = await fixture(t)
  await assert.rejects(createPlan(cwd, [{ tag_name: 'v0.1.4-beta.1', draft: false }]))
  const originalBranch = git(cwd, ['branch', '--show-current'])
  git(cwd, ['checkout', '--orphan', 'other-history'])
  commit(cwd)
  git(cwd, ['tag', 'v0.1.4-beta.1'])
  git(cwd, ['checkout', originalBranch])
  await assert.rejects(createPlan(cwd, [{ tag_name: 'v0.1.4-beta.1', draft: false }]))
})

test('prerelease plans stay marked as prereleases', async (t) => {
  const cwd = await fixture(t)
  await version(cwd, '0.1.5-beta.1')
  assert.equal((await createPlan(cwd, released)).manifest.prerelease, true)
})

test('release bundles verify package metadata and detect archive, checksum, notes and manifest tampering', async (t) => {
  const cwd = await fixture(t)
  const plan = await createPlan(cwd, released)
  const sealed = await bundle(cwd, plan)
  assert.match(sealed.sha256, /^[a-f0-9]{64}$/)
  assert.equal((await verifyBundle(cwd, plan)).tarball, 'dsh-model-kit-0.1.5.tgz')
  for (const [file, replacement, pattern] of [
    [sealed.tarball, 'tampered', /checksum mismatch/],
    ['SHA256SUMS', 'tampered', /SHA256SUMS changed/],
    ['notes.md', 'tampered', /notes changed/],
    ['manifest.json', JSON.stringify({ ...sealed, targetSha: 'other' }), /manifest changed/],
  ]) {
    const original = await readFile(join(cwd, 'work/release', file))
    await put(cwd, `work/release/${file}`, replacement)
    await assert.rejects(verifyBundle(cwd, plan), pattern)
    await put(cwd, `work/release/${file}`, original)
  }
})

test('packing rejects stale package versions and extra tarballs', async (t) => {
  const cwd = await fixture(t)
  const plan = await createPlan(cwd, released)
  await bundle(cwd, plan)
  await put(cwd, 'work/release/extra.tgz', 'extra')
  await assert.rejects(sealBundle(cwd), /exactly one/)
  await rm(join(cwd, 'work/release/extra.tgz'))
  const manifestPath = join(cwd, 'work/release/manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await put(cwd, 'work/release/manifest.json', JSON.stringify({ ...manifest, version: '0.1.6' }))
  await rm(join(cwd, 'work/release/dsh-model-kit-0.1.5.tgz'))
  execFileSync('tar', [
    '-czf',
    join(cwd, 'work/release/dsh-model-kit-0.1.6.tgz'),
    '-C',
    join(cwd, 'work/archive'),
    'package',
  ])
  await assert.rejects(sealBundle(cwd), /does not match/)
})

test('publication claims the tested tag before creating a release, with prerelease and asset flags', async (t) => {
  const cwd = await fixture(t)
  for (const versionValue of ['0.1.5', '0.1.5-beta.1']) {
    await version(cwd, versionValue)
    const plan = await createPlan(cwd, released)
    const sealed = await bundle(cwd, plan)
    const calls = []
    const url = await publishBundle(cwd, plan, 'owner/repo', (args) => {
      calls.push(args)
      return calls.length === 2 ? 'https://example.invalid/release' : '{}'
    })
    assert.equal(url, 'https://example.invalid/release')
    assert.deepEqual(calls[0], [
      'api',
      '--method',
      'POST',
      'repos/owner/repo/git/refs',
      '-f',
      `ref=refs/tags/v${versionValue}`,
      '-f',
      `sha=${plan.manifest.targetSha}`,
    ])
    assert.deepEqual(calls[1].slice(0, 3), ['release', 'create', `v${versionValue}`])
    for (const arg of [
      '--verify-tag',
      '--notes-file',
      join(cwd, 'work/release', sealed.tarball),
      join(cwd, 'work/release/SHA256SUMS'),
    ]) {
      assert.ok(calls[1].includes(arg), arg)
    }
    assert.equal(calls[1].includes('--prerelease'), Boolean(parseVersion(versionValue).pre))
    assert.equal(calls[1].at(-1), versionValue.includes('-') ? '--latest=false' : '--latest')
    await rm(join(cwd, 'work/release', sealed.tarball))
  }
})

test('publication stops before creating a release when the tag cannot be claimed or the bundle changed', async (t) => {
  const cwd = await fixture(t)
  const plan = await createPlan(cwd, released)
  await bundle(cwd, plan)
  let calls = 0
  const collision = () => {
    calls++
    throw new Error('Tag already exists remotely')
  }
  await assert.rejects(publishBundle(cwd, plan, 'owner/repo', collision), /already exists remotely/)
  assert.equal(calls, 1)
  await put(cwd, 'work/release/notes.md', 'changed')
  await assert.rejects(publishBundle(cwd, plan, 'owner/repo', collision), /notes changed/)
  assert.equal(calls, 1)
})

test('local note preview cannot publish and publishing commands refuse a local context', async (t) => {
  const cwd = await fixture(t)
  const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url))
  execFileSync(process.execPath, [script, 'notes', '--from', 'v0.1.4'], { cwd })
  assert.match(await readFile(join(cwd, 'work/release/notes.md'), 'utf8'), /Fixed model price/)
  assert.equal(git(cwd, ['tag', '--list', 'v0.1.5']), '')
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, 'publish'], {
        cwd,
        env: { ...process.env, GITHUB_ACTIONS: 'false' },
        stdio: 'pipe',
      }),
    /Command failed/,
  )
})

test('all repository change entries follow the bilingual schema', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  for (const name of await readdir(join(root, '.changes/entries'))) {
    parseFragment(await readFile(join(root, '.changes/entries', name), 'utf8'), name)
  }
})
