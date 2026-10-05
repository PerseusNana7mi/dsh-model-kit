import type { SettingsForms, SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'

import type { ModelFields, Prices } from '../core/catalog.js'



export type SettingsPort = Pick<SettingsForms, 'describe' | 'mutate' | 'writable'>

export const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

const MODEL_KEYS = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'] as const

export type ModelPatch = Partial<Omit<ModelFields, 'id'>>

export interface PriceSource { url: string; provider: string; model: string; fetchedAt: number; method?: 'provider' | 'base-url' | 'consensus' | 'single-source'; support?: number; total?: number; contributors?: { provider: string; model: string }[] }

export interface PriceValue {

  value: number

  origin: 'manual' | 'catalog'

  updatedAt: number

  source?: PriceSource

}
export type Currency = 'USD' | 'CNY'

export interface PriceRecord {

  currency: Currency

  unit: 'per-million-tokens'

  rates: Partial<Record<keyof Prices, PriceValue>>

  mode?: 'manual' | 'multiplier'

  multiplier?: number

  reference?: { prices: Prices; source: PriceSource }

}



/** Effective prices are derived, so repeated reads never compound the multiplier. */

export function effectivePrices(record: PriceRecord | undefined): Prices {

  const result: Prices = {}

  if (!record) return result

  for (const key of PRICE_KEYS) {

    const value = record.mode === 'multiplier' ? record.reference?.prices[key] : record.rates[key]?.value

    if (value === undefined) continue

    const effective = value * (record.mode === 'multiplier' ? (record.multiplier ?? 1) : 1)

    if (!Number.isFinite(effective) || effective < 0) continue

    result[key] = effective

  }

  return result

}



export function object(value: unknown): Record<string, unknown> {

  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected configuration object')

  return value as Record<string, unknown>

}

function own(value: unknown, key: string): unknown {

  const row = object(value)

  return Object.hasOwn(row, key) ? row[key] : undefined

}

function identifier(value: string): void {

  if (typeof value !== 'string' || !value.trim()) throw new Error('Provider and model ID must be non-empty')

}

function revision(value: number): void {

  if (!Number.isSafeInteger(value) || value < 0) throw new Error('expectedRevision is required')

}

function descriptor(settings: SettingsPort, ns: string): SettingsDescriptor {

  const found = settings.describe({ redactSecrets: true }).find(row => row.ns === ns)

  if (!found) throw new Error(`Settings namespace unavailable: ${ns}`)

  return found

}

function assertRevision(row: SettingsDescriptor, expected: number) {

  revision(expected)

  if (row.revision !== expected) {

    throw Object.assign(new Error('Configuration changed; reload the preview before saving'), { code: 'SETTINGS_CONFLICT' })

  }

}



/** Only explicit model lists are edited; inherited catalogs are never replaced with a partial list. */

export function readModel(settings: SettingsPort, ns: string, provider: string, id: string) {

  identifier(provider); identifier(id)

  const section = descriptor(settings, ns)

  const route = own(own(section.value, 'providers'), provider)

  const models = own(route, 'models')

  if (!Array.isArray(models)) throw new Error('Provider has no explicit models list; catalog-only models are not editable yet')

  const matches = models.flatMap((row, index) => object(row).id === id ? [index] : [])

  if (matches.length !== 1) throw new Error('Expected exactly one configured model with this ID')

  const index = matches[0]!

  const row = object(models[index])

  const model: ModelFields = { id }

  for (const key of MODEL_KEYS) {

    if (key === 'input' && Array.isArray(row[key]) && row[key].length === 0) continue

    if (row[key] !== undefined) Object.assign(model, { [key]: structuredClone(row[key]) })

  }

  return { model, revision: section.revision, index, models, section }

}



export function modelSnapshot(settings: SettingsPort, ns: string, provider: string, id: string) {

  const { model, revision } = readModel(settings, ns, provider, id)

  return { model, revision }

}



export async function saveModel(settings: SettingsPort, ns: string, provider: string, id: string,

  patch: ModelPatch, expectedRevision: number, acceptDefaultOutputCap = false, allowPresetOverride = false) {

  if (!settings.writable) throw new Error('Settings are read-only')

  const input = object(patch)

  for (const key of Object.keys(input)) {

    if (!(MODEL_KEYS as readonly string[]).includes(key) || input[key] === undefined) {

      throw new Error(`Unsupported model edit: ${key}`)

    }

  }

  const current = readModel(settings, ns, provider, id)

  assertRevision(current.section, expectedRevision)


  if ('maxTokens' in input && input.maxTokens !== current.model.maxTokens && !acceptDefaultOutputCap) {

    throw new Error('Changing maxTokens requires acceptDefaultOutputCap: true')

  }

  if (!Object.keys(input).length) return modelSnapshot(settings, ns, provider, id)

  // Replacing this one array preserves unedited rows and compat fields. Never reconstruct a redacted array.

  const root = ['providers', provider, 'models']

  if (current.section.secrets?.some(secret => root.every((part, i) => secret.path[i] === part))) {

    throw new Error('Model list contains redacted fields; refusing array replacement')

  }

  const models = structuredClone(current.models)

  models[current.index] = { ...object(models[current.index]), ...structuredClone(input) }

  // The official adapter schema and internal/config hook validate values before the host persists them.

  await settings.mutate(ns, [{ op: 'set', path: root, value: models }], expectedRevision)

  return modelSnapshot(settings, ns, provider, id)

}



/** JSON tuple avoids collisions between route/model identifiers containing dots or slashes. */

export function priceKey(modelNamespace: string, provider: string, id: string) {

  identifier(modelNamespace); identifier(provider); identifier(id)

  return JSON.stringify([modelNamespace, provider, id])

}



export function readPrices(settings: SettingsPort, priceNamespace: string, key: string) {

  const section = descriptor(settings, priceNamespace)

  const records = own(section.value, 'prices') ?? {}

  const stored = own(records, key)

  const record = stored === undefined ? undefined : structuredClone(stored) as PriceRecord

  return { revision: section.revision, record, effective: effectivePrices(record) }

}



export async function savePrices(settings: SettingsPort, ns: string, key: string, values: Prices,

  expectedRevision: number, source?: PriceSource, currency: Currency = 'USD', origins: Partial<Record<keyof Prices, PriceSource>> = {}) {

  if (!settings.writable) throw new Error('Settings are read-only')

  revision(expectedRevision)

  const input = object(values)

  for (const [name, value] of Object.entries(input)) {

    if (!(PRICE_KEYS as readonly string[]).includes(name) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {

      throw new Error(`Invalid price: ${name}`)

    }

  }

  const sources = [...Object.values(origins), ...(source ? [source] : [])]
  for (const source of sources) {

    const url = new URL(source.url)

    if (url.protocol !== 'https:' || url.username || url.password || !Number.isFinite(source.fetchedAt) || source.fetchedAt < 0) {

      throw new Error('Invalid catalog provenance')

    }

    identifier(source.provider); identifier(source.model)

  }

  const section = descriptor(settings, ns)

  assertRevision(section, expectedRevision)

  const current = readPrices(settings, ns, key)

  if (currency !== 'USD' && currency !== 'CNY') throw new Error('Unsupported currency')

  const sameCurrency = !current.record || current.record.currency === currency

  const rates = structuredClone(sameCurrency ? current.record?.rates ?? {} : {})

  const changed: string[] = []

  for (const name of PRICE_KEYS) {

    const value = values[name]

    if (value === undefined || (source && rates[name] !== undefined)) continue

    const provenance = origins[name] ?? source
    rates[name] = { value, origin: provenance ? 'catalog' : 'manual', updatedAt: Date.now(),
      ...(provenance ? { source: structuredClone(provenance) } : {}) }

    changed.push(name)

  }

  if (changed.length) {

    const record: PriceRecord = { ...(sameCurrency ? current.record : {}), currency, unit: 'per-million-tokens', rates,

      mode: source && sameCurrency ? (current.record?.mode ?? 'manual') : 'manual' }

    const ops: SettingsPathOp[] = [{ op: 'set', path: ['prices', key], value: record }]

    await settings.mutate(ns, ops, expectedRevision)

  }

  const saved = readPrices(settings, ns, key)
  // Catalog fill can populate the retained manual list without disabling an active multiplier.
  const effect: 'unchanged' | 'stored-inactive' | 'applied' = !changed.length ? 'unchanged'
    : saved.record?.mode === 'multiplier' ? 'stored-inactive' : 'applied'
  return { ...saved, changed, effect }

}



/** Snapshot the user-selected first-party catalog entry and retain manual prices for switching back. */

export async function saveMultiplier(settings: SettingsPort, ns: string, key: string,

  reference: NonNullable<PriceRecord['reference']>, multiplier: number, expectedRevision: number, currency: Currency = 'USD') {

  if (!settings.writable) throw new Error('Settings are read-only')

  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 0) {

    throw new Error('Multiplier must be a finite non-negative number')

  }

  const section = descriptor(settings, ns)

  assertRevision(section, expectedRevision)

  if (reference.prices.input === undefined || reference.prices.output === undefined) {

    throw new Error('Reference requires known input and output prices')

  }
  for (const key of PRICE_KEYS) {
    const value = reference.prices[key]
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || !Number.isFinite(value * multiplier))) {
      throw new Error('Effective price overflow')
    }
  }

  const current = readPrices(settings, ns, key)

  const record: PriceRecord = { ...current.record, currency, unit: 'per-million-tokens',

    rates: current.record?.currency === currency ? current.record.rates : {}, mode: 'multiplier', multiplier, reference: structuredClone(reference) }

  effectivePrices(record)

  await settings.mutate(ns, [{ op: 'set', path: ['prices', key], value: record }], expectedRevision)

  return readPrices(settings, ns, key)

}


export async function useManualPrices(settings: SettingsPort, ns: string, key: string, expectedRevision: number) {

  if (!settings.writable) throw new Error('Settings are read-only')

  assertRevision(descriptor(settings, ns), expectedRevision)

  const current = readPrices(settings, ns, key)

  if (!current.record) throw new Error('No saved price configuration')

  await settings.mutate(ns, [{ op: 'set', path: ['prices', key, 'mode'], value: 'manual' }], expectedRevision)

  return readPrices(settings, ns, key)

}
