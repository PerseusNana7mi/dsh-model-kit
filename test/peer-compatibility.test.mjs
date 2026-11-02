import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { CURRENT_HOST, LEGACY_HOST, legacyManifest } from '../scripts/host-versions.mjs'

// Use the host's own SemVer dependency, both with npm defaults and host options.
const semver = createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))('semver')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
const baseline = manifest.devDependencies['@deepseek-ai/dsh-app-boot']
const usesEngine = baseline === CURRENT_HOST

test('DSH peers admit the supported release line without a version exemption', () => {
  for (const version of [
    '0.2.0-rc.2',
    '0.2.0-rc.3',
    '0.2.0',
    '0.2.1-alpha.1',
    '0.2.1-rc.2',
    CURRENT_HOST,
    '0.2.1',
    '0.2.9',
  ]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
    for (const [name, range] of peers) {
      assert.ok(semver.satisfies(version, range), `${name} must also pass npm's default rules for ${version}`)
    }
  }
  // DSH opts into future patch prereleases; npm requires each new base explicitly.
  for (const version of ['0.2.2-alpha.1', '0.2.2-alpha.2']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
    assert.equal(semver.satisfies(version, manifest.engines.dsh), false)
  }
})

test('DSH peers reject older runtimes and the next minor, including its prereleases', () => {
  for (const version of ['0.1.9', '0.2.0-alpha.1', '0.2.0-rc.1', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, version)
    assert.equal(issue.exempted, false)
    if (usesEngine) assert.deepEqual(issue.requirements, { 'engines.dsh': manifest.engines.dsh })
    else assert.deepEqual(issue.peers, Object.fromEntries(peers))
    for (const [, range] of peers) assert.equal(semver.satisfies(version, range), false, version)
  }
})

test('host-specific engine precedence and peer fallback are explicit', () => {
  const incompatiblePeers = { ...manifest, peerDependencies: { '@deepseek-ai/dsh-llm': '^0.3.0' } }
  const result = evaluatePluginCompatibility(incompatiblePeers, {}, baseline)
  if (usesEngine) assert.equal(result, undefined)
  else assert.deepEqual(result.peers, incompatiblePeers.peerDependencies)

  const incompatibleEngine = { ...manifest, engines: { ...manifest.engines, dsh: '^0.3.0' } }
  const rejected = evaluatePluginCompatibility(incompatibleEngine, {}, baseline)
  if (usesEngine) assert.deepEqual(rejected.requirements, { 'engines.dsh': '^0.3.0' })
  else assert.equal(rejected, undefined)

  const { engines, ...noEngine } = incompatiblePeers
  const fallback = evaluatePluginCompatibility(noEngine, {}, baseline)
  assert.deepEqual(usesEngine ? fallback.requirements : fallback.peers, incompatiblePeers.peerDependencies)
})

test('peer ranges keep the pinned development baseline and lockfile consistent', async () => {
  assert.ok([CURRENT_HOST, LEGACY_HOST].includes(baseline), baseline)
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies)
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies)
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies)
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    assert.ok(semver.satisfies(manifest.devDependencies[name], range), name)
  }
  for (const name of Object.keys(manifest.devDependencies).filter((name) => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.equal(manifest.devDependencies[name], baseline, name)
    assert.equal(lock.packages[`node_modules/${name}`].version, baseline, name)
    const installed = JSON.parse(
      await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
    )
    assert.equal(installed.version, baseline, name)
  }
  for (const [name, allowed, denied] of [
    ['@deepseek-ai/cordis', '4.0.5', '4.1.0'],
    ['@deepseek-ai/cordis-plugin-loader', '1.0.6', '1.1.0'],
  ]) {
    assert.ok(semver.satisfies(allowed, manifest.peerDependencies[name]))
    assert.equal(semver.satisfies(denied, manifest.peerDependencies[name]), false)
  }
})

test('legacy lock retains the published dependency contract and all development tools', async () => {
  const lock = JSON.parse(await readFile(new URL('../compat/legacy-package-lock.json', import.meta.url), 'utf8'))
  const expected = legacyManifest(manifest)
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'engines']) {
    assert.deepEqual(lock.packages[''][key], expected[key], key)
  }
  for (const file of ['../package-lock.json', '../compat/legacy-package-lock.json']) {
    const graph = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))
    for (const [name, entry] of Object.entries(graph.packages)) {
      if (entry.resolved) assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/'), `${file}: ${name}`)
    }
  }
})
