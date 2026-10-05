/** Provider-specific prices in USD per million tokens. Missing means unknown. */
export interface Prices {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelFields {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  reasoningEfforts?: false | Record<string, string | null>
}

export interface Recommendation {
  provider: string
  model: ModelFields
  prices: Prices
  /** Catalog capability only; never persisted as an unsupported DSH model field. */
  reasoningSupported?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function number(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && (positive ? Number.isSafeInteger(value) && value > 0 : value >= 0)
}

/** Exact provider + model lookup only: never infer gateway pricing from another provider. */
export function lookup(catalog: unknown, provider: string, id: string): Recommendation | undefined {
  const providers = record(catalog)
  if (!providers || !Object.hasOwn(providers, provider)) return undefined
  const models = record(record(providers[provider])?.models)
  if (!models || !Object.hasOwn(models, id)) return undefined
  const source = record(models[id])
  if (!source) return undefined
  const model: ModelFields = { id }
  if (typeof source.name === 'string' && source.name.trim()) model.name = source.name
  const limit = record(source.limit)
  if (number(limit?.context, true)) model.contextWindow = limit.context
  if (number(limit?.output, true)) model.maxTokens = limit.output
  const inputs = record(source.modalities)?.input
  if (Array.isArray(inputs)) {
    const supported = [...new Set(inputs.filter((v): v is 'text' | 'image' => v === 'text' || v === 'image'))]
    if (supported.length) model.input = supported
  }
  if (source.reasoning === false) model.reasoningEfforts = false
  else if (Array.isArray(source.reasoning_options)) {
    const efforts: Record<string, string> = {}
    for (const raw of source.reasoning_options) {
      const option = record(raw)
      if (option?.type !== 'effort' || !Array.isArray(option.values)) continue
      for (const value of option.values) {
        if (value === 'none') efforts.off = 'none'
        else if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) efforts[value] = value
      }
    }
    if (Object.keys(efforts).some(key => key !== 'off')) model.reasoningEfforts = efforts
  }
  const prices: Prices = {}
  const cost = record(source.cost)
  for (const [from, to] of [['input', 'input'], ['output', 'output'], ['cache_read', 'cacheRead'], ['cache_write', 'cacheWrite']] as const) {
    if (number(cost?.[from])) prices[to] = cost[from]
  }
  return { provider, model, prices, ...(typeof source.reasoning === 'boolean' ? { reasoningSupported: source.reasoning } : {}) }
}

export function shouldFillField(current: ModelFields, suggested: ModelFields, key: keyof Omit<ModelFields, 'id'>): boolean {
  if (suggested[key] === undefined) return false
  if (current[key] === undefined) return true
  if (key === 'input') return !current.input?.includes('image') && suggested.input?.includes('image') === true
  if (key !== 'reasoningEfforts') return false
  const hasEfforts = (value: ModelFields['reasoningEfforts']) => !!value && Object.keys(value).some(level => level !== 'off')
  return !hasEfforts(current.reasoningEfforts) && hasEfforts(suggested.reasoningEfforts)
}

/** Pure preview. Preserve concrete overrides; false/empty reasoning can acquire known efforts. */
export function preview(current: ModelFields, recommendation: Recommendation) {
  if (current.id !== recommendation.model.id) throw new Error('Model ID mismatch')
  const proposed = structuredClone(current)
  const changes: string[] = []
  for (const key of ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'] as const) {
    if (shouldFillField(current, recommendation.model, key)) {
      Object.assign(proposed, { [key]: structuredClone(recommendation.model[key]) })
      changes.push(key)
    }
  }
  return {
    proposed,
    prices: structuredClone(recommendation.prices),
    changes,
    warnings: changes.includes('maxTokens')
      ? ['Explicit maxTokens also changes the DSH per-request default output cap.'] : [],
  }
}
