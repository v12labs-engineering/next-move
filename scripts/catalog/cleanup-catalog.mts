import { writeFile } from "node:fs/promises"
import { cleanupCatalog } from "../../lib/server/catalog/retention"
import { supabaseServerClient } from "../../lib/server/supabase-server"
import { verifiedContext } from "../lib/staging.mjs"

if (!process.argv.includes("--apply") || !process.argv.includes("--staging"))
  throw new Error(
    "Use --staging --apply to clean the verified isolated staging catalogue"
  )
const { env } = await verifiedContext()
Object.assign(process.env, env)
const db = supabaseServerClient(30_000)
const report = {
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  complete: false,
  deletedJobs: 0,
  deletedPacks: 0,
  deletedObjectBytes: 0,
  databaseBytesBefore: 0,
  databaseBytesAfter: 0,
  batches: [] as Awaited<ReturnType<typeof cleanupCatalog>>[],
}
const usage = await db.rpc("catalog_storage_usage")
if (usage.error) throw usage.error
report.databaseBytesBefore = Number(usage.data.database_bytes)
const deadline = Date.now() + 10 * 60_000
try {
  while (Date.now() < deadline) {
    const batch = await cleanupCatalog(db, {
      maxBatches: 8,
      packBatches: 4,
      maxMs: 30_000,
    })
    report.batches.push(batch)
    report.deletedJobs += batch.deletedJobs
    report.deletedPacks += batch.deletedPacks
    report.deletedObjectBytes += batch.deletedObjectBytes
    console.log(JSON.stringify(batch))
    await writeFile(
      ".local-data/catalog-retention-receipt.json",
      JSON.stringify(report, null, 2),
      { mode: 0o600 }
    )
    if (!batch.moreJobs && !batch.morePacks) {
      report.complete = true
      break
    }
    if (batch.busy)
      throw new Error("Another cleanup owns the lease; retry later")
  }
  const after = await db.rpc("catalog_storage_usage")
  if (after.error) throw after.error
  report.databaseBytesAfter = Number(after.data.database_bytes)
  report.completedAt = new Date().toISOString()
} finally {
  await writeFile(
    ".local-data/catalog-retention-receipt.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 }
  )
}
if (!report.complete)
  throw new Error(
    "Cleanup reached its time budget; committed batches are safe to resume"
  )
console.log(JSON.stringify(report, null, 2))
