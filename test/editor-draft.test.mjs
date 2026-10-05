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
