import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Plugin from '../lib/index.js'
import { PACKAGE_NAME } from '../lib/package-identity.js'

// An isolated profile uses the real boot, Loader, Settings and disk editor.
// Only the LLM adapter is a schema fixture: no credentials or model calls.
async function fixture(t, defaultDirectory = true, metadataConfig = {}) {
  const scratch = resolve('work')
  await mkdir(scratch, { recursive: true })
  const home = await mkdtemp(join(scratch, 'settings-'))
  const dir = join(home, 'profiles', 'isolated')
  initProfile(dir, ['fixture-bundle'])
  const bundle = join(dir, 'node_modules', 'fixture-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'isolated-test-installation' }))
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  await writeFile(
    join(bundle, 'cordis.patch.yml'),
    JSON.stringify([
      {
        insert: [
          { id: 'typert', name: 'cordis:test-typert' },
          { id: 'settings', name: 'cordis:test-settings' },
          { id: 'config-editor', name: 'cordis:test-editor' },
          { id: 'model-metadata', name: 'cordis:test-metadata', config: metadataConfig },
          {
            id: 'llm-pi-ai',
            name: 'cordis:test-models',
            config: {
              providers: {
                'gateway.with/slashes': {
                  api: 'openai-completions',
                  baseURL: 'https://example.test/v1',
                  apiKeyEnv: 'SECRET_REF',
                  headers: { Authorization: 'secret-value' },
                  models: [
                    { id: 'm', name: 'My model', compat: { supportsDeveloperRole: false } },
                    { id: 'other', name: 'Untouched' },
                  ],
                },
                'builtin-test': {
                  modelOverrides: {
                    catalog: { contextWindow: 64, compat: { supportsDeveloperRole: false } },
                    other: { name: 'Keep' },
                  },
                },
              },
            },
          },
        ],
      },
    ]),
  )
  const entry = join(dir, 'cordis.yml')
  await writeFile(entry, '[]')
  const profile = {
    name: 'isolated',
    startedBundles: ['fixture-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    home,
    cwd: home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const Models = {
    Config: Schema.object({
      providers: Schema.dict(
        Schema.object({
          api: Schema.string(),
          baseURL: Schema.string(),
          apiKeyEnv: Schema.string(),
          headers: Schema.dict(Schema.string().role('secret')),
          models: Schema.array(
            Schema.object({
              id: Schema.string().required(),
              name: Schema.string(),
              contextWindow: Schema.number().min(1).step(1),
              maxTokens: Schema.number().min(1).step(1),
              input: Schema.array(Schema.union(['text', 'image'])),
              reasoningEfforts: Schema.union([
                Schema.const(false),
                Schema.dict(Schema.union([Schema.string(), Schema.const(null)])),
              ]),
              compat: Schema.object({ supportsDeveloperRole: Schema.boolean() }),
            }),
          ),
          modelOverrides: Schema.dict(
            Schema.object({
              name: Schema.string(),
              contextWindow: Schema.number().min(1).step(1),
              maxTokens: Schema.number().min(1).step(1),
              input: Schema.array(Schema.union(['text', 'image'])),
              reasoningEfforts: Schema.union([
                Schema.const(false),
                Schema.dict(Schema.union([Schema.string(), Schema.const(null)])),
              ]),
              compat: Schema.object({ supportsDeveloperRole: Schema.boolean() }),
            }),
          ),
        }),
      )
        .default({})
        .volatile(),
    }),
    apply() {},
  }
  const contexts = []
  const start = async () => {
    const ctx = await boot('dsh', entry, readProfilePatches('dsh', profile), (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', {
        onReady(fn) {
          fn()
          return () => {}
        },
      })
      Object.assign(ctx.loader.builtins, {
        'test-typert': Typert,
        'test-settings': Settings,
        'test-editor': ConfigEditor,
        'test-metadata': Plugin,
        [PACKAGE_NAME]: Plugin,
        'test-models': Models,
      })
    })
    if (defaultDirectory)
      ctx.provide('llm', {
        listConfigurableProviders: () => [
          {
            provider,
            displayName: 'Gateway',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', provider],
            declared: true,
          },
        ],
      })
    contexts.push(ctx)
    return ctx
  }
  t.after(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    const target = resolve(home)
    if (!target.startsWith(scratch + sep)) throw new Error('Unsafe test cleanup path')
    await rm(target, { recursive: true, force: true })
  })
  return { ctx: await start(), start, profile, bundle }
}

const provider = 'gateway.with/slashes'

test('confirmed alias mappings persist through real Settings restart and fetch fresh prices without changing saved prices', async (t) => {
  const { ctx, start } = await fixture(t)
  const service = ctx.modelMetadata
  let input = 3
  let missing = false
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          vendor: { models: missing ? {} : { canonical: { cost: { input, output: 4, cache_read: 0 } } } },
        }),
      ),
  )
  await service.savePrices(provider, 'm', { input: 0 }, service.readPrices(provider, 'm').revision)
  const quote = await service.quotePrices('vendor', 'canonical', 'USD', 'models.dev', 'm', provider)
  await service.setPriceMultiplier(
    provider,
    'm',
    'vendor',
    'canonical',
    2,
    service.readPrices(provider, 'm').revision,
    'USD',
    'models.dev',
    quote.ticket,
  )
  const before = service.readPrices(provider, 'm')
  const state = service.sourceMappings.read(provider, 'm')
  const request = {
    action: 'mappingSave',
    provider,
    id: 'm',
    pricingSource: 'models.dev',
    currency: 'USD',
    quoteTicket: quote.ticket,
    revision: state.revision,
    modelRevision: state.modelRevision,
    confirmed: true,
  }
  const result = await ctx.modelMetadataUi.execute(request)
  assert.equal(result.sourceMappings.entries[0].referenceModel, 'canonical')
  assert.equal(result.sourceMappings.priceRevisionFrom, before.revision)
  assert.deepEqual(service.readPrices(provider, 'm').record, before.record)
  const recovered = (await start()).modelMetadata
  let restored = recovered.sourceMappings.read(provider, 'm')
  assert.equal(restored.entries[0].status, 'ready')
  input = 9
  const fresh = await recovered.useSourceMapping(
    provider,
    'm',
    'models.dev',
    'USD',
    restored.revision,
    restored.modelRevision,
  )
  assert.equal(fresh.prices.input, 9)
  assert.equal(fresh.prices.cacheRead, 0)
  assert.deepEqual(recovered.readPrices(provider, 'm').record, before.record)
  assert.equal(recovered.readPrices(provider, 'm').effective.input, 6)
  missing = true
  await assert.rejects(
    recovered.useSourceMapping(provider, 'm', 'models.dev', 'USD', restored.revision, restored.modelRevision),
    /exact reference/,
  )
  assert.equal(recovered.sourceMappings.read(provider, 'm').entries.length, 1)
  await recovered.sourceMappings.clear(provider, 'm', 'models.dev', 'USD', restored.revision)
  restored = (await start()).modelMetadata.sourceMappings.read(provider, 'm')
  assert.deepEqual(restored.entries, [])
})

