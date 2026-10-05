import test from 'node:test'
import assert from 'node:assert/strict'
import { lookup, preview } from '../lib/core/catalog.js'

const catalog = { vendor: { models: { example: {
  name: 'Example', limit: { context: 128000, output: 16000 },
  modalities: { input: ['text', 'image', 'audio'] },
  reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
  cost: { input: 0, output: 3, cache_read: 0.2 },
} } } }

test('exact match keeps unknown prices distinct from zero and maps supported fields', () => {
  const result = lookup(catalog, 'vendor', 'example')
  assert.deepEqual(result.prices, { input: 0, output: 3, cacheRead: 0.2 })
  assert.deepEqual(result.model.input, ['text', 'image'])
  assert.deepEqual(result.model.reasoningEfforts, { off: 'none', low: 'low', high: 'high' })
  assert.equal(lookup(catalog, 'gateway', 'example'), undefined)
  assert.equal(lookup(catalog, 'vendor', 'example-latest'), undefined)
})

test('preview preserves explicit overrides and does not mutate either input', () => {
  const match = lookup(catalog, 'vendor', 'example')
  const current = { id: 'example', name: 'Mine', contextWindow: 32000, reasoningEfforts: false }
  const before = structuredClone({ current, match })
  const result = preview(current, match)
  assert.equal(result.proposed.name, 'Mine')
  assert.equal(result.proposed.contextWindow, 32000)
  assert.deepEqual(result.proposed.reasoningEfforts, { off: 'none', low: 'low', high: 'high' })
  assert.equal(result.warnings.length, 1)
  result.proposed.input.push('text')
  assert.deepEqual({ current, match }, before)
})

test('malformed values are omitted and reasoning boolean does not invent levels', () => {
  const result = lookup({ v: { models: { m: {
    reasoning: true, limit: { context: -1, output: 2.5 },
    cost: { input: -3, output: Infinity },
  } } } }, 'v', 'm')
  assert.deepEqual(result.model, { id: 'm' })
  assert.deepEqual(result.prices, {})
  assert.equal(lookup({}, '__proto__', 'x'), undefined)
  assert.throws(() => preview({ id: 'other' }, result), /mismatch/)
})

test('fill replaces false and empty efforts but preserves concrete efforts and unknown recommendations', () => {
  const match = lookup(catalog, 'vendor', 'example')
  for (const reasoningEfforts of [false, {}, { off: null }]) {
    assert.deepEqual(preview({ id: 'example', reasoningEfforts }, match).proposed.reasoningEfforts, match.model.reasoningEfforts)
  }
  const existing = { high: 'custom-high' }
  assert.deepEqual(preview({ id: 'example', reasoningEfforts: existing }, match).proposed.reasoningEfforts, existing)
  assert.equal(preview({ id: 'example', reasoningEfforts: false }, { provider: 'vendor', model: { id: 'example' }, prices: {} }).proposed.reasoningEfforts, false)
})

test('fill restores catalog image input without removing already configured image support', () => {
  const match = lookup(catalog, 'vendor', 'example')
  assert.deepEqual(preview({ id: 'example', input: ['text'] }, match).proposed.input, ['text', 'image'])
  assert.deepEqual(preview({ id: 'example', input: ['text', 'image'] }, { ...match, model: { id: 'example', input: ['text'] } }).proposed.input, ['text', 'image'])
  assert.deepEqual(preview({ id: 'example', input: ['text'] }, { ...match, model: { id: 'example' } }).proposed.input, ['text'])
})
