import test from 'node:test'
import assert from 'node:assert/strict'
import { BatchEditor } from '../lib/integration/batch.js'
import { reviewModels } from '../lib/integration/review.js'
import { requestSchema, replySchema } from '../lib/wire.js'

const source = { url: 'https://models.dev/api.json', provider: 'vendor', model: 'm', fetchedAt: 1 }
async function fixture({ record, declared = true, ttl = false } = {}) {
  const sections = [
    {
      ns: 'adapter',
      revision: 7,
      value: {
        providers: {
          vendor: {
            apiKey: 'fixture-only-secret',
            models: [{ id: 'm', name: 'Custom', compat: { keep: true } }, { id: 'other' }, { id: 'untouched' }],
          },
        },
      },
    },
    { ns: 'plugin', revision: 11, value: { prices: record ? { '["adapter","vendor","m"]': record } : {} } },
  ]
  const writes = []
  const control = { fail: '', declared, afterModel: undefined, hold: undefined, release: undefined }
  const settings = {
    writable: true,
    describe: () => sections,
    async mutate(ns, ops, expected) {
      if (control.hold)
        await new Promise((resolve) => {
          control.release = resolve
        })
      const section = sections.find((row) => row.ns === ns)
      if (section.revision !== expected) throw new Error('SETTINGS_CONFLICT')
      if (control.fail === ns) throw new Error('fixture disk failure')
      for (const op of ops) {
        const parent = op.path.slice(0, -1).reduce((node, key) => (node[key] ??= {}), section.value)
        parent[op.path.at(-1)] = structuredClone(op.value)
      }
      section.revision++
      writes.push({ ns, ops: structuredClone(ops), expected })
      if (ns === 'adapter') control.afterModel?.()
    },
  }
  const catalog = {
    vendor: {
      models: {
        m: { name: 'Catalog', limit: { context: 128000, output: 8000 }, cost: { input: 2, output: 4 } },
        other: { name: 'Other', limit: { context: 64000 }, cost: { input: 0, output: 1 } },
      },
    },
  }
  const editor = new BatchEditor(
    () => settings,
    'adapter',
    () => 'plugin',
    () => new Set(control.declared ? ['vendor'] : []),
  )
  const load = () =>
    reviewModels(
      settings,
      'adapter',
      'plugin',
      new Set(declared ? ['vendor'] : []),
      {
        targets: [
          { provider: 'vendor', id: 'm' },
          { provider: 'vendor', id: 'other' },
        ],
        currency: 'USD',
        pricingSource: 'models.dev',
      },
      async () => ({
        metadata: { data: catalog, url: source.url, fetchedAt: Date.now() },
        pricing: { data: catalog, url: source.url, fetchedAt: Date.now() },
        warnings: [],
      }),
    )
  const review = editor.capture(await load(), 'USD')
  const request = {
    action: 'batchCommit',
    confirmed: true,
    ticket: review.ticket,
    mode: 'fill',
    selections: [
      { provider: 'vendor', id: 'm', fields: ['contextWindow'], prices: ['input', 'output'], updateReference: false },
      { provider: 'vendor', id: 'other', fields: ['name'], prices: ['input'], updateReference: false },
    ],
    acceptDefaultOutputCap: false,
    allowPresetOverride: false,
  }
  return { settings, sections, writes, editor, review, request, control, catalog, load }
}

test('batch commit merges one provider array and writes each namespace once, retaining unselected fields and provenance', async () => {
  const f = await fixture()
  f.review.rows[0].parameters.find((field) => field.key === 'contextWindow').after = '1'
  f.catalog.vendor.models.m.cost.input = 999
  const result = await f.editor.commit(f.request)
  replySchema.parse({ batchSaved: result })
  assert.equal(result.complete, true)
  assert.deepEqual(
    f.writes.map((row) => [row.ns, row.ops.length]),
    [
      ['adapter', 1],
      ['plugin', 2],
    ],
  )
  const models = f.sections[0].value.providers.vendor.models
  assert.deepEqual(models[0], { id: 'm', name: 'Custom', compat: { keep: true }, contextWindow: 128000 })
  assert.deepEqual(models[1], { id: 'other', name: 'Other' })
  assert.deepEqual(models[2], { id: 'untouched' })
  assert.equal(f.sections[0].value.providers.vendor.apiKey, 'fixture-only-secret')
  const record = f.sections[1].value.prices['["adapter","vendor","m"]']
  assert.equal(record.rates.input.value, 2)
  assert.equal(record.rates.input.origin, 'catalog')
  assert.equal(record.rates.cacheRead, undefined)
  assert.equal(record.rates.output.source.provider, 'vendor')
  assert.deepEqual(await f.editor.commit(f.request), result)
  assert.equal(f.writes.length, 2)
})

test('batch preflight rejects all writes for an invalid late row, missing consent, secrets, stale revision and read-only settings', async () => {
  const cases = [
    (f) => {
      f.request.selections[1].fields = ['reasoningEfforts']
    },
    (f) => {
      f.request.selections[1].id = 'forged'
    },
    (f) => {
      f.request.selections[0].fields = ['maxTokens']
    },
    (f) => {
      f.control.declared = false
    },
    (f) => {
      f.sections[0].secrets = [{ path: ['providers', 'vendor', 'models', '0', 'hidden'], set: true }]
    },
    (f) => {
      f.sections[1].revision++
    },
    (f) => {
      f.sections[0].revision++
    },
    (f) => {
      f.settings.writable = false
    },
    (f) => {
      f.request.selections[0].fields = ['name']
    },
    (f) => {
      f.request.selections.push(f.request.selections[0])
    },
    (f) => {
      f.request.selections[0].prices = ['cacheRead']
    },
  ]
  for (const change of cases) {
    const f = await fixture()
    change(f)
    await assert.rejects(f.editor.commit(f.request))
    assert.equal(f.writes.length, 0)
  }
  const f = await fixture({ declared: false })
  f.request.selections[0].fields = ['maxTokens']
  f.request.allowPresetOverride = true
  f.request.acceptDefaultOutputCap = true
  assert.equal((await f.editor.commit(f.request)).complete, true)
})

