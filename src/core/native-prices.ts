import type { Prices } from './catalog.js'

import type { Currency } from '../integration/settings.js'



function row(value: unknown): Record<string, unknown> {

  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pricing data')

  return value as Record<string, unknown>

}
/** Native lists are independent. Never merge USD fields into a CNY list. */

export function nativePrices(provider: unknown, id: string, currency: Currency): Prices {

  const entry = row(provider)

  if (entry.subscription === true) throw new Error('订阅套餐没有可用的按 token 单价')

  const models = row(entry.models)

  if (!Object.hasOwn(models, id)) throw new Error('No exact reference model match')

  const cost = row(row(models[id]).cost)
  if ((cost.currency ?? 'USD') !== currency && (!cost.currency_options || !Object.hasOwn(row(cost.currency_options), currency))) throw new Error('此模型没有所选币种的原生价格')

  const selected = (cost.currency ?? 'USD') === currency ? cost : row(row(cost.currency_options)[currency])

  if (selected.currency !== undefined && selected.currency !== currency) throw new Error('Currency mismatch')

  if (selected.schedule || selected.tiers || selected.context_over_200k ||

      (selected.reasoning !== undefined && selected.reasoning !== selected.output) ||

      Object.keys(selected).some(key => /audio|image|video|cache_write_/.test(key))) {

    throw new Error('此模型包含分时、阶梯或额外计费规则，不能自动保存为固定单价；请核对来源并手动填写')

  }

  const result: Prices = {}

  for (const [target, source] of Object.entries({ input: 'input', output: 'output', cacheRead: 'cache_read', cacheWrite: 'cache_write' })) {

    const value = selected[source]

    if (value === undefined) continue

    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid native price')

    Object.assign(result, { [target]: value })

  }

  if (result.input === undefined || result.output === undefined) throw new Error('Reference requires known input and output prices')

  return result

}
