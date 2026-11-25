import { readFile, writeFile } from "node:fs/promises"
import {
  archiveCatalogDescriptions,
  type DescriptionRef,
} from "../../lib/server/catalog/content"
import { supabaseServerClient } from "../../lib/server/supabase-server"
import { stagingContext } from "../lib/staging.mjs"

if (
  !process.argv.includes("--apply") ||
  !process.argv.includes("--readers-ready")
)
  throw new Error(
    "Use --apply --readers-ready only after the deployed app can read description references"
  )
const { env } = await stagingContext()
Object.assign(process.env, env)
const db = supabaseServerClient(30000)
const report = {
  startedAt: new Date().toISOString(),
  batches: 0,
  archivedRows: 0,
  verifiedOriginalBytes: 0,
  complete: false,
  latestDatabaseBytes: 0,
}
try {
  const previous = JSON.parse(
    await readFile(".local-data/catalog-description-backfill.json", "utf8")
  )
  if (!previous.complete) {
    report.startedAt = previous.startedAt
    report.batches = previous.batches
    report.archivedRows = previous.archivedRows
    report.verifiedOriginalBytes = previous.verifiedOriginalBytes
  }
} catch {
  /* First run has no progress journal. */
}
const deadline = Date.now() + 30 * 60000
let journal: Promise<unknown> = Promise.resolve()
const retry = async <T,>(
  operation: () => PromiseLike<{
    data: T
    error: { code?: string; message: string } | null
  }>
) => {
  for (let attempt = 0; ; attempt++) {
    const result = await operation()
    if (!result.error || result.error.code !== "57014" || attempt >= 2)
      return result
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
}
const save = () => {
  const snapshot = JSON.stringify(
    { ...report, updatedAt: new Date().toISOString() },
    null,
    2
  )
  journal = journal.then(() =>
    writeFile(".local-data/catalog-description-backfill.json", snapshot, {
      mode: 0o600,
    })
  )
  return journal
}
async function archive(rows: { id: string; description: string }[]) {
  const archived = await archiveCatalogDescriptions(db, rows)
  if (archived.some((row) => row.description || !row.description_ref))
    throw new Error(
      "Every archived description must be verified before attachment"
    )
  const references = archived.map((row) => ({
    id: row.id,
    description_ref: row.description_ref as DescriptionRef,
  }))
  let attachedRows = 0
  // Public packs remain efficient, while each database transaction stays small.
  for (let start = 0; start < references.length; start += 16) {
    const attached = await retry(() =>
      db.rpc("attach_catalog_description_refs", {
        p_rows: references.slice(start, start + 16),
      })
    )
    if (attached.error)
      throw new Error("archive attachment: " + attached.error.message)
    attachedRows += Number(attached.data)
  }
  report.batches++
  report.archivedRows += attachedRows
  report.verifiedOriginalBytes += rows.reduce(
    (sum, row) => sum + Buffer.byteLength(row.description),
    0
  )
  await save()
  console.log(
    JSON.stringify({
      batches: report.batches,
      archived: report.archivedRows,
      databaseBytes: report.latestDatabaseBytes,
    })
  )
}
const active = new Set<Promise<void>>()
let after: string | null = null,
  failure: unknown
try {
  while (Date.now() < deadline && !failure) {
    if (active.size >= 6) {
      await Promise.race(active)
      continue
    }
    const usage = await retry(() => db.rpc("catalog_storage_usage"))
    if (usage.error) throw new Error("archive usage: " + usage.error.message)
    report.latestDatabaseBytes = Number(
      (usage.data as { database_bytes: number }).database_bytes
    )
    if (report.latestDatabaseBytes > 450 * 1024 * 1024)
      throw new Error(
        "Backfill maintenance headroom reached; compact before resuming"
      )
    const batch = await retry(() =>
      db.rpc("archive_catalog_description_batch", {
        p_limit: 256,
        p_after: after,
      })
    )
    if (batch.error)
      throw new Error("archive batch read: " + batch.error.message)
    const rows = batch.data as { id: string; description: string }[]
    if (!rows.length) {
      await Promise.all(active)
      if (failure) break
      const remaining = await retry(() =>
        db.rpc("archive_catalog_description_batch", {
          p_limit: 1,
        })
      )
      if (remaining.error) throw remaining.error
      if (!(remaining.data as unknown[]).length) {
        report.complete = true
        break
      }
      after = null
      continue
    }
    after = rows.at(-1)!.id
    const task = archive(rows)
      .catch((error) => {
        failure = error
      })
      .finally(() => {
        active.delete(task)
      })
    active.add(task)
  }
} catch (error) {
  failure = error
}
await Promise.all(active)
await journal
await writeFile(
  ".local-data/catalog-description-backfill.json",
  JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2),
  { mode: 0o600 }
)
if (!report.complete) process.exitCode = 1
if (failure) throw failure
