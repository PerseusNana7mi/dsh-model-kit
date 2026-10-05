import test from 'node:test'
import assert from 'node:assert/strict'
import { recommendCatalog } from '../lib/core/recommend.js'

const model = (input = 3, output = 15, context = 128000) => ({ name: 'Shared', limit: { context, output: 8192 }, modalities: { input: ['text', 'image'] }, cost: { input, output } })
const route = (row, name = 'Vendor', api) => ({ name, api, models: { shared: row } })
const hints = { provider: 'custom-gateway', baseURL: 'https://proxy.example/v1' }

test('official weights recover Kimi efforts without overriding price routing or the requested ID', () => {
  const entry = (efforts, output = 131072) => ({ reasoning: true, reasoning_options: [{ type: 'effort', values: efforts }], limit: { context: 1048576, output }, cost: { input: 3, output: 15 } })
  // Snapshot shape: 18/33 agree on low/high/max, including two official catalogs.
  const catalog = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i === 0 ? 'moonshotai' : i === 1 ? 'moonshotai-cn' : `v${i}`, { models: { 'kimi-k3': entry(i < 18 ? ['low', 'high', 'max'] : i < 23 ? [] : ['none', 'high']) } }]))
  const result = recommendCatalog(catalog, 'models/KIMI-K3', { provider: 'v32' })
  assert.equal(result.method, 'weighted-consensus')
  assert.deepEqual(result.officialProviders, ['moonshotai', 'moonshotai-cn'])
  assert.equal(result.officialWeight, 5)
  assert.equal(result.reasoningSupported, true)
  assert.deepEqual(result.model.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
  assert.equal(result.model.id, 'models/KIMI-K3')
  assert.equal(result.price.provider, 'v32')
})

test('efforts only come from the official source, not votes, toggles or reseller defaults', () => {
  const catalog = { moonshotai: { models: { 'kimi-k3': { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } },
    other: { models: { 'kimi-k3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['medium'] }] } } } }
  const result = recommendCatalog(catalog, 'kimi-k3', hints)
  assert.equal(result.reasoningSupported, true)
  assert.equal(result.model.reasoningEfforts, undefined)
  assert.equal(recommendCatalog({ reseller: catalog.other }, 'kimi-k3', hints).method, 'consensus')
  const conflict = { moonshotai: { models: { 'kimi-k3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['high'] }] } } },
    'moonshotai-cn': { models: { 'kimi-k3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low'] }] } } } }
  assert.deepEqual(recommendCatalog(conflict, 'kimi-k3', hints).model.reasoningEfforts, { high: 'high' })
  assert.deepEqual(recommendCatalog(conflict, 'kimi-k3', { provider: 'moonshotai-cn' }).model.reasoningEfforts, { low: 'low' })
  assert.equal(recommendCatalog({ reseller: catalog.other }, 'kimi-k3', { provider: 'reseller' }).model.reasoningEfforts, undefined)
  const manyResellers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`vendor${i}`, catalog.other]))
  const result2 = recommendCatalog({ ...manyResellers, moonshotai: conflict.moonshotai }, 'kimi-k3', hints)
  assert.deepEqual(result2.model.reasoningEfforts, { high: 'high' })
  assert.equal(result2.reasoningProvider, 'moonshotai')
})

test('ordinary parameters use official weight but still require sixty percent and reject ties', () => {
  const row = context => ({ models: { 'kimi-k3': { limit: { context } } } })
  const catalog = { moonshotai: row(100), a: row(200), b: row(200), c: row(200) }
  assert.equal(recommendCatalog(catalog, 'kimi-k3', hints).model.contextWindow, 100) // 5/8
  assert.equal(recommendCatalog({ ...catalog, d: row(200) }, 'kimi-k3', hints).model.contextWindow, undefined) // 5/9
  assert.equal(recommendCatalog({ moonshotai: row(100), 'moonshotai-cn': row(200) }, 'kimi-k3', hints).model.contextWindow, undefined)
})

