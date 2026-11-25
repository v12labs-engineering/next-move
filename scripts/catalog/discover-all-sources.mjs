import { boardKinds } from "../../lib/server/catalog/source-identity.ts"
import { readFile, writeFile, appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CandidateStore } from "../../lib/server/catalog/discovery/store.ts"
import { bulkBatch, bulkProbe } from "../../lib/server/catalog/discovery/bulk.ts"
import { stagingContext, redact } from "../lib/staging.mjs"
import { scanCatalog } from "../../lib/server/catalog/read.ts"
import { createClient } from "@supabase/supabase-js"

const args = process.argv.slice(2)
const allowed = new Set([
  "--staging",
  "--apply",
  "--limit",
  "--workers",
  "--resume",
  "--output",
])
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw Error("Unknown bulk discovery option")
  if (!["--staging", "--apply"].includes(args[i])) i++
}
const value = (flag) => {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw Error(`${flag} requires a value`)
  return args[i + 1]
}
let limit = Number(value("--limit") ?? 150),
  workers = Number(value("--workers") ?? 3)
if (
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 300 ||
  !Number.isInteger(workers) ||
  workers < 1 ||
  workers > 4
)
  throw Error("Use batches 1–300 and 1–4 workers per provider")
if (!args.includes("--staging"))
  throw Error("Bulk discovery requires explicit --staging")
const context = await stagingContext()
Object.assign(process.env, context.env)
const store = new CandidateStore(
    createClient(
      context.env.NEXT_PUBLIC_SUPABASE_URL,
      context.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { persistSession: false },
        db: { retry: false },
        global: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              signal: AbortSignal.any([
                ...(init?.signal ? [init.signal] : []),
                AbortSignal.timeout(30_000),
              ]),
            }),
        },
      }
    )
  ),
  probe = bulkProbe()
const output = resolve(
  value("--resume") ??
    value("--output") ??
    `.local-data/discovery-full-sweep-${Date.now()}.json`
)
async function unchecked() {
  const rows = []
  await scanCatalog(
    async (after) => {
      let query = store.db
        .from("source_candidates")
        .select(
          "id,kind,board,expected_company,status,next_attempt_at,lease_until,validated_at"
        )
        .is("validated_at", null)
        .in("status", ["imported", "validating"])
        .order("id")
        .limit(500)
      if (after) query = query.gt("id", after)
      const r = await query
      if (r.error) throw r.error
      return r.data
    },
    (page) => rows.push(...page)
  )
  return rows
}
let manifest
if (value("--resume")) {
  manifest = JSON.parse(await readFile(output, "utf8"))
  if (
    manifest.projectRef !== context.ref ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.targets)
  )
    throw Error("The sweep manifest does not identify isolated staging")
  if (!value("--limit")) limit = manifest.batchSize
  if (!value("--workers")) workers = manifest.workersPerProvider
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 300 ||
    !Number.isInteger(workers) ||
    workers < 1 ||
    workers > 4
  )
    throw Error("Invalid saved sweep limits")
} else {
  const rows = await unchecked()
  manifest = {
    version: 1,
    projectRef: context.ref,
    startedAt: new Date().toISOString(),
    targets: rows.map((r) => r.id),
    batchSize: limit,
    workersPerProvider: workers,
  }
}
if (!args.includes("--apply")) {
  console.log(
    JSON.stringify(
      {
        applied: false,
        targets: manifest.targets.length,
        batchSize: limit,
        workersPerProvider: workers,
        output,
      },
      null,
      2
    )
  )
  process.exit(0)
}
if (!value("--resume"))
  await writeFile(output, JSON.stringify(manifest, null, 2), {
    flag: "wx",
    mode: 0o600,
  })
const targets = new Set(manifest.targets),
  summary = {
    startedAt: new Date().toISOString(),
    targets: targets.size,
    processed: 0,
    activated: 0,
    counts: {},
    batches: 0,
    complete: false,
  }
