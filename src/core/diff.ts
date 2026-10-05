import { lookup, shouldFillField, type ModelFields } from './catalog.js'

export const fieldKeys = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'] as const
export type FieldKey = typeof fieldKeys[number]
export function differences(current: ModelFields, suggested: ModelFields) {
  return fieldKeys.filter(key => suggested[key] !== undefined && JSON.stringify(current[key]) !== JSON.stringify(suggested[key]))
    .map(key => ({ key, before: JSON.stringify(current[key]) ?? '未设置 / 继承', after: JSON.stringify(suggested[key])!, selected: shouldFillField(current, suggested, key) }))
}
export function catalogCandidates(catalog: unknown, id: string) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return []
  return Object.keys(catalog).flatMap(provider => {
    const match = lookup(catalog, provider, id)
    if (!match) return []
    const raw = (catalog as Record<string, { name?: unknown }>)[provider]
    return [{ provider, name: typeof raw?.name === 'string' ? raw.name : provider, model: match.model }]
  })
}
