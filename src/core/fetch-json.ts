/** Bound decoded response bytes, including responses without Content-Length. */
export async function fetchJson(url: string, signal: AbortSignal, label = 'Model catalog'): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${label} request failed: HTTP ${response.status}`)
  }
  const maxBytes = 32 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${label} catalog exceeds 32 MiB`)
  }
  if (!response.body) throw new Error(`${label} response has no body`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`${label} catalog exceeds 32 MiB`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}
