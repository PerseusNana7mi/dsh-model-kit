import { useEffect, useRef, useState } from 'react'
import type { Reply, Request } from '../wire.js'
import { shouldFillField, type ModelFields } from '../core/catalog.js'
import { differences, fieldKeys, type FieldKey } from '../core/diff.js'
import { FieldDiff } from './FieldDiff.js'
import { readableError } from '../core/errors.js'
import { ModelSelect } from './ModelSelect.js'

type Recommendation = NonNullable<Reply['recommendation']>
type Candidate = NonNullable<Reply['candidates']>[number]
const candidateKey = (row: Candidate) => JSON.stringify([row.provider, row.model.id])
export function SourceReview({ current, provider, call, onApply, onSource, currency = 'USD', pricingSource = 'models.dev', onRecommendation, onStart, savedRevision }: {
  savedRevision?: number | undefined;
  current: ModelFields; provider: string; call: (request: Request) => Promise<Reply>;
  onApply: (model: ModelFields) => void; onSource?: (provider: string, id: string) => Promise<void>;
  currency?: 'USD' | 'CNY'; pricingSource?: 'models.dev' | 'basellm';
  onRecommendation?: (value: Recommendation) => void; onStart?: () => void;
}) {
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [current.id, provider, currency, pricingSource, call])
  const latest = useRef(current)
  latest.current = current
  const callbacks = useRef({ onApply, onSource, onRecommendation, onStart })
  callbacks.current = { onApply, onSource, onRecommendation, onStart }
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [automatic, setAutomatic] = useState<ModelFields>()
  const [reasoningSupported, setReasoningSupported] = useState<boolean>()
  const [reasoningProvider, setReasoningProvider] = useState<string>()
  const [source, setSource] = useState('')
  const [selected, setSelected] = useState<FieldKey[]>([])
  const [error, setError] = useState('')
  const [undo, setUndo] = useState<{ before: ModelFields; after: ModelFields; keys: FieldKey[] }>()
  const [notice, setNotice] = useState('')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    generation.current++
    setUndo(undefined)
    setBusy(false)
  }, [savedRevision])
  function fill(model: ModelFields) {
    const next = structuredClone(latest.current)
    const changed = fieldKeys.filter(key => shouldFillField(next, model, key))
    for (const key of changed) Object.assign(next, { [key]: structuredClone(model[key]) })
    if (changed.length) {
      setUndo({ before: structuredClone(latest.current), after: structuredClone(next), keys: changed })
      callbacks.current.onApply(next)
    }
    return changed.length
  }
  const candidate = candidates.find(row => candidateKey(row) === source)
  const suggestion = candidate?.model ?? automatic
  const rows = suggestion ? differences(current, suggestion as ModelFields) : []
  const signature = JSON.stringify(rows)
  useEffect(() => { setSelected(rows.filter(row => row.selected).map(row => row.key)) }, [signature, source])
  async function recommend() {
    const request = ++generation.current
    callbacks.current.onStart?.()
    setBusy(true); setError(''); setNotice('')
    try {
      const reply = await call({ action: 'recommend', provider, id: current.id, currency, pricingSource })
      if (request !== generation.current) return
      const result = reply.recommendation
      if (!result) throw new Error('未收到模型信息，请重试')
      setCandidates(result.candidates); setAutomatic(result.model as ModelFields); setSource('')
      setReasoningSupported(result.reasoningSupported)
      setReasoningProvider(result.reasoningProvider)
      const count = fill(result.model as ModelFields)
      callbacks.current.onRecommendation?.(result)
      const methods = { 'weighted-consensus': `官方加权一致性匹配（${result.officialProviders?.join(' / ')}，权重 ${result.officialWeight}）`, provider: '供应商匹配', 'base-url': 'API 地址匹配', consensus: '多来源一致性匹配', none: '没有匹配的模型' }
      setDetail(`${methods[result.method]} · ${result.priceMessage}`)
      setNotice(`${count ? `补全 ${count} 项` : '参数保留'} · ${result.priceQuote ? '已获取价格' : '未找到可靠价格'}`)
    } catch (e) { if (request === generation.current) setError(readableError(e)) }
    finally { if (request === generation.current) setBusy(false) }
  }
  return <div className="dmm-source-review">
    <button type="button" disabled={busy} onClick={() => void recommend()}>{busy ? '正在填入…' : '填入模型信息'}</button>
    <a className="dmm-source" href="https://github.com/anomalyco/models.dev" target="_blank" rel="noreferrer" title="models.dev">来源：models.dev ↗</a>
    {(notice || error) && <span className="dmm-fill-status" role={error ? 'alert' : 'status'} title={[error || detail, (candidate ? candidate.reasoningSupported : reasoningSupported) === true && !suggestion?.reasoningEfforts ? '支持推理，档位未知' : reasoningProvider ? `档位来源：${reasoningProvider}` : ''].filter(Boolean).join(' · ')}>{error || notice}</span>}
    {undo && <button className="dmm-undo" type="button" onClick={() => {
      const next = structuredClone(latest.current)
      for (const key of undo.keys) if (JSON.stringify(next[key]) === JSON.stringify(undo.after[key])) {
        if (undo.before[key] === undefined) delete next[key]
        else Object.assign(next, { [key]: undo.before[key] })
      }
      callbacks.current.onApply(next); setUndo(undefined); setNotice('已撤销本次参数填入，保留后续手动修改。')
    }}>撤销本次填入</button>}
    {automatic && <details className="dmm-source-advanced"><summary>高级比较</summary>
      {candidates.length > 0 && <fieldset className="dmm-source-picker" disabled={busy}>
        <ModelSelect label="参数参考来源" placeholder="自动推荐" value={source} onChange={value => {
          setSource(value)
          const next = candidates.find(row => candidateKey(row) === value)
          if (!next) return
          const request = ++generation.current
          fill(next.model as ModelFields)
          setBusy(true); setError('')
          void Promise.resolve(callbacks.current.onSource?.(next.provider, next.model.id))
            .catch(e => { if (request === generation.current) setError(readableError(e)) })
            .finally(() => { if (request === generation.current) setBusy(false) })
        }} options={candidates.map(row => ({ value: candidateKey(row), label: `${row.name} / ${row.model.id} (${row.provider})` }))}/>
      </fieldset>}
      <FieldDiff rows={rows} selected={selected} onChange={setSelected}/>
      <button type="button" disabled={!selected.length || busy} onClick={() => {
        if (!suggestion) return
        const next = structuredClone(latest.current)
        for (const key of selected) Object.assign(next, { [key]: suggestion[key] })
        callbacks.current.onApply(next)
      }}>应用选中差异到草稿</button>
    </details>}
  </div>
}
