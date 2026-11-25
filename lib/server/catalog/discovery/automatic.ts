import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { countryOptions } from "@/lib/location/countries"
import { supabaseServerClient } from "../../supabase-server"
import { scanCatalog } from "../read"
import { readCatalogCapacity } from "../health"
import { boardFromUrl } from "../source-identity"
import { CandidateStore } from "./store"
import {
  browserbaseSearchResponse,
  discoverWithBrowserbase,
} from "./browserbase"
import { candidatesFromLinks, linkDiscoveryOrigin } from "./links"
import { readBounded } from "./seeds"
import { countryDiscoveryQueries } from "./worldwide"

const priorityRow = z.object({
  country: z.string(),
  attempts: z.number().int().nonnegative(),
  last_attempt_at: z.string().nullable(),
  next_attempt_at: z.string(),
  users: z.number().nonnegative(),
  underserved: z.number().nonnegative(),
  unmeasured: z.number().nonnegative(),
})
export type CountryPriority = z.infer<typeof priorityRow>
export function prioritizeDiscoveryCountries(
  rows: CountryPriority[],
  limit = 6,
  now = Date.now()
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6)
    throw new Error("Use 1–6 discovery countries")
  const ready = rows.filter((row) => Date.parse(row.next_attempt_at) <= now)
  const age = (row: CountryPriority) =>
    Date.parse(row.last_attempt_at ?? "") || 0
  const rotation = [...ready].sort(
    (a, b) => age(a) - age(b) || a.country.localeCompare(b.country)
  )
  const priority = ready
    .filter((row) => row.users > 0)
    .sort(
      (a, b) =>
        b.underserved - a.underserved ||
        b.unmeasured - a.unmeasured ||
        b.users - a.users ||
        age(a) - age(b) ||
        a.country.localeCompare(b.country)
    )
  const selected = priority.slice(0, Math.floor(limit / 2))
  for (const row of rotation)
    if (
      selected.length < limit &&
      !selected.some((s) => s.country === row.country)
    )
      selected.push(row)
  return selected
}

const claimSchema = z.object({
  claimed: z.boolean(),
  id: z.uuid().optional(),
  token: z.uuid().optional(),
  reason: z.string().optional(),
  result: z.unknown().optional(),
})
const candidateSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    validated_at: z.string().nullable(),
    validation: z
      .object({ fresh_count: z.number().optional() })
      .passthrough()
      .nullable(),
  })
  .passthrough()
const receiptSchema = z
  .object({
    id: z.uuid(),
    status: z.string(),
    activatedSources: z.array(z.string()),
    reservedSearches: z.number(),
    completedSearches: z.number(),
    reservedMilliusd: z.number(),
  })
  .passthrough()
export type AutomaticDiscoveryReceipt = {
  status: string
  reason?: string
  activatedSources: string[]
  id?: string
  [key: string]: unknown
}