test('remembered sources reject unbound, cross-target, expired and stale-model quotes', async (t) => {
  const { ctx } = await fixture(t)
  const service = ctx.modelMetadata
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ vendor: { models: { canonical: { cost: { input: 1, output: 2 } } } } })),
  )
  const state = service.sourceMappings.read(provider, 'm')
  const base = {
    action: 'mappingSave',
    provider,
    id: 'm',
    pricingSource: 'models.dev',
    currency: 'USD',
    revision: state.revision,
    modelRevision: state.modelRevision,
    confirmed: true,
  }
  const unbound = await service.quotePrices('vendor', 'canonical', 'USD', 'models.dev', 'm')
  await assert.rejects(service.rememberSource({ ...base, quoteTicket: unbound.ticket }), /明确选择/)
  const quote = await service.quotePrices('vendor', 'canonical', 'USD', 'models.dev', 'm', provider)
  await assert.rejects(service.rememberSource({ ...base, provider: 'another', quoteTicket: quote.ticket }), /明确选择/)
  await assert.rejects(service.rememberSource({ ...base, id: 'other', quoteTicket: quote.ticket }), /模型不匹配/)
  await assert.rejects(service.rememberSource({ ...base, currency: 'CNY', quoteTicket: quote.ticket }), /币种不匹配/)
  await service.saveModel(provider, 'm', { name: 'Changed' }, state.modelRevision)
  await assert.rejects(
    service.rememberSource({
      ...base,
      modelRevision: service.readModel(provider, 'm').revision,
      quoteTicket: quote.ticket,
    }),
    /明确选择/,
  )
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 31 * 60_000)
  await assert.rejects(service.rememberSource({ ...base, quoteTicket: quote.ticket }), /过期/)
  assert.deepEqual(service.sourceMappings.read(provider, 'm').entries, [])
})

test('native remembered references preserve currency and reject configuration changes during fresh retrieval', async (t) => {
  const { ctx } = await fixture(t)
  const service = ctx.modelMetadata
  let changeDuringFetch = false
  t.mock.method(globalThis, 'fetch', async () => {
    if (changeDuringFetch) {
      changeDuringFetch = false
      await service.saveModel(provider, 'm', { name: 'Concurrent edit' }, service.readModel(provider, 'm').revision)
    }
    return new Response(JSON.stringify({ models: { canonical: { cost: { input: 0, output: 2, currency: 'CNY' } } } }))
  })
  const quote = await service.quotePrices('vendor', 'canonical', 'CNY', 'basellm', 'm', provider)
  let state = service.sourceMappings.read(provider, 'm')
  await service.rememberSource({
    action: 'mappingSave',
    provider,
    id: 'm',
    pricingSource: 'basellm',
    currency: 'CNY',
    quoteTicket: quote.ticket,
    revision: state.revision,
    modelRevision: state.modelRevision,
    confirmed: true,
  })
  state = service.sourceMappings.read(provider, 'm')
  const price = await service.useSourceMapping(provider, 'm', 'basellm', 'CNY', state.revision, state.modelRevision)
  assert.equal(price.prices.input, 0)
  await assert.rejects(
    service.useSourceMapping(provider, 'm', 'basellm', 'USD', state.revision, state.modelRevision),
    /不存在或已失效/,
  )
  changeDuringFetch = true
  await assert.rejects(
    service.useSourceMapping(provider, 'm', 'basellm', 'CNY', state.revision, state.modelRevision),
    /配置已变化/,
  )
  assert.equal(service.readPrices(provider, 'm').record, undefined)
})

test('consensus quotations cannot be remembered as a single reference mapping', async (t) => {
  const { ctx } = await fixture(t)
  const service = ctx.modelMetadata
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify(
          Object.fromEntries(
            ['vendor-a', 'vendor-b'].map((vendor) => [vendor, { models: { m: { cost: { input: 1, output: 2 } } } }]),
          ),
        ),
      ),
  )
  const recommendation = await service.recommend(provider, 'm', 'USD', 'models.dev')
  assert.equal(recommendation.priceQuote.source.method, 'consensus')
  const state = service.sourceMappings.read(provider, 'm')
  await assert.rejects(
    service.rememberSource({
      action: 'mappingSave',
      provider,
      id: 'm',
      pricingSource: 'models.dev',
      currency: 'USD',
      quoteTicket: recommendation.priceQuote.ticket,
      revision: state.revision,
      modelRevision: state.modelRevision,
      confirmed: true,
    }),
    /明确选择/,
  )
  assert.deepEqual(service.sourceMappings.read(provider, 'm').entries, [])
})

test('batch field selections persist with one real mutation per namespace and recover after restart', async (t) => {
  const { ctx, profile, start } = await fixture(t)
  const service = ctx.modelMetadata
  let price = 2
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          vendor: {
            api: 'https://example.test/v1',
            models: {
              m: { name: 'Directory', limit: { context: 128000, output: 8000 }, cost: { input: price, output: 4 } },
              other: { limit: { context: 64000 }, cost: { input: 0, output: 1 } },
            },
          },
        }),
      ),
  )
  const review = (
    await ctx.modelMetadataUi.execute({
      action: 'batchReview',
      targets: [
        { provider, id: 'm' },
        { provider, id: 'other' },
      ],
    })
  ).batchReview
  const request = {
    action: 'batchCommit',
    confirmed: true,
    ticket: review.ticket,
    mode: 'update',
    selections: [
      {
        provider,
        id: 'm',
        fields: ['contextWindow', 'maxTokens'],
        prices: ['input', 'output'],
        updateReference: false,
      },
      { provider, id: 'other', fields: ['contextWindow'], prices: ['input'], updateReference: false },
    ],
    allowPresetOverride: false,
    acceptDefaultOutputCap: false,
  }
  const before = await readFile(profile.patchPath, 'utf8').catch(() => '')
  await assert.rejects(ctx.modelMetadataUi.execute(request), /默认请求输出上限/)
  assert.equal(await readFile(profile.patchPath, 'utf8').catch(() => ''), before)
  const mutate = ctx.settings.mutate.bind(ctx.settings)
  const writes = []
  t.mock.method(ctx.settings, 'mutate', async (...args) => {
    writes.push(args)
    return mutate(...args)
  })
  price = 999
  request.acceptDefaultOutputCap = true
  const result = (await ctx.modelMetadataUi.execute(request)).batchSaved
  assert.equal(result.complete, true)
  assert.deepEqual(
    writes.map(([ns, ops]) => [ns, ops.length]),
    [
      ['llm-pi-ai', 1],
      ['model-metadata', 2],
    ],
  )
  assert.equal(service.readModel(provider, 'm').model.name, 'My model')
  assert.equal(service.readModel(provider, 'other').model.contextWindow, 64000)
  assert.equal(service.readPrices(provider, 'm').effective.input, 2)
  const restarted = await start()
  assert.equal(restarted.modelMetadata.readModel(provider, 'm').model.maxTokens, 8000)
  assert.equal(restarted.modelMetadata.readPrices(provider, 'other').effective.input, 0)
  assert.deepEqual((await ctx.modelMetadataUi.execute(request)).batchSaved, result)
  assert.equal(writes.length, 2)
  await assert.rejects(restarted.modelMetadataUi.execute(request), /过期|淘汰/)
})

