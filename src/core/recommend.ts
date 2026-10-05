// Matching policy adapted from agegr/pi-web (MIT). See THIRD_PARTY_NOTICES.md.
import { lookup, type ModelFields, type Prices } from './catalog.js'
import { officialProviders, officialSource } from './preferred-source.js'
import { fieldKeys } from './diff.js'
import { nativePrices } from './native-prices.js'
import type { Currency } from '../integration/settings.js'

type Row = Record<string, unknown>
const object = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {}
const normalizeProvider = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
const normalizeId = (v: string) => v.trim().toLowerCase().replace(/^models\//, '')
const canonicalHosts: Record<string, string[]> = {
  openai: ['api.openai.com'], anthropic: ['api.anthropic.com'],
  google: ['generativelanguage.googleapis.com'], openrouter: ['openrouter.ai'],
}
function host(v: string) { try { return new URL(v).hostname.toLowerCase().replace(/\.$/, '') } catch { return '' } }
export interface CatalogCandidate { provider: string; name: string; model: ModelFields; reasoningSupported?: boolean }
interface Entry extends CatalogCandidate { api: string; prices?: Prices }
export type MatchMethod = 'provider' | 'base-url' | 'consensus' | 'none'
export interface PriceRecommendation {
  status: 'reliable' | 'unreliable'
  method: MatchMethod | 'single-source'
  prices?: Prices
  provider?: string
  model?: string
  support: number
  total: number
  contributors: { provider: string; model: string }[]
  reason?: 'no-exact-match' | 'no-valid-price' | 'insufficient-support' | 'conflict'
}

function signature(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort())
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
  return typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value)
}
function winner<T>(values: T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>()
  for (const value of values) { const k = key(value); groups.set(k, [...groups.get(k) ?? [], value]) }
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length)
  return sorted[0] && sorted[0].length !== sorted[1]?.length ? sorted[0] : undefined
}

export const OFFICIAL_METADATA_WEIGHT = 5
const OTHER_METADATA_WEIGHT = 1
function weightedValue<T>(entries: Entry[], official: readonly string[], value: (entry: Entry) => T | undefined): T | undefined {
  const groups = new Map<string, { value: T; weight: number }>()
  let total = 0
  for (const entry of entries) {
    const weight = official.includes(entry.provider) ? OFFICIAL_METADATA_WEIGHT : OTHER_METADATA_WEIGHT
    total += weight
    const item = value(entry)
    if (item === undefined) continue
    const key = signature(item), previous = groups.get(key)
    groups.set(key, { value: item, weight: (previous?.weight ?? 0) + weight })
  }
  const ranked = [...groups.values()].sort((a, b) => b.weight - a.weight)
  const best = ranked[0]
  return best && best.weight !== ranked[1]?.weight && best.weight / total >= 0.6 ? structuredClone(best.value) : undefined
}

