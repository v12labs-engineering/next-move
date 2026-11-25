import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseServerClient } from "../../supabase-server"
import { readCatalogCapacity } from "../health"
import {
  ArchiveHttpError,
  discoverArchivePage,
  latestArchiveIndex,
} from "./archive"

const claimSchema = z.object({
  claimed: z.boolean(),
  reason: z.string().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  id: z.uuid().optional(),
  token: z.uuid().optional(),
  partition: z.string().optional(),
  index: z.string().nullable().optional(),
  page: z.number().int().nonnegative().optional(),
  completedIndex: z.string().nullable().optional(),
})

/** One admitted archive block, not a job collector. SQL owns leases, daily
 * request admission, atomic imports and continuation across scheduled runs. */
export async function runScheduledArchive(options: {
  requestKey: string
  env?: Partial<NodeJS.ProcessEnv>
  database?: SupabaseClient
  fetch?: typeof fetch
}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env
  if (env.AUTOMATIC_DISCOVERY_ENABLED !== "true") return { status: "disabled" }
  if (env.APP_ENV !== "staging")
    return { status: "skipped", reason: "staging_only" }
  const db = options.database ?? supabaseServerClient(30_000)
  const capacity = await readCatalogCapacity(db)
  if (capacity.bytes + 16 * 1024 * 1024 >= capacity.limit)
    return { status: "skipped", reason: "storage_budget" }
  async function rpc(name: string, args: Record<string, unknown>) {
    const response = await db.rpc(name, args)
    if (response.error)
      throw new Error(`Archive discovery storage operation failed: ${name}`)
    return response.data as unknown
  }
  const claim = claimSchema.parse(
    await rpc("claim_archive_discovery", { p_request_key: options.requestKey })
  )
  if (!claim.claimed)
    return claim.result ?? { status: "skipped", reason: claim.reason }
  if (!claim.id || !claim.token || !claim.partition || claim.page === undefined)
    throw new Error("Archive claim omitted its fence")
  const base = { p_run: claim.id, p_token: claim.token }
  try {
    const index = claim.index ?? (await latestArchiveIndex(options.fetch))
    if (!claim.index && index === claim.completedIndex)
      return (await rpc("finish_archive_discovery", {
        ...base,
        p_status: "unchanged",
        p_page: { index },
      })) as Record<string, unknown>
    const page = await discoverArchivePage(
      { index, partition: claim.partition, page: claim.page },
      { fetch: options.fetch }
    )
    return (await rpc("finish_archive_discovery", {
      ...base,
      p_status: "completed",
      p_page: page,
    })) as Record<string, unknown>
  } catch (error) {
    const status = error instanceof ArchiveHttpError ? error.status : null
    return (await rpc("finish_archive_discovery", {
      ...base,
      p_status: "failed",
      p_error: status ? `provider_http_${status}` : "archive_interrupted",
      p_retry_at:
        status === 429
          ? ((error as ArchiveHttpError).retryAt ??
            new Date(Date.now() + 3600000).toISOString())
          : null,
    })) as Record<string, unknown>
  }
}
