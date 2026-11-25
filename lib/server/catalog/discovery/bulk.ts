import { CandidateStore } from "./store"
import { probeClient, validateCandidate } from "./validate"
import type { BoardKind, SourceCandidate } from "./seeds"

import { boardKinds } from "../source-identity"
const kinds = boardKinds

/** Share origin pacing and provider throttles across all batches in a sweep. */
export function bulkProbe(transport: typeof fetch = fetch, spacingMs = 350) {
  const next = new Map<string, number>()
  const blocked = new Map<BoardKind, number>()
  const read = probeClient(async (input, init) => {
    const url = new URL(String(input))
    const kind: BoardKind = url.hostname.includes("ashby")
      ? "ashby"
      : url.hostname.includes("greenhouse")
        ? "greenhouse"
        : url.hostname.includes("smartrecruiters")
          ? "smartrecruiters"
          : url.hostname.endsWith(".myworkdayjobs.com")
            ? "workday"
            : url.hostname.endsWith(".recruitee.com")
              ? "recruitee"
              : url.hostname === "apply.workable.com"
                ? "workable"
                : url.hostname.endsWith(".keka.com")
                  ? "keka"
                  : /\.zohorecruit\.(com|in|eu|com\.au|jp)$/.test(url.hostname)
                    ? "zohorecruit"
                    : url.hostname.endsWith(".teamtailor.com")
                      ? "teamtailor"
                      : /\.jobs\.personio\.(com|de)$/.test(url.hostname)
                        ? "personio"
                        : "lever"
    const retry = blocked.get(kind) ?? 0
    if (retry > Date.now())
      return new Response(null, {
        status: 429,
        headers: {
          "retry-after": String(Math.ceil((retry - Date.now()) / 1000)),
        },
      })
    const slot = Math.max(Date.now(), next.get(url.origin) ?? 0)
    next.set(url.origin, slot + spacingMs)
    if (slot > Date.now())
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort)
          resolve()
        }, slot - Date.now())
        signal?.addEventListener("abort", abort, { once: true })
      })
    const response = await transport(input, init)
    if (response.status === 429) {
      const header = response.headers.get("retry-after")
      const until =
        header && /^\d+$/.test(header)
          ? Date.now() + Number(header) * 1000
          : header
            ? Date.parse(header)
            : Date.now() + 900_000
      blocked.set(
        kind,
        Math.max(
          Date.now() + 60_000,
          Number.isFinite(until) ? until : Date.now() + 900_000
        )
      )
    }
    return response
  })
  return { read, blocked }
}

/** A bounded operator batch. Every check/activation is committed individually. */
export async function bulkBatch(options: {
  store: CandidateStore
  candidates: SourceCandidate[]
  probe: ReturnType<typeof bulkProbe>
  parallelism?: number
  maxMs?: number
  onProgress?: (result: {
    id: string
    status: string
    activated: boolean
  }) => void
}) {
  if (process.env.APP_ENV !== "staging")
    throw new Error("Bulk activation requires isolated staging")
  const parallelism = options.parallelism ?? 3
  if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 4)
    throw new Error("Use 1–4 workers per provider")
  if (options.candidates.length > 300)
    throw new Error("Bulk batches are limited to 300 candidates")
  const maxMs = options.maxMs ?? 180_000
  if (maxMs < 20_000 || maxMs > 180_000)
    throw new Error("Bulk validation budget must be 20–180 seconds")
  const { db } = options.store
  const claim = await db.rpc("claim_source_expansion", { p_force: true })
  if (claim.error) throw claim.error
  if (!claim.data)
    return {
      skipped: "Expansion lease is held",
      processed: 0,
      activatedSources: [] as string[],
      counts: {} as Record<string, number>,
    }
  const batchId = claim.data as string
  const deadline = Date.now() + maxMs
  const activatedSources: string[] = [],
    counts: Record<string, number> = {}
  let fatal: unknown
  try {
    const recoverable = await options.store.list({
      limit: 300,
      status: "verified",
      validatedAfter: new Date(Date.now() - 86400000).toISOString(),
    })
    for (const candidate of recoverable) {
      await options.store.activate(
        [candidate.id],
        "Recovering an interrupted operator-authorized sweep: persisted live validation passed within the last 24 hours."
      )
      activatedSources.push(candidate.id)
    }
    await Promise.all(
      kinds.map(async (kind) => {
        const queue = options.candidates.filter((c) => c.kind === kind)
        let cursor = 0
        await Promise.all(
          Array.from({ length: parallelism }, async () => {
            while (
              !fatal &&
              cursor < queue.length &&
              Date.now() < deadline - 16_000 &&
              (options.probe.blocked.get(kind) ?? 0) <= Date.now()
            ) {
              const candidate = queue[cursor++]
              try {
                const claimed = await db.rpc("claim_source_candidate", {
                  p_id: candidate.id,
                })
                if (claimed.error) throw claimed.error
                if (!claimed.data) continue
                const result = await validateCandidate(
                  candidate,
                  options.probe.read,
                  new Date(),
                  AbortSignal.timeout(15_000)
                )
                const saved = await db.rpc("finish_source_candidate", {
                  p_id: candidate.id,
                  p_token: claimed.data.token,
                  p_result: result,
                })
                if (saved.error) throw saved.error
                let activated = false
                if (result.status === "verified") {
                  await options.store.activate(
                    [candidate.id],
                    "Operator-authorized full imported-directory sweep: live public provider identity and usable current posting evidence passed; historical provenance retained."
                  )
                  activatedSources.push(candidate.id)
                  activated = true
                }
                counts[result.status] = (counts[result.status] ?? 0) + 1
                options.onProgress?.({
                  id: candidate.id,
                  status: result.status,
                  activated,
                })
              } catch (error) {
                fatal = error
              }
            }
          })
        )
      })
    )
    if (fatal) throw fatal
    const report = {
      batchId,
      selected: options.candidates.length,
      processed: Object.values(counts).reduce((a, b) => a + b, 0),
      counts,
      activatedSources,
    }
    const finished = await db.rpc("finish_source_expansion", {
      p_id: batchId,
      p_result: report,
      p_failed: false,
    })
    if (finished.error) throw finished.error
    return report
  } catch (error) {
    await db.rpc("finish_source_expansion", {
      p_id: batchId,
      p_result: {
        error: "Bulk batch interrupted; committed candidate checks retained",
        counts,
        activatedSources,
      },
      p_failed: true,
    })
    throw error
  }
}