test('partial batch writes retain the original quote and revision, retry prices only, and refuse changed selections', async () => {
  const f = await fixture()
  f.control.fail = 'plugin'
  const partial = await f.editor.commit(f.request)
  assert.deepEqual([partial.models, partial.prices, partial.retryable], ['saved', 'failed', true])
  assert.equal(f.writes.length, 1)
  const changed = structuredClone(f.request)
  changed.selections[0].fields = []
  await assert.rejects(f.editor.commit(changed), /保留原选择/)
  f.catalog.vendor.models.m.cost.input = 500
  f.control.fail = ''
  const saved = await f.editor.commit(f.request)
  assert.equal(saved.complete, true)
  assert.deepEqual(
    f.writes.map((row) => row.ns),
    ['adapter', 'plugin'],
  )
  assert.equal(f.writes[1].expected, 11)
  assert.equal(f.sections[1].value.prices['["adapter","vendor","m"]'].rates.input.value, 2)
})

test('external writes after a partial save cannot be adopted as a new revision', async () => {
  for (const namespace of [0, 1]) {
    const f = await fixture()
    f.control.fail = 'plugin'
    await f.editor.commit(f.request)
    f.control.fail = ''
    f.sections[namespace].revision++
    await assert.rejects(f.editor.commit(f.request), /配置已变化/)
    assert.equal(f.writes.length, 1)
  }
  const f = await fixture()
  f.control.afterModel = () => {
    f.sections[0].value.providers.vendor.models[1].name = 'External'
    f.sections[0].revision++
  }
  const result = await f.editor.commit(f.request)
  assert.equal(result.models, 'saved')
  assert.equal(result.retryable, false)
  assert.equal(f.writes.length, 1)
})

test('failed model writes do not start price writes, and consent is checked again on retry', async () => {
  const f = await fixture()
  f.control.fail = 'adapter'
  const result = await f.editor.commit(f.request)
  assert.deepEqual([result.models, result.prices, result.retryable], ['failed', 'pending', true])
  f.control.fail = ''
  f.control.declared = false
  await assert.rejects(f.editor.commit(f.request), /覆盖预设/)
  assert.equal(f.writes.length, 0)
  f.request.allowPresetOverride = true
  assert.equal((await f.editor.commit(f.request)).complete, true)
})

test('tickets expire, are bounded, and cannot be committed concurrently', async (t) => {
  const f = await fixture()
  f.control.hold = true
  const pending = f.editor.commit(f.request)
  await assert.rejects(f.editor.commit(f.request), /正在保存/)
  f.control.hold = false
  f.control.release()
  assert.equal((await pending).complete, true)
  for (let i = 0; i < 20; i++) f.editor.capture(f.review, 'USD')
  await assert.rejects(f.editor.commit(f.request), /淘汰/)
  const review = f.editor.capture(await f.load(), 'USD')
  t.mock.method(Date, 'now', () => review.expiresAt)
  await assert.rejects(f.editor.commit({ ...f.request, ticket: review.ticket }), /过期/)
})

test('multiplier batch saves require the whole complete reference, preserve manual prices and keep zero multipliers', async () => {
  for (const multiplier of [0, 2]) {
    const record = {
      currency: 'USD',
      unit: 'per-million-tokens',
      mode: 'multiplier',
      multiplier,
      rates: { input: { value: 99, origin: 'manual', updatedAt: 1 } },
      reference: { prices: { input: 1, output: 3 }, source },
    }
    const f = await fixture({ record })
    assert.equal(f.review.rows[0].referenceUpdateAvailable, true)
    f.request.mode = 'update'
    f.request.selections = [{ provider: 'vendor', id: 'm', fields: [], prices: [], updateReference: true }]
    assert.equal((await f.editor.commit(f.request)).complete, true)
    assert.deepEqual(
      f.writes.map((row) => row.ns),
      ['plugin'],
    )
    const saved = f.sections[1].value.prices['["adapter","vendor","m"]']
    assert.deepEqual(saved.reference.prices, { input: 2, output: 4 })
    assert.equal(saved.rates.input.value, 99)
    assert.equal(saved.multiplier, multiplier)
  }
  const f = await fixture({
    record: {
      currency: 'USD',
      unit: 'per-million-tokens',
      mode: 'multiplier',
      multiplier: 2,
      rates: {},
      reference: { prices: { input: 1, output: 3, cacheRead: 0 }, source },
    },
  })
  assert.notEqual(f.review.rows[0].referenceUpdateAvailable, true)
  f.request.mode = 'update'
  f.request.selections = [{ provider: 'vendor', id: 'm', fields: [], prices: [], updateReference: true }]
  await assert.rejects(f.editor.commit(f.request), /整份/)
  assert.equal(f.writes.length, 0)
})

test('batch commit wire permits only named choices and explicit confirmation, never client-supplied values or sources', async () => {
  const f = await fixture()
  assert.equal(requestSchema.safeParse(f.request).success, true)
  for (const request of [
    { ...f.request, confirmed: false },
    { ...f.request, selections: [] },
    { ...f.request, patch: { name: 'forged' } },
    { ...f.request, selections: [{ ...f.request.selections[0], source }] },
    { ...f.request, selections: [{ ...f.request.selections[0], prices: ['apiKey'] }] },
  ])
    assert.equal(requestSchema.safeParse(request).success, false)
})
