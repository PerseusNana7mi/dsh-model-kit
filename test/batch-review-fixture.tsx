import { createRoot } from 'react-dom/client'
import { Panel } from '../src/client/Panel.js'
import type { Reply, Request } from '../src/wire.js'
import css from '../src/client/style.css'

const style = document.createElement('style')
style.textContent = css
document.head.append(style)
type Harness = {
  calls: Request[]
  hold: boolean
  fail: boolean
  pending: (() => void)[]
  notify: () => void
  failPrices: boolean
  saveHold: boolean
  savePending: (() => void)[]
  modelWrites: number
  priceWrites: number
  preset: boolean
}
const harness: Harness = ((window as any).batchHarness = {
  calls: [],
  hold: false,
  fail: false,
  pending: [],
  notify: () => {},
  failPrices: false,
  saveHold: false,
  savePending: [],
  modelWrites: 0,
  priceWrites: 0,
  preset: false,
})
const plans = new Map<string, { modelsDone: boolean }>()
const models = [
  { provider: 'gateway', id: 'm', name: '人工名称' },
  { provider: 'gateway', id: 'scaled', name: '倍率模型' },
  ...Array.from({ length: 203 }, (_, i) => ({ provider: 'extra', id: `extra-${i}`, name: `Extra ${i}` })),
]
async function call(request: Request): Promise<Reply> {
  harness.calls.push(request)
  if (request.action === 'list') return { models }
  if (request.action === 'routes')
    return {
      routes: [
        { provider: 'gateway', name: 'Gateway', protectedPreset: false },
        { provider: 'extra', name: 'Extra', protectedPreset: false },
      ],
    }
  if (request.action === 'read')
    return {
      model: { id: request.id, name: '人工名称' },
      revision: 1,
      prices: { revision: 2, effective: { input: 0 } },
    }
  if (request.action === 'batchReview') {
    const fail = harness.fail
    if (harness.hold) await new Promise<void>((resolve) => harness.pending.push(resolve))
    if (fail) throw new Error('目录暂不可用，请重试')
    const ticket = `fixture-plan-${harness.calls.length}`
    plans.set(ticket, { modelsDone: false })
    return {
      batchReview: {
        ticket,
        expiresAt: Date.now() + 15 * 60_000,
        writable: true,
        checkedAt: 1_800_000_000_000,
        modelRevision: 1,
        priceRevision: 2,
        warnings: [],
        rows: request.targets.map(({ provider, id }) => {
          const scaled = id === 'scaled'
          return {
            provider,
            id,
            name: scaled ? '倍率模型' : '人工名称',
            protectedPreset: harness.preset,
            parameters: [
              { key: 'name', before: '"人工名称"', after: '"目录名称"', selected: false },
              { key: 'maxTokens', before: '未设置 / 继承', after: '8192', selected: true },
            ],
            parameterMessage: '匹配 1 个来源',
            priceMessage: scaled ? '倍率基价保持，仅试算' : '参考来源：vendor',
            currentPrices: scaled ? { input: 2, output: 4 } : { input: 0 },
            referencePrices: { input: 3, output: 5 },
            currentCurrency: request.currency ?? 'USD',
            priceMode: scaled ? 'multiplier' : 'manual',
            ...(scaled ? { multiplier: 2 } : {}),
            ...(scaled ? { savedReferencePrices: { input: 1, output: 2 }, referenceUpdateAvailable: true } : {}),
            referenceSource: {
              url: 'https://models.dev/api.json',
              provider: 'vendor',
              model: id,
              fetchedAt: 1_800_000_000_000,
            },
            priceChanges: [
              { key: 'input', before: scaled ? 2 : 0, after: scaled ? 6 : 3, selected: false },
              { key: 'output', ...(scaled ? { before: 4 } : {}), after: scaled ? 10 : 5, selected: !scaled },
            ],
          }
        }),
      },
    }
  }
  if (request.action === 'batchCommit') {
    const plan = plans.get(request.ticket)!
    const models = request.selections.some((row) => row.fields.length)
    const prices = request.selections.some((row) => row.prices.length || row.updateReference)
    if (models && !plan.modelsDone) {
      harness.modelWrites++
      plan.modelsDone = true
      harness.notify()
    }
    if (harness.saveHold) await new Promise<void>((resolve) => harness.savePending.push(resolve))
    if (prices && harness.failPrices)
      return {
        batchSaved: {
          models: models ? 'saved' : 'skipped',
          prices: 'failed',
          complete: false,
          retryable: true,
          message: '模型参数已保存，价格失败，选择已保留，可按原报价重试。',
        },
      }
    if (prices) {
      harness.priceWrites++
      harness.notify()
    }
    return {
      batchSaved: {
        models: models ? 'saved' : 'skipped',
        prices: prices ? 'saved' : 'skipped',
        complete: true,
        retryable: false,
        message: '已保存本批选中参数和定价。',
      },
    }
  }
  throw new Error(`Unexpected write or operation: ${request.action}`)
}
createRoot(document.getElementById('root')!).render(
  <Panel
    call={call}
    subscribeChanges={(listener) => {
      harness.notify = listener
      return () => {
        harness.notify = () => {}
      }
    }}
  />,
)
