import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewModels, priceDifferences } from '../lib/integration/review.js'
import { requestSchema, replySchema } from '../lib/wire.js'

const url = 'https://models.dev/api.json'
const source = { url, provider: 'vendor', model: 'm', fetchedAt: 1 }
const manual = (rates, currency = 'USD') => ({
  currency,
  unit: 'per-million-tokens',
  mode: 'manual',
  rates: Object.fromEntries(
    Object.entries(rates).map(([key, value]) => [key, { value, origin: 'manual', updatedAt: 1 }]),
  ),
})
const multiplier = (factor = 2) => ({
  ...manual({ input: 9 }),
  mode: 'multiplier',
  multiplier: factor,
  reference: { prices: { input: 1, output: 2, cacheRead: 0 }, source },
})

test('batch price projections preserve zero, unknown fields, currencies and inactive manual prices', () => {
  const changes = priceDifferences(manual({ input: 0, output: 3 }), { input: 2, output: 4, cacheRead: 0 }, 'USD')
  assert.deepEqual(changes, [
    { key: 'input', before: 0, after: 2, selected: false },
    { key: 'output', before: 3, after: 4, selected: false },
    { key: 'cacheRead', before: undefined, after: 0, selected: true },
  ])
  assert.deepEqual(priceDifferences(manual({ input: 2 }), { output: 0 }, 'CNY'), [])
  assert.deepEqual(priceDifferences(multiplier(0), { input: 5, output: 8 }, 'USD'), [])
  assert.deepEqual(priceDifferences(multiplier(), { input: 3, output: 4 }, 'USD'), [
    { key: 'input', before: 2, after: 6, selected: false },
    { key: 'output', before: 4, after: 8, selected: false },
  ])
  for (const value of [NaN, Infinity, -1, 1_000_000_001])
    assert.deepEqual(priceDifferences(undefined, { input: value }, 'USD'), [])
})

function fixture(records = {}, modelEdits = {}) {
  const sections = [
    {
      ns: 'adapter',
      revision: 7,
      value: {
        providers: {
          vendor: {
            displayName: 'Vendor',
            baseURL: 'https://vendor.test',
            models: [
              { id: 'm', name: 'Custom', input: ['text'], reasoningEfforts: false, ...modelEdits },
              { id: 'other' },
            ],
          },
        },
      },
    },
    { ns: 'plugin-entry', revision: 11, value: { prices: records } },
  ]
  let describes = 0
  const settings = {
    writable: false,
    describe(options) {
      assert.equal(options.redactSecrets, true)
      describes++
      return sections
    },
    mutate() {
      assert.fail('Review must not mutate configuration')
    },
  }
  return { settings, sections, describes: () => describes }
}
const options = { targets: [{ provider: 'vendor', id: 'm' }], currency: 'USD', pricingSource: 'models.dev' }
const catalogs = (data) => ({
  metadata: { data, url, fetchedAt: 2 },
  pricing: { data, url, fetchedAt: 2 },
  warnings: [],
})
const catalog = {
  vendor: {
    models: {
      m: {
        name: 'Catalog',
        limit: { context: 128000, output: 8000 },
        modalities: { input: ['text', 'image'] },
        cost: { input: 2, output: 4 },
      },
      other: { name: 'Other', cost: { input: 0, output: 0 } },
    },
  },
}

test('batch review uses one immutable snapshot, isolates bad targets and only proposes fillable fields by default', async () => {
  const f = fixture({ '["adapter","vendor","m"]': manual({ input: 0, cacheRead: 1 }) })
  const before = structuredClone(f.sections)
  let loads = 0
  const result = await reviewModels(
    f.settings,
    'adapter',
    'plugin-entry',
    new Set(['vendor']),
    {
      ...options,
      targets: [...options.targets, { provider: 'vendor', id: 'missing' }, { provider: 'vendor', id: 'other' }],
    },
    async () => {
      loads++
      return catalogs(catalog)
    },
  )
  replySchema.parse({ batchReview: result })
  assert.equal(loads, 1)
  assert.equal(f.describes(), 2)
  assert.equal(result.modelRevision, 7)
  assert.equal(result.priceRevision, 11)
  const [row, missing, other] = result.rows
  assert.equal(row.protectedPreset, false)
  assert.equal(row.parameters.find((field) => field.key === 'name').selected, false)
  assert.equal(row.parameters.find((field) => field.key === 'contextWindow').selected, true)
  assert.equal(row.parameters.find((field) => field.key === 'input').selected, true)
  assert.deepEqual(row.priceChanges, [
    { key: 'input', before: 0, after: 2, selected: false },
    { key: 'output', before: undefined, after: 4, selected: true },
  ])
  assert.equal(row.currentPrices.cacheRead, 1)
  assert.equal(row.referencePrices.cacheRead, undefined)
  assert.match(missing.error, /exactly one/)
  assert.equal(other.priceChanges[0].after, 0)
  assert.deepEqual(f.sections, before)
})

