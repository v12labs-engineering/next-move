import { validSourceId } from "../../lib/server/catalog/source-identity.ts"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { supabaseServerClient } from "../../lib/server/supabase-server.ts"
import { scanCatalog } from "../../lib/server/catalog/read.ts"
import { catalogJob } from "../../lib/server/catalog/job.ts"
import { createCoverageAssessment } from "../../lib/jobs/coverage.ts"
import { countryOptions } from "../../lib/location/countries.ts"
import { syncCatalog } from "../../lib/server/catalog/sync.ts"
import { readSourceHealth } from "../../lib/server/catalog/health.ts"
import { hydrateCatalogDescriptions } from "../../lib/server/catalog/content.ts"

async function main() {
  const [command = "audit"] = process.argv.slice(2)
  if (process.argv.includes("--staging")) {
    const { stagingContext } = await import("../lib/staging.mjs")
    const { env } = await stagingContext()
    for (const [key, value] of Object.entries(env)) process.env[key] = value
  }
  const db = supabaseServerClient()
  if (command === "collect") {
    const idsIndex = process.argv.indexOf("--ids")
    const sourceIds =
      idsIndex < 0 ? undefined : process.argv[idsIndex + 1]?.split(",")
    if (
      idsIndex >= 0 &&
      (!sourceIds?.length || sourceIds.some((id) => !validSourceId(id)))
    )
      throw new Error("--ids requires canonical source IDs")
    const result = await syncCatalog({
      maxMs: 600000,
      maxPagesPerSource: 50,
      sourceIds,
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok || !result.complete) process.exitCode = 1
    return
  }
  if (command === "sources") {
    const sources = []
    await scanCatalog(
      async (after) => {
        let query = db
          .from("job_source_directory")
          .select("id,kind,company,board,enabled,discovered_url")
          .order("id")
          .limit(500)
        if (after) query = query.gt("id", after)
        const result = await query
        if (result.error) throw result.error
        return result.data
      },
      (page) => {
        sources.push(...page)
      }
    )
    console.log(JSON.stringify(sources, null, 2))
    return
  }
  if (command !== "audit")
    throw new Error(
      "Use audit, collect or sources. Source activation requires operator review in the database."
    )
  const assessment = createCoverageAssessment(countryOptions)
  const titles = new Map(),
    experience = new Map(),
    seen = new Set()
  const measuredAt = new Date()
  let unclassifiedLanguage = 0
  await scanCatalog(
    async (after) => {
      let query = db
        .from("job_catalog")
        .select("*")
        .order("id")
        .limit(500)
        .lte("discovered_at", measuredAt.toISOString())
      if (after) query = query.gt("id", after)
      const result = await query
      if (result.error) throw result.error
      return result.data
    },
    async (page) => {
      const jobs = (await hydrateCatalogDescriptions(db, page)).map((row) =>
        catalogJob(row)
      )
      assessment.add(jobs)
      for (const job of jobs) {
        if (
          !job.isActive ||
          !job.lastCheckedAt ||
          Date.parse(job.lastCheckedAt) < Date.now() - 7 * 86400000
        )
          continue
        const key = `${job.country}\n${job.url}`
        if (seen.has(key)) continue
        seen.add(key)
        titles.set(job.title, (titles.get(job.title) ?? 0) + 1)
        const years =
          job.description?.match(
            /\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?experience\b/i
          )?.[1] ?? "unknown"
        experience.set(years, (experience.get(years) ?? 0) + 1)
        unclassifiedLanguage++
      }
    }
  )
  const [sources, runs] = await Promise.all([
    readSourceHealth(db),
    db
      .from("job_catalog_runs")
      .select(
        "id,source,status,started_at,finished_at,attempts,pages,fetched_count,rejected_count,accepted_count,duplicate_count,new_count,updated_count,expired_count,request_count,last_error,next_page,retry_at"
      )
      .order("started_at", { ascending: false })
      .limit(100),
  ])
  if (runs.error) throw runs.error
  const report = {
    ...assessment.report(sources),
    sources,
    recentRuns: runs.data,
    pendingSourceReview: sources.filter((source) => !source.enabled).length,
    titleInventory: Object.fromEntries(
      [...titles].sort(([a], [b]) => a.localeCompare(b))
    ),
    explicitEnglishExperienceYears: Object.fromEntries(experience),
    language: {
      unknown: unclassifiedLanguage,
      note: "Source language metadata is unavailable; original text is retained. No automatic language or profession classification is claimed.",
    },
    notes: [
      "Counts describe observed supply, not worldwide market coverage.",
      "Title inventory is source wording, not a normalized occupation taxonomy.",
      "Candidate relevance is measured separately in each account; this operator audit includes no candidate data.",
      "Historical run counters start with the new migration; earlier trends cannot be reconstructed.",
    ],
  }
  const outputIndex = process.argv.indexOf("--output")
  if (outputIndex >= 0) {
    const filename = process.argv[outputIndex + 1]
    if (!filename) throw new Error("--output requires a path")
    await writeFile(resolve(filename), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    })
    console.log(`Coverage report saved to ${resolve(filename)}`)
  } else console.log(JSON.stringify(report, null, 2))
}
main().catch(() => {
  console.error(
    "Catalogue command failed. Check operator configuration, applied migrations and source status. Credentials were not printed."
  )
  process.exitCode = 1
})
