import type { SupabaseClient } from "@supabase/supabase-js"
import type { CatalogSourceHealth } from "@/lib/jobs/coverage"
import { scanCatalog } from "./read"

export async function readCatalogCapacity(
  db: SupabaseClient,
  budget = Number(
    process.env.CATALOG_DATABASE_BUDGET_BYTES ?? 400 * 1024 * 1024
  )
) {
  if (!Number.isSafeInteger(budget) || budget < 50 * 1024 * 1024)
    throw new Error("Invalid catalogue storage budget")
  const [usage, control] = await Promise.all([
    db.rpc("catalog_storage_usage"),
    db.from("catalog_capacity_control").select("budget_bytes").single(),
  ])
  if (usage.error) throw usage.error
  if (control.error) throw control.error
  const bytes =
    usage.data?.database_bytes == null ? NaN : Number(usage.data.database_bytes)
  const databaseBudget =
    control.data?.budget_bytes == null ? NaN : Number(control.data.budget_bytes)
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(databaseBudget) ||
    databaseBudget < 50 * 1024 * 1024
  )
    throw new Error("Catalogue storage usage is unavailable")
  const limit = Math.min(budget, databaseBudget)
  return { bytes, limit, available: bytes < limit }
}

interface MatchingOverview {
  totalJobs: number
  lastUpdatedAt: string | null
  sources: number
  failedSources: number
  health: CatalogSourceHealth[]
}

export async function readMatchingOverview(
  db: SupabaseClient,
  countries: string[]
) {
  const result = await db.rpc("catalog_matching_overview", {
    p_countries: countries,
  })
  if (result.error) throw result.error
  return result.data as MatchingOverview
}

export async function readSourceHealth(db: SupabaseClient) {
  const sources: CatalogSourceHealth[] = []
  await scanCatalog<CatalogSourceHealth>(
    async (after) => {
      const result = await db.rpc("catalog_source_health", {
        p_after: after,
        p_limit: 500,
      })
      if (result.error) throw result.error
      return result.data
    },
    (page) => {
      sources.push(...page)
    }
  )
  return sources
}
