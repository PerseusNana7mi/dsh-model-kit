import type { Prices } from '../core/catalog.js'
import { MAX_PRICE } from '../core/limits.js'

export type PriceKey = keyof Prices
export type PriceInputs = {
  values: Record<string, string>
  quotes: Partial<Record<PriceKey, string>>
  edited: PriceKey[]
}

/** Invalidate only unsaved catalog fills; keep manual edits and saved values. */
export function withoutQuotes(previous: PriceInputs): PriceInputs {
  const values = { ...previous.values }
  for (const key of Object.keys(previous.quotes)) delete values[key]
  return { values, quotes: {}, edited: [...previous.edited] }
}

/** Empty or invalid drafts are unknown; an explicit zero remains a valid multiplier. */
export function previewMultipliedPrice(reference: number | undefined, draft: string): number | undefined {
  if (reference === undefined || !Number.isFinite(reference) || reference < 0 || !draft.trim()) return
  const multiplier = Number(draft)
  if (!Number.isFinite(multiplier) || multiplier < 0) return
  const value = reference * multiplier
  return Number.isFinite(value) && value <= MAX_PRICE ? value : undefined
}

const formatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 12, useGrouping: false })
export function formatPrice(value: number | undefined, currency: 'USD' | 'CNY'): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '未知'
  return `${currency === 'CNY' ? '¥' : '$'}${formatter.format(value)}`
}
