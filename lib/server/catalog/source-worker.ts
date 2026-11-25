import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { supabaseServerClient } from "../supabase-server"
import { CatalogSourceError, fetchCatalogPage } from "./feeds"
import { jobCategoryIds } from "@/lib/jobs/categories"
import { connectors, type ConnectorKind } from "./connectors"
import { IncompleteAtsInventoryError } from "./connectors/additional-ats"
import {
  hourlyFirecrawlBoards,
  type BoardIndexLead,
} from "./connectors/board-index"
import { archiveCatalogDescriptions } from "./content"
import { retainCatalogObservations } from "./retention"

const deliverySchema = z
  .object({ taskId: z.uuid(), dispatchGeneration: z.number().int().positive() })
  .strict()
const runSchema = z
  .object({
    next_page: z.number().int().positive().nullable(),
    pages: z.number().int().nonnegative(),
    started_at: z.string().optional(),
  })
  .passthrough()
const claimSchema = z.object({
  claimed: z.boolean(),
  reason: z.string().optional(),
  state: z.string().optional(),
  lease_token: z.uuid().nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
})
const workSchema = z.object({
  source: z.object({
    id: z.string(),
    company: z.string(),
    board: z.string().nullable(),
    kind: z.custom<ConnectorKind>(
      (value) => typeof value === "string" && Object.hasOwn(connectors, value),
      "Unknown source connector"
    ),
    config: z.unknown().optional(),
  }),
  run: runSchema,
  records: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  capacity: z.object({
    bytes: z.number().int().nonnegative(),
    budget: z.number().int().positive(),
  }),
})
const releaseSchema = z.object({
  state: z.enum(["pending", "waiting", "failed"]),
  reason: z.string(),
  dispatch_generation: z.number().int().positive(),
  not_before: z.string(),
})
const boardSelectionSchema = z.object({
  mode: z.enum(["full", "incremental"]),
  urls: z.array(z.string()),
})

type Reason =
  | "page_budget"
  | "time_budget"
  | "request_budget"
  | "provider_backoff"
  | "network_error"
  | "invalid_source"
  | "incomplete_inventory"
  | "snapshot_limit"
  | "storage_budget"
  | "worker_error"
class WorkBudget extends Error {
  constructor(readonly reason: "time_budget" | "request_budget") {
    super(reason)
  }
}
class InvalidInventory extends Error {
  constructor(readonly reason: "snapshot_limit" | "storage_budget") {
    super(reason)
  }
}
export type AdvanceReceipt =
  | { taskId: string; status: "completed"; result: Record<string, unknown> }
  | { taskId: string; status: "skipped"; reason: string }
  | {
      taskId: string
      status: "pending" | "waiting" | "failed"
      reason: string
      dispatchGeneration?: number
      retryAt?: string
    }

type WorkerOptions = {
  database?: (signal?: AbortSignal, timeoutMs?: number) => SupabaseClient
  fetch?: typeof fetch
  now?: () => number
  maxPages?: number
  maxTotalPages?: number
  maxMs?: number
  maxRequests?: number
  maxResponseBytes?: number
  maxSnapshotRecords?: number
  maxSnapshotBytes?: number
  publicationTimeoutMs?: number
}

