import type { CollectionRun } from "@/lib/server/sponsor-sources/types"
import {
  isMissingTable,
  supabaseServerClient,
} from "@/lib/server/supabase-server"

const memoryRuns = new Map<string, CollectionRun>()

export async function saveRun(run: CollectionRun): Promise<void> {
  const supabase = supabaseServerClient()
  const { error } = await supabase.from("collection_runs").upsert({
    run_id: run.runId,
    source_id: run.sourceId,
    country: run.country,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? null,
    ok: run.ok,
    error: run.error ?? null,
    progress: run.progress,
    payload: run.payload ?? null,
    updated_at: new Date().toISOString(),
  })

  if (error) {
    if (!isMissingTable(error)) throw error
    memoryRuns.set(run.sourceId, run)
    return
  }

  memoryRuns.delete(run.sourceId)
}

export async function getRunBySource(
  sourceId: string
): Promise<CollectionRun | null> {
  const supabase = supabaseServerClient()
  const { data, error } = await supabase
    .from("collection_runs")
    .select(
      "run_id, source_id, country, started_at, finished_at, ok, error, progress, payload"
    )
    .eq("source_id", sourceId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    if (!isMissingTable(error)) throw error
    return memoryRuns.get(sourceId) ?? null
  }

  return data ? runFromRow(data) : (memoryRuns.get(sourceId) ?? null)
}

export async function getRunById(runId: string): Promise<CollectionRun | null> {
  const supabase = supabaseServerClient()
  const { data, error } = await supabase
    .from("collection_runs")
    .select(
      "run_id, source_id, country, started_at, finished_at, ok, error, progress, payload"
    )
    .eq("run_id", runId)
    .maybeSingle()

  if (error) {
    if (!isMissingTable(error)) throw error
    return [...memoryRuns.values()].find((run) => run.runId === runId) ?? null
  }

  return data
    ? runFromRow(data)
    : ([...memoryRuns.values()].find((run) => run.runId === runId) ?? null)
}

export async function listRuns(): Promise<CollectionRun[]> {
  const supabase = supabaseServerClient()
  const { data, error } = await supabase
    .from("collection_runs")
    .select(
      "run_id, source_id, country, started_at, finished_at, ok, error, progress, payload"
    )
    .order("updated_at", { ascending: false })

  if (error) {
    if (!isMissingTable(error)) throw error
    return [...memoryRuns.values()]
  }

  return (data ?? []).map(runFromRow)
}

function runFromRow(row: {
  run_id: string
  source_id: string
  country: CollectionRun["country"]
  started_at: string
  finished_at: string | null
  ok: boolean
  error: string | null
  progress: CollectionRun["progress"]
  payload: CollectionRun["payload"] | null
}): CollectionRun {
  return {
    runId: row.run_id,
    sourceId: row.source_id,
    country: row.country,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    ok: row.ok,
    error: row.error ?? undefined,
    progress: row.progress,
    payload: row.payload ?? undefined,
  }
}
