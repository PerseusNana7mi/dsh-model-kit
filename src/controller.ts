import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { descriptors, requestSchema, replySchema, type Request, type Reply } from './wire.js'
import type {} from './index.js'
import { readableError } from './core/errors.js'
import { PACKAGE_NAME } from './package-identity.js'

declare module '@deepseek-ai/cordis' { interface Context { modelMetadataUi: MetadataController } }

export default class MetadataController extends TypertRemoteService {
  static inject = ['modelMetadata', 'settings', 'typert']
  constructor(ctx: Context) {
    super(ctx, 'modelMetadataUi')
    ctx.effect(() => ctx.typert.register({ package: PACKAGE_NAME, face: 'host', schemas: [],
      model: { services: [{ key: 'modelMetadataUi', exportName: 'MetadataController', tags: [], types: [],
        members: [{ kind: 'method', name: 'execute', signature: 'execute(request: Request): Promise<Reply>' }] }], events: [], objects: [] },
      invocations: descriptors,
    }))
  }
  async execute(input: Request): Promise<Reply> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Invalid model metadata request', {})
    const r = parsed.data
    const service = this.ctx.modelMetadata
    try {
      if (r.action === 'recommend') return replySchema.parse({ recommendation: await service.recommend(r.provider, r.id, r.currency, r.pricingSource) })
      if (r.action === 'pricePreview') return replySchema.parse({ priceQuote: await service.quotePrices(r.catalogProvider, r.id, r.currency, r.pricingSource, r.targetId) })
      if (r.action === 'candidates') return replySchema.parse({ candidates: await service.candidates(r.id) })
      if (r.action === 'builtinList') return replySchema.parse({ builtinModels: await service.overrides.list(r.provider) })
      if (r.action === 'builtinRead') return replySchema.parse({ builtin: await service.overrides.read(r.provider, r.id) })
      if (r.action === 'builtinWrite') return replySchema.parse({ builtin: await service.overrides.write(r.provider, r.id, r.patch as Parameters<typeof service.overrides.write>[2], r.reset, r.revision, r.allowPresetOverride, r.acceptDefaultOutputCap) })
      if (r.action === 'routes') return replySchema.parse({ routes: service.importer.routes() })
      if (r.action === 'discover') return replySchema.parse({ discovery: await service.importer.discover(r.provider) })
      if (r.action === 'importPreview') return replySchema.parse({ importPlan: service.importer.plan(r.ticket, r.selections) })
      if (r.action === 'importCommit') return replySchema.parse({ imported: await service.importer.commit(r.ticket, r.acceptDefaultOutputCap, r.allowPresetOverride, r.choices), models: service.listModels() })
      if (r.action === 'list') return replySchema.parse({ models: service.listModels() })
      if (r.action === 'preview') {
        const preview = await service.previewConfigured(r.provider, r.id, r.catalogProvider)
        return replySchema.parse({ preview })
      }
      if (r.action === 'model') await service.saveModel(r.provider, r.id, r.patch as Parameters<typeof service.saveModel>[2], r.revision, r.acceptDefaultOutputCap, r.allowPresetOverride)
      if (r.action === 'priceDraft') await service.savePriceDraft(r.provider, r.id, r.values as Parameters<typeof service.savePriceDraft>[2], r.quotes as Parameters<typeof service.savePriceDraft>[3], r.revision, r.currency)
      if (r.action === 'manual') await service.savePrices(r.provider, r.id, r.values as Parameters<typeof service.savePrices>[2], r.revision, r.currency)
      if (r.action === 'fill') {
        const result = await service.fillPrices(r.provider, r.id, r.revision, r.catalogProvider, r.currency, r.pricingSource)
        return replySchema.parse({ ...service.readModel(r.provider, r.id), prices: result,
          fillResult: { changed: result.changed, effect: result.effect } })
      }
      if (r.action === 'multiplier') await service.setPriceMultiplier(r.provider, r.id, r.referenceProvider, r.referenceModel, r.multiplier, r.revision, r.currency, r.pricingSource, r.quoteTicket, r.reuseSavedReference)
      if (r.action === 'manualMode') await service.useManualPrices(r.provider, r.id, r.revision)
      return replySchema.parse({ ...service.readModel(r.provider, r.id), prices: service.readPrices(r.provider, r.id) })
    } catch (error) {
      const message = readableError(error)
      const operational = error instanceof SyntaxError || error instanceof TypeError
        || error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
        || /(?:request failed: HTTP|service is unavailable|catalog exceeds|response has no body)/i.test(message)
      throw new RemoteError(operational ? 'gateway/internal' : 'gateway/bad-request', message, {})
    }
  }
}
