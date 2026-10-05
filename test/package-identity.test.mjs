import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PACKAGE_NAME } from '../lib/package-identity.js'
import { descriptors, remoteContribution } from '../lib/wire.js'

test('published manifest, Loader and remote contract agree on the renamed package', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  const patch = await readFile(manifest.dsh.bundle.patch, 'utf8')
  assert.equal(PACKAGE_NAME, 'dsh-model-kit')
  assert.equal(manifest.name, PACKAGE_NAME)
  assert.equal(lock.name, PACKAGE_NAME)
  assert.equal(lock.packages[''].name, PACKAGE_NAME)
  assert.match(patch, /id: model-metadata\s+name: dsh-model-kit/)
  assert.equal(remoteContribution.package, PACKAGE_NAME)
  assert.equal(descriptors[0].id, `${PACKAGE_NAME}#modelMetadataUi/execute`)
  assert.equal(descriptors[0].parameters[0].codec.typeSymbol, `${PACKAGE_NAME}#Request`)
  assert.equal(descriptors[0].result.typeSymbol, `${PACKAGE_NAME}#Reply`)
})
