import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelImporter } from '../lib/integration/import.js'

function fixture({ declared = true, inherited = false, failCatalog = false } = {}) {
  let revision = 0
  const stored = { providers: { gateway: { api: 'openai-completions', baseURL: 'https://example.test/v1', headers: { Authorization: 'redacted' },
    ...(inherited ? {} : { models: [{ id: 'existing', compat: { supportsDeveloperRole: false } }] }) } } }
  const settings = { writable: true, describe: () => [{ ns: 'models', value: stored, revision }], mutate: async (ns, ops, expected) => {
    assert.equal(ns, 'models'); assert.equal(expected, revision)
    assert.deepEqual(ops[0].path, ['providers', 'gateway', 'models'])
    stored.providers.gateway.models = ops[0].value; revision++
  } }
  const llm = { listConfigurableProviders: () => [{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'models', settingsPath: ['providers', 'gateway'], declared }],
    discoverModels: async (ns, request, signal) => {
      assert.equal(ns, 'models'); assert.deepEqual(request, { provider: 'gateway', api: 'openai-completions', baseURL: 'https://example.test/v1' }); assert.ok(signal)
      return [{ id: 'existing' }, { id: 'unique', name: 'unique' }, { id: 'ambiguous', contextWindow: 64 }, { id: 'unknown' }, { id: 'unique' }]
    } }
  const catalog = { first: { models: { unique: { name: 'Unique Model', limit: { context: 128, output: 16 } }, ambiguous: { limit: { context: 256 } } } }, second: { models: { ambiguous: { limit: { context: 512 } } } } }
  return { stored, settings, bump: () => revision++, importer: new ModelImporter(() => settings, () => llm, 'models', async () => { if (failCatalog) throw Error('offline'); return catalog }, () => new AbortController().signal) }
}

test('discover, exact matching, preview, atomic append and replay rejection', async () => {
  const { importer, stored } = fixture()
  const discovery = await importer.discover('gateway')
  assert.equal(discovery.rows.length, 4)
  assert.equal(discovery.rows[0].existing, true)
  assert.equal(discovery.rows[1].selected, 'first')
  assert.deepEqual(discovery.rows[2].candidates, ['first', 'second'])
  assert.equal(discovery.rows[2].selected, undefined)
  const plan = importer.plan(discovery.ticket, [{ id: 'unique', catalogProvider: 'first' }, { id: 'ambiguous', catalogProvider: 'second' }, { id: 'unknown' }])
  assert.equal(plan.rows[0].model.name, 'Unique Model')
  assert.equal(plan.rows[0].model.maxTokens, 16)
  assert.equal(plan.rows[1].model.contextWindow, 64)
  assert.deepEqual(plan.rows[2].model, { id: 'unknown' })
  await assert.rejects(importer.commit(plan.ticket, false, false), /默认请求/)
  assert.equal(await importer.commit(plan.ticket, true, false), 3)
  assert.deepEqual(stored.providers.gateway.models[0], { id: 'existing', compat: { supportsDeveloperRole: false } })
  assert.equal(stored.providers.gateway.headers.Authorization, 'redacted')
  await assert.rejects(importer.commit(plan.ticket, true, false))
})

test('unknown IDs, invalid sources, duplicate selections, existing models and stale previews fail', async () => {
  const { importer, bump } = fixture()
  const { ticket } = await importer.discover('gateway')
  for (const selections of [[{ id: 'forged' }], [{ id: 'existing' }], [{ id: 'unique', catalogProvider: 'forged' }], [{ id: 'unique' }, { id: 'unique' }]]) assert.throws(() => importer.plan(ticket, selections))
  const plan = importer.plan(ticket, [{ id: 'unknown' }]); bump()
  await assert.rejects(importer.commit(plan.ticket, true, true), /配置已变化/)
})

