import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

// Use the host's own SemVer dependency, both with npm defaults and host options.
const semver = createRequire(import.meta.resolve('@deepseek-ai/dsh-app-boot'))('semver')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const peers = Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

test('DSH peers admit the supported release line without a version exemption', () => {
  for (const version of ['0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.2.1-alpha.1', '0.2.1', '0.2.9']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
    for (const [name, range] of peers) {
      assert.ok(semver.satisfies(version, range), `${name} must also pass npm's default rules for ${version}`)
    }
  }
  // DSH opts into future patch prereleases; npm requires each new base explicitly.
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.2-alpha.1'), undefined)
})

test('DSH peers reject older runtimes and the next minor, including its prereleases', () => {
  for (const version of ['0.1.9', '0.2.0-alpha.1', '0.2.0-rc.1', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, version)
    assert.equal(issue.exempted, false)
    assert.deepEqual(Object.keys(issue.peers).sort(), peers.map(([name]) => name).sort())
    for (const [, range] of peers) assert.equal(semver.satisfies(version, range), false, version)
  }
})

test('peer ranges keep the pinned development baseline and lockfile consistent', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies)
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    assert.ok(semver.satisfies(manifest.devDependencies[name], range), name)
  }
  for (const [name] of peers) {
    assert.equal(manifest.devDependencies[name], '0.2.0-rc.2', name)
    assert.equal(lock.packages[`node_modules/${name}`].version, '0.2.0-rc.2', name)
  }
  for (const [name, allowed, denied] of [
    ['@deepseek-ai/cordis', '4.0.5', '4.1.0'],
    ['@deepseek-ai/cordis-plugin-loader', '1.0.6', '1.1.0'],
  ]) {
    assert.ok(semver.satisfies(allowed, manifest.peerDependencies[name]))
    assert.equal(semver.satisfies(denied, manifest.peerDependencies[name]), false)
  }
})
