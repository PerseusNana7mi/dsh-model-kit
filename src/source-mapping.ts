import { z } from 'zod'

export const mappingSource = z.enum(['models.dev', 'basellm'])
const identifier = z.string().trim().min(1).max(512)
export const sourceMapping = z
  .object({
    pricingSource: mappingSource,
    currency: z.enum(['USD', 'CNY']),
    referenceProvider: identifier,
    referenceModel: identifier,
    catalogUrl: z.string().max(4096),
    routeHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedAt: z.number().int().nonnegative(),
  })
  .strict()
export type SourceMapping = z.infer<typeof sourceMapping>
export type MappingSource = SourceMapping['pricingSource']
export const mappingState = z.object({
  priceRevisionFrom: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative(),
  modelRevision: z.number().int().nonnegative(),
  writable: z.boolean(),
  entries: z.array(
    sourceMapping.omit({ catalogUrl: true, routeHash: true }).extend({
      status: z.enum(['ready', 'route-changed', 'catalog-changed', 'invalid']),
    }),
  ),
})
