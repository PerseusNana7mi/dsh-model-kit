import { readableError } from '../core/errors.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BuiltinPanel } from './BuiltinPanel.js'
import { SourceReview } from './SourceReview.js'
import { ImportPanel } from './ImportPanel.js'
import { ModelSelect } from './ModelSelect.js'
import type { Reply, Request, PriceState } from '../wire.js'
import { requestSchema } from '../wire.js'
import type { ModelFields } from '../core/catalog.js'
import { draftOf, draftModel, modelPatch, type Draft } from './model-draft.js'

export interface PanelProps { call: (request: Request) => Promise<Reply>; subscribeChanges?: (listener: () => void) => () => void }
const keys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
const labels = ['输入', '输出', '缓存读取', '缓存写入']
type PriceKey = typeof keys[number]
type PriceInputs = { values: Record<string, string>; quotes: Partial<Record<PriceKey, string>>; edited: PriceKey[] }
type Quote = { prices: NonNullable<Reply['priceQuote']>['prices']; source: NonNullable<Reply['priceQuote']>['source']; ticket?: string }
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function Panel({ call, subscribeChanges }: PanelProps) {
  const [listGeneration, setListGeneration] = useState(0)
  useEffect(() => subscribeChanges?.(() => setListGeneration(value => value + 1)), [subscribeChanges])
  const [provider, setProvider] = useState('')
  const [routes, setRoutes] = useState<NonNullable<Reply['routes']>>([])
  const [models, setModels] = useState<NonNullable<Reply['models']>>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selected, setSelected] = useState('')
  const [loaded, setLoaded] = useState<Reply>()
  const [loadedSelection, setLoadedSelection] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [priceState, setPriceState] = useState<PriceState>()
  const [priceInputs, setPriceInputs] = useState<PriceInputs>({ values: {}, quotes: {}, edited: [] })
  const manual = priceInputs.values
  const [quote, setQuote] = useState<Quote>()
  const priceGeneration = useRef(0)
  const [mode, setMode] = useState('manual')
  const [source, setSource] = useState('')
  const [referenceModel, setReferenceModel] = useState('')
  const [multiplier, setMultiplier] = useState('1')
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('USD')
  const [pricingSource, setPricingSource] = useState<'models.dev' | 'basellm'>('models.dev')
  const [priceDraft, setPriceDraft] = useState(false)
  const [priceEditing, setPriceEditing] = useState(false)
  const [priceCandidates, setPriceCandidates] = useState<{ provider: string; name: string; model: string }[]>([])
  const [readGeneration, setReadGeneration] = useState(0)
  const currentSelection = useRef('')
  currentSelection.current = JSON.stringify([selected, currency, pricingSource, readGeneration])
  const [allowPresetOverride, setAllowPresetOverride] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const operationGeneration = useRef(0)
  useLayoutEffect(() => {
    operationGeneration.current++
    setSaving(false)
    return () => { operationGeneration.current++ }
  }, [selected, call])
  const providerNames = new Map(routes.map(row => [row.provider, row.name]))
  const counts = new Map<string, number>()
  for (const model of models) { if (!providerNames.has(model.provider)) providerNames.set(model.provider, model.provider); counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1) }
  const providerModels = models.filter(row => row.provider === provider)
  const target = models.find(row => JSON.stringify([row.provider, row.id]) === selected)
  function receive(reply: Reply, includeModel: boolean, includePrices = true) {
    if (includeModel && reply.model) { setLoadedSelection(selected); setLoaded(reply); setDraft(draftOf(reply.model as ModelFields)); setAllowPresetOverride(false) }
    if (includePrices && reply.prices) {
      setPriceDraft(false)
      priceGeneration.current++
      const record = reply.prices.record
      const origin = (record?.mode === 'multiplier' ? record.reference?.source : Object.values(record?.rates ?? {}).find(rate => rate?.source)?.source) ?? record?.reference?.source
      const reference = record?.reference
      const matchesOrigin = (value: Quote | undefined) => value && (!origin || value.source.url === origin.url && value.source.provider === origin.provider && value.source.model === origin.model)
      setQuote(matchesOrigin(reference) ? reference : !includeModel && record?.currency === currency && matchesOrigin(quote) ? quote : undefined)
      setSource(origin?.provider ?? (includeModel ? '' : source))
      setReferenceModel(origin?.model ?? (includeModel ? target?.id ?? '' : referenceModel))
      if (origin) setPricingSource(origin.url.includes('basellm') ? 'basellm' : 'models.dev')
      setPriceState(reply.prices)
      setCurrency(reply.prices.record?.currency ?? 'USD')
      setMode(reply.prices.record?.mode ?? 'manual')
      setMultiplier(String(reply.prices.record?.multiplier ?? 1))
      setPriceInputs({ values: Object.fromEntries(keys.map(key => [key, String(reply.prices?.record?.rates[key]?.value ?? '')])), quotes: {}, edited: [] })
    }
  }
  useEffect(() => {
    let active = true
    setListState(previous => previous === 'ready' ? 'ready' : 'loading')
    Promise.all([call({ action: 'list' }), call({ action: 'routes' })]).then(([reply, directory]) => {
      if (!active) return
      const rows = reply.models ?? [], routes = directory.routes ?? []
      setModels(rows); setRoutes(routes)
      setProvider(current => routes.some(row => row.provider === current) || rows.some(row => row.provider === current) ? current : '')
      setSelected(current => rows.some(row => JSON.stringify([row.provider, row.id]) === current) ? current : '')
      setListState('ready')
    }).catch(e => { if (active) { setError(readableError(e)); setListState('error') } })
    return () => { active = false }
  }, [call, listGeneration])
  useEffect(() => {
    if (!target) { setBusy(false); setLoaded(undefined); setDraft(undefined); setQuote(undefined); return }
    let active = true
    priceGeneration.current++
    setQuote(undefined)
    setPriceCandidates([])
    setPriceDraft(false); setError(''); setNotice(''); setBusy(true)
    call({ action: 'read', provider: target.provider, id: target.id }).then(reply => {
      if (!active) return
      receive(reply, true)
    }).catch(e => { if (active) setError(readableError(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [selected, call])
  async function run(task: (isCurrent: () => boolean) => Promise<void>) {
    const request = ++operationGeneration.current
    const isCurrent = () => request === operationGeneration.current
    setBusy(true); setError(''); setNotice('')
    try { await task(isCurrent) } catch (e) { if (isCurrent()) setError(readableError(e)) }
    finally { if (isCurrent()) { setBusy(false); setSaving(false) } }
  }
  async function reload(isCurrent: () => boolean) {
    if (!target) return
    priceGeneration.current++
    setReadGeneration(value => value + 1)
    const reply = await call({ action: 'read', provider: target.provider, id: target.id })
    if (!isCurrent()) return
    receive(reply, true)
    setNotice('已重新读取保存值。')
  }
  function receiveQuote(received: NonNullable<Reply['priceQuote']>) {
    setSource(received.source.provider)
    setReferenceModel(received.source.model)
    setQuote(received)
    setPriceInputs(previous => {
      const values = { ...previous.values }, quotes = { ...previous.quotes }
      for (const key of keys) {
        if (quotes[key]) { delete values[key]; delete quotes[key] }
        if (!values[key]?.trim() && received.prices[key] !== undefined) {
          values[key] = String(received.prices[key])
          quotes[key] = received.ticket
        }
      }
      return { values, quotes, edited: previous.edited.filter(key => !quotes[key]) }
    })
    setPriceDraft(true)
  }
  function receiveRecommendation(result: NonNullable<Reply['recommendation']>, showNotice = true) {
    priceGeneration.current++
    setPriceCandidates(result.priceCandidates ?? [])
    if (result.priceQuote) receiveQuote(result.priceQuote)
    else setQuote(undefined)
    setNotice(showNotice ? (result.priceQuote ? result.priceMessage : '未找到可靠价格') : '')
  }
  async function fillPricing(catalogProvider: string, modelId = target?.id) {
    if (!target || !modelId) return
    const selection = currentSelection.current
    const request = ++priceGeneration.current
    setQuote(undefined)
    setError('')
    setSource(catalogProvider)
    setReferenceModel(modelId)
    try {
      const reply = await call({ action: 'pricePreview', id: modelId, targetId: target.id, catalogProvider, currency, pricingSource })
      if (request !== priceGeneration.current || selection !== currentSelection.current || !reply.priceQuote) return
      receiveQuote(reply.priceQuote)
      setNotice('已同时读取模型参数与参考价格，价格已填入草稿，点击保存即可。已有单价保持不变。')
    } catch (error) {
      if (request === priceGeneration.current && selection === currentSelection.current) throw new Error(`模型参数已填入，但参考价格未获取：${readableError(error)}。可手动填写价格。`)
    }
  }
  async function saveModel(isCurrent: () => boolean) {
    if (!target || !draft || !loaded?.model || loaded.revision === undefined) return
    const checked = modelPatch(draft, loaded.model as ModelFields)
    const reply = await call({ action: 'model', provider: target.provider, id: target.id, patch: checked, revision: loaded.revision, acceptDefaultOutputCap: true, allowPresetOverride })
    if (!isCurrent()) return
    receive(reply, true, false)
    if (reply.prices) setPriceState(reply.prices)
    return reply
  }
  function pricingRequest(): Request | undefined {
    if (!target || !priceState) return
    if (currency !== (priceState.record?.currency ?? 'USD') && mode === 'manual' && !keys.some(key => manual[key]?.trim())) throw new Error('切换币种后请填写新单价。')
    let request: Request
    if (mode === 'multiplier') {
      if (!source) throw new Error('请先点击“填入模型信息”选择匹配来源，无需手填供应商 ID。')
      if (!multiplier.trim()) throw new Error('请输入倍率。')
      if (!quote) throw new Error('请重新获取参考单价后保存倍率。')
      request = { action: 'multiplier', provider: target.provider, id: target.id, referenceProvider: source,
        referenceModel, currency, pricingSource, ...(quote.ticket ? { quoteTicket: quote.ticket } : { reuseSavedReference: true }), multiplier: Number(multiplier), revision: priceState.revision }
    } else {
      const values = Object.fromEntries(priceInputs.edited.filter(key => manual[key]?.trim()).map(key => [key, Number(manual[key])]))
      const quotes = priceInputs.quotes
      const changed = Object.keys(values).length || Object.keys(quotes).length
      if (!changed && (!priceState.record || priceState.record.mode !== 'multiplier')) return
      request = changed ? { action: 'priceDraft', provider: target.provider, id: target.id, values, quotes, currency, revision: priceState.revision }
        : { action: 'manualMode', provider: target.provider, id: target.id, revision: priceState.revision }
    }
    return requestSchema.parse(request)
  }
  const modelChanged = Boolean(draft && loaded?.model && JSON.stringify(draft) !== JSON.stringify(draftOf(loaded.model as ModelFields)))
  async function saveAll(isCurrent: () => boolean) {
    const pricing = pricingRequest()
    let modelSaved = false
    try {
      if (modelChanged) {
        const reply = await saveModel(isCurrent)
        if (!isCurrent()) return
        modelSaved = Boolean(reply)
        if (pricing && 'revision' in pricing && reply?.prices) pricing.revision = reply.prices.revision
      }
      if (pricing) {
        const reply = await call(pricing)
        if (!isCurrent()) return
        receive(reply, false)
      }
      setNotice('已保存模型参数和定价。')
    } catch (error) {
      throw new Error(`${modelSaved ? '模型参数已保存，但定价保存失败；价格草稿已保留，请重试。' : '保存未完成。'} ${readableError(error)}`)
    }
  }
  if (listState === 'loading') return null
  return <section className="dmm" aria-label="模型信息助手">
    <header><h2>模型信息助手</h2></header>

    <fieldset className="dmm-navigation" disabled={busy}>
      <div className="dmm-grid dmm-model-picker">
        <ModelSelect label="已添加供应商" placeholder="先选择供应商" value={provider} onChange={value => { setProvider(value); setSelected(''); priceGeneration.current++ }} options={[...providerNames].map(([id, name]) => ({ value: id, label: `${name} (${id}) · ${counts.get(id) ?? 0} 个模型` }))}/>
        <fieldset disabled={!provider || !providerModels.length}><ModelSelect key={provider} value={selected} placeholder={provider ? '选择该供应商的模型' : '请先选择供应商'} onChange={setSelected} options={providerModels.map(row => ({ value: JSON.stringify([row.provider, row.id]), label: `${row.name} (${row.id})` }))}/></fieldset>
      </div>
      {listState === 'ready' && provider && !providerModels.length && <p>{routes.find(row => row.provider === provider)?.inherited ? '此供应商使用内置目录，请在下方“内置模型参数覆盖与恢复”中编辑。' : '此供应商尚未添加模型，可在 DSH 模型页添加，或使用下方“从上游导入模型”。'}</p>}
      {listState === 'error' && <p>模型列表读取失败，无法判断已有模型；无需重新添加模型。</p>}
      {listState === 'ready' && !providerNames.size && <p>尚未添加供应商。请先在 DSH 模型页添加，列表会自动更新。</p>}
    </fieldset>
    <div className="dmm-editor-scroll">
    <fieldset disabled={busy || loadedSelection !== selected} aria-busy={busy} style={{ visibility: target && loadedSelection !== selected ? 'hidden' : undefined }}>
      {target && draft && <>
        <div className="dmm-heading"><h3>模型参数</h3><button type="button" onClick={() => void run(reload)}>重新读取（丢弃草稿）</button></div>
        {loaded?.protectedPreset && <label className="dmm-check"><input type="checkbox" checked={allowPresetOverride} onChange={e => setAllowPresetOverride(e.target.checked)}/>允许覆盖内置或继承预设参数（仅本次保存）</label>}
        <fieldset disabled={Boolean(loaded?.protectedPreset && !allowPresetOverride)}>
        <div className="dmm-grid dmm-model-identity"><label>模型 ID<input readOnly value={target.id}/></label><label>显示名<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label></div>

        <SourceReview key={`${selected}/${readGeneration}/${currency}/${pricingSource}`} savedRevision={loaded?.revision} provider={target.provider} currency={currency} pricingSource={pricingSource} call={call} onSource={fillPricing} onRecommendation={result => receiveRecommendation(result, false)} onStart={() => { priceGeneration.current++; setQuote(undefined) }} current={draftModel(target.id, draft)} onApply={model => { setDraft(draftOf(model)); setNotice('') }}/>
        <div className="dmm-model-capabilities">
        <label className="dmm-check"><input type="checkbox" title={draft.reasoning === 'inherit' ? '档位未配置 / 继承' : undefined} ref={element => { if (element) element.indeterminate = draft.reasoning === 'inherit' }} checked={draft.reasoning === 'custom'} onChange={e => setDraft({ ...draft, reasoning: e.target.checked ? 'custom' : 'disabled', efforts: e.target.checked && !Object.keys(draft.efforts).some(key => key !== 'off') ? { medium: 'medium' } : draft.efforts })}/>推理 / 思考</label>
        <label className="dmm-check"><input type="checkbox" checked={draft.input?.includes('image') ?? false} onChange={e => {
          const input = e.target.checked ? [...new Set([...(draft.input ?? ['text']), 'image'] as ('text' | 'image')[])] : draft.input?.filter(value => value !== 'image')
          setDraft({ ...draft, input: input?.length ? input : ['text'] })
        }}/>图片输入</label>
        </div>
        </fieldset>
        <fieldset disabled={Boolean(loaded?.protectedPreset && !allowPresetOverride)}>
        <div className="dmm-grid dmm-capacities"><label>上下文窗口<input type="number" min="1" step="1" value={draft.context} onChange={e => setDraft({ ...draft, context: e.target.value })}/></label><label title="保存此值也会更新每次请求的默认输出上限">最大输出 tokens<input type="number" min="1" step="1" value={draft.output} onChange={e => setDraft({ ...draft, output: e.target.value })}/></label></div>



        </fieldset>
        <div className="dmm-spec-heading"><h4 className="dmm-price-title">每百万 tokens 单价{priceDraft ? '（待保存）' : ''}</h4><button className="dmm-text-button" type="button" aria-expanded={priceEditing} onClick={() => setPriceEditing(value => !value)}>编辑价格</button></div><div className="dmm-prices">{keys.map((key, i) => {
          const value = priceDraft ? (mode === 'multiplier' ? (quote?.prices[key] === undefined ? undefined : quote.prices[key]! * Number(multiplier)) : (manual[key]?.trim() ? Number(manual[key]) : priceState?.record?.currency === currency ? priceState.record.rates[key]?.value : undefined)) : priceState?.effective[key]
          return <div key={key}><span>{labels[i]}</span><strong>{value === undefined ? '未知' : `${currency === 'CNY' ? '¥' : '$'}${value}`}</strong></div>
        })}</div>


        {priceEditing && <div className="dmm-price-editor">
        <div className="dmm-grid"><label>计价币种<select value={currency} onChange={e => { const next = e.target.value as 'USD' | 'CNY'; setCurrency(next); setSource(''); setPriceCandidates([]); setNotice(''); setPricingSource(next === 'CNY' ? 'basellm' : 'models.dev'); setPriceInputs({ values: {}, quotes: {}, edited: [] }); setQuote(undefined); priceGeneration.current++; setPriceDraft(true) }}><option value="USD">USD 美元</option><option value="CNY">CNY 人民币</option></select></label>
        <label>价格数据源<select value={pricingSource} onChange={e => { setPricingSource(e.target.value as 'models.dev' | 'basellm'); setSource(''); setPriceCandidates([]); setNotice(''); setQuote(undefined); priceGeneration.current++; setPriceDraft(true) }}><option value="basellm">basellm / llm-metadata</option><option value="models.dev" disabled={currency === 'CNY'}>Models.dev（仅 USD）</option></select></label></div>
        <p className="dmm-price-note">定价参考来源：{source === 'consensus' ? '多来源一致参考价' : source || '点击“填入模型信息”自动匹配'} · 模型：{target.id}</p>
        <p className="dmm-price-note">保存仅保留所选币种，不换汇；复杂计费请手填。</p>
        <div className="dmm-grid dmm-pricing-mode"><label>定价模式<select value={mode} onChange={e => { setMode(e.target.value); setPriceDraft(true) }}><option value="manual">手动单价</option><option value="multiplier">参考价 × 自定义倍率</option></select></label><label>参考价格来源<select aria-label="参考价格来源" value={priceCandidates.some(row => row.provider === source) ? source : ''} onChange={e => { const row = priceCandidates.find(row => row.provider === e.target.value); if (row) void run(() => fillPricing(row.provider, row.model)) }}><option value="">自动匹配 / 先获取来源</option>{priceCandidates.map(row => <option key={row.provider} value={row.provider}>{row.name} ({row.provider})</option>)}</select></label></div>
        {mode === 'manual' ? <div className="dmm-grid">{keys.map((key, i) => <label key={key}>{labels[i]}<input type="number" min="0" step="any" placeholder="未知 / 留空保留原值" value={manual[key] ?? ''} onChange={e => { const value = e.target.value; setPriceInputs(previous => { const quotes = { ...previous.quotes }; delete quotes[key]; return { values: { ...previous.values, [key]: value }, quotes, edited: [...new Set([...previous.edited, key])] } }); setPriceDraft(true) }}/></label>)}</div>
          : <div className="dmm-grid"><label>参考模型 ID<input readOnly value={referenceModel}/></label><label>统一倍率<input type="number" min="0" step="any" value={multiplier} onChange={e => { setMultiplier(e.target.value); setPriceDraft(true) }}/></label></div>}
        {mode === 'multiplier' && <p className="dmm-price-note">0.5 = 五折，2 = 两倍；实际结算以供应商为准。</p>}
        <div className="dmm-actions"><button type="button" onClick={() => void run(async () => {
          const selection = currentSelection.current
          const request = ++priceGeneration.current
          const reply = await call({ action: 'recommend', provider: target.provider, id: target.id, currency, pricingSource })
          if (request === priceGeneration.current && selection === currentSelection.current && reply.recommendation) receiveRecommendation(reply.recommendation)
        })}>重新获取参考单价</button></div>
        {priceState?.record?.reference && <p>倍率参考来源：{priceState.record.reference.source.provider} / {priceState.record.reference.source.model} · {new Date(priceState.record.reference.source.fetchedAt).toLocaleString()} · 已保存倍率 {priceState.record.multiplier}×</p>}
        </div>}
        <fieldset disabled={Boolean(loaded?.protectedPreset && !allowPresetOverride)}>
        <details className="dmm-advanced"><summary title="推理档位与请求值映射">高级设置</summary>
        <p>这里声明模型支持的推理档位；实际思考档位在聊天中选择。“不支持推理”不保证关闭上游默认思考。选择“自定义档位”后，请按供应商要求填写请求值。</p>
        <label>推理档配置<select value={draft.reasoning} onChange={e => setDraft({ ...draft, reasoning: e.target.value })}><option value="inherit">保留现有配置</option><option value="disabled">不支持推理</option><option value="custom">自定义档位</option></select></label>
        {draft.reasoning === 'custom' && <p>首次勾选默认使用 medium 档位；若接口使用其他请求值，请在下方调整。</p>}
        {draft.reasoning === 'custom' && <div className="dmm-efforts">{levels.map(level => <div key={level}><label className="dmm-check"><input type="checkbox" checked={Object.hasOwn(draft.efforts, level)} onChange={e => { const efforts = { ...draft.efforts }; if (e.target.checked) efforts[level] = level; else delete efforts[level]; setDraft({ ...draft, efforts }) }}/>{level}</label><input aria-label={`${level} 请求值`} disabled={!Object.hasOwn(draft.efforts, level)} value={draft.efforts[level] ?? ''} onChange={e => setDraft({ ...draft, efforts: { ...draft.efforts, [level]: e.target.value } })}/></div>)}</div>}
        </details>
        </fieldset>
      </>}
    </fieldset>
    <details className="dmm-advanced"><summary>更多模型操作</summary><ImportPanel call={call} refreshKey={listGeneration} onImported={setModels}/><BuiltinPanel call={call} refreshKey={listGeneration}/></details>
    </div>
    <footer className="dmm-save-bar">
      <span className={notice && !error ? "dmm-notice" : undefined} role={error ? "alert" : "status"} title={error || notice || (draft?.output.trim() && Number(draft.output) !== loaded?.model?.maxTokens ? "保存将更新默认请求输出上限" : undefined)}>{saving ? '保存中…' : busy ? '正在加载…' : !target ? '请选择模型' : error ? error : notice ? notice : modelChanged || priceDraft ? '有未保存的更改' : notice === '已保存模型参数和定价。' ? '已保存' : '暂无更改'}</span>
      <button className="dmm-primary" type="button" title="保存到配置文件" disabled={busy || saving || !target || !draft || loadedSelection !== selected || !(modelChanged || priceDraft) || Boolean(modelChanged && loaded?.protectedPreset && !allowPresetOverride)} onClick={() => {
        setSaving(true)
        void run(saveAll)
      }}>保存</button>
    </footer>
  </section>
}
