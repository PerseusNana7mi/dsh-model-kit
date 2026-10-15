import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceMappings, mappingKey } from '../lib/integration/source-mappings.js'
import { requestSchema, replySchema } from '../lib/wire.js'

function fixture() {
  const sections = [
    {
      ns: 'adapter',
      revision: 2,
      value: {
        providers: {
          'gateway/a.b': {
            api: 'openai',
            baseURL: 'https://example.test/v1?secret=fixture',
            headers: { Authorization: 'fixture-only' },
            models: [{ id: 'alias/m' }],
          },
        },
      },
    },
    { ns: 'custom-entry', revision: 5, value: { prices: { keep: { rates: { input: 0 } } }, sourceMappings: {} } },
  ]
  const writes = []
  const settings = {
    writable: true,
    describe: () => sections,
    async mutate(ns, ops, revision) {
      const section = sections.find((row) => row.ns === ns)
      assert.equal(section.revision, revision)
      for (const op of ops) {
        const parent = op.path.slice(0, -1).reduce((row, key) => (row[key] ??= {}), section.value)
        if (op.op === 'unset') delete parent[op.path.at(-1)]
        else parent[op.path.at(-1)] = structuredClone(op.value)
      }
      section.revision++
      writes.push({ ns, ops })
    },
  }
  const options = { catalog: 'https://models.dev/api.json' }
  const mappings = new SourceMappings(
    () => settings,
    'adapter',
    () => 'custom-entry',
    () => options.catalog,
  )
  const reference = {
    referenceProvider: 'vendor',
    referenceModel: 'canonical',
    pricingSource: 'models.dev',
    currency: 'USD',
  }
  const save = () => mappings.save('gateway/a.b', 'alias/m', reference, sections[1].revision, sections[0].revision)
  return { sections, writes, settings, mappings, reference, save, options }
}

test('source mappings are scoped exact references with sanitized replies and independent price storage', async () => {
  const f = fixture()
  const prices = structuredClone(f.sections[1].value.prices)
  const state = await f.save()
  replySchema.parse({ sourceMappings: state })
  assert.equal(state.priceRevisionFrom, 5)
  assert.equal(state.entries[0].status, 'ready')
  assert.equal(state.entries[0].referenceModel, 'canonical')
  assert.equal(f.writes[0].ns, 'custom-entry')
  assert.deepEqual(f.writes[0].ops[0].path, [
    'sourceMappings',
    mappingKey('adapter', 'gateway/a.b', 'alias/m', 'models.dev', 'USD'),
  ])
  assert.deepEqual(f.sections[1].value.prices, prices)
  const persisted = JSON.stringify(f.sections[1].value.sourceMappings)
  assert.ok(!persisted.includes('secret=') && !persisted.includes('Authorization'))
  assert.ok(!JSON.stringify(state).includes('routeHash') && !JSON.stringify(state).includes('catalogUrl'))
  await f.mappings.save('gateway/a.b', 'alias/m', { ...f.reference, pricingSource: 'basellm', currency: 'CNY' }, 6, 2)
  assert.equal(f.mappings.read('gateway/a.b', 'alias/m').entries.length, 2)
  f.sections[0].value.providers['gateway/a.b'].baseURL = 'https://changed.test'
  assert.equal(f.mappings.read('gateway/a.b', 'alias/m').entries[0].status, 'route-changed')
  assert.throws(() => f.mappings.reference('gateway/a.b', 'alias/m', 'models.dev', 'USD', 7, 2), /失效/)
  f.options.catalog = 'https://new.test/catalog'
  assert.equal(f.mappings.read('gateway/a.b', 'alias/m').entries[0].status, 'catalog-changed')
  await f.mappings.clear('gateway/a.b', 'alias/m', 'models.dev', 'USD', 7)
  assert.equal(f.mappings.read('gateway/a.b', 'alias/m').entries[0].currency, 'CNY')
  assert.deepEqual(f.sections[1].value.prices, prices)
})

test('mapping saves reject stale revisions, missing targets, hidden routes, read-only state and capacity overflow', async () => {
  const f = fixture()
  await assert.rejects(f.mappings.save('gateway/a.b', 'alias/m', f.reference, 4, 2), /变化/)
  await assert.rejects(f.mappings.save('gateway/a.b', 'alias/m', f.reference, 5, 1), /变化/)
  await assert.rejects(f.mappings.save('gateway/a.b', 'missing', f.reference, 5, 2), /exactly one/)
  f.settings.writable = false
  await assert.rejects(f.save(), /read-only/)
  f.settings.writable = true
  f.sections[0].secrets = [{ path: ['providers', 'gateway/a.b', 'baseURL'] }]
  await assert.rejects(f.save(), /脱敏/)
  delete f.sections[0].secrets
  await assert.rejects(f.mappings.save('gateway/a.b', 'alias/m', { ...f.reference, currency: 'CNY' }, 5, 2), /USD/)
  f.sections[1].value.sourceMappings = Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [`unrelated-${i}`, {}]),
  )
  await assert.rejects(f.save(), /2000/)
  assert.equal(f.writes.length, 0)
})

test('invalid mapping records can be cleared and price changes never silently rebase a draft', async () => {
  const f = fixture()
  const key = mappingKey('adapter', 'gateway/a.b', 'alias/m', 'models.dev', 'USD')
  f.sections[1].value.sourceMappings[key] = { bogus: true }
  assert.equal(f.mappings.read('gateway/a.b', 'alias/m').entries[0].status, 'invalid')
  const mutate = f.settings.mutate.bind(f.settings)
  f.settings.mutate = async (...args) => {
    await mutate(...args)
    f.sections[1].value.prices.keep.rates.input = 99
    f.sections[1].revision++
  }
  const state = await f.save()
  assert.equal(state.priceRevisionFrom, undefined)
  await assert.rejects(f.mappings.clear('gateway/a.b', 'alias/m', 'models.dev', 'USD', 5), /变化/)
  await f.mappings.clear('gateway/a.b', 'alias/m', 'models.dev', 'USD', 7)
  assert.deepEqual(f.mappings.read('gateway/a.b', 'alias/m').entries, [])
})

test('mapping protocol accepts only confirmed quote tickets and fixed target/source/currency operations', () => {
  const request = {
    action: 'mappingSave',
    provider: 'gateway',
    id: 'alias',
    pricingSource: 'models.dev',
    currency: 'USD',
    quoteTicket: 'ticket',
    revision: 0,
    modelRevision: 0,
    confirmed: true,
  }
  assert.equal(requestSchema.safeParse(request).success, true)
  for (const extra of [
    { confirmed: false },
    { referenceProvider: 'forged' },
    { values: { input: 0 } },
    { path: ['credentials'] },
  ])
    assert.equal(requestSchema.safeParse({ ...request, ...extra }).success, false)
})
