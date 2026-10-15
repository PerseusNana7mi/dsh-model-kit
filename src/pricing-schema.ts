import Schema from '@deepseek-ai/schemastery'

export const sourceMappingsSchema = Schema.dict(
  Schema.object({
    pricingSource: Schema.union(['models.dev', 'basellm']).required(),
    currency: Schema.union(['USD', 'CNY']).required(),
    referenceProvider: Schema.string().required(),
    referenceModel: Schema.string().required(),
    catalogUrl: Schema.string().required(),
    routeHash: Schema.string().required(),
    confirmedAt: Schema.number().min(0).step(1).required(),
  }),
)
  .default({})
  .volatile()

const timestamp = () => Schema.number().min(0).step(1).required()
const source = Schema.object({
  url: Schema.string().required(),
  provider: Schema.string().required(),
  model: Schema.string().required(),
  fetchedAt: timestamp(),
  method: Schema.union(['provider', 'base-url', 'consensus', 'single-source']),
  support: Schema.number().min(0).step(1),
  total: Schema.number().min(0).step(1),
  contributors: Schema.union([
    Schema.array(Schema.object({ provider: Schema.string().required(), model: Schema.string().required() })),
  ]),
})
const rate = Schema.object({
  value: Schema.number().min(0).required(),
  origin: Schema.union(['manual', 'catalog']).required(),
  updatedAt: timestamp(),
  source: Schema.union([source]),
})

export const pricesSchema = Schema.dict(
  Schema.object({
    currency: Schema.union(['USD', 'CNY']).required(),
    unit: Schema.const('per-million-tokens').required(),
    rates: Schema.dict(rate, Schema.union(['input', 'output', 'cacheRead', 'cacheWrite'])).required(),
    mode: Schema.union(['manual', 'multiplier']).default('manual'),
    multiplier: Schema.number().min(0).default(1),
    reference: Schema.union([
      Schema.object({
        prices: Schema.object({
          input: Schema.number().min(0).required(),
          output: Schema.number().min(0).required(),
          cacheRead: Schema.number().min(0),
          cacheWrite: Schema.number().min(0),
        }).required(),
        source: source.required(),
      }),
    ]),
  }),
)
  .default({})
  .volatile()
