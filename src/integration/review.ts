import { differences } from '../core/diff.js'
import { recommendCatalog } from '../core/recommend.js'
import { nativePrices } from '../core/native-prices.js'
import { BASELLM_CATALOG_URL, basellmProviderUrl } from '../core/sources.js'
import { readableError } from '../core/errors.js'
import { MAX_PRICE } from '../core/limits.js'
import { effectivePrices, object, PRICE_KEYS, priceKey, readModel, readPrices } from './settings.js'
import type { Currency, PriceRecord, PriceSource, SettingsPort } from './settings.js'
import type { Prices } from '../core/catalog.js'
import type { Reply } from '../wire.js'

type Review = NonNullable<Reply['batchReview']>
type Row = Review['rows'][number]
export interface ReviewOptions {
  targets: { provider: string; id: string }[]
  currency: Currency
  pricingSource: 'models.dev' | 'basellm'
}
export interface ReviewCatalog {
  data: unknown
  url: string
  fetchedAt: number
}
export interface ReviewCatalogs {
  metadata?: ReviewCatalog
  pricing?: ReviewCatalog
  warnings: string[]
}

/** A read-only projection: unknown reference fields never remove saved values. */
export function priceDifferences(
  record: PriceRecord | undefined,
  reference: Partial<Record<keyof Prices, number | undefined>>,
  currency: Currency,
) {
  const current = effectivePrices(record)
  if (record && record.currency !== currency) return []
  const factor = record?.mode === 'multiplier' ? record.multiplier : 1
  if (factor === undefined || !Number.isFinite(factor) || factor < 0) return []
  return PRICE_KEYS.flatMap((key) => {
    const value = reference[key]
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > MAX_PRICE) return []
    const after = value * factor
    if (!Number.isFinite(after) || after > MAX_PRICE || after < 0 || after === current[key]) return []
    return [{ key, before: current[key], after, selected: record?.mode !== 'multiplier' && current[key] === undefined }]
  })
}

