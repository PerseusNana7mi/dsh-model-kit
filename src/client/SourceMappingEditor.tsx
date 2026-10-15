import { useEffect, useRef, useState } from 'react'
import type { Reply, Request } from '../wire.js'

type State = NonNullable<Reply['sourceMappings']>
type Quote = NonNullable<Reply['priceQuote']>
export function SourceMappingEditor({
  call,
  run,
  provider,
  id,
  currency,
  pricingSource,
  initial,
  quote,
  onQuote,
  onSaved,
  fetchReference,
}: {
  call: (request: Request) => Promise<Reply>
  run: (task: (isCurrent: () => boolean) => Promise<void>) => Promise<void>
  provider: string
  id: string
  currency: 'USD' | 'CNY'
  pricingSource: 'models.dev' | 'basellm'
  initial: State | undefined
  quote: { ticket?: string; source: Quote['source'] } | undefined
  onQuote: (quote: Quote) => void
  onSaved: (state: State) => boolean
  fetchReference: (provider: string, model: string) => Promise<void>
}) {
  const [state, setState] = useState(initial)
  const [referenceProvider, setReferenceProvider] = useState('')
  const [referenceModel, setReferenceModel] = useState(id)
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    setState(initial)
  }, [initial])
  const entry = state?.entries.find((row) => row.pricingSource === pricingSource && row.currency === currency)
  const statuses = {
    ready: '可用',
    'route-changed': '路由已变化，请重新确认',
    'catalog-changed': '目录地址已变化，请重新确认',
    invalid: '记录无效，请替换或清除',
  }
  return (
    <details className="dmm-source-mapping">
      <summary>记住参考来源 / 指定别名</summary>
      <p className="dmm-price-note">
        仅记住当前目标、数据源和币种的参考关系；不证明供应商按此结算，也不改变自动匹配或已保存价格。
      </p>
      <p>
        {entry
          ? `已记住：${entry.referenceProvider} / ${entry.referenceModel}（${statuses[entry.status]}）`
          : '当前数据源和币种尚未记住参考来源。'}
      </p>
      <div className="dmm-grid">
        <label>
          指定参考供应商 ID
          <input
            maxLength={512}
            value={referenceProvider}
            onChange={(e) => setReferenceProvider(e.target.value)}
            placeholder="目录中的精确供应商 ID"
          />
        </label>
        <label>
          指定参考模型 ID
          <input maxLength={512} value={referenceModel} onChange={(e) => setReferenceModel(e.target.value)} />
        </label>
      </div>
      <div className="dmm-actions">
        <button
          type="button"
          disabled={!referenceProvider.trim() || !referenceModel.trim()}
          onClick={() =>
            void run(async () => {
              await fetchReference(referenceProvider.trim(), referenceModel.trim())
            })
          }
        >
          获取指定参考报价
        </button>
        <button
          type="button"
          disabled={!state || entry?.status !== 'ready'}
          onClick={() =>
            void run(async (isCurrent) => {
              if (!state) return
              const reply = await call({
                action: 'mappingUse',
                provider,
                id,
                currency,
                pricingSource,
                revision: state.revision,
                modelRevision: state.modelRevision,
              })
              if (alive.current && isCurrent() && reply.priceQuote) {
                onQuote(reply.priceQuote)
                setMessage('已按映射获取最新报价并填入价格草稿，请核对后保存价格。')
              }
            })
          }
        >
          按已记住来源获取最新报价
        </button>
        <button
          type="button"
          disabled={!state?.writable || !quote?.ticket || quote.source.provider === 'consensus'}
          onClick={() =>
            void run(async (isCurrent) => {
              if (!state || !quote?.ticket) return
              const reply = await call({
                action: 'mappingSave',
                provider,
                id,
                currency,
                pricingSource,
                quoteTicket: quote.ticket,
                revision: state.revision,
                modelRevision: state.modelRevision,
                confirmed: true,
              })
              if (alive.current && isCurrent() && reply.sourceMappings) {
                setState(reply.sourceMappings)
                const rebased = onSaved(reply.sourceMappings)
                setMessage(
                  rebased
                    ? '已确认并记住当前报价来源，价格草稿已保留。'
                    : '已记住来源；价格期间发生变化，保存价格前请重新读取。',
                )
              }
            })
          }
        >
          {entry ? '确认并替换为当前报价来源' : '确认并记住当前报价来源'}
        </button>
        <button
          type="button"
          disabled={!state?.writable || !entry}
          onClick={() =>
            void run(async (isCurrent) => {
              if (!state) return
              const reply = await call({
                action: 'mappingClear',
                provider,
                id,
                currency,
                pricingSource,
                revision: state.revision,
              })
              if (alive.current && isCurrent() && reply.sourceMappings) {
                setState(reply.sourceMappings)
                const rebased = onSaved(reply.sourceMappings)
                setMessage(
                  rebased
                    ? '已清除来源映射，价格及草稿保持原样。'
                    : '已清除映射；价格期间发生变化，保存价格前请重新读取。',
                )
              }
            })
          }
        >
          清除当前来源映射
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </details>
  )
}
