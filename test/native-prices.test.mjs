import test from 'node:test'
import assert from 'node:assert/strict'
import { nativePrices } from '../lib/core/native-prices.js'
import { saveModel, savePrices, saveMultiplier, readPrices } from '../lib/integration/settings.js'

const provider = cost => ({ models: { m: { cost } } })
test('native currency selection never mixes lists and rejects complex/subscription prices', () => {
  const data = provider({ input: 1, output: 2, cache_read: .1, currency_options: { CNY: { input: 7, output: 14 } } })
  assert.deepEqual(nativePrices(data, 'm', 'CNY'), { input: 7, output: 14 })
  assert.deepEqual(nativePrices(data, 'm', 'USD'), { input: 1, output: 2, cacheRead: .1 })
  assert.throws(() => nativePrices(provider({ input: 1, output: 2 }), 'm', 'CNY'))
  for (const extra of [{ schedule: {} }, { tiers: [] }, { reasoning: 3 }]) {
    assert.throws(() => nativePrices(provider({ input: 1, output: 2, ...extra }), 'm', 'USD'))
  }
  assert.throws(() => nativePrices({ ...data, subscription: true }, 'm', 'USD'))
  assert.throws(() => nativePrices(data, 'missing', 'USD'))
})
function settings(value) {
  let rev = 0
  return { writable: true, describe: () => [{ ns: 'test', value, revision: rev }],
    mutate: async (_ns, ops, expected) => {
      assert.equal(expected, rev)
      for (const op of ops) { let node = value; for (const part of op.path.slice(0, -1)) node = node[part]; node[op.path.at(-1)] = op.value }
      rev++
    } }
}
test('preset guard is enforced in backend, consent is per save and preserves other models', async () => {
  const value = { providers: { 'opencode-go': { api: 'test', baseURL: 'https://example.test', models: [{ id: 'm' }, { id: 'other' }] } } }
  const port = settings(value)
  await assert.rejects(saveModel(port, 'test', 'opencode-go', 'm', { name: 'New' }, 0))
  await saveModel(port, 'test', 'opencode-go', 'm', { name: 'New' }, 0, false, true)
  assert.deepEqual(value.providers['opencode-go'].models[1], { id: 'other' })
  await assert.rejects(saveModel(port, 'test', 'opencode-go', 'm', { name: 'Again' }, 1))
})
test('currency switch drops old rates/reference and multiplier cannot reuse other-currency manual values', async () => {
  const port = settings({ prices: {} })
  await savePrices(port, 'test', 'm', { input: 1, output: 2, cacheRead: .1 }, 0)
  await savePrices(port, 'test', 'm', { input: 7, output: 14 }, 1, undefined, 'CNY')
  assert.deepEqual(readPrices(port, 'test', 'm').effective, { input: 7, output: 14 })
  await saveMultiplier(port, 'test', 'm', { prices: { input: 3, output: 6 }, source: { url: 'https://example.test', provider: 'p', model: 'm', fetchedAt: 1 } }, 2, 2, 'USD')
  const saved = readPrices(port, 'test', 'm')
  assert.equal(saved.record.currency, 'USD')
  assert.deepEqual(saved.record.rates, {})
  assert.deepEqual(saved.effective, { input: 6, output: 12 })
})
