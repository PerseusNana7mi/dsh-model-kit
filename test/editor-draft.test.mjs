import test from 'node:test'
import assert from 'node:assert/strict'
import { draftOf, draftModel, modelPatch } from '../lib/client/model-draft.js'

test('editing a name preserves exact modalities, absent fields and reasoning values', () => {
  for (const input of [undefined, ['image'], ['text'], ['image', 'text']]) {
    const model = { id: 'm', ...(input ? { input } : {}), reasoningEfforts: { off: null, high: 'custom-high' } }
    const draft = draftOf(model)
    assert.deepEqual(modelPatch(draft, model), {})
    draft.name = 'New name'
    assert.deepEqual(modelPatch(draft, model), { name: 'New name' })
    assert.deepEqual(draftModel('m', draft).input, input)
    assert.deepEqual(draftModel('m', draft).reasoningEfforts, model.reasoningEfforts)
  }
})

test('quote invalidation preserves manual and saved rates and formats small prices', async () => {
  const { withoutQuotes, formatPrice } = await import('../lib/client/price-draft.js')
  const draft = {
    values: { input: '0', output: '15', cacheRead: '0.1' },
    quotes: { output: 'old-ticket' },
    edited: ['input'],
  }
  assert.deepEqual(withoutQuotes(draft), { values: { input: '0', cacheRead: '0.1' }, quotes: {}, edited: ['input'] })
  assert.equal(draft.values.output, '15')
  assert.equal(formatPrice(0.1 * 3, 'USD'), '$0.3')
  assert.equal(formatPrice(1e-12, 'CNY'), '¥0.000000000001')
  assert.equal(formatPrice(Infinity, 'USD'), '未知')
})
