import { recommendCatalog } from './core/recommend.js'
import { randomUUID } from 'node:crypto'
import { nativePrices } from './core/native-prices.js'
import { ModelImporter } from './integration/import.js'
import { ModelOverrides } from './integration/overrides.js'
import { catalogCandidates } from './core/diff.js'
import type {} from '@deepseek-ai/dsh-llm'

import type { Currency, PriceRecord } from './integration/settings.js'

import { Service, type Context } from '@deepseek-ai/cordis'

import Schema from '@deepseek-ai/schemastery'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type {} from '@deepseek-ai/dsh-settings'

import { lookup, preview, type ModelFields } from './core/catalog.js'

import { modelSnapshot, saveModel, readPrices, savePrices, saveMultiplier, useManualPrices, priceKey, type ModelPatch, type PriceSource } from './integration/settings.js'

import type { Prices } from './core/catalog.js'

import { pricesSchema } from './pricing-schema.js'

import MetadataController from './controller.js'



export interface Config {

  catalogUrl: string

  timeoutMs: number

  cacheTtlMs: number

  modelNamespace: string

  prices: Record<string, PriceRecord>

}


export const Config = Schema.object({

  catalogUrl: Schema.string().default('https://models.dev/api.json'),

  timeoutMs: Schema.number().min(1).max(2147483647).step(1).default(15000),

  cacheTtlMs: Schema.number().min(0).max(2147483647).step(1).default(86400000),

  modelNamespace: Schema.string().default('llm-pi-ai'),

  prices: pricesSchema,

})



declare module '@deepseek-ai/cordis' {

  interface Context { modelMetadata: ModelMetadataService }

}



/** Host-only foundation. Network access is explicit; startup performs no sync. */

export default class ModelMetadataService extends Service {

  static Config = Config

  private readonly quotes = new Map<string, { prices: Prices; source: PriceSource; currency: Currency; targetId: string; expires: number }>()
  private nativeCatalog: { data: unknown; fetchedAt: number } | undefined
  private catalog: unknown

  private fetchedAt = 0

  private readonly lifetime = new AbortController()
  readonly importer: ModelImporter
  readonly overrides: ModelOverrides