test('real Settings batch partial failure retries only the original price mutation and never adopts an external price revision', async (t) => {
  const { ctx } = await fixture(t)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          vendor: {
            api: 'https://example.test/v1',
            models: {
              m: { limit: { context: 128000 }, cost: { input: 2, output: 4 } },
            },
          },
        }),
      ),
  )
  const plan = await ctx.modelMetadata.batchReview([{ provider, id: 'm' }])
  const request = {
    action: 'batchCommit',
    confirmed: true,
    ticket: plan.ticket,
    mode: 'fill',
    selections: [{ provider, id: 'm', fields: ['contextWindow'], prices: ['input'], updateReference: false }],
    allowPresetOverride: false,
    acceptDefaultOutputCap: false,
  }
  const mutate = ctx.settings.mutate.bind(ctx.settings)
  const writes = []
  let fail = true
  t.mock.method(ctx.settings, 'mutate', async (ns, ops, revision) => {
    writes.push([ns, revision])
    if (fail && ns === 'model-metadata') throw new Error('fixture disk temporarily unavailable')
    return mutate(ns, ops, revision)
  })
  const partial = (await ctx.modelMetadataUi.execute(request)).batchSaved
  assert.equal(partial.models, 'saved')
  assert.equal(partial.retryable, true)
  assert.equal(ctx.modelMetadata.readModel(provider, 'm').model.contextWindow, 128000)
  fail = false
  assert.equal((await ctx.modelMetadataUi.execute(request)).batchSaved.complete, true)
  assert.deepEqual(
    writes.map(([ns]) => ns),
    ['llm-pi-ai', 'model-metadata', 'model-metadata'],
  )
  assert.equal(writes[1][1], plan.priceRevision)
  assert.equal(writes[2][1], plan.priceRevision)
  const stale = await ctx.modelMetadata.batchReview([{ provider, id: 'm' }])
  await ctx.modelMetadata.savePrices(provider, 'm', { input: 88 }, ctx.modelMetadata.readPrices(provider, 'm').revision)
  await assert.rejects(ctx.modelMetadataUi.execute({ ...request, ticket: stale.ticket }), /配置已变化/)
  assert.equal(ctx.modelMetadata.readPrices(provider, 'm').effective.input, 88)
})

test('batch native multiplier snapshots persist at zero without losing cached or manual rates', async (t) => {
  const { ctx, start } = await fixture(t)
  let input = 2
  let cache = true
  t.mock.method(globalThis, 'fetch', async (url) => {
    const native = url.includes('basellm')
    const data = {
      api: 'https://example.test/v1',
      models: {
        m: {
          cost: {
            input,
            output: input * 2,
            ...(native ? { currency: 'CNY' } : {}),
            ...(cache ? { cache_read: 0 } : {}),
          },
        },
      },
    }
    return new Response(JSON.stringify(url.includes('/providers/') ? data : { vendor: data }))
  })
  const service = ctx.modelMetadata
  await service.savePrices(provider, 'm', { input: 77 }, service.readPrices(provider, 'm').revision, 'CNY')
  await service.setPriceMultiplier(
    provider,
    'm',
    'vendor',
    'm',
    0,
    service.readPrices(provider, 'm').revision,
    'CNY',
    'basellm',
  )
  input = 3
  const review = await service.batchReview([{ provider, id: 'm' }], 'CNY', 'basellm')
  assert.equal(review.rows[0].referenceUpdateAvailable, true)
  const request = {
    action: 'batchCommit',
    confirmed: true,
    ticket: review.ticket,
    mode: 'update',
    selections: [{ provider, id: 'm', fields: [], prices: [], updateReference: true }],
    allowPresetOverride: false,
    acceptDefaultOutputCap: false,
  }
  assert.equal((await ctx.modelMetadataUi.execute(request)).batchSaved.complete, true)
  const record = service.readPrices(provider, 'm').record
  assert.deepEqual(record.reference.prices, { input: 3, output: 6, cacheRead: 0 })
  assert.equal(record.multiplier, 0)
  assert.equal(record.rates.input.value, 77)
  assert.match(record.reference.source.url, /all.json$/)
  const restarted = await start()
  assert.deepEqual(restarted.modelMetadata.readPrices(provider, 'm').record, record)
  cache = false
  input = 5
  const missing = await service.batchReview([{ provider, id: 'm' }], 'CNY', 'basellm')
  assert.notEqual(missing.rows[0].referenceUpdateAvailable, true)
  await assert.rejects(ctx.modelMetadataUi.execute({ ...request, ticket: missing.ticket }), /整份/)
  assert.deepEqual(service.readPrices(provider, 'm').record, record)
})

test('batch review shares fresh downloads, preserves real Settings and isolates metadata failures', async (t) => {
  const { ctx, profile } = await fixture(t, true, { cacheTtlMs: 0 })
  const service = ctx.modelMetadata
  await service.savePrices(provider, 'm', { input: 0 }, service.readPrices(provider, 'm').revision, 'CNY')
  const before = await readFile(profile.patchPath, 'utf8')
  const calls = { metadata: 0, native: 0 }
  let offline = false
  t.mock.method(globalThis, 'fetch', async (url) => {
    const native = url.includes('basellm')
    calls[native ? 'native' : 'metadata']++
    if (!native && offline) throw new Error('metadata offline')
    return new Response(
      JSON.stringify({
        vendor: {
          models: {
            m: { name: 'Catalog', cost: { input: 2, output: 4, ...(native ? { currency: 'CNY' } : {}) } },
            other: { cost: { input: 0, output: 0, ...(native ? { currency: 'CNY' } : {}) } },
          },
        },
      }),
    )
  })
  const request = {
    action: 'batchReview',
    targets: [
      { provider, id: 'm' },
      { provider, id: 'other' },
    ],
    currency: 'CNY',
    pricingSource: 'basellm',
  }
  const first = (await ctx.modelMetadataUi.execute(request)).batchReview
  assert.deepEqual(calls, { metadata: 1, native: 1 })
  assert.equal(first.rows[0].currentPrices.input, 0)
  assert.equal(first.rows[0].priceChanges.find((field) => field.key === 'input').selected, false)
  assert.ok(first.rows[0].parameters.length > 0)
  assert.equal(JSON.stringify(first).includes('secret-value'), false)
  assert.equal(JSON.stringify(first).includes('SECRET_REF'), false)
  offline = true
  const second = (await ctx.modelMetadataUi.execute(request)).batchReview
  assert.deepEqual(calls, { metadata: 2, native: 2 })
  assert.match(second.warnings[0], /metadata offline/)
  assert.deepEqual(second.rows[0].parameters, [])
  assert.ok(second.rows[0].priceChanges.length > 0)
  assert.equal(await readFile(profile.patchPath, 'utf8'), before)
  await assert.rejects(service.batchReview([...request.targets, request.targets[0]], 'CNY', 'basellm'), /重复/)
  await assert.rejects(service.batchReview(Array.from({ length: 101 }, (_, i) => ({ provider, id: String(i) }))))
  assert.deepEqual(calls, { metadata: 2, native: 2 })
})

