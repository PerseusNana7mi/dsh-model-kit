import type { ModelFields } from '../core/catalog.js'
import { fields } from '../wire.js'

export type Draft = {
  name: string; context: string; output: string; input: ModelFields['input'];
  reasoning: string; efforts: Record<string, string>;
}

export function draftOf(model: ModelFields): Draft {
  return { name: model.name ?? '', context: String(model.contextWindow ?? ''), output: String(model.maxTokens ?? ''),
    input: model.input ? [...model.input] : undefined,
    reasoning: model.reasoningEfforts === false ? 'disabled' : model.reasoningEfforts ? 'custom' : 'inherit',
    efforts: Object.fromEntries(Object.entries(model.reasoningEfforts || {}).map(([key, value]) => [key, value ?? ''])) }
}

export function draftModel(id: string, draft: Draft): ModelFields {
  return { id, ...(draft.name ? { name: draft.name } : {}),
    ...(draft.context.trim() ? { contextWindow: Number(draft.context) } : {}),
    ...(draft.output.trim() ? { maxTokens: Number(draft.output) } : {}),
    ...(draft.input ? { input: [...draft.input] } : {}),
    ...(draft.reasoning === 'disabled' ? { reasoningEfforts: false as const } : draft.reasoning === 'custom'
      ? { reasoningEfforts: Object.fromEntries(Object.entries(draft.efforts).map(([key, value]) => [key, key === 'off' && !value ? null : value])) } : {}) }
}

/** Submit edited fields only; displaying a model must not normalize its stored capabilities. */
export function modelPatch(draft: Draft, saved: ModelFields) {
  const before = draftOf(saved)
  const model = draftModel(saved.id, draft)
  const patch: Record<string, unknown> = {}
  if (draft.name !== before.name) patch.name = draft.name
  if (draft.context !== before.context && draft.context.trim()) patch.contextWindow = model.contextWindow
  if (draft.output !== before.output && draft.output.trim()) patch.maxTokens = model.maxTokens
  if (JSON.stringify(draft.input) !== JSON.stringify(before.input) && draft.input) patch.input = model.input
  if ((draft.reasoning !== before.reasoning || JSON.stringify(draft.efforts) !== JSON.stringify(before.efforts))
    && model.reasoningEfforts !== undefined) patch.reasoningEfforts = model.reasoningEfforts
  return fields.parse(patch)
}
