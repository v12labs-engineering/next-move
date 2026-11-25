import { requireAccount } from "@/lib/server/session"
import { apiError } from "@/lib/server/http"
import { logoCandidates } from "@/lib/jobs/company-logo"

type Logo = { type: string; bytes: ArrayBuffer } | null
const cache = new Map<string, Promise<Logo>>()

async function favicon(domain: string): Promise<Logo> {
  const res = await fetch(
    `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    { signal: AbortSignal.timeout(4000) }
  ).catch(() => null)
  const type = res?.headers.get("content-type") ?? ""
  if (!res?.ok || !type.startsWith("image/")) return null
  return { type, bytes: await res.arrayBuffer() }
}

// Probes run in parallel; the earliest candidate with a real icon wins.
async function lookup(name: string, hint: string | null): Promise<Logo> {
  const results = await Promise.all(logoCandidates(name, hint).map(favicon))
  return results.find(Boolean) ?? null
}

// Fetched server-side so the logo provider never sees who is browsing.
export async function GET(request: Request) {
  try {
    await requireAccount()
    const params = new URL(request.url).searchParams
    const name = (params.get("name") ?? "").slice(0, 120)
    const hint = params.get("hint")?.toLowerCase().slice(0, 120) ?? null
    if (!name.trim() || (hint && !/^[a-z0-9.-]+$/.test(hint)))
      return new Response(null, { status: 400 })
    const key = `${name}|${hint ?? ""}`
    if (!cache.has(key)) {
      if (cache.size > 5000) cache.clear()
      cache.set(key, lookup(name, hint))
    }
    const logo = await cache.get(key)!
    if (!logo)
      return new Response(null, {
        status: 404,
        headers: { "Cache-Control": "private, max-age=86400" },
      })
    return new Response(logo.bytes.slice(0), {
      headers: {
        "Content-Type": logo.type,
        "Cache-Control": "private, max-age=604800, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    return apiError(error)
  }
}