test('batch review rejects configuration changes made during downloads through the real Settings API', async (t) => {
  const { ctx } = await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => {
    await ctx.modelMetadata.savePrices(
      provider,
      'm',
      { input: 3 },
      ctx.modelMetadata.readPrices(provider, 'm').revision,
    )
    return new Response('{}')
  })
  await assert.rejects(
    ctx.modelMetadataUi.execute({ action: 'batchReview', targets: [{ provider, id: 'm' }] }),
    /配置已变化/,
  )
  assert.equal(ctx.modelMetadata.readPrices(provider, 'm').effective.input, 3)
})

test('preset protection follows the host directory and ignores unrelated paths', async (t) => {
  const { ctx } = await fixture(t, false)
  let rows = [{ provider, settingsNs: 'llm-pi-ai', settingsPath: ['other', provider], declared: false }]
  ctx.provide('llm', { listConfigurableProviders: () => rows })
  assert.equal(ctx.modelMetadata.readModel(provider, 'm').protectedPreset, true)
  await assert.rejects(
    ctx.modelMetadata.saveModel(
      provider,
      'm',
      { name: 'Blocked' },
      ctx.modelMetadata.readModel(provider, 'm').revision,
    ),
    /覆盖预设/,
  )
  rows = [{ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: false }]
  assert.equal(ctx.modelMetadata.readModel(provider, 'm').protectedPreset, true)
  rows = [{ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: true }]
  assert.equal(ctx.modelMetadata.readModel(provider, 'm').protectedPreset, false)
})

test('host fill reports inactive rates without cancelling the multiplier, then manualMode activates them', async (t) => {
  const { ctx } = await fixture(t)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          vendor: {
            models: {
              m: {
                name: 'Catalog model',
                cost: { input: 4, output: 20 },
              },
            },
          },
        }),
      ),
  )
  const execute = (request) => ctx.modelMetadataUi.execute(request)
  assert.equal((await execute({ action: 'candidates', id: 'm' })).candidates[0].provider, 'vendor')
  assert.equal(
    (await execute({ action: 'preview', provider, id: 'm', catalogProvider: 'vendor' })).preview.matched,
    true,
  )
  // Use the public service to obtain and persist a genuine reference snapshot.
  const quote = (await execute({ action: 'pricePreview', catalogProvider: 'vendor', id: 'm' })).priceQuote
  const scaled = await execute({
    action: 'multiplier',
    provider,
    id: 'm',
    referenceProvider: 'vendor',
    referenceModel: 'm',
    quoteTicket: quote.ticket,
    multiplier: 2,
    revision: ctx.modelMetadata.readPrices(provider, 'm').revision,
  })
  const filled = await execute({
    action: 'fill',
    provider,
    id: 'm',
    catalogProvider: 'vendor',
    revision: scaled.prices.revision,
  })
  assert.deepEqual(filled.fillResult, { changed: ['input', 'output'], effect: 'stored-inactive' })
  assert.equal(filled.prices.record.mode, 'multiplier')
  assert.deepEqual(filled.prices.effective, { input: 8, output: 40 })
  assert.equal(filled.prices.record.rates.input.value, 4)
  const again = await execute({
    action: 'fill',
    provider,
    id: 'm',
    catalogProvider: 'vendor',
    revision: filled.prices.revision,
  })
  assert.deepEqual(again.fillResult, { changed: [], effect: 'unchanged' })
  const manual = await execute({ action: 'manualMode', provider, id: 'm', revision: filled.prices.revision })
  assert.deepEqual(manual.prices.effective, { input: 4, output: 20 })
})

test('quote capacity evicts the oldest ticket while retaining newer tickets', async (t) => {
  const { ctx } = await fixture(t)
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ vendor: { models: { m: { cost: { input: 1, output: 2 } } } } })),
  )
  const tickets = []
  for (let i = 0; i < 129; i++)
    tickets.push((await ctx.modelMetadata.quotePrices('vendor', 'm', 'USD', 'models.dev')).ticket)
  const revision = ctx.modelMetadata.readPrices(provider, 'm').revision
  await assert.rejects(
    ctx.modelMetadata.savePriceDraft(provider, 'm', {}, { input: tickets[0] }, revision, 'USD'),
    /过期/,
  )
  const saved = await ctx.modelMetadata.savePriceDraft(
    provider,
    'm',
    {},
    { input: tickets[1], output: tickets[128] },
    revision,
    'USD',
  )
  assert.deepEqual(saved.effective, { input: 1, output: 2 })
})

test('official Kimi efforts pass the remote contract and survive Settings restart', async (t) => {
  const { ctx, start } = await fixture(t)
  const section = ctx.settings.describe({ redactSecrets: true }).find((row) => row.ns === 'llm-pi-ai')
  await ctx.settings.mutate(
    'llm-pi-ai',
    [{ op: 'set', path: ['providers', provider, 'models'], value: [{ id: 'kimi-k3' }] }],
    section.revision,
  )
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          moonshotai: {
            models: {
              'kimi-k3': {
                reasoning: true,
                reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
              },
            },
          },
        }),
      ),
  )
  const result = (await ctx.modelMetadataUi.execute({ action: 'recommend', provider, id: 'kimi-k3' })).recommendation
  assert.equal(result.reasoningProvider, 'moonshotai')
  assert.equal(result.reasoningSupported, true)
  await ctx.modelMetadataUi.execute({
    action: 'model',
    provider,
    id: 'kimi-k3',
    patch: { reasoningEfforts: result.model.reasoningEfforts },
    revision: ctx.modelMetadata.readModel(provider, 'kimi-k3').revision,
    acceptDefaultOutputCap: false,
  })
  const restarted = await start()
  assert.deepEqual(restarted.modelMetadata.readModel(provider, 'kimi-k3').model.reasoningEfforts, {
    low: 'low',
    high: 'high',
    max: 'max',
  })
})