/** Normalize only known ID spellings. No suffix stripping or fuzzy model guesses. */
export function recommendCatalog(catalog: unknown, id: string, hints: { provider: string; name?: string; baseURL?: string }, currency: Currency = 'USD') {
  const entries: Entry[] = []
  const query = normalizeId(id)
  for (const [provider, raw] of Object.entries(object(catalog))) {
    const row = object(raw)
    for (const key of Object.keys(object(row.models))) {
      if (normalizeId(key) !== query && `${provider.toLowerCase()}/${normalizeId(key)}` !== query) continue
      const match = lookup(catalog, provider, key)
      if (!match) continue
      let prices: Prices | undefined
      try { prices = nativePrices(row, key, currency) } catch { /* Unknown/complex/subscription prices are not fixed rates. */ }
      entries.push({ provider, name: typeof row.name === 'string' ? row.name : provider, model: match.model,
        ...(match.reasoningSupported === undefined ? {} : { reasoningSupported: match.reasoningSupported }),
        api: typeof row.api === 'string' ? row.api : '', ...(prices ? { prices } : {}) })
    }
  }
  // A provider gets one vote, even if aliases normalize to the same ID.
  const unique = [...new Map(entries.map(entry => [entry.provider, entry])).values()]
  const names = [hints.provider, hints.name ?? ''].map(normalizeProvider).filter(Boolean)
  const byProvider = unique.filter(entry => names.includes(normalizeProvider(entry.provider)) || names.includes(normalizeProvider(entry.name)))
  const hostname = host(hints.baseURL ?? '')
  const byUrl = unique.filter(entry => hostname && [...canonicalHosts[entry.provider] ?? [], host(entry.api)].filter(Boolean)
    .some(expected => hostname === expected || hostname.endsWith(`.${expected}`)))
  // Prefer official evidence in the vote, without discarding other providers.
  const official = officialProviders(id).filter(provider => unique.some(entry => entry.provider === provider))
  const reasoningSource = byProvider.find(entry => official.includes(entry.provider))
    ?? byUrl.find(entry => official.includes(entry.provider)) ?? officialSource(id, unique)
  const chosen = official.length ? undefined : byProvider[0] ?? byUrl[0]
  const method = official.length ? 'weighted-consensus' as const : chosen ? (byProvider.includes(chosen) ? 'provider' as const : 'base-url' as const) : unique.length ? 'consensus' as const : 'none' as const
  const model: ModelFields = { id }
  if (chosen) Object.assign(model, chosen.model, { id })
  else for (const key of fieldKeys) {
    if (key === 'reasoningEfforts') continue
    const value = weightedValue(unique, official, entry => entry.model[key])
    if (value !== undefined) Object.assign(model, { [key]: value })
  }
  // Effort names/request values are an API contract, never a majority vote.
  delete model.reasoningEfforts
  if (reasoningSource?.model.reasoningEfforts !== undefined) model.reasoningEfforts = structuredClone(reasoningSource.model.reasoningEfforts)
  const reasoningSupported = chosen?.reasoningSupported ?? weightedValue(unique, official, entry => entry.reasoningSupported)
  const priced = unique.filter(entry => entry.prices)
  const direct = byProvider.find(entry => entry.prices) ?? byUrl.find(entry => entry.prices)
  let price: PriceRecommendation
  if (direct) price = { status: 'reliable', method: byProvider.includes(direct) ? 'provider' : 'base-url', prices: direct.prices!,
    provider: direct.provider, model: direct.model.id, support: 1, total: 1, contributors: [{ provider: direct.provider, model: direct.model.id }] }
  else if (currency === 'CNY' && priced.length === 1) {
    const reference = priced[0]!
    price = { status: 'reliable', method: 'single-source', prices: reference.prices!, provider: reference.provider, model: reference.model.id,
      support: 1, total: 1, contributors: [{ provider: reference.provider, model: reference.model.id }] }
  }
  else {
    const group = winner(priced, entry => JSON.stringify([entry.prices!.input, entry.prices!.output]))
    if (priced.length > 1 && group && (group.length / priced.length >= 0.6 || group.length >= 5)) {
      const prices: Prices = { input: group[0]!.prices!.input!, output: group[0]!.prices!.output! }
      for (const key of ['cacheRead', 'cacheWrite'] as const) {
        // Missing remains unknown. Do not turn unknown or tied cache prices into free usage.
        const cache = winner(group.map(entry => entry.prices![key]), signature)
        if (cache?.[0] !== undefined) prices[key] = cache[0]
      }
      price = { status: 'reliable', method: 'consensus', prices, provider: 'consensus', model: id, support: group.length, total: priced.length,
        contributors: group.map(entry => ({ provider: entry.provider, model: entry.model.id })) }
    } else price = { status: 'unreliable', method: 'none', support: group?.length ?? 0, total: priced.length, contributors: [],
      reason: !unique.length ? 'no-exact-match' : !priced.length ? 'no-valid-price' : priced.length === 1 ? 'insufficient-support' : 'conflict' }
  }
  return { model, method, matches: unique.length,
    ...(official.length ? { officialProviders: official, officialWeight: OFFICIAL_METADATA_WEIGHT } : {}),
    ...(reasoningSource ? { reasoningProvider: reasoningSource.provider } : {}),
    ...(reasoningSupported === undefined ? {} : { reasoningSupported }),
    price, priceCandidates: priced.map(({ provider, name, model }) => ({ provider, name, model: model.id })),
    candidates: unique.map(({ provider, name, model, reasoningSupported }) => ({ provider, name, model,
      ...(reasoningSupported === undefined ? {} : { reasoningSupported }) })) }
}
