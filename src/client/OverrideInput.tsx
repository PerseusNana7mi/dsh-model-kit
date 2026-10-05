import type { FieldKey } from '../core/diff.js'
import { fieldLabels } from './FieldDiff.js'
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function OverrideInput({ field, value, onChange }: { field: FieldKey; value: string; onChange: (value: string) => void }) {
  const label = `${fieldLabels[field]}覆盖值`
  if (field === 'input') return <label>{label}<select value={value} onChange={e => onChange(e.target.value)}><option value="">不修改</option><option value={'["text"]'}>文本</option><option value={'["text","image"]'}>文本和图片</option><option value={'["image"]'}>图片</option></select></label>
  if (field === 'reasoningEfforts') {
    const mode = !value ? '' : value === 'false' ? 'disabled' : 'custom'
    let entries: Record<string, string | null> = {}
    let invalid = false
    if (mode === 'custom') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.entries(parsed).some(([key, item]) =>
          !levels.includes(key as typeof levels[number]) || !(typeof item === 'string' || key === 'off' && item === null))) invalid = true
        else entries = parsed as Record<string, string | null>
      } catch { invalid = true }
    }
    return <div><label>{label}<select value={mode} onChange={e => onChange(e.target.value === '' ? '' : e.target.value === 'disabled' ? 'false' : '{}')}><option value="">不修改</option><option value="disabled">禁用推理</option><option value="custom">自定义档位</option></select></label>
      {invalid && <p role="alert">推理档覆盖值格式无效，请重新选择配置模式。</p>}
      {mode === 'custom' && !invalid && <div className="dmm-efforts">{levels.map(level => <div key={level}><label className="dmm-check"><input type="checkbox" checked={Object.hasOwn(entries, level)} onChange={e => { const next = { ...entries }; if (e.target.checked) next[level] = level; else delete next[level]; onChange(JSON.stringify(next)) }}/>{level}</label><input aria-label={`内置模型 ${level} 请求值`} disabled={!Object.hasOwn(entries, level)} value={entries[level] ?? ''} onChange={e => onChange(JSON.stringify({ ...entries, [level]: level === 'off' && !e.target.value ? null : e.target.value }))}/></div>)}</div>}
    </div>
  }
  return <label>{label}<input type={field === 'name' ? 'text' : 'number'} min={field === 'name' ? undefined : 1} step={field === 'name' ? undefined : 1} value={value} placeholder="留空不修改" onChange={e => onChange(e.target.value)}/></label>
}
