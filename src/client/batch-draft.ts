import type { Reply, Request } from '../wire.js'

export type BatchSelection = Extract<Request, { action: 'batchCommit' }>['selections'][number]
export type BatchRow = NonNullable<Reply['batchReview']>['rows'][number]
export const batchKey = (row: { provider: string; id: string }) => JSON.stringify([row.provider, row.id])
export function availableSelection(row: BatchRow, mode: string): BatchSelection {
  return {
    provider: row.provider,
    id: row.id,
    fields: row.error
      ? []
      : row.parameters.filter((field) => mode === 'update' || field.selected).map((field) => field.key),
    prices:
      row.error || row.priceMode === 'multiplier'
        ? []
        : row.priceChanges.filter((field) => mode === 'update' || field.selected).map((field) => field.key),
    updateReference: !row.error && mode === 'update' && row.referenceUpdateAvailable === true,
  }
}
export function hasSelection(row: BatchSelection) {
  return row.fields.length > 0 || row.prices.length > 0 || row.updateReference
}
