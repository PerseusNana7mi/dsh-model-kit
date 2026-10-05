import test from 'node:test'
import assert from 'node:assert/strict'
import { saveModel, savePrices, saveMultiplier, useManualPrices } from '../lib/integration/settings.js'
import { ModelOverrides } from '../lib/integration/overrides.js'

test('all settings write paths reject read-only settings before mutation', async () => {
  let mutations = 0
  const port = { writable: false, describe: () => [], mutate: async () => { mutations++ } }
  for (const task of [
    () => saveModel(port, 'n', 'p', 'm', {}, 0),
    () => savePrices(port, 'n', 'm', { input: 1 }, 0),
    () => saveMultiplier(port, 'n', 'm', {}, 2, 0),
    () => useManualPrices(port, 'n', 'm', 0),
    () => new ModelOverrides(() => port, () => ({}), 'n', () => new AbortController().signal).write('p', 'm', {}, [], 0, true, true),
  ]) await assert.rejects(task, /read-only/)
  assert.equal(mutations, 0)
})

test('model arrays containing redacted values are never reconstructed', async () => {
  let mutations = 0
  const value = { providers: { gateway: { api: 'test', baseURL: 'https://example.test', models: [{ id: 'm', compat: { token: '[redacted]' } }] } } }
  const before = structuredClone(value)
  const port = { writable: true, describe: () => [{ ns: 'n', value, revision: 0, secrets: [{ path: ['providers', 'gateway', 'models', 0, 'compat', 'token'] }] }],
    mutate: async () => { mutations++ } }
  await assert.rejects(saveModel(port, 'n', 'gateway', 'm', { name: 'New' }, 0), /redacted/)
  assert.equal(mutations, 0)
  assert.deepEqual(value, before)
})

test('builtin discovery ignores invalid host limits', async () => {
  const value = { providers: { p: { modelOverrides: {} } } }
  const port = { writable: true, describe: () => [{ ns: 'n', value, revision: 0 }], mutate: async () => {} }
  const llm = { listConfigurableProviders: () => [{ provider: 'p', settingsNs: 'n', settingsPath: ['providers', 'p'], declared: false }],
    discoverModels: async () => [{ id: 'm', name: 'Model', contextWindow: -1, maxTokens: Number.MAX_SAFE_INTEGER + 1 }] }
  const snapshot = await new ModelOverrides(() => port, () => llm, 'n', () => new AbortController().signal).read('p', 'm')
  assert.deepEqual(snapshot.base, { id: 'm', name: 'Model' })
})
