import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

test('distributed client registers a lazy DSH module factory and exports the plugin', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: entry => { registered = entry } } } }
  vm.runInNewContext(await readFile('lib/client.js', 'utf8'), sandbox)
  assert.equal(manifest.name, 'dsh-model-kit')
  assert.equal(registered.id, manifest.name)
  const plugin = registered.factory(name => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsx
    throw new Error(`Unexpected runtime dependency: ${name}`)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(Array.from(plugin.inject), ['remote', 'slots'])
  let call
  let subscribeChanges
  const listeners = new Map()
  const listen = (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) }
  let namespaceDisposed = false
  let unmounted = false
  const effects = []
  sandbox.document = { createElement: () => ({ remove() {} }), head: { append() {} } }
  const slots = { inject: (name, fn) => { assert.equal(name, 'settings.section'); fn(); return () => {} }, register: entry => {
    assert.equal(entry.name, 'settings.section')
    assert.equal(entry.id, 'model-metadata')
    assert.equal(entry.label(), '模型信息助手')
    ;({ call, subscribeChanges } = entry.inject())
  } }
  const ctx = {
    slots,
    remote: new Proxy({ $mount: async contribution => {
      assert.equal(contribution.package, manifest.name)
      assert.equal(contribution.descriptors[0].id, `${manifest.name}#modelMetadataUi/execute`)
      assert.equal(contribution.descriptors[0].parameters[0].codec.typeSymbol, `${manifest.name}#Request`)
      assert.equal(contribution.descriptors[0].result.typeSymbol, `${manifest.name}#Reply`)
      return async () => { unmounted = true }
    } }, { get(target, key) {
      if (key === 'modelMetadataUi') throw Error('namespace accessed without inject')
      return target[key]
    } }),
    effect: fn => { effects.push(Promise.resolve(fn())) },
    inject: (names, fn) => {
      assert.deepEqual(Array.from(names), ['remote.modelMetadataUi'])
      fn({ slots, on: listen, remote: { $on: listen, modelMetadataUi: { execute: async () => ({ ok: true, value: { models: [] } }) } }, effect: ctx.effect })
      return { dispose: async () => { namespaceDisposed = true } }
    },
  }
  plugin.apply(ctx)
  const cleanup = await Promise.all(effects)
  assert.equal((await call({ action: 'list' })).models.length, 0)
  let invalidations = 0
  const unsubscribe = subscribeChanges(() => invalidations++)
  for (const event of ['settings/document-updated', 'llm/adapters-updated', 'connection/reset']) listeners.get(event)()
  assert.equal(invalidations, 3)
  unsubscribe()
  assert.equal(listeners.size, 0)
  for (const dispose of cleanup.reverse()) if (typeof dispose === 'function') await dispose()
  assert.equal(namespaceDisposed, true)
  assert.equal(unmounted, true)
})