test('package rename keeps saved models and both currencies under the same Loader entry', async (t) => {
  const { ctx, start, profile, bundle } = await fixture(t)
  await ctx.modelMetadata.saveModel(
    provider,
    'm',
    { name: 'Preserved model', contextWindow: 128000 },
    ctx.modelMetadata.readModel(provider, 'm').revision,
    false,
  )
  const cny = await ctx.modelMetadata.savePrices(
    provider,
    'm',
    { input: 20, output: 100, cacheRead: 2 },
    ctx.modelMetadata.readPrices(provider, 'm').revision,
    'CNY',
  )
  const usd = await ctx.modelMetadata.savePrices(
    provider,
    'other',
    { input: 3, output: 15, cacheRead: 0 },
    ctx.modelMetadata.readPrices(provider, 'other').revision,
    'USD',
  )
  const before = await readFile(profile.patchPath, 'utf8')
  await ctx.fiber.dispose()
  const bundlePatch = join(bundle, 'cordis.patch.yml')
  const rows = JSON.parse(await readFile(bundlePatch, 'utf8'))
  const entry = rows[0].insert.find((row) => row.id === 'model-metadata')
  entry.name = `cordis:${PACKAGE_NAME}`
  await writeFile(bundlePatch, JSON.stringify(rows))
  // Settings pins the Loader name in its user patch. Changing the bundle alone
  // makes the old name-targeted override stop applying, even when the ID matches.
  const migratedPatch = before.replace('name: cordis:test-metadata', `name: cordis:${PACKAGE_NAME}`)
  assert.notEqual(migratedPatch, before)
  await writeFile(profile.patchPath, migratedPatch)
  const renamed = await start()
  assert.equal(renamed.modelMetadata.readModel(provider, 'm').model.name, 'Preserved model')
  assert.equal(renamed.modelMetadata.readModel(provider, 'm').model.contextWindow, 128000)
  assert.deepEqual(renamed.modelMetadata.readPrices(provider, 'm').record, cny.record)
  assert.deepEqual(renamed.modelMetadata.readPrices(provider, 'other').record, usd.record)
  assert.equal(
    (await renamed.modelMetadataUi.execute({ action: 'read', provider, id: 'm' })).prices.record.currency,
    'CNY',
  )
  assert.equal(await readFile(profile.patchPath, 'utf8'), migratedPatch)
})

test('one-click consensus quotes persist contributors, reuse the preview, and recover after restart', async (t) => {
  const { ctx, start } = await fixture(t)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify(
          Object.fromEntries(
            ['a', 'b', 'c'].map((vendor) => [
              vendor,
              {
                models: {
                  m: { name: 'Model', limit: { context: 128000 }, cost: { input: vendor === 'c' ? 9 : 3, output: 15 } },
                },
              },
            ]),
          ),
        ),
      ),
  )
  const reply = await ctx.modelMetadataUi.execute({ action: 'recommend', provider, id: 'm' })
  const result = reply.recommendation
  assert.equal(result.model.contextWindow, 128000)
  assert.equal(result.method, 'consensus')
  assert.equal(result.priceQuote.source.method, 'consensus')
  assert.equal(result.priceQuote.source.support, 2)
  assert.equal(JSON.stringify(reply).includes('SECRET_REF'), false)
  assert.equal(JSON.stringify(reply).includes('secret-value'), false)
  assert.equal(JSON.stringify(reply).includes('example.test'), false)
  assert.equal(ctx.modelMetadata.readPrices(provider, 'm').record, undefined)
  const { priceQuote: quote } = result
  const saved = await ctx.modelMetadataUi.execute({
    action: 'priceDraft',
    provider,
    id: 'm',
    values: {},
    quotes: { input: quote.ticket, output: quote.ticket },
    revision: ctx.modelMetadata.readPrices(provider, 'm').revision,
  })
  assert.equal(saved.prices.record.rates.input.source.method, 'consensus')
  assert.deepEqual(saved.prices.record.rates.input.source.contributors, [
    { provider: 'a', model: 'm' },
    { provider: 'b', model: 'm' },
  ])
  const scaled = await ctx.modelMetadataUi.execute({
    action: 'multiplier',
    provider,
    id: 'm',
    referenceProvider: 'consensus',
    referenceModel: 'm',
    quoteTicket: quote.ticket,
    multiplier: 2,
    revision: saved.prices.revision,
  })
  assert.deepEqual(scaled.prices.effective, { input: 6, output: 30 })
  await ctx.fiber.dispose()
  const restarted = await start()
  assert.deepEqual(restarted.modelMetadata.readPrices(provider, 'm').record, scaled.prices.record)
})

test('one-click native CNY is independent of USD and normalized reference IDs stay bound to the target model', async (t) => {
  const { ctx } = await fixture(t)
  const section = ctx.settings.describe().find((row) => row.ns === 'llm-pi-ai')
  await ctx.settings.mutate(
    'llm-pi-ai',
    [{ op: 'set', path: ['providers', provider, 'models'], value: [{ id: 'vendor/m' }] }],
    section.revision,
  )
  const catalog = {
    vendor: {
      api: 'https://example.test/v1',
      models: { m: { limit: { context: 64000 }, cost: { input: 3, output: 15 } } },
    },
  }
  const native = {
    vendor: { api: 'https://example.test/v1', models: { m: { cost: { currency: 'CNY', input: 8, output: 24 } } } },
  }
  t.mock.method(
    globalThis,
    'fetch',
    async (url) => new Response(JSON.stringify(String(url).includes('basellm') ? native : catalog)),
  )
  const request = { action: 'recommend', provider, id: 'vendor/m', currency: 'CNY', pricingSource: 'basellm' }
  const result = (await ctx.modelMetadataUi.execute(request)).recommendation
  assert.equal(result.model.id, 'vendor/m')
  assert.equal(result.model.contextWindow, 64000)
  assert.equal(result.priceQuote.source.model, 'm')
  assert.deepEqual(result.priceQuote.prices, { input: 8, output: 24 })
  const saved = await ctx.modelMetadataUi.execute({
    action: 'priceDraft',
    provider,
    id: 'vendor/m',
    currency: 'CNY',
    values: {},
    quotes: { input: result.priceQuote.ticket, output: result.priceQuote.ticket },
    revision: ctx.modelMetadata.readPrices(provider, 'vendor/m').revision,
  })
  assert.deepEqual(saved.prices.effective, { input: 8, output: 24 })
  const scaled = await ctx.modelMetadataUi.execute({
    action: 'multiplier',
    provider,
    id: 'vendor/m',
    currency: 'CNY',
    pricingSource: 'basellm',
    referenceProvider: 'vendor',
    referenceModel: 'm',
    quoteTicket: result.priceQuote.ticket,
    multiplier: 0.5,
    revision: saved.prices.revision,
  })
  assert.deepEqual(scaled.prices.effective, { input: 4, output: 12 })
})

