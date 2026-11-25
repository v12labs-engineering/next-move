import { NextResponse } from "next/server"
import { requireOperator } from "@/lib/server/operator"
import { apiError } from "@/lib/server/http"

import { adapterForSourceId } from "@/lib/server/sponsor-sources/adapters"
import {
  listSavedCompanyIdsForSource,
  saveImportPayload,
} from "@/lib/server/app-state-store"
import { runSponsorCollection } from "@/lib/server/sponsor-sources/pipeline"
import {
  getRunBySource,
  getRunById,
  listRuns,
  saveRun,
} from "@/lib/server/sponsor-sources/run-store"
import type { CollectionRun } from "@/lib/server/sponsor-sources/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Live scrape + careers crawl can run for several minutes.
export const maxDuration = 300

/** GET ?sourceId=… or ?runId=… → current run status (+payload when done). */
export async function GET(request: Request) {
  try {
    requireOperator(request)
  } catch (error) {
    return apiError(error)
  }
  const url = new URL(request.url)
  const runId = url.searchParams.get("runId")
  const sourceId = url.searchParams.get("sourceId")

  if (!runId && !sourceId) {
    const runs = await listRuns()
    return NextResponse.json({ ok: true, runs })
  }

  const run = runId
    ? await getRunById(runId)
    : sourceId
      ? await getRunBySource(sourceId)
      : null

  if (!run) {
    return NextResponse.json(
      { ok: false, error: "No run found" },
      { status: 404 }
    )
  }
  return NextResponse.json({ ok: true, run })
}

/** POST { sourceId, maxEnrich? } → starts an async collection run. */
export async function POST(request: Request) {
  try {
    requireOperator(request)
  } catch (error) {
    return apiError(error)
  }
  const body = (await request.json().catch(() => ({}))) as {
    sourceId?: string
    maxEnrich?: number
    jobsPerCompany?: number
  }
  const sourceId = body.sourceId ?? ""
  const adapter = adapterForSourceId(sourceId)
  if (!adapter) {
    return NextResponse.json(
      { ok: false, error: "Unknown sponsor source" },
      { status: 404 }
    )
  }

  // One run per source at a time.
  const existing = await getRunBySource(sourceId)
  if (existing && !existing.finishedAt) {
    return NextResponse.json({ ok: true, run: existing, alreadyRunning: true })
  }

  const runId = `run-${sourceId}-${Date.now()}`
  const run: CollectionRun = {
    runId,
    country: adapter.meta.country,
    sourceId,
    startedAt: new Date().toISOString(),
    ok: false,
    progress: {
      phase: "fetching_source",
      seedsFound: 0,
      softwareSeeds: 0,
      companiesEnriched: 0,
      jobsFound: 0,
      message: "Starting…",
    },
  }
  await saveRun(run)

  // Operator request awaits the run. Customer requests never trigger ingestion.
  const skipCompanyIds =
    existing?.finishedAt && !existing.ok
      ? await listSavedCompanyIdsForSource(adapter.meta.sourceName)
      : undefined

  await executeRun(run, {
    maxEnrich: body.maxEnrich,
    jobsPerCompany: body.jobsPerCompany,
    skipCompanyIds,
  })

  return NextResponse.json({ ok: true, run })
}

async function executeRun(
  run: CollectionRun,
  opts: {
    maxEnrich?: number
    jobsPerCompany?: number
    skipCompanyIds?: ReadonlySet<string>
  }
): Promise<void> {
  let checkpointSave = Promise.resolve()
  try {
    const payload = await runSponsorCollection(run.sourceId, {
      maxEnrich: opts.maxEnrich,
      jobsPerCompany: opts.jobsPerCompany,
      skipCompanyIds: opts.skipCompanyIds,
      onProgress: (progress) => {
        run.progress = progress
        void saveRun({ ...run })
      },
      onCheckpoint: (payload) => {
        checkpointSave = checkpointSave.then(() => saveImportPayload(payload))
        return checkpointSave
      },
    })
    await checkpointSave
    run.payload = payload
    await saveRun({ ...run })
    await saveImportPayload(payload)
    run.ok = true
    run.finishedAt = new Date().toISOString()
    run.progress = { ...run.progress, phase: "done" }
    await saveRun({ ...run })
  } catch (error) {
    run.ok = false
    run.error = describeError(error)
    run.finishedAt = new Date().toISOString()
    run.progress = { ...run.progress, phase: "error", message: run.error }
    await saveRun({ ...run })
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const e = error as {
      message?: string
      code?: string
      details?: string
      hint?: string
    }
    return (
      [e.message, e.details, e.hint, e.code && `(code ${e.code})`]
        .filter(Boolean)
        .join(" — ") || JSON.stringify(error)
    )
  }
  return "Collection failed"
}
