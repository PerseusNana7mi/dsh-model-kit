import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mappingState, sourceMapping, type SourceMapping, type MappingSource } from '../source-mapping.js'
import { BASELLM_CATALOG_URL } from '../core/sources.js'
import { object, readModel, type Currency, type SettingsPort } from './settings.js'

export const mappingKey = (ns: string, provider: string, id: string, source: MappingSource, currency: Currency) =>
  JSON.stringify([ns, provider, id, source, currency])

/** Only an explicitly confirmed reference is remembered; no automatic matching policy changes. */
export class SourceMappings {
  constructor(
    private readonly settings: () => SettingsPort,
    private readonly modelNs: string,
    private readonly pluginNs: () => string,
    private readonly catalogUrl: () => string,
  ) {}
  private snapshot(provider: string) {
    const settings = this.settings()
    const sections = settings.describe({ redactSecrets: true })
    const plugin = sections.find((row) => row.ns === this.pluginNs())
    const model = sections.find((row) => row.ns === this.modelNs)
    if (!plugin || !model) throw new Error('Settings namespace is unavailable')
    const providers = object(object(model.value).providers ?? {})
    const route = Object.hasOwn(providers, provider) ? object(providers[provider]) : undefined
    const hiddenRoute = model.secrets?.some((secret) =>
      ['api', 'baseURL'].some((key) => ['providers', provider, key].every((part, i) => secret.path[i] === part)),
    )
    // Never persist or return route URLs, headers or credentials.
    const routeHash =
      hiddenRoute || !route
        ? ''
        : createHash('sha256')
            .update(JSON.stringify([route.api ?? null, route.baseURL ?? null]))
            .digest('hex')
    const records = object(object(plugin.value).sourceMappings ?? {})
    return { settings, plugin, model, records, routeHash }
  }
  private url(source: MappingSource) {
    return source === 'models.dev' ? this.catalogUrl() : BASELLM_CATALOG_URL
  }
  private afterMutation(provider: string, id: string, revision: number, pricesBefore: unknown) {
    const state = this.read(provider, id)
    const pricesAfter = object(this.snapshot(provider).plugin.value).prices
    // Rebase only a draft based on the exact pre-mutation revision, and only
    // when the complete price table is still equal to that revision's table.
    return mappingState.parse({
      ...state,
      ...((state.revision === revision || state.revision === revision + 1) &&
      isDeepStrictEqual(pricesBefore, pricesAfter)
        ? { priceRevisionFrom: revision }
        : {}),
    })
  }
  read(provider: string, id: string) {
    const current = this.snapshot(provider)
    const entries = []
    for (const pricingSource of ['models.dev', 'basellm'] as const) {
      for (const currency of ['USD', 'CNY'] as const) {
        const key = mappingKey(this.modelNs, provider, id, pricingSource, currency)
        if (!Object.hasOwn(current.records, key)) continue
        const parsed = sourceMapping.safeParse(current.records[key])
        const record = parsed.success
          ? parsed.data
          : {
              pricingSource,
              currency,
              referenceProvider: 'invalid',
              referenceModel: 'invalid',
              confirmedAt: 0,
            }
        entries.push({
          referenceProvider: record.referenceProvider,
          referenceModel: record.referenceModel,
          confirmedAt: record.confirmedAt,
          pricingSource,
          currency,
          status:
            !parsed.success || parsed.data.pricingSource !== pricingSource || parsed.data.currency !== currency
              ? ('invalid' as const)
              : parsed.data.catalogUrl !== this.url(pricingSource)
                ? ('catalog-changed' as const)
                : parsed.data.routeHash !== current.routeHash || !current.routeHash
                  ? ('route-changed' as const)
                  : ('ready' as const),
        })
      }
    }
    return mappingState.parse({
      revision: current.plugin.revision,
      modelRevision: current.model.revision,
      writable: current.settings.writable,
      entries,
    })
  }
  check(provider: string, id: string, revision: number, modelRevision: number) {
    const state = this.read(provider, id)
    if (state.revision !== revision || state.modelRevision !== modelRevision)
      throw new Error('配置已变化，请重新读取后操作来源映射')
    readModel(this.settings(), this.modelNs, provider, id)
    return state
  }
  reference(
    provider: string,
    id: string,
    source: MappingSource,
    currency: Currency,
    revision: number,
    modelRevision: number,
  ) {
    const state = this.check(provider, id, revision, modelRevision)
    const entry = state.entries.find((row) => row.pricingSource === source && row.currency === currency)
    if (!entry || entry.status !== 'ready') throw new Error('来源映射不存在或已失效，请重新选择并确认来源')
    return entry
  }
  async save(
    provider: string,
    id: string,
    reference: Pick<SourceMapping, 'referenceProvider' | 'referenceModel' | 'pricingSource' | 'currency'>,
    revision: number,
    modelRevision: number,
  ) {
    this.check(provider, id, revision, modelRevision)
    const current = this.snapshot(provider)
    if (!current.settings.writable) throw new Error('Settings are read-only')
    if (!current.routeHash) throw new Error('路由字段已脱敏，无法安全记住来源映射')
    if (reference.pricingSource === 'models.dev' && reference.currency !== 'USD')
      throw new Error('Models.dev 仅提供 USD')
    const record = sourceMapping.parse({
      ...reference,
      catalogUrl: this.url(reference.pricingSource),
      routeHash: current.routeHash,
      confirmedAt: Date.now(),
    })
    const key = mappingKey(this.modelNs, provider, id, reference.pricingSource, reference.currency)
    if (!Object.hasOwn(current.records, key) && Object.keys(current.records).length >= 2000)
      throw new Error('来源映射已达 2000 条上限，请先清除不需要的映射')
    const pricesBefore = structuredClone(object(current.plugin.value).prices)
    await current.settings.mutate(
      this.pluginNs(),
      [{ op: 'set', path: ['sourceMappings', key], value: record }],
      revision,
    )
    return this.afterMutation(provider, id, revision, pricesBefore)
  }
  async clear(provider: string, id: string, source: MappingSource, currency: Currency, revision: number) {
    const current = this.snapshot(provider)
    if (!current.settings.writable) throw new Error('Settings are read-only')
    if (current.plugin.revision !== revision) throw new Error('配置已变化，请重新读取后清除来源映射')
    const key = mappingKey(this.modelNs, provider, id, source, currency)
    const pricesBefore = structuredClone(object(current.plugin.value).prices)
    if (Object.hasOwn(current.records, key))
      await current.settings.mutate(this.pluginNs(), [{ op: 'unset', path: ['sourceMappings', key] }], revision)
    return this.afterMutation(provider, id, revision, pricesBefore)
  }
}