/** Both namespaces are captured once, then checked again after the shared downloads. No mutation or quote tickets. */
export async function reviewModels(
  settings: SettingsPort,
  modelNamespace: string,
  priceNamespace: string,
  declaredProviders: ReadonlySet<string>,
  options: ReviewOptions,
  loadCatalogs: () => Promise<ReviewCatalogs>,
): Promise<Review> {
  const keys = options.targets.map(({ provider, id }) => priceKey(modelNamespace, provider, id))
  if (new Set(keys).size !== keys.length) throw new Error('批量核对不能重复选择同一模型')
  const sections = structuredClone(settings.describe({ redactSecrets: true }))
  const models = sections.find((row) => row.ns === modelNamespace)
  const prices = sections.find((row) => row.ns === priceNamespace)
  if (!models || !prices) throw new Error('批量核对的模型或价格配置不可用')
  const snapshot: SettingsPort = {
    describe: () => sections,
    writable: false,
    mutate: () => {
      throw new Error('批量核对不写入配置')
    },
  }
  const catalogs = await loadCatalogs()
  const rows = options.targets.map(({ provider, id }, index): Row => {
    const row: Row = {
      provider,
      id,
      name: id,
      protectedPreset: !declaredProviders.has(provider),
      parameters: [],
      parameterMessage: '',
      priceMessage: '',
      currentPrices: {},
      referencePrices: {},
      priceMode: 'manual',
      priceChanges: [],
    }
    try {
      const { model } = readModel(snapshot, modelNamespace, provider, id)
      row.name = model.name?.trim() || id
      const route = object(object(object(models.value).providers)[provider])
      const hints = {
        provider,
        ...(typeof route.displayName === 'string' ? { name: route.displayName } : {}),
        ...(typeof route.baseURL === 'string' ? { baseURL: route.baseURL } : {}),
      }
      const metadata = catalogs.metadata ? recommendCatalog(catalogs.metadata.data, id, hints) : undefined
      if (metadata) {
        row.parameters = differences(model, metadata.model)
        row.parameterMessage = metadata.matches
          ? [
              `匹配 ${metadata.matches} 个来源`,
              metadata.officialProviders ? `官方加权：${metadata.officialProviders.join(' / ')}` : '',
              metadata.reasoningProvider ? `推理档来源：${metadata.reasoningProvider}` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          : '没有匹配的参数来源'
      } else row.parameterMessage = '参数目录不可用，未提供参数建议'
      const { record, effective } = readPrices(snapshot, priceNamespace, keys[index]!)
      row.currentPrices = effective
      row.priceMode = record?.mode ?? 'manual'
      if (record) row.currentCurrency = record.currency
      if (record?.multiplier !== undefined) row.multiplier = record.multiplier
      if (record?.mode === 'multiplier' && record.reference) row.savedReferencePrices = record.reference.prices
      if (!catalogs.pricing) {
        row.priceMessage = '价格目录不可用，未提供价格建议'
        return row
      }
      if (record && record.currency !== options.currency) {
        row.priceMessage = `已保存 ${record.currency}，本次核对 ${options.currency}；跳过价格比较，不换币种`
        return row
      }
      const { data, url, fetchedAt } = catalogs.pricing
      let source: PriceSource
      if (record?.mode === 'multiplier') {
        const saved = record.reference?.source
        const matchingSource =
          saved &&
          (options.pricingSource === 'models.dev'
            ? saved.url === url
            : saved.url === BASELLM_CATALOG_URL || saved.url === basellmProviderUrl(saved.provider))
        if (!saved || !matchingSource || saved.method === 'consensus' || saved.provider === 'consensus') {
          row.priceMessage = '倍率参考来源与本次目录不一致或为历史共识；保留已保存基价，请在单模型编辑器核对'
          return row
        }
        const providers = object(data)
        if (!Object.hasOwn(providers, saved.provider)) throw new Error('目录中没有已保存的倍率参考供应商')
        row.referencePrices = nativePrices(providers[saved.provider], saved.model, options.currency)
        // This is a new exact-source lookup, not a revalidation of the old routing vote or contributors.
        source = { provider: saved.provider, model: saved.model, url, fetchedAt }
        row.priceMessage = '按已保存来源和倍率试算；补全模式保留倍率基价，更新模式展示基价更新后的生效价'
      } else {
        const recommended =
          options.pricingSource === 'models.dev' && metadata
            ? metadata.price
            : recommendCatalog(data, id, hints, options.currency).price
        if (recommended.status !== 'reliable' || !recommended.prices) {
          const messages = {
            'no-exact-match': '没有匹配的参考价格',
            'no-valid-price': '没有可用的固定单价（可能缺失、复杂或订阅计费）',
            'insufficient-support': '价格来源不足，请在单模型编辑器选择参考来源',
            conflict: '参考价格存在分歧，请在单模型编辑器核对',
          }
          row.priceMessage = messages[recommended.reason ?? 'no-valid-price']
          return row
        }
        row.referencePrices = recommended.prices
        source = {
          url,
          fetchedAt,
          provider: recommended.provider!,
          model: recommended.model!,
          method: recommended.method as NonNullable<PriceSource['method']>,
          support: recommended.support,
          total: recommended.total,
          contributors: recommended.contributors,
        }
        row.priceMessage =
          recommended.method === 'consensus'
            ? `${recommended.support}/${recommended.total} 个价格来源一致`
            : `参考来源：${recommended.provider}`
      }
      row.referenceSource = source
      row.priceChanges = priceDifferences(record, row.referencePrices, options.currency)
      if (record?.mode === 'multiplier') {
        const factor = record.multiplier
        if (
          factor === undefined ||
          !Number.isFinite(factor) ||
          factor < 0 ||
          PRICE_KEYS.some((key) => {
            const value = row.referencePrices[key]
            return value !== undefined && (!Number.isFinite(value * factor) || value * factor > MAX_PRICE)
          })
        ) {
          row.priceChanges = []
          row.priceMessage = '倍率无效或试算超出支持范围；保留已保存基价，请在单模型编辑器修正'
        } else if (
          PRICE_KEYS.some(
            (key) => record.reference?.prices[key] !== undefined && row.referencePrices[key] === undefined,
          )
        ) {
          row.priceMessage = '最新目录缺少已保存的价格项，保留整份倍率基价；请在单模型编辑器核对'
        } else {
          row.referenceUpdateAvailable = PRICE_KEYS.some(
            (key) => record.reference?.prices[key] !== row.referencePrices[key],
          )
        }
      }
    } catch (error) {
      // A bad target or unavailable reference must not hide other models or successful parameter suggestions.
      if (!row.parameterMessage) row.error = readableError(error)
      else row.priceMessage = `价格未比较：${readableError(error)}`
    }
    return row
  })
  const latest = settings.describe({ redactSecrets: true })
  if (
    latest.find((row) => row.ns === modelNamespace)?.revision !== models.revision ||
    latest.find((row) => row.ns === priceNamespace)?.revision !== prices.revision
  ) {
    throw new Error('核对期间配置已变化，请重新生成批量预览')
  }
  return {
    checkedAt: Date.now(),
    modelRevision: models.revision,
    priceRevision: prices.revision,
    warnings: catalogs.warnings,
    rows,
  }
}
