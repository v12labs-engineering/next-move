import type { SupabaseClient } from "@supabase/supabase-js"
import { CATALOG_CONTENT_BUCKET } from "./content"

/** Avoid archiving expired new observations; existing history can still refresh. */
export async function retainCatalogObservations<
  T extends { id: string; posted_at: string | null },
>(db: SupabaseClient, jobs: T[], now = new Date()) {
  const cutoff = now.getTime() - 30 * 86400000
  const expired = jobs.filter(
    (job) => job.posted_at && Date.parse(job.posted_at) < cutoff
  )
  if (!expired.length) return jobs
  const existing = new Set<string>()
  for (let offset = 0; offset < expired.length; offset += 200) {
    const result = await db
      .from("job_catalog")
      .select("id")
      .in(
        "id",
        expired.slice(offset, offset + 200).map((job) => job.id)
      )
    if (result.error) throw result.error
    for (const row of result.data) existing.add(row.id)
  }
  const expiredIds = new Set(expired.map((job) => job.id))
  return jobs.filter((job) => !expiredIds.has(job.id) || existing.has(job.id))
}

/** Bounded, retryable maintenance. Only confirmed removals count as reclaimed. */
export async function cleanupCatalog(
  db: SupabaseClient,
  options: { maxBatches?: number; maxMs?: number; packBatches?: number } = {}
) {
  const maxBatches = options.maxBatches ?? 8
  const packBatches = options.packBatches ?? 4
  const maxMs = options.maxMs ?? 20_000
  if (
    ![maxBatches, packBatches, maxMs].every(
      (n) => Number.isSafeInteger(n) && n > 0
    )
  )
    throw new Error("Invalid cleanup limits")
  const deadline = Date.now() + maxMs
  let deletedJobs = 0,
    deletedPacks = 0,
    deletedObjectBytes = 0,
    moreJobs = true,
    morePacks = true,
    busy = false
  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch++) {
    const result = await db.rpc("cleanup_catalog_jobs", { p_limit: 500 })
    if (result.error) throw result.error
    deletedJobs += result.data.deleted
    moreJobs = result.data.more
    busy = result.data.busy
    if (!moreJobs || busy) break
  }
  for (let batch = 0; batch < packBatches && Date.now() < deadline; batch++) {
    const claimed = await db.rpc("claim_catalog_content_cleanup", {
      p_limit: 32,
    })
    if (claimed.error) throw claimed.error
    const packs = claimed.data as { id: string; bytes: number; token: string }[]
    morePacks = packs.length === 32
    if (!packs.length) break
    const removed = await db.storage
      .from(CATALOG_CONTENT_BUCKET)
      .remove(packs.map((pack) => `v1/${pack.id}.bin`))
    if (removed.error) throw removed.error
    const finished = await db.rpc("finish_catalog_content_cleanup", {
      p_ids: packs.map((pack) => pack.id),
      p_token: packs[0].token,
    })
    if (finished.error) throw finished.error
    if (finished.data !== packs.length)
      throw new Error("Content cleanup acknowledgement differs")
    deletedPacks += packs.length
    deletedObjectBytes += packs.reduce((sum, pack) => sum + pack.bytes, 0)
    if (!morePacks) break
  }
  return {
    deletedJobs,
    deletedPacks,
    deletedObjectBytes,
    moreJobs,
    morePacks,
    busy,
  }
}