let progressAt = 0
let transientFailures = 0
let providerBackoffRestored = false
try {
  for (;;) {
    try {
      if (!providerBackoffRestored) {
        const throttled = await store.db
          .from("source_candidates")
          .select("kind,next_attempt_at,reason:validation->>reason")
          .eq("status", "deferred")
          .gt("next_attempt_at", new Date().toISOString())
          .limit(500)
        if (throttled.error) throw throttled.error
        for (const row of throttled.data)
          if (row.reason === "Provider HTTP 429")
            probe.blocked.set(
              row.kind,
              Math.max(
                probe.blocked.get(row.kind) ?? 0,
                Date.parse(row.next_attempt_at)
              )
            )
        providerBackoffRestored = true
      }
      const remaining = (await unchecked()).filter((row) => targets.has(row.id))
      if (!remaining.length) {
        const recovered = await bulkBatch({
          store,
          candidates: [],
          probe,
          parallelism: workers,
        })
        if (recovered.skipped) {
          await new Promise((r) => setTimeout(r, 10_000))
          continue
        }
        summary.activated += recovered.activatedSources.length
        if (recovered.activatedSources.length) continue
        summary.complete = true
        break
      }
      const eligible = remaining.filter(
        (row) =>
          (probe.blocked.get(row.kind) ?? 0) <= Date.now() &&
          Date.parse(row.next_attempt_at) <= Date.now() &&
          (!row.lease_until || Date.parse(row.lease_until) <= Date.now())
      )
      if (!eligible.length) {
        console.log(
          JSON.stringify({
            waiting: true,
            remaining: remaining.length,
            providerBackoff: Object.fromEntries(probe.blocked),
          })
        )
        await new Promise((r) => setTimeout(r, 60_000))
        continue
      }
      const queues = boardKinds.map((kind) =>
          eligible.filter((row) => row.kind === kind)
        ),
        candidates = []
      for (let i = 0; candidates.length < limit; i++) {
        let found = false
        for (const queue of queues)
          if (queue[i] && candidates.length < limit) {
            candidates.push(queue[i])
            found = true
          }
        if (!found) break
      }
      const report = await bulkBatch({
        store,
        candidates,
        probe,
        parallelism: workers,
        onProgress: (row) => {
          if (Date.now() - progressAt > 30_000) {
            progressAt = Date.now()
            console.log(
              JSON.stringify({
                inProgress: true,
                last: row.id,
                status: row.status,
                remainingAtBatchStart: remaining.length,
                ...summary,
              })
            )
          }
        },
      })
      await appendFile(
        output + ".batches.jsonl",
        JSON.stringify({ ...report, finishedAt: new Date().toISOString() }) +
          "\n",
        { mode: 0o600 }
      )
      if (report.skipped) {
        console.log(JSON.stringify(report))
        await new Promise((r) => setTimeout(r, 10_000))
        continue
      }
      summary.batches++
      summary.processed += report.processed
      summary.activated += report.activatedSources.length
      for (const [key, count] of Object.entries(report.counts))
        summary.counts[key] = (summary.counts[key] ?? 0) + count
      await writeFile(
        output + ".progress.json",
        JSON.stringify(
          {
            ...summary,
            remainingBeforeBatch: remaining.length,
            latest: report,
            measuredAt: new Date().toISOString(),
          },
          null,
          2
        ),
        { mode: 0o600 }
      )
      console.log(
        JSON.stringify({ ...summary, remainingAtBatchStart: remaining.length })
      )
      transientFailures = 0
    } catch (error) {
      const retryable =
        ["57014", "PGRST000", "PGRST001", "PGRST002", "PGRST003"].includes(
          error?.code
        ) ||
        /upstream request timeout|fetch failed|abort|timed? ?out/i.test(
          String(error?.message ?? "")
        )
      if (!retryable || ++transientFailures > 5) throw error
      console.log(
        JSON.stringify({
          retryingStorage: true,
          consecutiveFailures: transientFailures,
          error: redact(
            error?.message ?? "Storage request unavailable",
            context.env
          ),
        })
      )
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(60_000, transientFailures * 10_000))
      )
    }
  }
} catch (error) {
  summary.error = redact(error?.message ?? "Bulk sweep failed", context.env)
  process.exitCode = 1
}
summary.finishedAt = new Date().toISOString()
await writeFile(output + ".receipt.json", JSON.stringify(summary, null, 2), {
  mode: 0o600,
})
console.log(JSON.stringify(summary, null, 2))