  constructor(private readonly owner: Context, private readonly config: Config) {

    const ctx = owner

    super(ctx, 'modelMetadata')
    this.overrides = new ModelOverrides(() => this.settings(), () => {
      const llm = this.owner.get('llm')
      if (!llm) throw new Error('DSH LLM service is unavailable')
      return llm
    }, config.modelNamespace, () => AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.timeoutMs)]))
    this.importer = new ModelImporter(() => this.settings(), () => {
      const llm = this.owner.get('llm')
      if (!llm) throw new Error('DSH LLM service is unavailable')
      return llm
    }, config.modelNamespace, async () => {
      if (!this.catalog || Date.now() - this.fetchedAt >= config.cacheTtlMs) await this.refresh()
      return this.catalog
    }, () => AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.timeoutMs)]))

    const url = new URL(config.catalogUrl)

    if (url.protocol !== 'https:' || url.username || url.password) {

      throw new Error('catalogUrl must be an HTTPS URL without credentials')

    }

    ctx.effect(() => () => this.lifetime.abort(), 'model-metadata requests')

    ctx.plugin(MetadataController)

  }



  private settings() {

    const settings = this.owner.get('settings')

    if (!settings) throw new Error('DSH Settings service is unavailable')

    return settings

  }



  private priceNamespace() {

    const id = this.owner.fiber.entry?.options.id

    if (!id) throw new Error('Price persistence requires a Loader profile entry')

    return id

  }



  readModel(provider: string, id: string) {

    const snapshot = modelSnapshot(this.settings(), this.config.modelNamespace, provider, id)
    const directory = this.owner.get('llm')?.listConfigurableProviders().find(row => row.settingsNs === this.config.modelNamespace && row.provider === provider)
    return { ...snapshot, protectedPreset: snapshot.protectedPreset || (directory !== undefined && directory.declared !== true) }

  }

  async candidates(id: string) {
    if (!this.catalog || Date.now() - this.fetchedAt >= this.config.cacheTtlMs) await this.refresh()
    return catalogCandidates(this.catalog, id)
  }



  listModels() {

    const section = this.settings().describe({ redactSecrets: true }).find(row => row.ns === this.config.modelNamespace)

    if (!section) throw new Error('Model settings namespace is unavailable')

    const providers = (section.value as { providers?: Record<string, { models?: ModelFields[] }> }).providers ?? {}

    return Object.entries(providers).flatMap(([provider, route]) => (route.models ?? []).map(model => ({

      provider, id: model.id, name: model.name ?? model.id,

    })))

  }



  async previewConfigured(provider: string, id: string, catalogProvider = provider) {

    const snapshot = this.readModel(provider, id)

    return { ...await this.preview(catalogProvider, snapshot.model), revision: snapshot.revision }

  }



  async saveModel(provider: string, id: string, patch: ModelPatch, expectedRevision: number, acceptDefaultOutputCap = false, allowPresetOverride = false) {
    if (this.readModel(provider, id).protectedPreset && !allowPresetOverride) throw new Error('请明确开启覆盖预设参数')

    return saveModel(this.settings(), this.config.modelNamespace, provider, id, patch, expectedRevision, acceptDefaultOutputCap, allowPresetOverride)

  }



  readPrices(provider: string, id: string) {

    return readPrices(this.settings(), this.priceNamespace(), priceKey(this.config.modelNamespace, provider, id))

  }



  /** Explicit reference provider/model: never assume a reseller's catalog is the official rate. */

  async setPriceMultiplier(provider: string, id: string, referenceProvider: string, referenceModel: string,

    multiplier: number, expectedRevision: number, currency: Currency = 'USD', pricingSource = 'models.dev', quoteTicket?: string, reuseSavedReference = false) {

    this.readModel(provider, id)

    const saved = this.readPrices(provider, id).record
    const prior = saved?.currency === currency ? saved.reference : undefined
    const url = pricingSource === 'models.dev' ? this.config.catalogUrl : `https://basellm.github.io/llm-metadata/api/providers/${referenceProvider}.json`
    const reference = quoteTicket ? this.readQuote(quoteTicket, currency) : reuseSavedReference ? prior : await this.priceReference(referenceProvider, referenceModel, currency, pricingSource)
    if (!reference) throw new Error('没有已保存的参考报价，请重新获取参考单价')
    if (reference.source.provider !== referenceProvider || reference.source.model !== referenceModel || (reference.source.url !== url && !(pricingSource === 'basellm' && reference.source.url === 'https://basellm.github.io/llm-metadata/api/all.json'))) throw new Error('报价来源已变化，请重新获取参考单价')

    return saveMultiplier(this.settings(), this.priceNamespace(), priceKey(this.config.modelNamespace, provider, id), reference, multiplier, expectedRevision, currency)

  }



  async useManualPrices(provider: string, id: string, expectedRevision: number) {

    this.readModel(provider, id)

    return useManualPrices(this.settings(), this.priceNamespace(), priceKey(this.config.modelNamespace, provider, id), expectedRevision)

  }



  /** Manual edits replace only specified rates; omitted rates remain intact. */

  async savePrices(provider: string, id: string, values: Prices, expectedRevision: number, currency: Currency = 'USD') {

    this.readModel(provider, id)

    return savePrices(this.settings(), this.priceNamespace(), priceKey(this.config.modelNamespace, provider, id), values, expectedRevision, undefined, currency)

  }



  /** Catalog fill never overwrites existing rates, including manually configured zero. */

  async fillPrices(provider: string, id: string, expectedRevision: number, catalogProvider = provider,

    currency: Currency = 'USD', pricingSource = 'models.dev') {

    this.readModel(provider, id)

    const reference = await this.priceReference(catalogProvider, id, currency, pricingSource)

    return savePrices(this.settings(), this.priceNamespace(), priceKey(this.config.modelNamespace, provider, id), reference.prices, expectedRevision, reference.source, currency)

  }



  private readQuote(ticket: string, currency: Currency, targetId?: string) {
    const quote = this.quotes.get(ticket)
    if (!quote || quote.expires < Date.now()) throw new Error('参考报价已过期，请重新获取参考单价')
    if (targetId !== undefined && quote.targetId !== targetId) throw new Error('报价模型不匹配，请重新获取参考单价')
    if (quote.currency !== currency) throw new Error('报价币种不匹配，请重新获取参考单价')
    return { prices: structuredClone(quote.prices), source: structuredClone(quote.source) }
  }

  private storeQuote(reference: { prices: Prices; source: PriceSource }, currency: Currency, targetId: string) {
    for (const [ticket, quote] of this.quotes) if (quote.expires < Date.now()) this.quotes.delete(ticket)
    if (this.quotes.size >= 128) this.quotes.delete(this.quotes.keys().next().value!)
    const ticket = randomUUID()
    this.quotes.set(ticket, { ...structuredClone(reference), currency, targetId, expires: Date.now() + 30 * 60_000 })
    return { ...reference, ticket }
  }

  async quotePrices(provider: string, id: string, currency: Currency, pricingSource: string, targetId = id) {
    return this.storeQuote(await this.priceReference(provider, id, currency, pricingSource), currency, targetId)
  }

  async recommend(provider: string, id: string, currency: Currency, pricingSource: string) {
    const section = this.settings().describe({ redactSecrets: true }).find(row => row.ns === this.config.modelNamespace)
    const providers = (section?.value as { providers?: Record<string, { displayName?: string; baseURL?: string }> } | undefined)?.providers
    if (!providers || !Object.hasOwn(providers, provider)) throw new Error('请先配置供应商')
    const route = providers[provider]!
    const hints = { provider, ...(route.displayName ? { name: route.displayName } : {}), ...(route.baseURL ? { baseURL: route.baseURL } : {}) }
    if (!this.catalog || Date.now() - this.fetchedAt >= this.config.cacheTtlMs) await this.refresh()
    const metadata = recommendCatalog(this.catalog, id, hints)
    const result = { model: metadata.model, method: metadata.method, matches: metadata.matches, candidates: metadata.candidates,
      ...(metadata.officialProviders ? { officialProviders: metadata.officialProviders, officialWeight: metadata.officialWeight } : {}),
      ...(metadata.reasoningProvider ? { reasoningProvider: metadata.reasoningProvider } : {}),
      ...(metadata.reasoningSupported === undefined ? {} : { reasoningSupported: metadata.reasoningSupported }) }
    try {
      let catalog = this.catalog, fetchedAt = this.fetchedAt, url = this.config.catalogUrl
      if (pricingSource === 'basellm') {
        url = 'https://basellm.github.io/llm-metadata/api/all.json'
        if (!this.nativeCatalog || Date.now() - this.nativeCatalog.fetchedAt >= this.config.cacheTtlMs) {
          const response = await fetch(url, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)]), headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`basellm request failed: HTTP ${response.status}`)
          const data: unknown = await response.json()
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid basellm catalog')
          this.nativeCatalog = { data, fetchedAt: Date.now() }
        }
        catalog = this.nativeCatalog.data; fetchedAt = this.nativeCatalog.fetchedAt
      } else if (pricingSource !== 'models.dev' || currency !== 'USD') throw new Error('Models.dev 仅提供 USD；人民币请选 basellm')
      const { price, priceCandidates } = recommendCatalog(catalog, id, hints, currency)
      if (price.status !== 'reliable' || !price.prices) {
        const messages = { 'no-exact-match': '没有匹配的参考价格', 'no-valid-price': '没有可用的固定单价（可能缺失、分层或订阅计费）', 'insufficient-support': '价格来源不足，未自动填价', conflict: '参考价格存在分歧，未自动填价' }
        return { ...result, priceCandidates, priceMessage: price.reason === 'insufficient-support' ? `仅找到 1 个 ${currency} 价格来源，请在“编辑价格”中选择参考来源后获取` : messages[price.reason ?? 'no-valid-price'] }
      }
      const source: PriceSource = { url, provider: price.provider!, model: price.model!, fetchedAt,
        method: price.method as NonNullable<PriceSource['method']>, support: price.support, total: price.total, contributors: price.contributors }
      return { ...result, priceCandidates, priceQuote: this.storeQuote({ prices: price.prices, source }, currency, id),
        priceMessage: price.method === 'single-source' ? `参考价：${price.provider}（CNY 单一来源参考价）` : price.method === 'consensus' ? `参考价：${price.support}/${price.total} 个来源一致` : `参考价：${price.provider}（${price.method === 'provider' ? '供应商匹配' : 'API 地址匹配'}）` }
    } catch (error) {
      return { ...result, priceMessage: `参数已查询；参考价格未获取：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async savePriceDraft(provider: string, id: string, manual: Prices, quotes: Partial<Record<keyof Prices, string>>, expectedRevision: number, currency: Currency) {
    this.readModel(provider, id)
    const values = { ...manual }
    const origins: Partial<Record<keyof Prices, PriceSource>> = {}
    for (const key of Object.keys(quotes) as (keyof Prices)[]) {
      if (Object.hasOwn(manual, key)) throw new Error('同一单价不能同时来自手动输入和参考报价')
      const quote = this.readQuote(quotes[key]!, currency, id)
      const value = quote.prices[key]
      if (value === undefined) throw new Error('参考报价不包含此单价')
      values[key] = value
      origins[key] = quote.source
    }
    return savePrices(this.settings(), this.priceNamespace(), priceKey(this.config.modelNamespace, provider, id), values, expectedRevision, undefined, currency, origins)
  }

  async priceReference(provider: string, id: string, currency: Currency, pricingSource: string) {

    if (pricingSource === 'basellm') {

      if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error('Invalid reference provider ID')

      const url = `https://basellm.github.io/llm-metadata/api/providers/${provider}.json`

      const response = await fetch(url, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)]), headers: { accept: 'application/json' } })

      if (!response.ok) throw new Error(`basellm request failed: HTTP ${response.status}`)

      const data: unknown = await response.json()

      return { prices: nativePrices(data, id, currency), source: { url, provider, model: id, fetchedAt: Date.now() } }

    }

    if (pricingSource !== 'models.dev' || currency !== 'USD') throw new Error('Models.dev 仅提供 USD；人民币请选 basellm 或手动填写')

    if (!this.catalog || Date.now() - this.fetchedAt >= this.config.cacheTtlMs) await this.refresh()

    const match = lookup(this.catalog, provider, id)

    if (!match) throw new Error('No exact reference price match')

    // Apply the same complexity guard to Models.dev prices.

    const data = (this.catalog as Record<string, unknown>)[provider]

    return { prices: nativePrices(data, id, currency), source: { url: this.config.catalogUrl, provider, model: id, fetchedAt: this.fetchedAt } }

  }



  async refresh() {

    const response = await fetch(this.config.catalogUrl, {

      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)]),

      headers: { accept: 'application/json' },

    })

    if (!response.ok) throw new Error(`Model catalog request failed: HTTP ${response.status}`)

    const catalog: unknown = await response.json()

    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {

      throw new Error('Model catalog must be a provider-keyed object')

    }

    this.catalog = catalog

    this.fetchedAt = Date.now()

    return { fetchedAt: this.fetchedAt, source: this.config.catalogUrl }

  }



  async preview(provider: string, current: ModelFields) {

    if (!this.catalog || Date.now() - this.fetchedAt >= this.config.cacheTtlMs) await this.refresh()

    const match = lookup(this.catalog, provider, current.id)

    if (!match) return { matched: false as const, provider, id: current.id }

    return { matched: true as const, ...preview(current, match), source: this.config.catalogUrl, fetchedAt: this.fetchedAt }

  }

}
