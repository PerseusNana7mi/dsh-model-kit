import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME } from './package-identity.js'

const id = z.string().trim().min(1).max(512)
const quoteFields = z.object({ input: id.optional(), output: id.optional(), cacheRead: id.optional(), cacheWrite: id.optional() }).strict()
const revision = z.number().int().nonnegative()
const price = z.number().finite().nonnegative()
export const prices = z.object({ input: price.optional(), output: price.optional(), cacheRead: price.optional(), cacheWrite: price.optional() }).strict()
export const fields = z.object({
  name: z.string().optional(), contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(),
  input: z.array(z.enum(['text', 'image'])).min(1).optional(),
  reasoningEfforts: z.union([z.literal(false), z.object({
    off: z.string().min(1).nullable().optional(),
    minimal: z.string().min(1).optional(), low: z.string().min(1).optional(),
    medium: z.string().min(1).optional(), high: z.string().min(1).optional(),
    xhigh: z.string().min(1).optional(), max: z.string().min(1).optional(),
  }).strict()]).optional(),
}).strict()
const currency = z.enum(['USD', 'CNY']).default('USD')
const pricingSource = z.enum(['models.dev', 'basellm']).default('models.dev')
const target = { provider: id, id }
const fieldKey = z.enum(['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'])
const modelFields = fields.extend({ id })
const candidate = z.object({ provider: id, name: z.string(), model: modelFields, reasoningSupported: z.boolean().optional() })
const difference = z.object({ key: fieldKey, before: z.string(), after: z.string(), selected: z.boolean() })
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('recommend'), ...target, currency, pricingSource }).strict(),
  z.object({ action: z.literal('pricePreview'), id, targetId: id.optional(), catalogProvider: id, currency, pricingSource }).strict(),
  z.object({ action: z.literal('candidates'), id }).strict(),
  z.object({ action: z.literal('builtinList'), provider: id }).strict(),
  z.object({ action: z.literal('builtinRead'), ...target }).strict(),
  z.object({ action: z.literal('builtinWrite'), ...target, patch: fields, reset: z.array(fieldKey), revision, allowPresetOverride: z.boolean(), acceptDefaultOutputCap: z.boolean() }).strict(),
  z.object({ action: z.literal('routes') }).strict(),
  z.object({ action: z.literal('discover'), provider: id }).strict(),
  z.object({ action: z.literal('importPreview'), ticket: id, selections: z.array(z.object({ id, catalogProvider: id.optional() }).strict()).min(1).max(500) }).strict(),
  z.object({ action: z.literal('importCommit'), ticket: id, acceptDefaultOutputCap: z.boolean(), allowPresetOverride: z.boolean(), choices: z.array(z.object({ id, fields: z.array(fieldKey).max(5) }).strict()).max(500).optional() }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), ...target }).strict(),
  z.object({ action: z.literal('preview'), ...target, catalogProvider: id }).strict(),
  z.object({ action: z.literal('model'), ...target, patch: fields, revision, acceptDefaultOutputCap: z.boolean(), allowPresetOverride: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('priceDraft'), ...target, values: prices, quotes: quoteFields, currency, revision }).strict(),
  z.object({ action: z.literal('manual'), ...target, values: prices, currency, revision }).strict(),
  z.object({ action: z.literal('fill'), ...target, catalogProvider: id, currency, pricingSource, revision }).strict(),
  z.object({ action: z.literal('multiplier'), ...target, referenceProvider: id, referenceModel: id, quoteTicket: id.optional(), reuseSavedReference: z.boolean().default(false), multiplier: price, currency, pricingSource, revision }).strict(),
  z.object({ action: z.literal('manualMode'), ...target, revision }).strict(),
])
const source = z.object({ url: z.string(), provider: z.string(), model: z.string(), fetchedAt: z.number(), method: z.enum(['provider', 'base-url', 'consensus', 'single-source']).optional(), support: revision.optional(), total: revision.optional(), contributors: z.array(z.object({ provider: z.string(), model: z.string() })).optional() })
const quote = z.object({ prices, source, ticket: id })
const rate = z.object({ value: price, origin: z.enum(['manual', 'catalog']), updatedAt: z.number(), source: source.optional() })
const rates = z.object({ input: rate.optional(), output: rate.optional(), cacheRead: rate.optional(), cacheWrite: rate.optional() })
export const priceStateSchema = z.object({ revision, effective: prices, record: z.object({
  currency: z.enum(['USD', 'CNY']), unit: z.literal('per-million-tokens'), rates,
  mode: z.enum(['manual', 'multiplier']).optional(), multiplier: price.optional(),
  reference: z.object({ prices, source }).optional(),
}).optional() })
export const replySchema = z.object({
  fillResult: z.object({ changed: z.array(z.enum(['input', 'output', 'cacheRead', 'cacheWrite'])), effect: z.enum(['unchanged', 'stored-inactive', 'applied']) }).optional(),
  priceQuote: quote.optional(),
  recommendation: z.object({ model: modelFields, method: z.enum(['weighted-consensus', 'provider', 'base-url', 'consensus', 'none']), officialProviders: z.array(id).optional(), officialWeight: z.number().positive().optional(), reasoningProvider: id.optional(), reasoningSupported: z.boolean().optional(), matches: revision, candidates: z.array(candidate), priceCandidates: z.array(z.object({ provider: id, name: z.string(), model: id })).optional(), priceMessage: z.string(), priceQuote: quote.optional() }).optional(),
  candidates: z.array(candidate).optional(),
  builtinModels: z.array(z.object({ id, name: z.string() })).optional(),
  builtin: z.object({ base: modelFields, model: modelFields, overrides: fields, revision }).optional(),
  routes: z.array(z.object({ provider: id, name: z.string(), protectedPreset: z.boolean(), inherited: z.boolean().optional() })).optional(),
  discovery: z.object({ ticket: id, protectedPreset: z.boolean(), warning: z.string().optional(), rows: z.array(z.object({ model: modelFields, existing: z.boolean(), candidates: z.array(z.string()), details: z.array(candidate).optional(), selected: z.string().optional() })) }).optional(),
  importPlan: z.object({ ticket: id, protectedPreset: z.boolean(), requiresOutputConsent: z.boolean(), rows: z.array(z.object({ model: modelFields, current: modelFields.optional(), suggested: modelFields.optional(), differences: z.array(difference).optional(), source: z.string(), changes: z.array(z.string()) })) }).optional(),
  imported: z.number().int().nonnegative().optional(),
  models: z.array(z.object({ provider: z.string(), id: z.string(), name: z.string() })).optional(),
  model: fields.extend({ id: z.string() }).optional(), revision: revision.optional(),
  prices: priceStateSchema.optional(), protectedPreset: z.boolean().optional(),
  preview: z.object({ matched: z.boolean(), proposed: fields.extend({ id: z.string() }).optional(),
    changes: z.array(z.string()).optional(), warnings: z.array(z.string()).optional(), source: z.string().optional(),
  }).optional(),
})
export type Request = z.input<typeof requestSchema>
export type Reply = z.infer<typeof replySchema>
export type PriceState = z.infer<typeof priceStateSchema>
export const descriptors: readonly InvocationDescriptor[] = [{
  id: `${PACKAGE_NAME}#modelMetadataUi/execute`, service: 'modelMetadataUi', namespace: 'modelMetadataUi', method: 'execute',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE_NAME}#Request`, create: () => requestSchema } }],
  result: { mode: 'strict', typeSymbol: `${PACKAGE_NAME}#Reply`, create: () => replySchema },
}]
export const remoteContribution = { package: PACKAGE_NAME, descriptors }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { modelMetadataUi: { execute(request: Request): Promise<RemoteResult<Reply>> } }
}
