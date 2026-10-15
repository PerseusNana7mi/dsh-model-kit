export const BASELLM_CATALOG_URL = 'https://basellm.github.io/llm-metadata/api/all.json'

export function basellmProviderUrl(provider: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error('Invalid reference provider ID')
  return `https://basellm.github.io/llm-metadata/api/providers/${provider}.json`
}
