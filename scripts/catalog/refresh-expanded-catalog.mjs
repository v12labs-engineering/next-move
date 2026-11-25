import { readFile, writeFile, appendFile } from "node:fs/promises"
import { syncCatalog } from "../../lib/server/catalog/sync.ts"
import { stagingContext, redact } from "../lib/staging.mjs"
const args = process.argv.slice(2)
if (
  args.some(
    (v) =>
      v.startsWith("--") &&
      !["--staging", "--apply", "--watch-sweep", "--output"].includes(v)
  )
)
  throw Error("Unknown refresh option")
if (!args.includes("--staging") || !args.includes("--apply"))
  throw Error("Use --staging --apply for the explicitly scoped refresh worker")
const value = (flag) => {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw Error(`${flag} requires a value`)
  return args[i + 1]
}
const watch = value("--watch-sweep"),
  output =
    value("--output") ?? `.local-data/discovery-refresh-${Date.now()}.json`
const { env } = await stagingContext()
Object.assign(process.env, env)
const report = {
  startedAt: new Date().toISOString(),
  batches: 0,
  publishedSourceSnapshots: 0,
  recordsPublished: 0,
  complete: false,
}
const deadline = Date.now() + 6 * 3600000
for (;;) {
  if (Date.now() >= deadline) {
    report.paused = "Worker time budget reached"
    break
  }
  let result
  try {
    result = await syncCatalog({
      maxSources: 60,
      concurrency: 4,
      maxMs: 180000,
      maxPagesPerSource: 50,
    })
  } catch (error) {
    report.paused = redact(error?.message ?? "Collection interrupted", env)
    break
  }
  report.batches++
  const published = result.results.filter(
    (row) => typeof row.count === "number"
  )
  report.publishedSourceSnapshots += published.length
  report.recordsPublished += published.reduce((n, row) => n + row.count, 0)
  report.latest = { ...result, measuredAt: new Date().toISOString() }
  await appendFile(
    output + ".batches.jsonl",
    JSON.stringify(report.latest) + "\n",
    { mode: 0o600 }
  )
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(
    JSON.stringify({
      batches: report.batches,
      published: published.length,
      recordsPublished: report.recordsPublished,
      remaining: result.remainingSources,
      deferred: result.deferredSources,
      errors: result.results
        .filter((row) => row.error)
        .map((row) => ({ source: row.source, error: row.error })),
    })
  )
  if (result.results.some((row) => row.error?.includes("storage budget"))) {
    report.paused =
      "Catalogue storage budget reached; validation continues independently"
    break
  }
  let sweepDone = !watch
  if (watch) {
    try {
      sweepDone =
        JSON.parse(await readFile(watch + ".receipt.json", "utf8")).complete ===
        true
    } catch {}
  }
  if (result.complete && sweepDone) {
    report.complete = true
    break
  }
  if (
    !result.remainingSources &&
    !result.results.some((row) => row.pending && !row.skipped)
  )
    await new Promise((resolve) => setTimeout(resolve, 60_000))
}
report.finishedAt = new Date().toISOString()
await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (!report.complete) process.exitCode = 2
