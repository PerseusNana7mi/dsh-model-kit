import { readableError } from '../core/errors.js'
import { useEffect, useState } from 'react'
import type { Reply, Request } from '../wire.js'
import { fields } from '../wire.js'
import { fieldKeys, type FieldKey } from '../core/diff.js'
import type { ModelFields } from '../core/catalog.js'
import { fieldLabels } from './FieldDiff.js'
import { SourceReview } from './SourceReview.js'
import { OverrideInput } from './OverrideInput.js'
import { overrideDraftModel, parseOverrideDraft, applyOverrideDraft } from './override-draft.js'

export function BuiltinPanel({ call, refreshKey = 0 }: { refreshKey?: number; call: (request: Request) => Promise<Reply> }) {
  const [routes, setRoutes] = useState<NonNullable<Reply['routes']>>([])
  const [provider, setProvider] = useState('')
  const [models, setModels] = useState<NonNullable<Reply['builtinModels']>>([])
  const [id, setId] = useState('')
  const [snapshot, setSnapshot] = useState<Reply['builtin']>()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [reset, setReset] = useState<FieldKey[]>([])
  const [consent, setConsent] = useState(false)
  const [cap, setCap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [routesError, setRoutesError] = useState('')
  const [retry, setRetry] = useState(0)
  const [readGeneration, setReadGeneration] = useState(0)
  useEffect(() => {
    let active = true
    void call({ action: 'routes' }).then(reply => {
      if (active) { setRoutes((reply.routes ?? []).filter(row => row.inherited)); setRoutesError('') }
    }).catch(e => { if (active) { setRoutes([]); setRoutesError(`内置供应商读取失败：${readableError(e)}`) } })
    return () => { active = false }
  }, [call, refreshKey, retry])
  let current = snapshot?.model as ModelFields | undefined
  let draftError = ''
  if (current) {
    try { current = overrideDraftModel(current, draft) }
    catch { draftError = '覆盖值尚未填写完整或格式无效，请修正后再填入参考信息。' }
  }
  function receive(value: Reply['builtin']) { setSnapshot(value); setDraft({}); setReset([]); setConsent(false); setCap(false) }
  async function run(task: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await task() } catch (e) { setError(readableError(e)) } finally { setBusy(false) } }
  return <details className="dmm-import"><summary>内置模型参数覆盖与恢复</summary>
    <p>仅修改选中内置模型，保留完整目录。空白表示不修改；恢复继承会移除用户覆盖，回到上层预设值（可能来自安装包），不一定是目录原值。宿主未公开的继承值显示为未知。</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {routesError && <p role="alert">{routesError} <button type="button" onClick={() => setRetry(value => value + 1)}>重试读取内置供应商</button></p>}
    <fieldset disabled={busy}>
      <label>内置供应商<select value={provider} onChange={e => { setProvider(e.target.value); setModels([]); setId(''); receive(undefined) }}><option value="">选择供应商</option>{routes.map(row => <option key={row.provider} value={row.provider}>{row.name}</option>)}</select></label>
      <button type="button" disabled={!provider} onClick={() => void run(async () => { receive(undefined); setId(''); setModels((await call({ action: 'builtinList', provider })).builtinModels ?? []) })}>读取内置目录</button>
      <label>内置模型<select aria-label="内置模型" value={id} onChange={e => { setId(e.target.value); receive(undefined) }}><option value="">选择内置模型</option>{models.map(row => <option key={row.id} value={row.id}>{row.name} ({row.id})</option>)}</select></label>
      <button type="button" disabled={!id} onClick={() => { setReadGeneration(value => value + 1); void run(async () => receive((await call({ action: 'builtinRead', provider, id })).builtin)) }}>读取参数（丢弃草稿）</button>
      {snapshot && <>
        <fieldset disabled={Boolean(draftError)}>
        <SourceReview key={`${provider}/${id}/${readGeneration}`} savedRevision={snapshot.revision} current={current!} provider={provider} call={call} onApply={model => {
          setDraft(previous => {
            // A request may finish while an input is temporarily invalid. Keep that draft intact.
            try {
              const latest = overrideDraftModel(snapshot.model as ModelFields, previous)
              const next = { ...model }
              for (const key of reset) {
                if (latest[key] === undefined) delete next[key]
                else Object.assign(next, { [key]: latest[key] })
              }
              return applyOverrideDraft(snapshot.model as ModelFields, latest, next, previous)
            } catch { return previous }
          })
        }}/>
        </fieldset>
        {draftError && <p role="alert">{draftError}</p>}
        {fieldKeys.map(key => <div key={key}>
          <p>{fieldLabels[key]} · 当前：{JSON.stringify(snapshot.model[key]) ?? '未知 / 继承'} · {Object.hasOwn(snapshot.overrides, key) ? '已有覆盖' : '继承目录'}</p>
          <OverrideInput field={key} value={draft[key] ?? ''} onChange={value => { setDraft({ ...draft, [key]: value }); setReset(reset.filter(item => item !== key)) }}/>
          {Object.hasOwn(snapshot.overrides, key) && <label className="dmm-check"><input type="checkbox" checked={reset.includes(key)} onChange={e => { setReset(e.target.checked ? [...reset, key] : reset.filter(value => value !== key)); setDraft({ ...draft, [key]: '' }) }}/>恢复{fieldLabels[key]}继承</label>}
        </div>)}
        <label className="dmm-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>允许本次覆盖或恢复内置模型参数</label>
        <label className="dmm-check"><input type="checkbox" checked={cap} onChange={e => setCap(e.target.checked)}/>确认最大输出覆盖或恢复会改变默认请求输出上限</label>
        <button type="button" disabled={!consent} onClick={() => void run(async () => {
          const patch = parseOverrideDraft(draft)
          receive((await call({ action: 'builtinWrite', provider, id, patch, reset, revision: snapshot.revision, allowPresetOverride: consent, acceptDefaultOutputCap: cap })).builtin)
          setMessage('已保存单模型覆盖；勾选恢复的字段已恢复继承，其他字段和模型保持不变。')
        })}>保存内置模型修改</button>
      </>}
    </fieldset>
  </details>
}
