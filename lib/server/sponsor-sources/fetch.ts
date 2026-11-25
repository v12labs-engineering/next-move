const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

/** Fetch an official source as text. Throws loudly on any non-OK response. */
export async function fetchSourceHtml(url: string, timeoutMs = 30_000): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Source fetch failed: ${response.status} ${response.statusText} for ${url}`)
  }
  return response.text()
}

/** Fetch an official source as a binary buffer (XLSX, PDF). Throws on non-OK. */
export async function fetchSourceBuffer(url: string, timeoutMs = 60_000): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Source fetch failed: ${response.status} ${response.statusText} for ${url}`)
  }
  return Buffer.from(await response.arrayBuffer())
}