test('quoted and edited prices save atomically with per-field provenance and survive restart', async (t) => {
  const { ctx, start } = await fixture(t)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          vendor: {
            models: {
              m: { cost: { input: 3, output: 15, cache_read: 0 } },
              other: { cost: { input: 9, output: 30 } },
            },
          },
        }),
      ),
  )
  const execute = (request) => ctx.modelMetadataUi.execute(request)
  const { priceQuote: quote } = await execute({
    action: 'pricePreview',
    catalogProvider: 'vendor',
    id: 'm',
    currency: 'USD',
    pricingSource: 'models.dev',
  })
  const request = {
    action: 'priceDraft',
    provider,
    id: 'm',
    values: { input: 7 },
    quotes: { output: quote.ticket, cacheRead: quote.ticket },
    currency: 'USD',
    revision: ctx.modelMetadata.readPrices(provider, 'm').revision,
  }
  // All validation precedes the one Settings mutation.
  for (const change of [
    { currency: 'CNY' },
    { quotes: { output: 'unknown' } },
    { quotes: { input: quote.ticket } },
    { quotes: { cacheWrite: quote.ticket } },
    { id: 'other' },
  ])
    await assert.rejects(execute({ ...request, ...change }))
  assert.equal(ctx.modelMetadata.readPrices(provider, 'm').record, undefined)
  const saved = (await execute(request)).prices
  assert.deepEqual(saved.effective, { input: 7, output: 15, cacheRead: 0 })
  assert.equal(saved.record.rates.input.origin, 'manual')
  assert.equal(saved.record.rates.input.source, undefined)
  assert.equal(saved.record.rates.output.origin, 'catalog')
  assert.deepEqual(saved.record.rates.output.source, quote.source)
  await assert.rejects(execute(request), /changed/)
  await ctx.fiber.dispose()
  const restarted = await start()
  assert.deepEqual(restarted.modelMetadata.readPrices(provider, 'm').record, saved.record)
  const updated = await restarted.modelMetadataUi.execute({
    ...request,
    revision: restarted.modelMetadata.readPrices(provider, 'm').revision,
    values: { input: 0 },
    quotes: {},
  })
  assert.deepEqual(updated.prices.record.rates.output, saved.record.rates.output)
  assert.equal(updated.prices.effective.input, 0)
})

test('multiplier uses the previewed quote even when the catalog changes; expired quotes fail', async (t) => {
  const { ctx, start } = await fixture(t)
  let input = 3
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ vendor: { models: { m: { cost: { input, output: 15 } } } } })),
  )
  const execute = (request) => ctx.modelMetadataUi.execute(request)
  const { priceQuote: quote } = await execute({
    action: 'pricePreview',
    catalogProvider: 'vendor',
    id: 'm',
    currency: 'USD',
    pricingSource: 'models.dev',
  })
  input = 99
  await ctx.modelMetadata.refresh()
  const request = {
    action: 'multiplier',
    provider,
    id: 'm',
    referenceProvider: 'vendor',
    referenceModel: 'm',
    currency: 'USD',
    pricingSource: 'models.dev',
    multiplier: 2,
    quoteTicket: quote.ticket,
    revision: ctx.modelMetadata.readPrices(provider, 'm').revision,
  }
  await assert.rejects(execute({ ...request, referenceProvider: 'different' }), /来源/)
  await assert.rejects(execute({ ...request, id: 'other' }), /模型不匹配/)
  const saved = (await execute(request)).prices
  assert.deepEqual(saved.effective, { input: 6, output: 30 })
  assert.deepEqual(saved.record.reference.source, quote.source)
  const now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now + 31 * 60_000)
  await assert.rejects(execute({ ...request, revision: saved.revision }), /过期/)
  assert.deepEqual(ctx.modelMetadata.readPrices(provider, 'm').effective, saved.effective)
  clock.mock.restore()
  await ctx.fiber.dispose()
  const restarted = await start()
  const { quoteTicket, ...rest } = request
  const restored = await restarted.modelMetadataUi.execute({
    ...rest,
    reuseSavedReference: true,
    multiplier: 3,
    revision: restarted.modelMetadata.readPrices(provider, 'm').revision,
  })
  assert.deepEqual(restored.prices.effective, { input: 9, output: 45 })
  const refreshed = await restarted.modelMetadata.setPriceMultiplier(
    provider,
    'm',
    'vendor',
    'm',
    1,
    restored.prices.revision,
  )
  assert.equal(refreshed.effective.input, 99)
})

test('builtin overrides set and unset individual fields through real Settings and restart', async (t) => {
  const { ctx, start } = await fixture(t, false)
  function register(runtime) {
    runtime.provide('llm', {
      listConfigurableProviders: () => [
        {
          provider: 'builtin-test',
          displayName: 'Builtin',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'builtin-test'],
          declared: false,
        },
      ],
      discoverModels: async () => [
        { id: 'catalog', name: 'Catalog', contextWindow: 128, maxTokens: 16 },
        { id: 'other' },
      ],
    })
  }
  register(ctx)
  const routes = await ctx.modelMetadataUi.execute({ action: 'routes' })
  assert.equal(routes.routes.find((row) => row.provider === 'builtin-test').inherited, true)
  const directory = await ctx.modelMetadataUi.execute({ action: 'builtinList', provider: 'builtin-test' })
  assert.deepEqual(
    directory.builtinModels.map((row) => row.id),
    ['catalog', 'other'],
  )
  assert.equal(
    (await ctx.modelMetadataUi.execute({ action: 'builtinRead', provider: 'builtin-test', id: 'catalog' })).builtin
      .model.contextWindow,
    64,
  )
  const before = await ctx.modelMetadata.overrides.read('builtin-test', 'catalog')
  assert.equal(before.model.contextWindow, 64)
  await assert.rejects(
    ctx.modelMetadata.overrides.write(
      'builtin-test',
      'catalog',
      { name: 'Refused' },
      [],
      before.revision,
      false,
      false,
    ),
    /允许/,
  )
  await assert.rejects(
    ctx.modelMetadata.overrides.write('builtin-test', 'catalog', { maxTokens: 32 }, [], before.revision, true, false),
    /上限/,
  )
  await assert.rejects(ctx.modelMetadata.overrides.read('builtin-test', 'not-in-catalog'), /没有此模型/)
  const saved = await ctx.modelMetadata.overrides.write(
    'builtin-test',
    'catalog',
    { name: 'Custom', contextWindow: 256 },
    [],
    before.revision,
    true,
    false,
  )
  assert.equal(saved.model.contextWindow, 256)
  await assert.rejects(
    ctx.modelMetadata.overrides.write('builtin-test', 'catalog', {}, ['contextWindow'], before.revision, true, false),
    /配置已变化/,
  )
  await ctx.modelMetadata.overrides.write('builtin-test', 'catalog', {}, ['contextWindow'], saved.revision, true, false)
  await ctx.fiber.dispose()
  const restarted = await start()
  register(restarted)
  const restored = await restarted.modelMetadata.overrides.read('builtin-test', 'catalog')
  // Unsetting a user value reveals the bundle's value, not an invented catalog replacement.
  assert.equal(restored.model.contextWindow, 64)
  assert.equal(restored.model.name, 'Custom')
  const profile = restarted.settings.describe({ redactSecrets: true }).find((row) => row.ns === 'llm-pi-ai').value
    .providers['builtin-test']
  assert.equal(profile.models?.length ?? 0, 0)
  assert.equal(profile.modelOverrides.catalog.compat.supportsDeveloperRole, false)
  assert.equal(profile.modelOverrides.other.name, 'Keep')
})

