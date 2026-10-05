import { createRoot } from 'react-dom/client'
import { SettingsPage } from '../src/client/SettingsPage.js'
import css from '../src/client/style.css'
import type { Request, Reply } from '../src/wire.js'
const style = document.createElement('style'); style.textContent = css; document.head.append(style)
const harness = (window as any).harness = { release: undefined as undefined | (() => void), releaseList: undefined as undefined | (() => void) }
async function call(request: Request): Promise<Reply> {
  if (request.action === 'routes') return { routes: [{ provider: 'test', name: 'Test', protectedPreset: false }] }
  if (request.action === 'list') {
    await new Promise<void>(resolve => { harness.releaseList = resolve })
    return { models: ['a', 'b'].map(id => ({ provider: 'test', id, name: id })) }
  }
  if (request.action === 'read') {
    if (request.id === 'b') await new Promise<void>(resolve => { harness.release = resolve })
    return { model: { id: request.id, name: request.id }, revision: 0, prices: { revision: 0, effective: {} } }
  }
  return {}
}
createRoot(document.getElementById('root')!).render(<SettingsPage call={call}/>)