test('field selection can preserve a missing output cap and explicitly replace a conflicting capacity', async () => {
  const { importer, stored } = fixture()
  const { ticket } = await importer.discover('gateway')
  const plan = importer.plan(ticket, [{ id: 'unique', catalogProvider: 'first' }, { id: 'ambiguous', catalogProvider: 'second' }])
  assert.equal(plan.rows[1].differences.find(row => row.key === 'contextWindow').selected, false)
  await assert.rejects(importer.commit(plan.ticket, false, false, [{ id: 'unique', fields: ['id'] }, { id: 'ambiguous', fields: [] }]))
  await importer.commit(plan.ticket, false, false, [{ id: 'unique', fields: ['name'] }, { id: 'ambiguous', fields: ['contextWindow'] }])
  assert.equal(stored.providers.gateway.models[1].maxTokens, undefined)
  assert.equal(stored.providers.gateway.models[1].name, 'Unique Model')
  assert.equal(stored.providers.gateway.models[2].contextWindow, 512)
})

test('built-in imports need consent; inherited catalogs are never replaced; offline catalog retains discovery', async () => {
  const { importer } = fixture({ declared: false })
  const discovery = await importer.discover('gateway')
  const plan = importer.plan(discovery.ticket, [{ id: 'unknown' }])
  await assert.rejects(importer.commit(plan.ticket, false, false), /预设/)
  assert.equal(await importer.commit(plan.ticket, false, true), 1)
  await assert.rejects(fixture({ declared: false, inherited: true }).importer.discover('gateway'), /继承/)
  const offline = fixture({ failCatalog: true }).importer
  const result = await offline.discover('gateway')
  assert.ok(result.warning)
  assert.deepEqual(result.rows[1].candidates, [])
  const onlyUpstream = offline.plan(result.ticket, [{ id: 'unknown' }])
  assert.equal(await offline.commit(onlyUpstream.ticket, false, false), 1)
})

test('import rejects read-only settings and redacted arrays without changing models', async () => {
  for (const reason of ['readonly', 'redacted']) {
    const { importer, settings, stored } = fixture()
    const found = await importer.discover('gateway')
    const plan = importer.plan(found.ticket, [{ id: 'unknown' }])
    const before = structuredClone(stored)
    if (reason === 'readonly') settings.writable = false
    else {
      const describe = settings.describe
      settings.describe = () => describe().map(row => ({ ...row, secrets: [{ path: ['providers', 'gateway', 'models', 0, 'secret'] }] }))
    }
    await assert.rejects(importer.commit(plan.ticket, false, false), reason === 'readonly' ? /read-only/ : /redacted/)
    assert.deepEqual(stored, before)
  }
})

test('discovery and plan limits invalidate old tickets and allow recovery through discovery', async () => {
  const { importer } = fixture()
  const first = await importer.discover('gateway')
  let latest
  for (let i = 0; i < 20; i++) latest = await importer.discover('gateway')
  assert.throws(() => importer.plan(first.ticket, [{ id: 'unknown' }]), /过期/)
  for (let i = 0; i < 20; i++) importer.plan(latest.ticket, [{ id: 'unknown' }])
  assert.throws(() => importer.plan(latest.ticket, [{ id: 'unknown' }]), /过多/)
  const recovered = await importer.discover('gateway')
  assert.ok(importer.plan(recovered.ticket, [{ id: 'unknown' }]).ticket)
})

test('concurrent discoveries keep bounded sessions and expired plans do not consume capacity', async t => {
  const { importer } = fixture()
  const discoveries = await Promise.all(Array.from({ length: 25 }, () => importer.discover('gateway')))
  for (const row of discoveries.slice(0, 5)) assert.throws(() => importer.plan(row.ticket, [{ id: 'unknown' }]), /过期/)
  const latest = discoveries.at(-1)
  const plan = importer.plan(latest.ticket, [{ id: 'unknown' }])
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 16 * 60_000)
  await assert.rejects(importer.commit(plan.ticket, false, false), /过期/)
  const fresh = await importer.discover('gateway')
  assert.ok(importer.plan(fresh.ticket, [{ id: 'unknown' }]).ticket)
})
