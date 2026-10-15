import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Plugin from '../lib/index.js'
import { replySchema } from '../lib/wire.js'

test('real Cordis load: schema defaults, lazy fetch, cache and disposal', async (t) => {
  let calls = 0
  let signal
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    signal = options.signal
    return new Response(JSON.stringify({ vendor: { models: { m: { name: 'Model' } } } }))
  })
  const ctx = new Context()
  const fiber = await ctx.plugin(Plugin, {})
  try {
    assert.equal(calls, 0)
    assert.ok(ctx.get('modelMetadata'))
    const service = ctx.modelMetadata
    assert.equal((await service.preview('vendor', { id: 'm' })).proposed.name, 'Model')
    await service.preview('vendor', { id: 'm' })
    assert.equal(calls, 1)
  } finally {
    await fiber.dispose()
  }
  assert.equal(ctx.get('modelMetadata'), undefined)
  assert.equal(signal.aborted, true)
})

test('invalid config fails at load', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(Plugin, { timeoutMs: -1 })
  await assert.rejects(async () => await fiber)
  await fiber.dispose()
})

test('concurrent refreshes share a bounded catalog download', async (t) => {
  const ctx = new Context()
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  let calls = 0
  let release
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    await new Promise((resolve) => {
      release = resolve
    })
    return new Response('{}')
  })
  const a = ctx.modelMetadata.refresh()
  const b = ctx.modelMetadata.refresh()
  release()
  assert.deepEqual(await a, await b)
  assert.equal(calls, 1)
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(33 * 1024 * 1024)))
  await assert.rejects(ctx.modelMetadata.refresh(), /32 MiB/)
})

test('network and malformed catalog failures remain explicit and a subsequent refresh recovers', async (t) => {
  const ctx = new Context()
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  let respond = async () => {
    throw new Error('offline')
  }
  t.mock.method(globalThis, 'fetch', (...args) => respond(...args))
  await assert.rejects(ctx.modelMetadata.refresh(), /offline/)
  respond = async () => new Response('{}', { status: 503 })
  await assert.rejects(ctx.modelMetadata.refresh(), /HTTP 503/)
  respond = async () => new Response('{broken')
  await assert.rejects(ctx.modelMetadata.refresh(), SyntaxError)
  for (const invalid of [null, [], 'invalid']) {
    respond = async () => new Response(JSON.stringify(invalid))
    await assert.rejects(ctx.modelMetadata.refresh(), /provider-keyed/)
  }
  respond = async () => {
    throw new DOMException('Timed out', 'TimeoutError')
  }
  await assert.rejects(ctx.modelMetadata.refresh(), { name: 'TimeoutError' })
  respond = async () => new Response(JSON.stringify({ vendor: { models: { m: { name: 'Recovered' } } } }))
  assert.equal((await ctx.modelMetadata.preview('vendor', { id: 'm' })).proposed.name, 'Recovered')
})

test('explicit refresh bypasses both caches and native downloads share one request', async (t) => {
  const ctx = new Context()
  ctx.provide('settings', { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { vendor: {} } }, revision: 0 }] })
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  let price = 1
  const calls = { model: 0, native: 0 }
  let release
  let hold = false
  t.mock.method(globalThis, 'fetch', async (url) => {
    const native = url.includes('basellm')
    calls[native ? 'native' : 'model']++
    if (native && hold)
      await new Promise((resolve) => {
        release = resolve
      })
    return new Response(
      JSON.stringify({
        vendor: { models: { m: { cost: { input: price, output: 2, ...(native ? { currency: 'CNY' } : {}) } } } },
      }),
    )
  })
  const service = ctx.modelMetadata
  assert.equal((await service.recommend('vendor', 'm', 'USD', 'models.dev')).priceQuote.prices.input, 1)
  price = 9
  assert.equal((await service.recommend('vendor', 'm', 'USD', 'models.dev')).priceQuote.prices.input, 1)
  assert.equal((await service.recommend('vendor', 'm', 'USD', 'models.dev', true)).priceQuote.prices.input, 9)
  hold = true
  const a = service.recommend('vendor', 'm', 'CNY', 'basellm')
  const b = service.recommend('vendor', 'm', 'CNY', 'basellm')
  assert.equal(calls.native, 1)
  release()
  await Promise.all([a, b])
  hold = false
  price = 12
  assert.equal((await service.recommend('vendor', 'm', 'CNY', 'basellm')).priceQuote.prices.input, 9)
  assert.equal((await service.recommend('vendor', 'm', 'CNY', 'basellm', true)).priceQuote.prices.input, 12)
  assert.equal(calls.native, 2)
})

