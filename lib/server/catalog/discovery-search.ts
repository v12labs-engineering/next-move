import type { SupabaseClient } from "@supabase/supabase-js"
import { relevantJobTitle } from "@/lib/matching"
import { jobCategoryIds } from "@/lib/jobs/categories"
import {
  fetchCatalogPage,
  type CatalogPosting,
  type CatalogSource,
} from "./feeds"

/** A filtered observation set is never a complete employer snapshot. */
export async function discoverProfileSource(
  source: CatalogSource,
  scope: { roles: string[]; countries: string[] },
  options: { fetch?: typeof fetch; page?: number; maxPages?: number } = {}
) {
  let page: number | null = options.page ?? 1,
    requests = 0
  const jobs = new Map<string, CatalogPosting>()
  for (
    let count = 0;
    page !== null && count < (options.maxPages ?? 3);
    count++
  ) {
    const snapshot = await fetchCatalogPage(source, page, {
      jobCategories: jobCategoryIds,
      fetch: options.fetch,
      maxResponseBytes: 15_000_000,
    })
    requests += snapshot.requests
    for (const job of snapshot.jobs)
      if (
        scope.countries.includes(job.country) &&
        relevantJobTitle(job.title, scope.roles)
      )
        jobs.set(job.id, job)
    page = snapshot.nextPage
  }
  return {
    jobs: [...jobs.values()],
    complete: page === null && source.kind !== "linkedin",
    nextPage: page,
    requests,
  }
}

/** New catalogue IDs get the bounded publication slots before old observations. */
export async function prioritizeDiscoveryObservations(
  db: SupabaseClient,
  jobs: CatalogPosting[],
  limit = 100
) {
  const existing = new Set<string>()
  for (let offset = 0; offset < jobs.length; offset += 100) {
    const result = await db
      .from("job_catalog")
      .select("id")
      .in(
        "id",
        jobs.slice(offset, offset + 100).map((row) => row.id)
      )
    if (result.error) throw result.error
    for (const row of result.data) existing.add(row.id)
  }
  return [...jobs]
    .sort(
      (a, b) =>
        Number(existing.has(a.id)) - Number(existing.has(b.id)) ||
        (Date.parse(b.posted_at ?? "") || 0) -
          (Date.parse(a.posted_at ?? "") || 0) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit)
}