test('model import uses host discovery and persists atomically through Settings and restart', async (t) => {
  const { ctx, start } = await fixture(t, false)
  ctx.provide('llm', {
    listConfigurableProviders: () => [
      {
        provider,
        displayName: 'Gateway',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
        declared: true,
      },
    ],
    discoverModels: async (_ns, request) => {
      assert.deepEqual(request, { provider, api: 'openai-completions', baseURL: 'https://example.test/v1' })
      return [{ id: 'new-model' }]
    },
  })
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          firstparty: { models: { 'new-model': { name: 'New Model', limit: { context: 128000, output: 8192 } } } },
        }),
      ),
  )
  const discovery = (await ctx.modelMetadataUi.execute({ action: 'discover', provider })).discovery
  assert.equal(discovery.rows[0].selected, 'firstparty')
  const plan = (
    await ctx.modelMetadataUi.execute({
      action: 'importPreview',
      ticket: discovery.ticket,
      selections: [{ id: 'new-model', catalogProvider: 'firstparty' }],
    })
  ).importPlan
  await ctx.modelMetadataUi.execute({
    action: 'importCommit',
    ticket: plan.ticket,
    acceptDefaultOutputCap: true,
    allowPresetOverride: false,
  })
  assert.equal(ctx.modelMetadata.listModels().length, 3)
  await ctx.fiber.dispose()
  const restarted = await start()
  assert.equal(restarted.modelMetadata.readModel(provider, 'new-model').model.contextWindow, 128000)
  assert.equal(restarted.modelMetadata.readModel(provider, 'm').model.name, 'My model')
})

test('basellm CNY persists through the UI contract and a real Settings restart', async (t) => {
  const { ctx, start } = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://basellm.github.io/llm-metadata/api/providers/zhipuai.json')
    return new Response(
      JSON.stringify({ models: { m: { cost: { currency: 'CNY', input: 8, output: 28, cache_read: 2 } } } }),
    )
  })
  const before = ctx.modelMetadata.readPrices(provider, 'm')
  const saved = await ctx.modelMetadataUi.execute({
    action: 'multiplier',
    provider,
    id: 'm',
    referenceProvider: 'zhipuai',
    referenceModel: 'm',
    multiplier: 0.5,
    currency: 'CNY',
    pricingSource: 'basellm',
    revision: before.revision,
  })
  assert.equal(saved.prices.record.currency, 'CNY')
  assert.deepEqual(saved.prices.effective, { input: 4, output: 14, cacheRead: 1 })
  await ctx.fiber.dispose()
  const restarted = await start()
  const restored = restarted.modelMetadata.readPrices(provider, 'm')
  assert.equal(restored.record.currency, 'CNY')
  assert.deepEqual(restored.effective, saved.prices.effective)
})

test('registered UI contract exposes projected model data and rejects malformed edits', async (t) => {
  const { ctx, start, profile } = await fixture(t)
  assert.ok(ctx.typert.local.get('modelMetadataUi/execute'))
  const list = await ctx.modelMetadataUi.execute({ action: 'list' })
  assert.equal(list.models.length, 2)
  assert.equal(JSON.stringify(list).includes('secret'), false)
  const snapshot = await ctx.modelMetadataUi.execute({ action: 'read', provider, id: 'm' })
  const saved = await ctx.modelMetadataUi.execute({
    action: 'manual',
    provider,
    id: 'm',
    values: { input: 0 },
    revision: snapshot.prices.revision,
  })
  assert.equal(saved.prices.effective.input, 0)
  const current = await ctx.modelMetadataUi.execute({ action: 'read', provider, id: 'm' })
  await ctx.modelMetadataUi.execute({
    action: 'model',
    provider,
    id: 'm',
    patch: { contextWindow: 128000, maxTokens: 8192 },
    revision: current.revision,
    acceptDefaultOutputCap: true,
  })
  assert.match(await readFile(profile.patchPath, 'utf8'), /8192/)
  const reread = await ctx.modelMetadataUi.execute({ action: 'read', provider, id: 'm' })
  assert.equal(reread.model.maxTokens, 8192)
  await assert.rejects(
    ctx.modelMetadataUi.execute({
      action: 'model',
      provider,
      id: 'm',
      patch: { baseURL: 'https://bad.example' },
      revision: snapshot.revision,
      acceptDefaultOutputCap: false,
    }),
    /Invalid/,
  )
  await ctx.fiber.dispose()
  const restarted = await start()
  const restored = await restarted.modelMetadataUi.execute({ action: 'read', provider, id: 'm' })
  assert.equal(restored.model.maxTokens, 8192)
  assert.equal(restored.model.contextWindow, 128000)
})

test('reference multiplier preserves manual prices, scales once, persists and supports mode switching', async (t) => {
  const { ctx, start } = await fixture(t)
  const service = ctx.modelMetadata
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          firstparty: {
            models: {
              official: { cost: { input: 3, output: 15, cache_read: 0.3 } },
              unknown: { cost: { input: 3 } },
            },
          },
        }),
      ),
  )
  let state = await service.savePrices(
    provider,
    'm',
    { input: 7, output: 20 },
    service.readPrices(provider, 'm').revision,
  )
  state = await service.setPriceMultiplier(provider, 'm', 'firstparty', 'official', 0.5, state.revision)
  assert.deepEqual(state.effective, { input: 1.5, output: 7.5, cacheRead: 0.15 })
  assert.deepEqual(service.readPrices(provider, 'm').effective, state.effective)
  assert.equal(state.record.reference.prices.input, 3)
  assert.equal(state.record.rates.input.value, 7)
  await assert.rejects(
    service.setPriceMultiplier(provider, 'm', 'firstparty', 'official', -1, state.revision),
    /Multiplier/,
  )
  await assert.rejects(
    service.setPriceMultiplier(provider, 'm', 'firstparty', 'official', Infinity, state.revision),
    /Multiplier/,
  )
  await assert.rejects(
    service.setPriceMultiplier(provider, 'm', 'firstparty', 'official', Number.MAX_VALUE, state.revision),
    /overflow/,
  )
  await assert.rejects(
    service.setPriceMultiplier(provider, 'm', 'firstparty', 'unknown', 1, state.revision),
    /known input and output/,
  )
  await ctx.fiber.dispose()
  const restarted = await start()
  const restored = restarted.modelMetadata.readPrices(provider, 'm')
  assert.deepEqual(restored.effective, state.effective)
  state = await restarted.modelMetadata.useManualPrices(provider, 'm', restored.revision)
  assert.deepEqual(state.effective, { input: 7, output: 20 })
  state = await restarted.modelMetadata.setPriceMultiplier(provider, 'm', 'firstparty', 'official', 0, state.revision)
  assert.deepEqual(state.effective, { input: 0, output: 0, cacheRead: 0 })
  assert.equal(state.effective.cacheWrite, undefined)
  state = await restarted.modelMetadata.savePrices(provider, 'm', { output: 9 }, state.revision)
  assert.equal(state.record.mode, 'manual')
  assert.deepEqual(state.effective, { input: 7, output: 9 })
})

