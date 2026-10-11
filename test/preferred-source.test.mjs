import test from 'node:test'
import assert from 'node:assert/strict'
import { preferredSource } from '../lib/core/preferred-source.js'

test('prefer developer exact candidates without guessing a reseller or subscription', () => {
  const rows = [{ provider: 'abacus' }, { provider: 'openai' }]
  assert.equal(preferredSource('gpt-example', rows), rows[1])
  assert.equal(preferredSource('unknown', rows), undefined)
  assert.equal(preferredSource('gpt-example', [{ provider: 'abacus' }, { provider: 'azure' }]), undefined)
  assert.equal(preferredSource('glm-example', [{ provider: 'zhipuai-coding-plan' }, { provider: 'abacus' }]), undefined)
  assert.equal(preferredSource('deepseek-chat', [{ provider: 'deepseek' }, ...rows]).provider, 'deepseek')
})

test('GLM international and domestic official entries are both recognized', async () => {
  const { officialProviders, officialSource } = await import('../lib/core/preferred-source.js')
  assert.deepEqual(officialProviders('glm-4.6'), ['zai', 'zhipuai'])
  assert.equal(officialSource('glm-4.6', [{ provider: 'zai' }]).provider, 'zai')
  assert.equal(officialSource('glm-4.6', [{ provider: 'zhipuai' }]).provider, 'zhipuai')
})
