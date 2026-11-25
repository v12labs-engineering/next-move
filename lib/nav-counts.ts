import { useEffect, useSyncExternalStore } from "react"
import type { RunGroup } from "@/lib/applications/activity"

export type NavCounts = { jobs?: number; applications?: number }

const KEY = "nav-counts"
const STALE_MS = 60_000
const empty: NavCounts = {}
let counts: NavCounts | null = null
let applicationsFetchedAt = 0
const listeners = new Set<() => void>()

function current() {
  if (counts) return counts
  try {
    counts = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as NavCounts
  } catch {
    counts = {}
  }
  return counts
}

export function publishNavCounts(next: NavCounts) {
  const merged = { ...current(), ...next }
  if (
    merged.jobs === counts?.jobs &&
    merged.applications === counts?.applications
  )
    return
  counts = merged
  try {
    sessionStorage.setItem(KEY, JSON.stringify(merged))
  } catch {}
  listeners.forEach((listener) => listener())
}

export type { RunGroup } from "@/lib/applications/activity"

export function runGroup(status: string): RunGroup {
  if (["ready", "needs_attention", "submission_unknown"].includes(status))
    return "needs"
  if (status === "submitted") return "submitted"
  if (status === "cancelled") return "cancelled"
  if (status === "queued_prepare" || status === "queued") return "queue"
  return "flight"
}

export function applicationsNeedingYou(runs: { status: string }[]) {
  return runs.filter((run) => runGroup(run.status) === "needs").length
}

/** Badge counts for the sidebar; applications refresh cheaply, jobs come from the Jobs page. */
export function useNavCounts() {
  useEffect(() => {
    if (Date.now() - applicationsFetchedAt < STALE_MS) return
    applicationsFetchedAt = Date.now()
    fetch("/api/applications")
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            counts?: { needs: number }
            applications?: { status: string }[]
          } | null
        ) => {
          if (data?.applications)
            publishNavCounts({
              applications:
                data.counts?.needs ?? applicationsNeedingYou(data.applications),
            })
        }
      )
      .catch(() => {})
  }, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    current,
    () => empty
  )
}
