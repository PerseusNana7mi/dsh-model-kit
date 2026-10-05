import type Llm from '@deepseek-ai/dsh-llm'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { fieldKeys, type FieldKey } from '../core/diff.js'
import type { ModelFields } from '../core/catalog.js'
import { object, type SettingsPort, type ModelPatch } from './settings.js'

export class ModelOverrides {
  constructor(private settings: () => SettingsPort, private llm: () => Pick<Llm, 'listConfigurableProviders' | 'discoverModels'>, private ns: string, private signal: () => AbortSignal) {}
  private snapshot(provider: string) {
    const directory = this.llm().listConfigurableProviders().find(row => row.provider === provider && row.settingsNs === this.ns && row.settingsPath.length === 2 && row.settingsPath[0] === 'providers' && row.settingsPath[1] === provider)
    if (directory?.declared !== false) throw new Error('仅支持宿主确认的内置供应商')
    const section = this.settings().describe({ redactSecrets: true }).find(row => row.ns === this.ns)
    if (!section) throw new Error('Settings unavailable')
    const providers = object(object(section.value).providers)
    if (!Object.hasOwn(providers, provider)) throw new Error('请先配置供应商')
    const profile = object(providers[provider])
    if (profile.models !== undefined && (!Array.isArray(profile.models) || profile.models.length > 0)) throw new Error('显式 models 列表不能同时使用 modelOverrides')
    return { section, profile }
  }
  async list(provider: string) {
    this.snapshot(provider)
    const models = await this.llm().discoverModels(this.ns, { provider }, this.signal())
    return models.map(row => ({ id: row.id, name: row.name ?? row.id }))
  }
  async read(provider: string, id: string) {
    const { section, profile } = this.snapshot(provider)
    const models = await this.llm().discoverModels(this.ns, { provider }, this.signal())
    const row = models.find(row => row.id === id)
    if (!row) throw new Error('内置目录中没有此模型')
    const base: ModelFields = { id }
    if (row.name) base.name = row.name
    for (const key of ['contextWindow', 'maxTokens'] as const) if (Number.isSafeInteger(row[key]) && row[key]! > 0) base[key] = row[key]!
    const input = row.inputModalities?.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    if (input?.length) base.input = [...input]
    const all = object(profile.modelOverrides ?? {})
    const raw = Object.hasOwn(all, id) ? object(all[id]) : {}
    const overrides: ModelPatch = {}
    for (const key of fieldKeys) {
      if (key === 'input' && Array.isArray(raw[key]) && !raw[key].length) continue
      if (raw[key] !== undefined) Object.assign(overrides, { [key]: structuredClone(raw[key]) })
    }
    return { base, model: { ...base, ...overrides }, overrides, revision: section.revision }
  }
  async write(provider: string, id: string, patch: ModelPatch, reset: FieldKey[], revision: number, consent: boolean, acceptCap: boolean) {
    if (!this.settings().writable) throw new Error('Settings are read-only')
    if (!consent) throw new Error('请允许本次覆盖或恢复内置模型参数')
    const current = await this.read(provider, id)
    if (!Number.isSafeInteger(revision) || revision !== current.revision) throw new Error('配置已变化，请重新读取')
    if (Object.keys(patch).some(key => !fieldKeys.includes(key as FieldKey)) || reset.some(key => !fieldKeys.includes(key))) throw new Error('Unsupported override field')
    if (reset.some(key => Object.hasOwn(patch, key))) throw new Error('同一字段不能同时写入和恢复')
    if ((patch.maxTokens !== undefined && patch.maxTokens !== current.overrides.maxTokens || reset.includes('maxTokens') && current.overrides.maxTokens !== undefined) && !acceptCap) throw new Error('请确认默认请求输出上限变化')
    const root = ['providers', provider, 'modelOverrides', id]
    const ops: SettingsPathOp[] = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [...root, key], value }))
    for (const key of reset) if (Object.hasOwn(current.overrides, key)) ops.push({ op: 'unset', path: [...root, key] })
    if (ops.length) await this.settings().mutate(this.ns, ops, revision)
    return this.read(provider, id)
  }
}
