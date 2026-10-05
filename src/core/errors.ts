import { ZodError } from 'zod'

export function readableError(error: unknown): string {
  if (error instanceof ZodError) {
    const path = error.issues[0]?.path.map(String).join('.')
    return `模型数据格式校验失败${path ? `（字段：${path}）` : ''}。请检查该字段或更新插件后重试。`
  }
  return error instanceof Error ? error.message : '操作失败，请重试。'
}