test('automatic matching uses provider names, then actual API host, and preserves requested ID', () => {
  const catalog = { openai: route(model(), 'OpenAI'), other: route(model(9, 30, 64000)) }
  let result = recommendCatalog(catalog, 'models/SHARED', { provider: 'Open AI', baseURL: 'https://other.example' })
  assert.equal(result.method, 'provider')
  assert.equal(result.price.provider, 'openai')
  assert.equal(result.model.id, 'models/SHARED')
  result = recommendCatalog(catalog, 'openai/shared', { provider: 'gateway', baseURL: 'https://api.openai.com/v1' })
  assert.equal(result.method, 'base-url')
  assert.equal(result.price.model, 'shared')
  assert.equal(result.price.prices.cacheRead, undefined)
  result = recommendCatalog(catalog, 'shared', { provider: 'gateway', baseURL: 'https://api.openai.com.attacker.test' })
  assert.equal(result.method, 'consensus')
  assert.equal(result.price.status, 'unreliable')
  assert.equal(result.model.contextWindow, undefined)
})

test('unknown gateways get independent field and price consensus without choosing a provider', () => {
  const catalog = { a: route(model()), b: route(model()), c: route(model(9, 30, 64000)) }
  const result = recommendCatalog(catalog, 'shared', hints)
  assert.equal(result.method, 'consensus')
  assert.equal(result.model.contextWindow, 128000)
  assert.equal(result.price.method, 'consensus')
  assert.deepEqual(result.price.prices, { input: 3, output: 15 })
  assert.equal(result.price.support, 2)
  assert.equal(result.price.total, 3)
  assert.deepEqual(result.price.contributors, [{ provider: 'a', model: 'shared' }, { provider: 'b', model: 'shared' }])
})

test('pi-web price threshold permits five agreeing sources but rejects ties and lone sources', () => {
  const entries = Array.from({ length: 11 }, (_, i) => [`v${i}`, route(model(i < 5 ? 3 : i, 15))])
  assert.equal(recommendCatalog(Object.fromEntries(entries), 'shared', hints).price.support, 5)
  assert.equal(recommendCatalog({ a: route(model()), b: route(model(9)) }, 'shared', hints).price.reason, 'conflict')
  assert.equal(recommendCatalog({ a: route(model()) }, 'shared', hints).price.reason, 'insufficient-support')
  assert.equal(recommendCatalog({ a: route(model()) }, 'shared-latest', hints).price.reason, 'no-exact-match')
})

test('complex, subscription and wrong-currency prices never become automatic fixed prices', () => {
  const complex = model(); complex.cost.tiers = [{ input: 6, output: 30 }]
  const catalog = { a: route(complex), b: { ...route(model()), subscription: true }, c: route(model()) }
  const result = recommendCatalog(catalog, 'shared', hints)
  assert.equal(result.model.contextWindow, 128000)
  assert.equal(result.price.reason, 'insufficient-support')
  assert.equal(recommendCatalog(catalog, 'shared', hints, 'CNY').price.reason, 'no-valid-price')
  const native = model(); native.cost.currency_options = { CNY: { input: 8, output: 24 } }
  assert.deepEqual(recommendCatalog({ a: route(native) }, 'shared', { provider: 'a' }, 'CNY').price.prices, { input: 8, output: 24 })
})

test('cache unknowns and ties remain unknown; explicit zero remains free; aliases do not multiply votes', () => {
  const a = model(), b = model(), c = model()
  a.cost.cache_read = 0; b.cost.cache_read = 0; c.cost.cache_read = 1
  a.cost.cache_write = 2; b.cost.cache_write = 3
  const result = recommendCatalog({ a: route(a), b: route(b), c: route(c) }, 'shared', hints)
  assert.equal(result.price.prices.cacheRead, 0)
  assert.equal(result.price.prices.cacheWrite, undefined)
  const aliases = { a: { models: { shared: model(), 'models/shared': model() } }, b: route(model(9)) }
  assert.equal(recommendCatalog(aliases, 'shared', hints).price.status, 'unreliable')
})

test('CNY allows one native fixed-price source while USD still requires corroboration', () => {
  const catalog = { native: { models: { shared: { id: 'shared', cost: { currency: 'CNY', input: 20, output: 100, cache_read: 2 } } } } }
  const result = recommendCatalog(catalog, 'shared', { provider: 'gateway' }, 'CNY')
  assert.equal(result.price.status, 'reliable')
  assert.equal(result.price.provider, 'native')
  assert.equal(result.price.support, 1)
  assert.deepEqual(result.price.prices, { input: 20, output: 100, cacheRead: 2 })
  assert.equal(recommendCatalog(catalog, 'shared', { provider: 'gateway' }, 'USD').price.status, 'unreliable')
  assert.deepEqual(result.priceCandidates, [{ provider: 'native', name: 'native', model: 'shared' }])
})
