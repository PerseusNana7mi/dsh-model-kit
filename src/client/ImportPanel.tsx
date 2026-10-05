import { readableError } from '../core/errors.js'
import { useEffect, useState } from 'react'
import type { Reply, Request } from '../wire.js'
import { FieldDiff } from './FieldDiff.js'
import type { FieldKey } from '../core/diff.js'

export function ImportPanel({ call, onImported, refreshKey = 0 }: { refreshKey?: number; call: (request: Request) => Promise<Reply>; onImported: (models: NonNullable<Reply['models']>) => void }) {
  const [routes, setRoutes] = useState<NonNullable<Reply['routes']>>([])
  const [provider, setProvider] = useState('')
  const [discovery, setDiscovery] = useState<Reply['discovery']>()
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [sources, setSources] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<Reply['importPlan']>()
  const [choices, setChoices] = useState<Record<string, FieldKey[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [acceptCap, setAcceptCap] = useState(false)
  const [acceptPreset, setAcceptPreset] = useState(false)
  const requiresCap = plan?.rows.some(row => (row.current ?? row.model).maxTokens !== undefined || (choices[row.model.id]?.includes('maxTokens') && row.suggested?.maxTokens !== undefined)) ?? false
  useEffect(() => {
    let active = true
    call({ action: 'routes' }).then(reply => { if (active) setRoutes(reply.routes ?? []) }).catch(() => { if (active) setError('暂时无法读取供应商，请确认 DSH 模型服务已加载') })
    return () => { active = false }
  }, [call, refreshKey])
  function invalidate() { setPlan(undefined); setAcceptCap(false); setAcceptPreset(false) }
  async function run(task: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await task() } catch (error) { setError(readableError(error)) }
    finally { setBusy(false) }
  }
  return <details className="dmm-import"><summary>从上游导入模型</summary>
    <p>使用 DSH 中已配置供应商的凭据获取列表。自定义供应商查询上游；内置供应商由 DSH 返回安装目录。只新增选中模型，不覆盖已有模型。价格在导入后单独设置。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy}>
      <label>导入目标供应商<select value={provider} onChange={e => { setProvider(e.target.value); setDiscovery(undefined); setSelected({}); invalidate() }}><option value="">选择已配置供应商</option>{routes.filter(row => !row.inherited).map(row => <option key={row.provider} value={row.provider}>{row.name} ({row.provider}){row.protectedPreset ? ' · 预设' : ''}</option>)}</select></label>
      <button type="button" disabled={!provider} onClick={() => void run(async () => {
        setDiscovery(undefined); invalidate()
        const reply = await call({ action: 'discover', provider })
        setDiscovery(reply.discovery); setSelected({})
        setSources(Object.fromEntries((reply.discovery?.rows ?? []).map(row => [row.model.id, row.selected ?? ''])))
      })}>获取上游模型</button>
      {discovery && <>
        {discovery.warning && <p>{discovery.warning}</p>}
        <p>找到 {discovery.rows.length} 个模型。精确匹配存在多个来源时请选择供应商；“仅上游信息”不会猜测参数。</p>
        <div className="dmm-import-list">{discovery.rows.map(row => <div key={row.model.id}>
          <label className="dmm-check"><input type="checkbox" disabled={row.existing} checked={selected[row.model.id] ?? false} onChange={e => { setSelected({ ...selected, [row.model.id]: e.target.checked }); invalidate() }}/>{row.model.id}{row.existing ? '（已配置）' : ''}</label>
          {!row.existing && <label>参考来源：{row.model.id}<select value={sources[row.model.id] ?? ''} onChange={e => { setSources({ ...sources, [row.model.id]: e.target.value }); invalidate() }}><option value="">仅上游信息{row.candidates.length > 1 ? '（多个匹配待选择）' : row.candidates.length === 0 ? '（无精确匹配）' : ''}</option>{row.candidates.map(source => <option key={source} value={source}>{source} / {row.model.id}</option>)}</select></label>}
          {row.details?.filter(value => value.provider === sources[row.model.id]).map(value => <p key={value.provider}>{value.name} · {value.model.name ?? value.model.id} · 上下文 {value.model.contextWindow ?? '未知'} · 输出 {value.model.maxTokens ?? '未知'} · 输入 {value.model.input?.join(' / ') ?? '未知'}<br/>同 ID 精确匹配，参数参考不代表官方价格认证。</p>)}
        </div>)}</div>
        <button type="button" disabled={!Object.values(selected).some(Boolean)} onClick={() => void run(async () => {
          invalidate()
          const selections = discovery.rows.filter(row => selected[row.model.id] && !row.existing).map(row => ({ id: row.model.id, ...(sources[row.model.id] ? { catalogProvider: sources[row.model.id] } : {}) }))
          const next = (await call({ action: 'importPreview', ticket: discovery.ticket, selections })).importPlan
          setPlan(next); setChoices(Object.fromEntries((next?.rows ?? []).map(row => [row.model.id, (row.differences ?? []).filter(value => value.selected).map(value => value.key)])))
        })}>预览选中模型参数</button>
      </>}
      {plan && <>
        <h4>即将新增 {plan.rows.length} 个模型</h4>
        <p>缺失字段默认勾选；已有上游值与建议不同时默认保留，可主动勾选替换。</p>
        {plan.rows.map(row => <div key={row.model.id}><strong>{row.model.id}</strong><p>来源：{row.source}</p><FieldDiff rows={row.differences ?? []} selected={choices[row.model.id] ?? []} onChange={keys => { setChoices({ ...choices, [row.model.id]: keys }); setAcceptCap(false) }}/><details><summary>上游原始参数</summary><pre className="dmm-import-preview">{JSON.stringify(row.current ?? row.model, null, 2)}</pre></details></div>)}
        {requiresCap && <label className="dmm-check"><input type="checkbox" checked={acceptCap} onChange={e => setAcceptCap(e.target.checked)}/>确认导入最大输出参数，同时设置默认请求输出上限</label>}
        {plan.protectedPreset && <label className="dmm-check"><input type="checkbox" checked={acceptPreset} onChange={e => setAcceptPreset(e.target.checked)}/>允许本次修改内置预设模型列表</label>}
        <button type="button" className="dmm-primary" disabled={(requiresCap && !acceptCap) || (plan.protectedPreset && !acceptPreset)} onClick={() => void run(async () => {
          const reply = await call({ action: 'importCommit', ticket: plan.ticket, acceptDefaultOutputCap: acceptCap, allowPresetOverride: acceptPreset, choices: plan.rows.map(row => ({ id: row.model.id, fields: choices[row.model.id] ?? [] })) })
          onImported(reply.models ?? []); setDiscovery(undefined); invalidate()
          setNotice(`已导入 ${reply.imported ?? 0} 个模型，可在下方选择并继续编辑。`)
        })}>确认导入</button>
      </>}
    </fieldset>
    {busy && <p role="status">正在处理导入…</p>}
  </details>
}
