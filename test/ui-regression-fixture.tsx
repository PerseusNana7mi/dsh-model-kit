import { createRoot } from 'react-dom/client'
import { Panel } from '../src/client/Panel.js'
import { SettingsPage } from '../src/client/SettingsPage.js'
import css from '../src/client/style.css'
import type { Request, Reply, PriceState } from '../src/wire.js'
import { recommendCatalog } from '../src/core/recommend.js'

// Only transport and Settings are simulated. The production React components run unchanged.
interface Harness {
  calls: Request[]; holdCandidates: boolean; holdQuote: boolean; holdRead: boolean;
  release: undefined | (() => void); reject: undefined | (() => void);
  modelProviders: Record<string, string>; routes: NonNullable<Reply['routes']>;
  saved: Record<string, PriceState>; addProvider: () => void; removeProvider: () => void; removeModel: (id: string) => void;
}
const harness: Harness = (window as any).harness = {
  calls: [], holdCandidates: false, holdQuote: false, holdRead: false, release: undefined, reject: undefined,
  modelProviders: {}, routes: [], saved: {}, addProvider() {}, removeProvider() {}, removeModel() {},
}
const scenario = new URLSearchParams(location.search).get('scenario')
let modelRevision = 0
if (scenario === 'save-layout') { const style = document.createElement('style'); style.textContent = css + 'html,body{margin:0}#root{height:100vh}'; document.head.append(style) }
const models = new Map(['gpt-a', 'gpt-b'].map(id => [id, { id, name: id, ...(scenario === 'official' ? { reasoningEfforts: false } : {}), ...(scenario === 'conflict' ? { contextWindow: 64000 } : {}) } as NonNullable<Reply['model']>]))
const listeners = new Set<() => void>()
if (scenario === 'image-only') models.get('gpt-a')!.input = ['image']
harness.removeModel = id => { models.delete(id); for (const listener of listeners) listener() }
const subscribeChanges = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
harness.modelProviders = {}
harness.routes = [{ provider: 'gateway', name: 'Gateway', protectedPreset: false }]
harness.addProvider = () => {
  harness.routes.push({ provider: 'new-route', name: 'New Route', protectedPreset: false })
  for (let i = 0; i < 350; i++) { const id = `new-${i}`; models.set(id, { id, name: `New ${i}` }); harness.modelProviders[id] = 'new-route' }
  for (const listener of listeners) listener()
}
harness.removeProvider = () => {
  harness.routes = harness.routes.filter((row: { provider: string }) => row.provider !== 'new-route')
  for (const [id] of models) if (harness.modelProviders[id] === 'new-route') models.delete(id)
  for (const listener of listeners) listener()
}
const states = new Map<string, PriceState>()
if (scenario === 'prices') states.set('gpt-a', { revision: 0, effective: { input: 10, output: 20 }, record: {
  currency: 'USD', unit: 'per-million-tokens', mode: 'manual', rates: {
    input: { value: 10, origin: 'manual', updatedAt: 1 }, output: { value: 20, origin: 'manual', updatedAt: 1 },
  },
} })
const quote = (id: string) => ({ ticket: `quote-${id}`, prices: { input: 3, output: 15 }, source: { url: 'https://models.dev/api.json', provider: 'openai', model: id, fetchedAt: 1 } })
const call = async (r: Request): Promise<Reply> => {
  harness.calls.push(structuredClone(r))
  if (r.action === 'read' && harness.holdRead) {
    harness.holdRead = false
    const model = structuredClone(models.get(r.id)!)
    await new Promise<void>((resolve, reject) => { harness.release = resolve; harness.reject = () => reject(new Error('stale read failure')) })
    return { model, revision: modelRevision, prices: structuredClone(states.get(r.id) ?? { revision: 0, effective: {} }) }
  }
  if (scenario === 'save-layout' && ['list', 'routes'].includes(r.action) && modelRevision) await new Promise(resolve => setTimeout(resolve, 120))
  if (r.action === 'list') return { models: [...models.values()].map(model => ({ provider: harness.modelProviders[model.id] ?? 'gateway', id: model.id, name: model.name! })) }
  if (r.action === 'routes') return { routes: harness.routes }
  if (r.action === 'recommend') {
    if (harness.holdCandidates || harness.holdQuote) await new Promise<void>(resolve => { harness.release = resolve })
    if (scenario === 'official' || scenario === 'unknown-efforts') {
      const reasoning_options = scenario === 'official' ? [{ type: 'effort', values: ['low', 'high', 'max'] }] : [{ type: 'toggle' }]
      const recommendation = recommendCatalog({ openai: { models: { [r.id]: { reasoning: true, reasoning_options, modalities: { input: ['text', 'image'] } } } } }, r.id, { provider: 'gateway' })
      return { recommendation: { ...recommendation, priceMessage: '没有参考价格' } }
    }
    return { recommendation: { model: { id: r.id, contextWindow: 128000 }, method: 'base-url', matches: 1,
      candidates: [{ provider: 'openai', name: 'OpenAI', model: { id: r.id, contextWindow: 128000 } }],
      ...(scenario === 'unpriced' ? {} : { priceQuote: quote(r.id) }), priceMessage: scenario === 'unpriced' ? '参考价格存在分歧，未自动填价' : '参考价：openai（API 地址匹配）' } }
  }
  if (r.action === 'candidates') {
    if (harness.holdCandidates) await new Promise<void>(resolve => { harness.release = resolve })
    return { candidates: [{ provider: 'openai', name: 'OpenAI', model: { id: r.id, contextWindow: 128000 } }] }
  }
  if (r.action === 'pricePreview') {
    if (harness.holdQuote) await new Promise<void>(resolve => { harness.release = resolve })
    return { priceQuote: quote(r.id) }
  }
  if (!('id' in r)) throw new Error('Unexpected request')
  let state = states.get(r.id) ?? { revision: 0, effective: {} }
  if (r.action === 'model') { models.set(r.id, { ...models.get(r.id)!, ...r.patch }); modelRevision++ }
  if (r.action === 'priceDraft') {
    const rates = structuredClone(state.record && state.record.currency === (r.currency ?? 'USD') ? state.record.rates : {})
    for (const [key, value] of Object.entries(r.values)) Object.assign(rates, { [key]: { value, origin: 'manual', updatedAt: 2 } })
    for (const key of Object.keys(r.quotes)) Object.assign(rates, { [key]: { value: quote(r.id).prices[key as 'input' | 'output'], origin: 'catalog', updatedAt: 2, source: quote(r.id).source } })
    state = { revision: state.revision + 1, effective: Object.fromEntries(Object.entries(rates).map(([key, rate]) => [key, rate!.value])), record: { currency: r.currency ?? 'USD', unit: 'per-million-tokens', mode: 'manual', rates } }
  }
  if (r.action === 'multiplier') state = { revision: state.revision + 1, effective: { input: 3 * r.multiplier, output: 15 * r.multiplier }, record: {
    currency: r.currency ?? 'USD', unit: 'per-million-tokens', mode: 'multiplier', multiplier: r.multiplier, reference: quote(r.id), rates: state.record?.rates ?? {},
  } }
  if (r.action === 'manualMode' && state.record) state = { revision: state.revision + 1, record: { ...state.record, mode: 'manual' }, effective: Object.fromEntries(Object.entries(state.record.rates).map(([key, rate]) => [key, rate!.value])) }
  if (scenario === 'save-layout' && ['model', 'priceDraft'].includes(r.action)) { for (const listener of listeners) listener(); await new Promise(resolve => setTimeout(resolve, 80)) }
  states.set(r.id, state)
  harness.saved = Object.fromEntries(states)
  return { model: models.get(r.id)!, revision: modelRevision, prices: structuredClone(state), protectedPreset: false }
}
createRoot(document.getElementById('root')!).render(scenario === 'save-layout' ? <SettingsPage call={call} subscribeChanges={subscribeChanges}/> : <Panel call={call} subscribeChanges={subscribeChanges}/> )
