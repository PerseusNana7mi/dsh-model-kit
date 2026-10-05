import type { differences, FieldKey } from '../core/diff.js'
export const fieldLabels: Record<FieldKey, string> = { name: '显示名', contextWindow: '上下文窗口', maxTokens: '最大输出', input: '输入模态', reasoningEfforts: '推理档' }
export function FieldDiff({ rows, selected, onChange }: { rows: ReturnType<typeof differences>; selected: FieldKey[]; onChange: (keys: FieldKey[]) => void }) {
  return <div className="dmm-diff">{rows.length ? rows.map(row => <div key={row.key}>
    <label className="dmm-check"><input type="checkbox" checked={selected.includes(row.key)} onChange={e => onChange(e.target.checked ? [...selected, row.key] : selected.filter(key => key !== row.key))}/>应用{fieldLabels[row.key]}</label>
    <div><span>当前：{row.before}</span><span>建议：{row.after}</span></div>
  </div>) : <p>没有可应用的字段差异。</p>}</div>
}