/** Only the SQL reservation admits a paid request. A crash never refunds it. */
export async function runAutomaticDiscovery(options: {
  requestKey: string
  env?: Partial<NodeJS.ProcessEnv>
  database?: SupabaseClient
  fetch?: typeof fetch
  maxCountries?: number
}): Promise<AutomaticDiscoveryReceipt> {
  const env = options.env ?? process.env
  if (env.AUTOMATIC_DISCOVERY_ENABLED !== "true")
    return { status: "disabled", activatedSources: [] }
  if (env.APP_ENV !== "staging")
    return { status: "skipped", reason: "staging_only", activatedSources: [] }
  if (!env.BROWSERBASE_API_KEY)
    return {
      status: "skipped",
      reason: "provider_not_configured",
      activatedSources: [],
    }
  const db = options.database ?? supabaseServerClient(15_000)
  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const response = await db.rpc(name, args)
    if (response.error)
      throw new Error(`Automatic discovery storage operation failed: ${name}`)
    return response.data as unknown
  }
  const capacity = await readCatalogCapacity(db)
  if (capacity.bytes + 16 * 1024 * 1024 >= capacity.limit)
    return { status: "skipped", reason: "storage_budget", activatedSources: [] }
  await rpc("initialize_automatic_discovery", { p_countries: countryOptions })
  const claim = claimSchema.parse(
    await rpc("claim_automatic_discovery", {
      p_request_key: options.requestKey,
    })
  )
  if (!claim.claimed) {
    const prior = receiptSchema.safeParse(claim.result)
    return prior.success
      ? prior.data
      : {
          status: "skipped",
          reason: claim.reason ?? "already_admitted",
          activatedSources: [],
        }
  }
  if (!claim.id || !claim.token)
    throw new Error("Automatic discovery claim omitted its fence")
  const run = claim.id,
    token = claim.token,
    started = Date.now(),
    deadline = started + 240_000
  let stopReason: string | undefined,
    checkedSources = 0
  const base = { p_run: run, p_token: token }
  try {
    const priorities = z
      .array(priorityRow)
      .parse(await rpc("automatic_discovery_country_priority"))
    const countries = prioritizeDiscoveryCountries(
      priorities,
      options.maxCountries ?? 6
    )
    const plan = countries.map((row) => ({
      country: row.country,
      queries: countryDiscoveryQueries(row.country, row.attempts),
    }))
    await rpc("set_automatic_discovery_plan", { ...base, p_plan: plan })
    const known = new Set<string>()
    await scanCatalog(
      async (after) => {
        let q = db
          .from("job_source_directory")
          .select("id")
          .eq("enabled", true)
          .order("id")
          .limit(500)
        if (after) q = q.gt("id", after)
        const r = await q
        if (r.error) throw new Error("Automatic discovery source read failed")
        return r.data
      },
      (page) => {
        for (const row of page) known.add(row.id)
      }
    )
    const seen = new Set(known)
    for (const [countryIndex, country] of plan.entries()) {
      if (Date.now() >= deadline - 140_000) {
        stopReason = "time_budget"
        break
      }
      let ordinal = countryIndex * 2
      const discovered = await discoverWithBrowserbase(country.queries, {
        apiKey: env.BROWSERBASE_API_KEY,
        maxBrowsers: 0,
        maxUrls: 2,
        maxUrlsPerQuery: 1,
        knownSourceIds: known,
        maxMs: 30_000,
        fetch: async (input, init) => {
          if (String(input) !== "https://api.browserbase.com/v1/search")
            throw new Error("Unexpected paid endpoint")
          const query = JSON.parse(String(init?.body)).query as string,
            index = ordinal++
          const reservation = z
            .object({ allowed: z.boolean(), reason: z.string().optional() })
            .parse(
              await rpc("reserve_automatic_discovery_search", {
                ...base,
                p_ordinal: index,
                p_query: query,
              })
            )
          if (!reservation.allowed) {
            stopReason = reservation.reason
            throw new Error("Paid discovery request not admitted")
          }
          let status = 503,
            retryAt: string | null = null
          let result: z.infer<typeof browserbaseSearchResponse> = {
            requestId: "unavailable",
            results: [],
          }
          try {
            const response = await (options.fetch ?? fetch)(input, init)
            status = response.status
            const retry = response.headers.get("retry-after")
            if (retry) {
              const time = /^\d+$/.test(retry)
                ? Date.now() + Number(retry) * 1000
                : Date.parse(retry)
              if (Number.isFinite(time) && time > Date.now())
                retryAt = new Date(time).toISOString()
            }
            if (status === 200) {
              const parsed = browserbaseSearchResponse.parse(
                JSON.parse(
                  (await readBounded(response, 256_000)).toString("utf8")
                )
              )
              const boardIds = parsed.results.flatMap((row) => {
                const board = boardFromUrl(row.url)
                return board ? [board.id] : []
              })
              if (boardIds.length) {
                const existing = await db
                  .from("source_candidates")
                  .select("id")
                  .in("id", boardIds)
                if (existing.error) throw existing.error
                for (const row of existing.data) seen.add(row.id)
              }
              // Only directly observed supported boards enter scheduled intake.
              // Unsupported pages need an operator reader decision, not a browser.
              const observed = parsed.results.find((row) => {
                const board = boardFromUrl(row.url)
                return board && !seen.has(board.id)
              })
              result = {
                requestId: parsed.requestId,
                results: observed ? [observed] : [],
              }
            } else await response.body?.cancel()
          } catch {
            status = 503
          }
          if ([401, 402, 403].includes(status))
            retryAt = new Date(Date.now() + 86400000).toISOString()
          const candidates = result.results.flatMap((row) =>
            candidatesFromLinks(row.url, [row.url])
          )
          const origin = {
            ...linkDiscoveryOrigin(
              result.results.map((r) => r.url),
              candidates
            ),
            id: `automatic:${run}:${index}`,
            format: "automatic-browserbase-search",
            query,
            country: country.country,
            requestId: result.requestId,
          }
          await rpc("record_automatic_discovery_search", {
            ...base,
            p_ordinal: index,
            p_status: status,
            p_result: result,
            p_origin: origin,
            p_candidates: candidates,
            p_retry_at: retryAt,
          })
          for (const c of candidates) seen.add(c.id)
          return Response.json(result, { status })
        },
      })
      if (!discovered.complete) {
        stopReason ??= "provider_failure"
        break
      }
    }
    // Recover candidates from earlier crashed runs too. Each query atomically
    // persisted its provenance/intake before another paid request was attempted.
    const pending = z
      .array(candidateSchema)
      .parse(await rpc("automatic_discovery_pending_candidates"))
    const unvalidated = pending
      .filter(
        (c) =>
          c.status !== "verified" ||
          !c.validation?.fresh_count ||
          !c.validated_at ||
          Date.parse(c.validated_at) <= Date.now() - 86400000
      )
      .map((c) => c.id)
    if (unvalidated.length && Date.now() < deadline - 30_000) {
      const validated = await new CandidateStore(db).validate({
        limit: 12,
        ids: unvalidated,
        apply: true,
        requireRecent: true,
        maxMs: deadline - Date.now() - 15_000,
        candidateMs: 10_000,
      })
      checkedSources = validated.processed
      if (!validated.complete) stopReason ??= "validation_budget"
    }
    const ready = z
      .array(candidateSchema)
      .parse(await rpc("automatic_discovery_pending_candidates"))
    for (const candidate of ready) {
      if (
        candidate.status !== "verified" ||
        !candidate.validation?.fresh_count ||
        !candidate.validated_at ||
        Date.parse(candidate.validated_at) <= Date.now() - 86400000
      )
        continue
      await rpc("activate_automatic_discovery_source", {
        ...base,
        p_source: candidate.id,
      })
    }
    return receiptSchema.parse(
      await rpc("finish_automatic_discovery", {
        ...base,
        p_status: stopReason ? "partial" : "completed",
        p_result: {
          checkedSources,
          reason: stopReason ?? null,
          selectedCountries: plan.map((p) => p.country),
        },
      })
    )
  } catch {
    // Never include provider bodies, credentials, profile contents or signed URLs.
    try {
      return receiptSchema.parse(
        await rpc("finish_automatic_discovery", {
          ...base,
          p_status: "failed",
          p_result: { reason: "discovery_interrupted", checkedSources },
        })
      )
    } catch {
      return {
        id: run,
        status: "interrupted",
        reason: "settlement_unconfirmed",
        activatedSources: [],
      }
    }
  }
}