test('competing writes with one revision cannot silently overwrite each other', async (t) => {
  const { ctx } = await fixture(t)
  const service = ctx.modelMetadata
  const { revision } = service.readPrices(provider, 'm')
  const results = await Promise.allSettled([
    service.savePrices(provider, 'm', { input: 1 }, revision),
    service.savePrices(provider, 'm', { output: 2 }, revision),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(Object.keys(service.readPrices(provider, 'm').record.rates).length, 1)
})

test('real Settings writes preserve route secrets and other models, reject stale revisions, and survive restart', async (t) => {
  const { ctx, start, profile } = await fixture(t)
  const service = ctx.modelMetadata
  const snapshot = service.readModel(provider, 'm')
  assert.equal(snapshot.model.name, 'My model')
  assert.equal(JSON.stringify(snapshot).includes('secret'), false)
  const saved = await service.saveModel(provider, 'm', { contextWindow: 64000 }, snapshot.revision)
  assert.equal(saved.model.contextWindow, 64000)
  await assert.rejects(service.saveModel(provider, 'm', { name: 'Stale' }, snapshot.revision), /changed/)
  await assert.rejects(service.saveModel(provider, 'm', { maxTokens: 8000 }, saved.revision), /acceptDefaultOutputCap/)
  await assert.rejects(service.saveModel(provider, 'm', { contextWindow: -1 }, saved.revision))
  const final = await service.saveModel(provider, 'm', { maxTokens: 8000 }, saved.revision, true)
  assert.equal(final.model.maxTokens, 8000)
  const raw = ctx.settings.describe().find((row) => row.ns === 'llm-pi-ai').value.providers[provider]
  assert.equal(raw.headers.Authorization, 'secret-value')
  assert.equal(raw.apiKeyEnv, 'SECRET_REF')
  assert.equal(raw.models[0].compat.supportsDeveloperRole, false)
  assert.equal(raw.models[1].name, 'Untouched')
  const file = await readFile(profile.patchPath, 'utf8')
  assert.match(file, /64000/)
  assert.match(file, /8000/)
  await ctx.fiber.dispose()
  const restarted = await start()
  assert.equal(restarted.modelMetadata.readModel(provider, 'm').model.maxTokens, 8000)
})

test('prices persist independently with manual zero protected and unknown rates absent', async (t) => {
  const { ctx, start, profile } = await fixture(t)
  const service = ctx.modelMetadata
  const initial = service.readPrices(provider, 'm')
  assert.equal(initial.record, undefined)
  let prices = await service.savePrices(provider, 'm', { input: 0 }, initial.revision)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          vendor: {
            models: {
              m: {
                cost: { input: 5, output: 8, cache_read: 0.2 },
              },
            },
          },
        }),
      ),
  )
  prices = await service.fillPrices(provider, 'm', prices.revision, 'vendor')
  assert.equal(prices.record.rates.input.value, 0)
  assert.equal(prices.record.rates.input.origin, 'manual')
  assert.equal(prices.record.rates.output.source.provider, 'vendor')
  assert.equal(prices.record.rates.output.value, 8)
  assert.equal(prices.record.rates.cacheWrite, undefined)
  assert.deepEqual(prices.changed, ['output', 'cacheRead'])
  await assert.rejects(service.savePrices(provider, 'm', { output: 1 }, initial.revision), /changed/)
  await assert.rejects(service.savePrices(provider, 'm', { output: -1 }, prices.revision), /Invalid price/)
  await assert.rejects(service.savePrices(provider, 'm', { output: Infinity }, prices.revision), /Invalid price/)
  const modelSection = ctx.settings.describe().find((row) => row.ns === 'llm-pi-ai')
  assert.equal(JSON.stringify(modelSection.value).includes('per-million-tokens'), false)
  assert.match(await readFile(profile.patchPath, 'utf8'), /per-million-tokens/)
  await ctx.fiber.dispose()
  const restarted = await start()
  assert.deepEqual(restarted.modelMetadata.readPrices(provider, 'm').record, prices.record)
})

test('blank display names fall back to the ID in navigation', async (t) => {
  const { ctx } = await fixture(t)
  const snapshot = ctx.modelMetadata.readModel(provider, 'm')
  await ctx.modelMetadata.saveModel(provider, 'm', { name: '' }, snapshot.revision)
  assert.equal(ctx.modelMetadata.listModels().find((row) => row.id === 'm').name, 'm')
})

test('legacy oversized values remain readable and can be corrected through real Settings', async (t) => {
  const { ctx } = await fixture(t)
  await ctx.settings.mutate(
    'llm-pi-ai',
    [{ op: 'set', path: ['providers', provider, 'models', 0, 'name'], value: 'x'.repeat(513) }],
    ctx.modelMetadata.readModel(provider, 'm').revision,
  )
  const key = JSON.stringify(['llm-pi-ai', provider, 'm'])
  await ctx.settings.mutate(
    'model-metadata',
    [
      {
        op: 'set',
        path: ['prices', key],
        value: {
          currency: 'USD',
          unit: 'per-million-tokens',
          mode: 'manual',
          rates: { input: { value: Number.MAX_VALUE, origin: 'manual', updatedAt: 1 } },
        },
      },
    ],
    ctx.modelMetadata.readPrices(provider, 'm').revision,
  )
  const loaded = await ctx.modelMetadataUi.execute({ action: 'read', provider, id: 'm' })
  assert.equal(loaded.model.name.length, 513)
  assert.equal(loaded.prices.effective.input, Number.MAX_VALUE)
  await ctx.modelMetadataUi.execute({
    action: 'model',
    provider,
    id: 'm',
    patch: { name: 'Corrected' },
    revision: loaded.revision,
    acceptDefaultOutputCap: false,
  })
  const corrected = await ctx.modelMetadataUi.execute({
    action: 'manual',
    provider,
    id: 'm',
    values: { input: 3 },
    revision: loaded.prices.revision,
  })
  assert.equal(corrected.model.name, 'Corrected')
  assert.equal(corrected.prices.effective.input, 3)
})
