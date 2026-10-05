/** Prefer the developer's catalog entry only when it is an exact-ID candidate. */
export function officialProviders(id: string): readonly string[] {
  const modelId = id.trim().replace(/^models\//i, '').split('/').at(-1)!
  const families: [RegExp, string[]][] = [
    [/^(gpt-|chatgpt-|o[134](?:-|$))/i, ['openai']],
    [/^claude-/i, ['anthropic']],
    [/^gemini-/i, ['google']],
    [/^deepseek-/i, ['deepseek']],
    [/^grok-/i, ['xai']],
    [/^kimi-/i, ['moonshotai', 'moonshotai-cn']],
    [/^qwen/i, ['alibaba', 'alibaba-cn']],
    [/^glm-/i, ['zhipuai']],
    [/^mistral-|^magistral-|^codestral-/i, ['mistral']],
    [/^minimax-/i, ['minimax', 'minimax-cn']],
  ]
  return families.find(([pattern]) => pattern.test(modelId))?.[1] ?? []
}

export function officialSource<T extends { provider: string }>(id: string, candidates: T[]): T | undefined {
  const providers = officialProviders(id)
  for (const provider of providers) {
    const candidate = candidates.find(row => row.provider === provider)
    if (candidate) return candidate
  }
  return undefined
}

export function preferredSource<T extends { provider: string }>(id: string, candidates: T[]): T | undefined {
  return officialSource(id, candidates) ?? (candidates.length === 1 ? candidates[0] : undefined)
}
