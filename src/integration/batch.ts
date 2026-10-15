import { randomUUID } from 'node:crypto'
import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { editableFields, prices, requestSchema, type Reply, type Request } from '../wire.js'
import { MAX_PRICE } from '../core/limits.js'
import { readableError } from '../core/errors.js'
import { PRICE_KEYS, object, priceKey, readModel, readPrices } from './settings.js'
import type { Currency, ModelPatch, PriceRecord, PriceSource, SettingsPort } from './settings.js'

type Review = NonNullable<Reply['batchReview']>
type Commit = Extract<Request, { action: 'batchCommit' }>
type Result = NonNullable<Reply['batchSaved']>
type Prepared = {
  signature: string
  modelOps: SettingsPathOp[]
  priceOps: SettingsPathOp[]
  expectedModel: unknown
  modelRevision: number
  modelsDone: boolean
}
type Plan = {
  review: Review
  currency: Currency
  priceNamespace: string
  expiresAt: number
  busy: boolean
  prepared?: Prepared
  result?: Result
}
const targetKey = (row: { provider: string; id: string }) => JSON.stringify([row.provider, row.id])
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/** Bounded, host-owned plans. Commit accepts field names only; values and provenance never come from the client. */
export class BatchEditor {
  private readonly plans = new Map<string, Plan>()
  constructor(
    private readonly settings: () => SettingsPort,
    private readonly modelNamespace: string,
    private readonly priceNamespace: () => string,
    private readonly declaredProviders: () => ReadonlySet<string>,
  ) {}
  capture(review: Review, currency: Currency): Review {
    for (const [key, plan] of this.plans) if (!plan.busy && plan.expiresAt <= Date.now()) this.plans.delete(key)
    if (this.plans.size >= 20) {
      const oldest = [...this.plans].find(([, plan]) => !plan.busy)
      if (!oldest) throw new Error('批量保存计划繁忙，请稍后重试')
      this.plans.delete(oldest[0])
    }
    const ticket = randomUUID()
    const expiresAt = Date.now() + 15 * 60_000
    const result = { ...structuredClone(review), ticket, expiresAt, writable: this.settings().writable }
    this.plans.set(ticket, {
      review: structuredClone(result),
      currency,
      priceNamespace: this.priceNamespace(),
      expiresAt,
      busy: false,
    })
    return result
  }
  private sections() {
    const settings = this.settings()
    const sections = structuredClone(settings.describe({ redactSecrets: true }))
    const model = sections.find((row) => row.ns === this.modelNamespace)
    const price = sections.find((row) => row.ns === this.priceNamespace())
    if (!model || !price || model.ns === price.ns) throw new Error('批量保存的模型或价格命名空间不可用')
    const snapshot: SettingsPort = {
      describe: () => sections,
      writable: false,
      mutate: () => {
        throw new Error('预校验不写入配置')
      },
    }
    return { sections, model, price, snapshot }
  }
  private assertRevisions(plan: Plan, model: SettingsDescriptor, price: SettingsDescriptor) {
    if (
      model.revision !== (plan.prepared?.modelRevision ?? plan.review.modelRevision) ||
      price.revision !== plan.review.priceRevision
    )
      throw new Error('配置已变化，请重新获取批量预览；不会覆盖外部修改')
  }
  private prepare(plan: Plan, request: Commit, signature: string): Prepared {
    const { model, price, snapshot } = this.sections()
    this.assertRevisions(plan, model, price)
    const declared = this.declaredProviders()
    const modelGroups = new Map<string, unknown[]>()
    const priceOps: SettingsPathOp[] = []
    const seen = new Set<string>()
    for (const selection of request.selections) {
      const key = targetKey(selection)
      if (seen.has(key)) throw new Error('批量保存不能重复选择同一模型')
      seen.add(key)
      const row = plan.review.rows.find((row) => targetKey(row) === key)
      if (!row || row.error) throw new Error('选择的模型不在本次可用预览中')
      if (
        new Set(selection.fields).size !== selection.fields.length ||
        new Set(selection.prices).size !== selection.prices.length
      )
        throw new Error('批量保存不能重复选择字段')
      if (!selection.fields.length && !selection.prices.length && !selection.updateReference)
        throw new Error('请选择需要保存的字段')
      const current = readModel(snapshot, this.modelNamespace, selection.provider, selection.id)
      if (selection.fields.length) {
        if ((!declared.has(selection.provider) || row.protectedPreset) && !request.allowPresetOverride)
          throw new Error('请明确允许本次批量覆盖预设参数')
        const patch: ModelPatch = {}
        for (const key of selection.fields) {
          const field = row.parameters.find((field) => field.key === key)
          if (!field || (request.mode === 'fill' && !field.selected)) throw new Error('字段不属于本次补全或更新建议')
          Object.assign(patch, { [key]: JSON.parse(field.after) })
        }
        editableFields.parse(patch)
        if (
          patch.maxTokens !== undefined &&
          patch.maxTokens !== current.model.maxTokens &&
          !request.acceptDefaultOutputCap
        )
          throw new Error('请确认批量最大输出变化同时更新默认请求输出上限')
        const path = ['providers', selection.provider, 'models']
        if (model.secrets?.some((secret) => path.every((part, index) => secret.path[index] === part)))
          throw new Error('模型列表含脱敏字段，不能批量替换')
        const models = modelGroups.get(selection.provider) ?? structuredClone(current.models)
        models[current.index] = { ...object(models[current.index]), ...patch }
        modelGroups.set(selection.provider, models)
      }
      if (selection.prices.length || selection.updateReference) {
        const key = priceKey(this.modelNamespace, selection.provider, selection.id)
        const { record } = readPrices(snapshot, this.priceNamespace(), key)
        if (record && record.currency !== plan.currency) throw new Error('报价币种与保存记录不匹配')
        const source = row.referenceSource as PriceSource | undefined
        if (!source) throw new Error('本次预览没有可保存的参考报价')
        const url = new URL(source.url)
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          !Number.isSafeInteger(source.fetchedAt) ||
          source.fetchedAt < 0
        )
          throw new Error('无效的参考报价来源')
        let next: PriceRecord
        if (record?.mode === 'multiplier') {
          if (
            selection.prices.length ||
            !selection.updateReference ||
            request.mode !== 'update' ||
            !row.referenceUpdateAvailable
          )
            throw new Error('倍率模型只能在更新模式下确认更新整份可用参考快照')
          const reference = prices.parse(row.referencePrices)
          const multiplier = record.multiplier
          if (
            reference.input === undefined ||
            reference.output === undefined ||
            multiplier === undefined ||
            !Number.isFinite(multiplier) ||
            multiplier < 0
          )
            throw new Error('倍率参考或倍率无效')
          for (const key of PRICE_KEYS) {
            if (record.reference?.prices[key] !== undefined && reference[key] === undefined)
              throw new Error('新快照缺少已保存的倍率价格项')
            if (
              reference[key] !== undefined &&
              (reference[key]! > MAX_PRICE ||
                !Number.isFinite(reference[key]! * multiplier) ||
                reference[key]! * multiplier > MAX_PRICE)
            )
              throw new Error('倍率价格超出支持范围')
          }
          next = {
            ...record,
            reference: {
              prices: reference as NonNullable<PriceRecord['reference']>['prices'],
              source: structuredClone(source),
            },
          }
        } else {
          if (selection.updateReference) throw new Error('直接单价不能更新倍率参考快照')
          next = {
            ...record,
            currency: plan.currency,
            unit: 'per-million-tokens',
            mode: 'manual',
            rates: structuredClone(record?.rates ?? {}),
          }
          for (const key of selection.prices) {
            const field = row.priceChanges.find((field) => field.key === key)
            if (
              !field ||
              (request.mode === 'fill' && !field.selected) ||
              field.after > MAX_PRICE ||
              !Number.isFinite(field.after) ||
              field.after < 0
            )
              throw new Error('单价不属于本次有效补全或更新建议')
            next.rates[key] = {
              value: field.after,
              origin: 'catalog',
              updatedAt: Date.now(),
              source: structuredClone(source),
            }
          }
        }
        priceOps.push({ op: 'set', path: ['prices', key], value: next })
      }
    }
    const modelOps: SettingsPathOp[] = [...modelGroups].map(([provider, value]) => ({
      op: 'set',
      path: ['providers', provider, 'models'],
      value,
    }))
    const expectedModel = structuredClone(model.value)
    for (const [provider, value] of modelGroups)
      object(object(object(expectedModel).providers)[provider]).models = value
    return {
      signature,
      modelOps,
      priceOps,
      expectedModel,
      modelRevision: model.revision,
      modelsDone: false,
    }
  }
  async commit(input: Commit): Promise<Result> {
    const request = requestSchema.parse(input)
    if (request.action !== 'batchCommit') throw new Error('Invalid batch commit request')
    const plan = this.plans.get(request.ticket)
    if (!plan || plan.expiresAt <= Date.now()) throw new Error('批量保存计划已过期或被淘汰，请重新获取预览')
    if (plan.priceNamespace !== this.priceNamespace()) throw new Error('价格命名空间已变化，请重新获取预览')
    if (plan.busy) throw new Error('此批量计划正在保存，请等待结果')
    const signature = JSON.stringify({ mode: request.mode, selections: request.selections })
    if (plan.prepared && plan.prepared.signature !== signature)
      throw new Error('保存已开始，请保留原选择重试，或重新获取预览')
    if (plan.result?.complete) return structuredClone(plan.result)
    if (!this.settings().writable) throw new Error('Settings are read-only')
    plan.busy = true
    try {
      const prepared = plan.prepared ?? this.prepare(plan, request, signature)
      const { model, price } = this.sections()
      this.assertRevisions(plan, model, price)
      if (prepared.modelOps.length && !prepared.modelsDone) {
        const declared = this.declaredProviders()
        if (
          request.selections.some(
            (row) =>
              row.fields.length &&
              (!declared.has(row.provider) ||
                plan.review.rows.find((target) => targetKey(target) === targetKey(row))?.protectedPreset),
          ) &&
          !request.allowPresetOverride
        )
          throw new Error('请明确允许本次批量覆盖预设参数')
        if (request.selections.some((row) => row.fields.includes('maxTokens')) && !request.acceptDefaultOutputCap)
          throw new Error('请确认批量最大输出变化同时更新默认请求输出上限')
        for (const op of prepared.modelOps) {
          if (model.secrets?.some((secret) => op.path.every((part, index) => secret.path[index] === part)))
            throw new Error('模型列表含脱敏字段，不能批量替换')
        }
      }
      plan.prepared = prepared
      let models: Result['models'] = prepared.modelOps.length ? (prepared.modelsDone ? 'saved' : 'pending') : 'skipped'
      let prices: Result['prices'] = prepared.priceOps.length ? 'pending' : 'skipped'
      let stage: 'models' | 'prices' = 'models'
      try {
        if (prepared.modelOps.length && !prepared.modelsDone) {
          await this.settings().mutate(this.modelNamespace, prepared.modelOps, prepared.modelRevision)
          prepared.modelsDone = true
          models = 'saved'
          const { model: after } = this.sections()
          if (!same(after.value, prepared.expectedModel)) throw new Error('参数写入后配置再次变化，请重新获取预览')
          prepared.modelRevision = after.revision
        }
        stage = 'prices'
        if (prepared.priceOps.length) {
          if (plan.expiresAt <= Date.now()) throw new Error('保存计划已过期，请重新获取预览')
          const { model, price } = this.sections()
          this.assertRevisions(plan, model, price)
          await this.settings().mutate(this.priceNamespace(), prepared.priceOps, plan.review.priceRevision)
          prices = 'saved'
        }
        return this.remember(plan, {
          models,
          prices,
          complete: true,
          retryable: false,
          message: '已保存本批选中参数和定价。',
        })
      } catch (error) {
        if (stage === 'models' && !prepared.modelsDone) models = 'failed'
        if (stage === 'prices') prices = 'failed'
        let retryable = false
        try {
          const { model, price } = this.sections()
          this.assertRevisions(plan, model, price)
          retryable = plan.expiresAt > Date.now() && (!prepared.modelsDone || same(model.value, prepared.expectedModel))
        } catch {
          /* An ambiguous or conflicting write requires a fresh preview; never adopt a newer revision. */
        }
        return this.remember(plan, {
          models,
          prices,
          complete: false,
          retryable,
          message: `${prepared.modelsDone ? '模型参数已保存，' : '本批保存未完成，'}未完成的选择已保留。${readableError(error)}${retryable ? ' 可按原报价重试。' : ' 请重新获取预览，不会覆盖外部修改。'}`,
        })
      }
    } finally {
      plan.busy = false
    }
  }
  private remember(plan: Plan, result: Result) {
    plan.result = structuredClone(result)
    return result
  }
}