test('both native endpoints reject oversized responses and recover after failure', async (t) => {
  const ctx = new Context()
  ctx.provide('settings', { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { vendor: {} } }, revision: 0 }] })
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  const service = ctx.modelMetadata
  t.mock.method(globalThis, 'fetch', async (url) =>
    url.includes('models.dev')
      ? new Response('{}')
      : new Response('x', { headers: { 'content-length': String(33 * 1024 * 1024) } }),
  )
  await assert.rejects(service.priceReference('vendor', 'm', 'CNY', 'basellm'), /32 MiB/)
  assert.match((await service.recommend('vendor', 'm', 'CNY', 'basellm')).priceMessage, /32 MiB/)
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(33 * 1024 * 1024)))
  await assert.rejects(service.priceReference('vendor', 'm', 'CNY', 'basellm'), /32 MiB/)
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ models: { m: { cost: { currency: 'CNY', input: 1, output: 2 } } } })),
  )
  assert.deepEqual((await service.priceReference('vendor', 'm', 'CNY', 'basellm')).prices, { input: 1, output: 2 })
})

test('native prices survive metadata failure without adopting stale model parameters', async (t) => {
  const ctx = new Context()
  ctx.provide('settings', { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { vendor: {} } }, revision: 0 }] })
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  let metadataOffline = false
  let pricesOffline = false
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('models.dev')) {
      if (metadataOffline) throw new Error('metadata offline')
      return new Response(JSON.stringify({ vendor: { models: { m: { limit: { context: 64000 } } } } }))
    }
    if (pricesOffline) throw new Error('prices offline')
    return new Response(
      JSON.stringify({ vendor: { models: { m: { cost: { currency: 'CNY', input: 8, output: 24 } } } } }),
    )
  })
  const service = ctx.modelMetadata
  metadataOffline = true
  const cold = replySchema.parse({ recommendation: await service.recommend('vendor', 'm', 'CNY', 'basellm') })
  assert.deepEqual(cold.recommendation.model, { id: 'm' })
  assert.deepEqual(cold.recommendation.priceQuote.prices, { input: 8, output: 24 })
  assert.match(cold.recommendation.metadataMessage, /metadata offline/)
  metadataOffline = false
  assert.equal((await service.recommend('vendor', 'm', 'CNY', 'basellm', true)).model.contextWindow, 64000)
  metadataOffline = true
  const refreshed = await service.recommend('vendor', 'm', 'CNY', 'basellm', true)
  assert.equal(refreshed.model.contextWindow, undefined)
  assert.equal(refreshed.priceQuote.prices.input, 8)
  pricesOffline = true
  const failed = await service.recommend('vendor', 'm', 'CNY', 'basellm', true)
  assert.match(failed.metadataMessage, /metadata offline/)
  assert.match(failed.priceMessage, /prices offline/)
  assert.equal(failed.priceQuote, undefined)
  await assert.rejects(service.recommend('vendor', 'm', 'USD', 'models.dev', true), /metadata offline/)
  metadataOffline = false
  const metadataOnly = await service.recommend('vendor', 'm', 'CNY', 'basellm', true)
  assert.equal(metadataOnly.model.contextWindow, 64000)
  assert.equal(metadataOnly.metadataMessage, undefined)
  assert.match(metadataOnly.priceMessage, /prices offline/)
})
