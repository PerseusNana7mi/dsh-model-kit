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

test('multiplier previews distinguish incomplete drafts, zero and unknown reference prices', async () => {
  const { previewMultipliedPrice, formatPrice } = await import('../lib/client/price-draft.js')
  for (const draft of ['', '   ', '-', '1e', 'invalid', 'Infinity', '-1']) {
    assert.equal(previewMultipliedPrice(3, draft), undefined, draft)
    assert.equal(previewMultipliedPrice(0, draft), undefined, draft)
  }
  assert.equal(formatPrice(previewMultipliedPrice(3, ''), 'USD'), '未知')
  assert.equal(previewMultipliedPrice(3, '0'), 0)
  assert.equal(previewMultipliedPrice(undefined, '0'), undefined)
  assert.equal(previewMultipliedPrice(3, '0.5'), 1.5)
  assert.equal(previewMultipliedPrice(3, '2'), 6)
  assert.equal(previewMultipliedPrice(1, '1000000000'), 1_000_000_000)
  assert.equal(previewMultipliedPrice(3, '1000000000'), undefined)
  assert.equal(previewMultipliedPrice(3, '1e308'), undefined)
})
