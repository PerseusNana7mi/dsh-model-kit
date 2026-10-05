import { fields } from '../wire.js'
import { fieldKeys } from '../core/diff.js'
import type { ModelFields } from '../core/catalog.js'

export function overrideDraftModel(base: ModelFields, draft: Record<string, string>): ModelFields {
  const patch = parseOverrideDraft(draft)
  return { ...base, ...patch } as ModelFields
}

/** Parse the editable representation at the shared boundary used by render and save. */
export function parseOverrideDraft(draft: Record<string, string>): Partial<ModelFields> {
  return fields.parse(Object.fromEntries(fieldKeys.filter(key => draft[key]?.trim()).map(key =>
    [key, key === 'name' ? draft[key] : JSON.parse(draft[key]!)]))) as Partial<ModelFields>
}

/** Update only fields changed by this recommendation/undo, preserving unrelated edits. */
export function applyOverrideDraft(base: ModelFields, current: ModelFields, next: ModelFields, draft: Record<string, string>) {
  const result = { ...draft }
  for (const key of fieldKeys) {
    if (JSON.stringify(current[key]) === JSON.stringify(next[key])) continue
    if (JSON.stringify(next[key]) === JSON.stringify(base[key]) || next[key] === undefined) delete result[key]
    else result[key] = key === 'name' ? String(next[key]) : JSON.stringify(next[key])!
  }
  return result
}
