import { randomUUID } from 'node:crypto'
import { officialSource } from '../core/preferred-source.js'
import type Llm from '@deepseek-ai/dsh-llm'
import { lookup, preview, type ModelFields } from '../core/catalog.js'
import { object, type SettingsPort } from './settings.js'
import { catalogCandidates, differences, fieldKeys, type FieldKey } from '../core/diff.js'

type LlmPort = Pick<Llm, 'listConfigurableProviders' | 'discoverModels'>
type Selection = { id: string; catalogProvider?: string | undefined }
type Candidate = { model: ModelFields; existing: boolean; candidates: string[]; details: ReturnType<typeof catalogCandidates>; selected?: string }
type Session = { provider: string; revision: number; expires: number; rows: Candidate[]; catalog: unknown; plan?: ModelFields[]; suggestions?: ModelFields[] }

/** Import previews are host-owned snapshots, never client-supplied configuration arrays. */
export class ModelImporter {
  private sessions = new Map<string, Session>()
  private pruneExpired() {
    for (const [key, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(key)
  }
  constructor(private settings: () => SettingsPort, private llm: () => LlmPort, private ns: string,
    private catalog: () => Promise<unknown>, private signal: () => AbortSignal) {}

  routes() {
    const section = this.settings().describe({ redactSecrets: true }).find(row => row.ns === this.ns)
    if (!section) return []
    const providers = object(object(section.value).providers ?? {})
    return this.llm().listConfigurableProviders().filter(row => row.settingsNs === this.ns
      && row.settingsPath.length === 2 && row.settingsPath[0] === 'providers' && row.settingsPath[1] === row.provider
      && Object.hasOwn(providers, row.provider)).map(row => ({ provider: row.provider, name: row.displayName, protectedPreset: row.declared !== true,
        inherited: row.declared === false && (!Array.isArray(object(providers[row.provider]).models) || (object(providers[row.provider]).models as unknown[]).length === 0) }))
  }

  private snapshot(provider: string) {
    const route = this.routes().find(row => row.provider === provider)
    if (!route) throw new Error('请先在 DSH 中配置此供应商')
    const section = this.settings().describe({ redactSecrets: true }).find(row => row.ns === this.ns)!
    const profile = object(object(object(section.value).providers)[provider])
    if (profile.models !== undefined && !Array.isArray(profile.models)) throw new Error('Invalid model list')
    if ((!Array.isArray(profile.models) || profile.models.length === 0) && route.protectedPreset) throw new Error('继承内置目录请使用单模型覆盖入口，避免替换整个目录')
    return { section, profile, models: (profile.models ?? []) as unknown[], protectedPreset: route.protectedPreset }
  }

  async discover(provider: string) {
    const current = this.snapshot(provider)
    const request = { provider,
      ...(typeof current.profile.api === 'string' ? { api: current.profile.api } : {}),
      ...(typeof current.profile.baseURL === 'string' ? { baseURL: current.profile.baseURL } : {}) }
    // Stored secrets/headers are resolved by the official adapter, not by this plugin.
    let discovered
    try { discovered = await this.llm().discoverModels(this.ns, request, this.signal()) }
    catch { throw new Error('获取模型失败，请检查 DSH 中的协议、地址及凭据；该协议也可能不支持模型发现') }
    let catalog: unknown
    let warning: string | undefined
    try { catalog = await this.catalog() } catch { warning = '参考目录获取失败：可仅导入上游信息，或重新获取后匹配' }
    const providers = catalog && typeof catalog === 'object' && !Array.isArray(catalog) ? Object.keys(catalog) : []
    const seen = new Set<string>()
    const rows: Candidate[] = []
    for (const item of discovered) {
      if (!item.id.trim() || item.id.length > 512 || seen.has(item.id)) continue
      seen.add(item.id)
      const model: ModelFields = { id: item.id }
      if (item.name && item.name !== item.id) model.name = item.name
      for (const key of ['contextWindow', 'maxTokens'] as const) if (Number.isSafeInteger(item[key]) && item[key]! > 0) model[key] = item[key]!
      const input = item.inputModalities?.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
      if (input?.length) model.input = [...new Set(input)]
      const candidates = providers.filter(source => lookup(catalog, source, item.id) !== undefined)
      const selected = officialSource(item.id, candidates.map(provider => ({ provider })))?.provider
        ?? (candidates.includes(provider) ? provider : candidates.length === 1 ? candidates[0] : undefined)
      rows.push({ model, existing: current.models.some(row => object(row).id === item.id), candidates, details: catalogCandidates(catalog, item.id), ...(selected ? { selected } : {}) })
    }
    const ticket = randomUUID()
    // Enforce after awaited discovery, including concurrent callers and full plan caches.
    this.pruneExpired()
    while (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value!)
    this.sessions.set(ticket, { provider, revision: current.section.revision, expires: Date.now() + 15 * 60_000, rows, catalog })
    return { ticket, rows, protectedPreset: current.protectedPreset, ...(warning ? { warning } : {}) }
  }

  private session(ticket: string) {
    const session = this.sessions.get(ticket)
    if (!session || session.expires < Date.now()) throw new Error('导入预览已过期，请重新获取模型')
    const current = this.snapshot(session.provider)
    if (current.section.revision !== session.revision) throw new Error('配置已变化，请重新获取模型并预览')
    return { session, current }
  }

  plan(ticket: string, selections: Selection[]) {
    this.pruneExpired()
    const { session, current } = this.session(ticket)
    if (!selections.length || selections.length > 500 || new Set(selections.map(row => row.id)).size !== selections.length) throw new Error('请选择 1–500 个不同模型')
    const rows = selections.map(selection => {
      const row = session.rows.find(row => row.model.id === selection.id)
      if (!row || row.existing) throw new Error('只能导入上游列表中尚未配置的模型')
      if (selection.catalogProvider && !row.candidates.includes(selection.catalogProvider)) throw new Error('无效的参考供应商')
      const match = selection.catalogProvider ? lookup(session.catalog, selection.catalogProvider, selection.id) : undefined
      return { model: match ? preview(row.model, match).proposed : structuredClone(row.model),
        current: structuredClone(row.model), suggested: match?.model ?? structuredClone(row.model),
        differences: differences(row.model, match?.model ?? row.model),
        source: selection.catalogProvider ?? 'upstream', changes: match ? preview(row.model, match).changes : [] }
    })
    // A new token binds save to this exact preview even if another client revises its selection.
    const planTicket = randomUUID()
    if (this.sessions.size >= 40) throw new Error('导入预览过多，请重新获取模型后重试')
    this.sessions.set(planTicket, { ...session, plan: rows.map(row => structuredClone(row.model)), suggestions: rows.map(row => structuredClone(row.suggested)) })
    return { ticket: planTicket, rows, protectedPreset: current.protectedPreset,
      requiresOutputConsent: rows.some(row => row.model.maxTokens !== undefined) }
  }

  async commit(ticket: string, acceptDefaultOutputCap: boolean, allowPresetOverride: boolean, choices?: { id: string; fields: FieldKey[] }[]) {
    const { session, current } = this.session(ticket)
    if (!session.plan) throw new Error('请先预览导入参数')
    let final = structuredClone(session.plan)
    if (choices) {
      if (choices.length !== final.length || new Set(choices.map(row => row.id)).size !== final.length) throw new Error('Invalid field selection')
      final = final.map(planned => {
        const selection = choices.find(row => row.id === planned.id)
        const baseline = session.rows.find(row => row.model.id === planned.id)!.model
        const suggested = session.suggestions?.find(row => row.id === planned.id)
        if (!selection || !suggested || selection.fields.some(key => !fieldKeys.includes(key) || suggested[key] === undefined)) throw new Error('Invalid field selection')
        const model = structuredClone(baseline)
        for (const key of selection.fields) Object.assign(model, { [key]: structuredClone(suggested[key]) })
        return model
      })
    }
    if (!this.settings().writable) throw new Error('Settings are read-only')
    if (current.protectedPreset && !allowPresetOverride) throw new Error('请明确允许修改内置预设')
    if (final.some(row => row.maxTokens !== undefined) && !acceptDefaultOutputCap) throw new Error('请确认最大输出也会设置默认请求输出上限')
    const path = ['providers', session.provider, 'models']
    if (current.section.secrets?.some(secret => path.every((part, index) => secret.path[index] === part))) throw new Error('Model list contains redacted fields')
    const ids = new Set(current.models.map(row => object(row).id))
    if (session.plan.some(row => ids.has(row.id))) throw new Error('模型已存在，请重新预览')
    await this.settings().mutate(this.ns, [{ op: 'set', path, value: [...structuredClone(current.models), ...final] }], session.revision)
    this.sessions.delete(ticket)
    return session.plan.length
  }
}
