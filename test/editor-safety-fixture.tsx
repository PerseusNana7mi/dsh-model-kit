import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { BuiltinPanel } from '../src/client/BuiltinPanel.js'
import { OverrideInput } from '../src/client/OverrideInput.js'
import type { Request, Reply } from '../src/wire.js'

const harness = { failRoutes: false, hold: false, release: undefined as undefined | (() => void), saved: [] as Request[] }
Object.assign(window, { editorHarness: harness })
const call = async (r: Request): Promise<Reply> => {
  if (r.action === 'routes') {
    if (harness.failRoutes) throw new Error('连接暂不可用')
    return { routes: [{ provider: 'openai', name: 'OpenAI', inherited: true, protectedPreset: true }] }
  }
  if (r.action === 'builtinList') return { builtinModels: [{ id: 'm', name: 'Model' }] }
  const model = { id: 'm', name: 'Model' }
  if (r.action === 'builtinRead') return { builtin: { base: model, model, overrides: {}, revision: 1 } }
  if (r.action === 'recommend') {
    if (harness.hold) await new Promise<void>(resolve => { harness.release = resolve })
    return { recommendation: { model: { ...model, contextWindow: 128000, maxTokens: 8000 },
      method: 'consensus', matches: 2, candidates: [], priceMessage: '无报价' } }
  }
  if (r.action === 'builtinWrite') {
    harness.saved.push(r)
    return { builtin: { base: model, model: { ...model, ...r.patch }, overrides: r.patch, revision: 2 } }
  }
  throw new Error('Unexpected action')
}
function InvalidDraft() {
  const [value, setValue] = useState('{broken')
  return <OverrideInput field="reasoningEfforts" value={value} onChange={setValue}/>
}
const scenario = new URLSearchParams(location.search).get('scenario')
harness.failRoutes = scenario === 'routes'
createRoot(document.getElementById('root')!).render(scenario === 'invalid' ? <InvalidDraft/> : <BuiltinPanel call={call}/>)
