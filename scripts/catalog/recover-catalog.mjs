import { writeFile } from "node:fs/promises"
import { stagingContext, redact } from "../lib/staging.mjs"
import { supabaseServerClient } from "../../lib/server/supabase-server.ts"
import { syncCatalog } from "../../lib/server/catalog/sync.ts"

// Explicit, bounded recovery; never bypass source leases or provider backoff.
const args = process.argv.slice(2)
if (
  args.some((a) => !["--staging", "--apply"].includes(a)) ||
  !args.includes("--staging")
)
  throw new Error("Use --staging, optionally --apply")
const { env } = await stagingContext()
Object.assign(process.env, env)
const db = supabaseServerClient(30_000)
const pending = await db
  .from("job_catalog_runs")
  .select("id,source,next_page,last_error,retry_at")
  .eq("status", "paused")
  .order("started_at", { ascending: false })
  .limit(100)
if (pending.error) throw new Error("Cannot read pending source runs")
const eligible = pending.data.filter(
  (r) =>
    r.last_error === "Invalid Workday detail path" ||
    (r.source.startsWith("smartrecruiters:") &&
      r.last_error?.includes("videos"))
)
const sourceIds = [...new Set(eligible.map((r) => r.source))].slice(0, 10)
const report = {
  startedAt: new Date().toISOString(),
  applied: args.includes("--apply"),
  sources: sourceIds,
  batches: [],
  complete: false,
}
const output = `.local-data/source-recovery-${Date.now()}.json`
try {
  if (report.applied && sourceIds.length) {
    const deadline = Date.now() + 15 * 60_000
    for (let batch = 0; batch < 10 && Date.now() < deadline; batch++) {
      const result = await syncCatalog({
        sourceIds,
        maxSources: 10,
        concurrency: 2,
        maxMs: Math.min(180_000, deadline - Date.now()),
        maxPagesPerSource: 30,
      })
      report.batches.push(result)
      await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
      console.log(
        JSON.stringify({
          batch: batch + 1,
          complete: result.complete,
          results: result.results,
        })
      )
      if (result.complete) {
        report.complete = true
        break
      }
      if (
        !result.ok ||
        result.results.some(
          (r) => r.reason === "backoff" || r.reason === "leased"
        )
      )
        break
    }
  }
} catch (error) {
  report.error = redact(error.message, env)
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(
    JSON.stringify({
      output,
      sources: sourceIds,
      complete: report.complete,
      error: report.error,
    })
  )
}
if (report.applied && sourceIds.length && !report.complete) process.exitCode = 2