test('batch review rejects duplicate selections before fetching and changed namespace revisions after fetching', async () => {
  let loads = 0
  const f = fixture()
  await assert.rejects(
    reviewModels(
      f.settings,
      'adapter',
      'plugin-entry',
      new Set(),
      {
        ...options,
        targets: [...options.targets, ...options.targets],
      },
      async () => {
        loads++
        return catalogs(catalog)
      },
    ),
    /重复/,
  )
  assert.equal(loads, 0)
  for (const index of [0, 1]) {
    const f = fixture()
    await assert.rejects(
      reviewModels(f.settings, 'adapter', 'plugin-entry', new Set(), options, async () => {
        f.sections[index].revision++
        return catalogs(catalog)
      }),
      /配置已变化/,
    )
  }
})

test('batch multiplier review uses the saved exact reference and skips mismatched sources, consensus and overflow', async () => {
  const data = { ...catalog, reference: { models: { 'exact-reference': { cost: { input: 4, output: 8 } } } } }
  const saved = {
    ...multiplier(),
    reference: {
      prices: { input: 1, output: 2 },
      source: { ...source, provider: 'reference', model: 'exact-reference', method: 'provider', support: 3, total: 5 },
    },
  }
  const f = fixture({ '["adapter","vendor","m"]': saved })
  const result = await reviewModels(f.settings, 'adapter', 'plugin-entry', new Set(), options, async () =>
    catalogs(data),
  )
  const row = result.rows[0]
  assert.equal(row.protectedPreset, true)
  assert.equal(row.referenceSource.provider, 'reference')
  assert.equal(row.referenceSource.model, 'exact-reference')
  assert.equal(row.referenceSource.support, undefined)
  assert.equal(row.referenceSource.total, undefined)
  assert.deepEqual(row.currentPrices, { input: 2, output: 4 })
  assert.deepEqual(row.referencePrices, { input: 4, output: 8 })
  assert.deepEqual(
    row.priceChanges.map((field) => [field.after, field.selected]),
    [
      [8, false],
      [16, false],
    ],
  )
  assert.equal(saved.reference.prices.input, 1)
  for (const patch of [
    { reference: { ...saved.reference, source: { ...saved.reference.source, url: 'https://different.test' } } },
    { reference: { ...saved.reference, source: { ...saved.reference.source, method: 'consensus' } } },
    { multiplier: 1e308 },
  ]) {
    const f = fixture({ '["adapter","vendor","m"]': { ...saved, ...patch } })
    const result = await reviewModels(f.settings, 'adapter', 'plugin-entry', new Set(), options, async () =>
      catalogs(data),
    )
    assert.deepEqual(result.rows[0].priceChanges, [])
    assert.match(result.rows[0].priceMessage, /保留已保存基价/)
  }
})

test('batch reviews keep parameter results when prices are complex, conflicting or in a different currency', async () => {
  for (const [record, cost, expected] of [
    [manual({ input: 1 }, 'CNY'), { input: 2, output: 4 }, /不换币种/],
    [undefined, { input: 2, output: 4, tiers: [{}] }, /固定单价/],
  ]) {
    const f = fixture(record ? { '["adapter","vendor","m"]': record } : {})
    const data = { vendor: { models: { m: { name: 'Catalog', cost } } } }
    const result = await reviewModels(f.settings, 'adapter', 'plugin-entry', new Set(), options, async () =>
      catalogs(data),
    )
    assert.equal(result.rows[0].parameters.length, 1)
    assert.deepEqual(result.rows[0].priceChanges, [])
    assert.match(result.rows[0].priceMessage, expected)
  }
})

test('batch wire requests are bounded, strictly targeted and read-only', () => {
  assert.equal(requestSchema.safeParse({ action: 'batchReview', ...options }).success, true)
  for (const patch of [
    { targets: [] },
    { targets: Array.from({ length: 101 }, (_, i) => ({ provider: 'vendor', id: String(i) })) },
    { targets: [{ provider: 'vendor', id: 'm', path: ['apiKey'] }] },
    { patch: { name: 'Changed' } },
  ])
    assert.equal(requestSchema.safeParse({ action: 'batchReview', ...options, ...patch }).success, false)
})
