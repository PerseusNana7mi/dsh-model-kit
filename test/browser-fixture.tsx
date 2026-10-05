import { createRoot } from 'react-dom/client'
import { Panel } from '../src/client/Panel.js'
import css from '../src/client/style.css'
import type { Request, Reply, PriceState } from '../src/wire.js'
import { differences } from '../src/core/diff.js'
const style = document.createElement('style'); style.textContent = css; document.head.append(style)
let model = { id: 'gpt-sample', name: 'Sample model' } as NonNullable<Reply['model']>
let revision = 0
let prices: PriceState = { revision: 0, effective: {} }
const call = async (r: Request): Promise<Reply> => {
  if (r.action === 'recommend') {
    const candidates = (await call({ action: 'candidates', id: r.id })).candidates!
    const priceQuote = (await call({ action: 'pricePreview', id: r.id, catalogProvider: 'openai' })).priceQuote!
    return { recommendation: { model: candidates.find(row => row.provider === 'openai')!.model, method: 'base-url', matches: candidates.length, candidates, priceQuote, priceMessage: '参考价：openai（API 地址匹配）' } }
  }
  if (r.action === 'pricePreview') {
    if (r.catalogProvider !== 'openai' || r.id !== 'gpt-sample') throw new Error('Incorrect automatic price reference')
    return { priceQuote: { ticket: 'quote-openai', prices: { input: 3, output: 15 }, source: { provider: r.catalogProvider, model: r.id, url: 'https://models.dev/api.json', fetchedAt: Date.now() } } }
  }
  if (r.action === 'routes') return { routes: [{ provider: 'gateway', name: 'Gateway', protectedPreset: false }, { provider: 'builtin', name: 'Builtin', protectedPreset: true, inherited: true }] }
  if (r.action === 'candidates') return { candidates: [...Array.from({ length: 40 }, (_, i) => ({ provider: `reseller-${i}`, name: `Reseller ${i}`, model: { id: r.id, contextWindow: 32000 } })), { provider: 'openai', name: 'OpenAI', model: { id: r.id, name: 'Catalog name', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] } }] }
  if (r.action === 'builtinList') return { builtinModels: [{ id: 'catalog', name: 'Catalog' }] }
  if (r.action === 'builtinRead') return { builtin: { base: { id: 'catalog', contextWindow: 128000 }, model: { id: 'catalog', contextWindow: 64000 }, overrides: { contextWindow: 64000 }, revision: 0 } }
  if (r.action === 'builtinWrite') return { builtin: { base: { id: 'catalog', contextWindow: 128000 }, model: { id: 'catalog', contextWindow: r.reset.includes('contextWindow') ? 128000 : r.patch.contextWindow ?? 64000 }, overrides: r.reset.includes('contextWindow') ? {} : r.patch, revision: 1 } }
  if (r.action === 'discover') return { discovery: { ticket: 'discovery', protectedPreset: false, rows: [{ model: { id: 'new-model' }, existing: false, candidates: ['openai'], selected: 'openai' }] } }
  if (r.action === 'importPreview') {
    const current = { id: 'new-model' }
    const suggested = { ...current, name: 'New Model', contextWindow: 128000, maxTokens: 8192 }
    return { importPlan: { ticket: 'plan', protectedPreset: false, requiresOutputConsent: true, rows: [{ model: suggested, current, suggested, differences: differences(current, suggested), source: 'openai', changes: ['name', 'contextWindow', 'maxTokens'] }] } }
  }
  if (r.action === 'importCommit') return { imported: 1, models: [{ provider: 'gateway', id: 'gpt-sample', name: model.name! }, { provider: 'gateway', id: 'new-model', name: 'New Model' }] }
  if (r.action === 'list') return { models: [{ provider: 'gateway', id: 'gpt-sample', name: model.name! }, ...Array.from({ length: 100 }, (_, i) => ({ provider: 'gateway', id: `extra-${i}`, name: `Extra model ${i}` }))] }
  if (r.action === 'preview') return { preview: { matched: true, proposed: { ...model, contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] }, changes: ['contextWindow', 'maxTokens', 'input'] } }
  if (r.action === 'model') {
    if (r.patch.maxTokens && !r.acceptDefaultOutputCap) throw new Error('Changing maxTokens requires acceptDefaultOutputCap: true')
    model = { ...model, ...r.patch }; revision++
  }
  if (r.action === 'manual' || r.action === 'priceDraft') {
    const quoted = r.action === 'priceDraft' ? Object.fromEntries(Object.keys(r.quotes).map(key => [key, key === 'input' ? 3 : 15])) : {}
    const values = { ...Object.fromEntries(Object.entries(prices.record?.currency === (r.currency ?? 'USD') ? prices.record.rates : {}).map(([key, rate]) => [key, rate?.value])), ...quoted, ...r.values }
    if (r.values.input === 13) throw new Error('模拟价格保存失败')
    prices = { revision: prices.revision + 1, effective: values, record: { mode: 'manual', currency: r.currency ?? 'USD', unit: 'per-million-tokens',
      rates: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value, origin: 'manual', updatedAt: Date.now() }])) } }
  }
  if (r.action === 'multiplier') {
    prices = { revision: prices.revision + 1, effective: { input: 3 * r.multiplier, output: 15 * r.multiplier },
      record: { currency: 'USD', unit: 'per-million-tokens', rates: prices.record?.rates ?? {}, mode: 'multiplier', multiplier: r.multiplier,
        reference: { prices: { input: 3, output: 15 }, source: { url: 'https://models.dev/api.json', provider: r.referenceProvider, model: r.referenceModel, fetchedAt: Date.now() } } } }
  }
  return { model, revision, prices, protectedPreset: true }
}
createRoot(document.getElementById('root')!).render(<Panel call={call}/> )