/** Advances one source under a database-enforced single-worker lease. */
export async function advanceCollection(
  delivery: unknown,
  options: WorkerOptions = {}
): Promise<AdvanceReceipt> {
  const { taskId, dispatchGeneration } = deliverySchema.parse(delivery)
  const limits = {
    pages: options.maxPages ?? 3,
    totalPages: options.maxTotalPages ?? 1000,
    ms: options.maxMs ?? 120_000,
    requests: options.maxRequests ?? 24,
    responseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024,
    records: options.maxSnapshotRecords ?? 10_000,
    bytes: options.maxSnapshotBytes ?? 16 * 1024 * 1024,
    publicationMs: options.publicationTimeoutMs ?? 15_000,
  }
  for (const [value, min, max] of [
    [limits.pages, 1, 10],
    [limits.totalPages, 1, 10000],
    [limits.ms, 35_000, 180_000],
    [limits.requests, 1, 100],
    [limits.responseBytes, 1, 15_000_000],
    [limits.records, 1, 100_000],
    [limits.bytes, 1, 64 * 1024 * 1024],
    [limits.publicationMs, 1000, Math.min(60_000, limits.ms - 1000)],
  ])
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error("Invalid source worker limits")
  const now = options.now ?? Date.now,
    deadline = now() + limits.ms
  const signal = AbortSignal.timeout(limits.ms)
  const database =
    options.database ??
    ((signal?: AbortSignal, timeoutMs = 15_000) =>
      supabaseServerClient(timeoutMs, signal))
  const db = database(signal, 15_000)
  const settlementDb = database(undefined, 15_000)
  const publicationDb = database(signal, limits.publicationMs)
  async function rpc(
    name: string,
    args: Record<string, unknown>,
    settle = false
  ): Promise<unknown> {
    const client = settle
      ? settlementDb
      : name === "finish_catalog_source_task"
        ? publicationDb
        : db
    const query = client.rpc(name, args)
    const result = await (settle ? query : query.abortSignal(signal))
    if (result.error) throw result.error
    return result.data
  }
  const claim = claimSchema.parse(
    await rpc("claim_catalog_source_task", {
      p_id: taskId,
      p_generation: dispatchGeneration,
    })
  )
  if (!claim.claimed) {
    if (claim.state === "completed" && claim.result)
      return { taskId, status: "completed", result: claim.result }
    if (claim.state === "failed")
      return {
        taskId,
        status: "failed",
        reason: String(claim.result?.reason ?? "worker_error"),
      }
    return { taskId, status: "skipped", reason: claim.reason ?? "unavailable" }
  }
  if (!claim.lease_token)
    throw new Error("Source worker claim has no attempt token")
  const token = claim.lease_token
  let phase: "storage" | "fetch" | "checkpoint" | "publish" = "storage"
  let requests = 0,
    uncommittedRequests = 0,
    pages = 0,
    releasing = false
  async function release(
    mode: "continue" | "retry" | "failed",
    reason: Reason,
    retryAt: string | null = null
  ): Promise<AdvanceReceipt> {
    releasing = true
    const result = releaseSchema.parse(
      await rpc(
        "release_catalog_source_work",
        {
          p_id: taskId,
          p_token: token,
          p_mode: mode,
          p_reason: reason,
          p_requests: uncommittedRequests,
          p_retry_at: retryAt,
        },
        true
      )
    )
    console.info("Source worker released", {
      taskId,
      state: result.state,
      reason,
      pages,
    })
    return {
      taskId,
      status: result.state,
      reason: result.reason,
      dispatchGeneration: result.dispatch_generation,
      retryAt: result.not_before,
    }
  }
  try {
    const work = workSchema.parse(
      await rpc("read_catalog_source_work", { p_id: taskId, p_token: token })
    )
    const configuredBudget = Number(
      process.env.CATALOG_DATABASE_BUDGET_BYTES ?? work.capacity.budget
    )
    if (
      !Number.isSafeInteger(configuredBudget) ||
      configuredBudget < 50 * 1024 * 1024
    )
      throw new Error("Invalid catalogue database budget")
    if (work.capacity.bytes >= Math.min(work.capacity.budget, configuredBudget))
      throw new InvalidInventory("storage_budget")
    if (work.records > limits.records || work.bytes > limits.bytes)
      throw new InvalidInventory("snapshot_limit")
    const trackIndex =
      work.source.kind === "indiaboard" &&
      hourlyFirecrawlBoards.some(
        (board) => work.source.id === `indiaboard:${board}`
      )
    async function selectBoardUrls(leads: readonly BoardIndexLead[]) {
      const result = boardSelectionSchema.parse(
        await rpc("catalog_board_details_to_check", {
          p_id: taskId,
          p_token: token,
          p_leads: leads,
        })
      )
      return new Set(result.urls)
    }
    if (trackIndex) await selectBoardUrls([])
    let page = work.run.next_page,
      totalPages = work.run.pages
    while (
      page !== null &&
      pages < limits.pages &&
      totalPages < limits.totalPages &&
      requests < limits.requests &&
      now() < deadline - 30_000
    ) {
      phase = "fetch"
      const pageSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, deadline - now() - 30_000)),
      ])
      const checked: BoardIndexLead[] = []
      const snapshot = await fetchCatalogPage(work.source, page, {
        jobCategories: jobCategoryIds,
        fetch: options.fetch,
        snapshotStartedAt: work.run.started_at,
        signal: pageSignal,
        maxResponseBytes: limits.responseBytes,
        ...(trackIndex
          ? {
              boardIndexRefresh: {
                select: selectBoardUrls,
                checked({ url, fingerprint }) {
                  checked.push({ url, fingerprint })
                },
              },
            }
          : {}),
        onRequest() {
          if (now() >= deadline - 30_000) throw new WorkBudget("time_budget")
          if (requests >= limits.requests)
            throw new WorkBudget("request_budget")
          requests++
          uncommittedRequests++
        },
      })
      phase = "storage"
      if (
        snapshot.jobs.length > limits.records ||
        Buffer.byteLength(JSON.stringify(snapshot.jobs)) > limits.bytes
      )
        throw new InvalidInventory("snapshot_limit")
      const retained = await retainCatalogObservations(db, snapshot.jobs)
      const stored =
        process.env.CATALOG_CONTENT_ENABLED === "true"
          ? await archiveCatalogDescriptions(db, retained)
          : retained
      phase = "checkpoint"
      const committed = runSchema.parse(
        await rpc(
          trackIndex
            ? "checkpoint_catalog_board_source_work"
            : "checkpoint_catalog_source_work",
          {
            p_id: taskId,
            p_token: token,
            p_page: page,
            p_next: snapshot.nextPage,
            p_jobs: stored,
            p_fetched: snapshot.fetched,
            p_rejected: snapshot.rejected,
            p_requests: uncommittedRequests,
            p_max_records: limits.records,
            p_max_bytes: limits.bytes,
            p_max_pages: limits.totalPages,
            ...(trackIndex ? { p_checked: checked } : {}),
          }
        )
      )
      uncommittedRequests = 0
      pages++
      page = committed.next_page
      totalPages = committed.pages
      phase = "storage"
    }
    if (page !== null && totalPages >= limits.totalPages)
      throw new InvalidInventory("snapshot_limit")
    // Publication is atomic and can be larger than a page write. Give it its
    // full bounded request budget, or hand the complete snapshot to a new step.
    if (page === null && now() < deadline - limits.publicationMs) {
      phase = "publish"
      const result = z.record(z.string(), z.unknown()).parse(
        await rpc("finish_catalog_source_task", {
          p_id: taskId,
          p_token: token,
        })
      )
      console.info("Source worker completed", { taskId, pages })
      return { taskId, status: "completed", result }
    }
    const reason =
      page === null || now() >= deadline - 30_000
        ? "time_budget"
        : requests >= limits.requests
          ? "request_budget"
          : "page_budget"
    return await release(
      pages > 0 || page === null ? "continue" : "retry",
      reason
    )
  } catch (error) {
    // A lost RPC acknowledgment may hide a committed checkpoint/publication.
    // Leave its lease intact; recovery must read the database's actual cursor.
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : ""
    if (releasing || phase === "checkpoint" || phase === "publish") {
      // PostgreSQL confirms these transactions rolled back. Keep the last
      // committed cursor, but release the lease into bounded retry/backoff.
      // A transport error can hide a commit and must retain its lease instead.
      if (!releasing && ["57014", "40001", "40P01"].includes(String(code)))
        return release("retry", "worker_error")
      if (
        !releasing &&
        code === "P0001" &&
        /snapshot limit|storage budget/.test(message)
      ) {
        return release(
          "failed",
          /snapshot limit/.test(message) ? "snapshot_limit" : "storage_budget"
        )
      }
      throw error
    }
    if (error instanceof InvalidInventory)
      return release("failed", error.reason)
    if (
      error instanceof WorkBudget ||
      signal.aborted ||
      now() >= deadline - 30_000
    )
      return release(
        pages > 0 ? "continue" : "retry",
        error instanceof WorkBudget ? error.reason : "time_budget"
      )
    if (phase === "storage") {
      if (/storage budget/.test(message))
        return release("failed", "storage_budget")
      throw error
    }
    if (error instanceof CatalogSourceError)
      return release(
        /^Source HTTP (401|403|404|410)$/.test(error.message)
          ? "failed"
          : "retry",
        "provider_backoff",
        error.retryAt
      )
    if (error instanceof IncompleteAtsInventoryError)
      return release("failed", "incomplete_inventory")
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      /Invalid .*pagination|Invalid employer board|Source exceeded size limit|Source returned no body/.test(
        message
      )
    )
      return release("failed", "invalid_source")
    // Unclassified failures retry as network errors; keep the cause visible.
    console.warn("Source worker network error", {
      taskId,
      error: error instanceof Error ? error.name : typeof error,
      message: message.slice(0, 200),
    })
    return release("retry", "network_error")
  }
}
