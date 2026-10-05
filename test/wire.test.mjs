import test from 'node:test'
import assert from 'node:assert/strict'
import { fields, requestSchema, replySchema } from '../lib/wire.js'
import { lookup } from '../lib/core/catalog.js'
import { readableError } from '../lib/core/errors.js'

test('partial reasoning levels survive catalog discovery and write contracts', () => {
  const catalog = { vendor: { models: { m: { reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } } }
  const model = lookup(catalog, 'vendor', 'm').model
  const reply = replySchema.parse({ discovery: { ticket: 'ticket', protectedPreset: false, rows: [
    { model: { id: 'm' }, existing: false, candidates: ['vendor'], details: [{ provider: 'vendor', name: 'Vendor', model }] },
  ] } })
  assert.deepEqual(reply.discovery.rows[0].details[0].model.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' })
  for (const reasoningEfforts of [false, {}, { high: 'high' }, { off: null, high: 'high' }]) {
    const patch = { reasoningEfforts }
    requestSchema.parse({ action: 'model', provider: 'gateway', id: 'm', patch, revision: 0, acceptDefaultOutputCap: false })
    requestSchema.parse({ action: 'builtinWrite', provider: 'vendor', id: 'm', patch, reset: [], revision: 0, allowPresetOverride: true, acceptDefaultOutputCap: false })
  }
  for (const reasoningEfforts of [{ high: null }, { fake: 'fake' }, { low: '' }]) assert.equal(fields.safeParse({ reasoningEfforts }).success, false)
})

test('schema errors have a concise field diagnostic rather than a JSON issue dump', () => {
  const result = fields.safeParse({ contextWindow: -1 })
  const message = readableError(result.error)
  assert.match(message, /contextWindow/)
  assert.ok(message.length < 150)
  assert.equal(message.includes('invalid_union'), false)
})
