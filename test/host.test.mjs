import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Plugin from '../lib/index.js'

test('real Cordis load: schema defaults, lazy fetch, cache and disposal', async t => {
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

test('concurrent refreshes share a bounded catalog download', async t => {
  const ctx = new Context()
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  let calls = 0
  let release
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    await new Promise(resolve => { release = resolve })
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

test('network and malformed catalog failures remain explicit and a subsequent refresh recovers', async t => {
  const ctx = new Context()
  const fiber = await ctx.plugin(Plugin, {})
  t.after(() => fiber.dispose())
  let respond = async () => { throw new Error('offline') }
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
  respond = async () => { throw new DOMException('Timed out', 'TimeoutError') }
  await assert.rejects(ctx.modelMetadata.refresh(), { name: 'TimeoutError' })
  respond = async () => new Response(JSON.stringify({ vendor: { models: { m: { name: 'Recovered' } } } }))
  assert.equal((await ctx.modelMetadata.preview('vendor', { id: 'm' })).proposed.name, 'Recovered')
})
