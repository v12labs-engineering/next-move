"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronRight, Eye, Inbox, Send, Sparkles, X } from "lucide-react"

import { AppShell } from "@/components/shell/app-shell"
import { RunStatus } from "@/components/applications/application-review"
import { ApplicationFollowup } from "@/components/applications/application-followup"
import { JobRow } from "@/components/jobs/job-row"
import { Button } from "@/components/ui/button"
import { FacetFilter } from "@/components/ui/facet-filter"
import { SkeletonRows } from "@/components/ui/skeleton-rows"
import { CompanyMark } from "@/components/jobs/company-mark"
import { cn } from "@/lib/utils"
import { ResumeDrafts, type ResumeDraftRow } from "@/components/resume/resume-drafts"
import { publishNavCounts, type RunGroup } from "@/lib/nav-counts"
import {
  emptyApplicationCounts,
  type ApplicationCounts,
} from "@/lib/applications/activity"
import { relativeTime } from "@/lib/utils"
import type { Job, JobStatus, SimpleAppState } from "@/lib/jobs"

type StatusFilter = RunGroup | "all" | "applied" | "dismissed"

const isRunGroup = (value: StatusFilter): value is RunGroup =>
  value !== "all" && value !== "applied" && value !== "dismissed"

type Run = {
  id: string
  title: string
  company: string
  status: string
  updated_at?: string
}

const sectionLabel = "text-sm font-semibold tracking-tight"

const progressSteps = [
  "In queue",
  "Prepare",
  "Answers",
  "Submit",
  "Confirmed",
] as const

function runProgress(status: string): {
  step: number
  tone: "active" | "waiting" | "attention" | "done" | "muted"
} {
  if (status === "queued_prepare") return { step: 0, tone: "waiting" }
  if (status === "preparing") return { step: 1, tone: "active" }
  if (status === "ready" || status === "needs_attention")
    return { step: 2, tone: "attention" }
  if (status === "queued") return { step: 3, tone: "waiting" }
  if (status === "running" || status === "submitting")
    return { step: 3, tone: "active" }
  if (status === "submitted") return { step: 4, tone: "done" }
  if (status === "submission_unknown") return { step: 4, tone: "attention" }
  return { step: 0, tone: "muted" }
}

function RunProgress({ status }: { status: string }) {
  const { step, tone } = runProgress(status)
  return (
    <span
      role="img"
      aria-label={
        tone === "muted"
          ? "Stopped"
          : `Step ${step + 1} of ${progressSteps.length}: ${status === "submission_unknown" ? "Ready to retry" : progressSteps[step]}`
      }
      className="grid w-full max-w-40 grid-cols-5 gap-1"
    >
      {progressSteps.map((label, index) => (
        <span
          key={label}
          className={cn(
            "h-1 rounded-full bg-muted",
            tone === "done" && "bg-emerald-500/80",
            tone !== "done" &&
              tone !== "muted" &&
              index < step &&
              "bg-emerald-500/60",
            index === step &&
              tone === "active" &&
              "bg-primary motion-safe:animate-pulse",
            index === step && tone === "attention" && "bg-amber-500",
            tone === "muted" && "bg-muted-foreground/15",
            tone === "waiting" && index === step && "bg-muted-foreground/50"
          )}
        />
      ))}
    </span>
  )
}

export function ApplicationsPage({
  drafts,
  initialView,
  manualFollowupJobs,
}: {
  drafts: ResumeDraftRow[]
  initialView: "pipeline" | "drafts"
  manualFollowupJobs: Job[]
}) {
  const router = useRouter()
  const [view, setView] = useState(initialView)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [state, setState] = useState<SimpleAppState>({
    jobs: [],
    trackedCountries: [],
  })
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [statusPending, setStatusPending] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [runCounts, setRunCounts] = useState<ApplicationCounts>(
    emptyApplicationCounts
  )
  const [runPage, setRunPage] = useState(0)
  const [runsLoading, setRunsLoading] = useState(true)
  const [runsError, setRunsError] = useState("")

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function loadSaved() {
      try {
        const stale = await refreshState((next) => {
          if (active) setState(next)
        })
        if (active && stale) timer = setTimeout(loadSaved, 10000)
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Could not load applications."
          )
          timer = setTimeout(loadSaved, 30000)
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadSaved()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])

  const runFilter: RunGroup | "all" = isRunGroup(statusFilter)
    ? statusFilter
    : "all"
  const showRuns = statusFilter === "all" || isRunGroup(statusFilter)
  const showOutcomes = !isRunGroup(statusFilter)

  useEffect(() => {
    let active = true
    let loading = false
    const loadRuns = async () => {
      if (loading || document.visibilityState === "hidden") return
      loading = true
      try {
        const params = new URLSearchParams({
          filter: runFilter,
          offset: String(runPage * 50),
          limit: "50",
        })
        const response = await fetch(`/api/applications?${params}`, {
          cache: "no-store",
        })
        const data = await response.json()
        if (!response.ok)
          throw new Error(data.error || "Could not load applications.")
        if (active) {
          setRuns(data.applications)
          setRunCounts(data.counts)
          setRunsError("")
          publishNavCounts({ applications: data.counts.needs })
          // Live status changes can remove the last page of a filter.
          if (runPage && runPage * 50 >= data.total)
            setRunPage(Math.max(0, Math.ceil(data.total / 50) - 1))
        }
      } catch (error) {
        if (active)
          setRunsError(
            error instanceof Error
              ? error.message
              : "Could not load applications."
          )
      } finally {
        loading = false
        if (active) setRunsLoading(false)
      }
    }
    void loadRuns()
    const refresh = () => {
      void loadRuns()
    }
    const timer = setInterval(refresh, 5000)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("application-questions-changed", refresh)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener("application-questions-changed", refresh)
    }
  }, [runFilter, runPage])

  const followupOrder = useMemo(
    () => new Map(manualFollowupJobs.map((job, index) => [job.id, index])),
    [manualFollowupJobs]
  )
  const trackedJobs = useMemo(() => {
    const jobs = new Map(state.jobs.map((job) => [job.id, job]))
    // Recent tracker entries can exist before a matching generation includes them.
    for (const job of manualFollowupJobs)
      if (!jobs.has(job.id)) jobs.set(job.id, job)
    return [...jobs.values()]
  }, [state.jobs, manualFollowupJobs])

  async function setStatus(id: string, status: JobStatus) {
    if (statusPending) return
    const job = trackedJobs.find((job) => job.id === id)
    if (!job) return
    setStatusPending(true)
    setState({
      ...state,
      jobs: state.jobs.some((entry) => entry.id === id)
        ? state.jobs.map((entry) =>
            entry.id === id ? { ...entry, status } : entry
          )
        : [...state.jobs, { ...job, status }],
    })

    try {
      const res = await fetch("/api/state/job-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      })
      if (!res.ok)
        throw new Error("Could not save this status. Please try again.")
      if (status === "applied" || followupOrder.has(id)) router.refresh()
    } catch (err) {
      setState((current) => ({
        ...current,
        jobs: current.jobs.map((entry) =>
          entry.id === id ? { ...entry, status: job.status } : entry
        ),
      }))
      setError(err instanceof Error ? err.message : "Could not save.")
    } finally {
      setStatusPending(false)
    }
  }

  const archivedJobs = useMemo(() => {
    return trackedJobs
      .filter(
        (job) =>
          (job.status === "applied" || job.status === "dismissed") &&
          !isRunGroup(statusFilter) &&
          (statusFilter === "all" || job.status === statusFilter)
      )
      .sort((a, b) => {
        if (statusFilter === "applied") {
          const recent =
            (followupOrder.get(a.id) ?? followupOrder.size) -
            (followupOrder.get(b.id) ?? followupOrder.size)
          if (recent) return recent
        }
        const aSeen = new Date(a.seenAt).getTime()
        const bSeen = new Date(b.seenAt).getTime()
        return (
          (Number.isNaN(bSeen) ? 0 : bSeen) - (Number.isNaN(aSeen) ? 0 : aSeen)
        )
      })
  }, [trackedJobs, followupOrder, statusFilter])

  const appliedCount = trackedJobs.filter(
    (job) => job.status === "applied"
  ).length
  const rejectedCount = trackedJobs.filter(
    (job) => job.status === "dismissed"
  ).length
  const inFlight = runCounts.flight
  const visibleRuns = runs
  const needsYou = runCounts.needs
  const filtered = statusFilter !== "all"
  const statusOptions: {
    value: StatusFilter
    label: string
    icon?: typeof Send
    hint?: string
  }[] = [
    { value: "all", label: "All statuses" },
    { value: "needs", label: "Needs you", hint: String(runCounts.needs) },
    { value: "queue", label: "In queue", hint: String(runCounts.queue) },
    { value: "flight", label: "In flight", hint: String(runCounts.flight) },
    {
      value: "submitted",
      label: "Submitted",
      hint: String(runCounts.submitted),
    },
    {
      value: "cancelled",
      label: "Cancelled",
      hint: String(runCounts.cancelled),
    },
    {
      value: "applied",
      label: "Marked applied",
      icon: Send,
      hint: String(appliedCount),
    },
    {
      value: "dismissed",
      label: "Rejected",
      icon: X,
      hint: String(rejectedCount),
    },
  ]

  return (
    <AppShell
      title="Applications"
      actions={
        <Button variant="outline" asChild>
          <Link href="/applications/questions">Saved answers</Link>
        </Button>
      }
      description={
        loading || runsLoading ? (
          "Loading your pipeline…"
        ) : (
          <>
            {needsYou > 0 && (
              <>
                <strong className="font-semibold text-foreground">
                  {needsYou} need you
                </strong>
                {" · "}
              </>
            )}
            {runCounts.queue} in queue · {inFlight} in flight · {appliedCount}{" "}
            applied · {rejectedCount} rejected
          </>
        )
      }
    >
      <div
        role="tablist"
        aria-label="Applications view"
        className="-mt-2 flex gap-6 border-b"
      >
        {(
          [
            [
              "pipeline",
              "Pipeline",
              runCounts.all + appliedCount + rejectedCount,
            ],
            ["drafts", "Resume drafts", drafts.length],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => {
              setView(value)
              window.history.replaceState(
                null,
                "",
                value === "drafts" ? "?view=drafts" : window.location.pathname
              )
            }}
            className={cn(
              "-mb-px flex h-10 items-center gap-2 border-b-2 border-transparent text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground",
              view === value && "border-primary text-foreground"
            )}
          >
            {label}
            <span className="rounded-full bg-muted px-1.5 text-[11px] leading-5 tabular-nums">
              {count}
            </span>
          </button>
        ))}
      </div>

      {view === "drafts" ? (
        <ResumeDrafts drafts={drafts} />
      ) : (
        <>
          <p className="pt-3 text-sm text-muted-foreground">
            Up to two applications run at a time in queue order. Jobs that need
            your answers or review pause while the next job proceeds.
          </p>
          <div
            role="toolbar"
            aria-label="Filters"
            className="-mx-4 flex [scrollbar-width:none] items-center gap-2 overflow-x-auto border-b bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:z-20 lg:-mx-10 lg:px-10"
          >
            <FacetFilter
              title="Status"
              value={statusFilter}
              allValue="all"
              onChange={(value) => {
                if (isRunGroup(value) && value !== runFilter)
                  setRunsLoading(true)
                setStatusFilter(value)
                setRunPage(0)
              }}
              options={statusOptions}
            />
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (runFilter !== "all") setRunsLoading(true)
                  setStatusFilter("all")
                  setRunPage(0)
                }}
              >
                Reset
                <X />
              </Button>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          {showRuns && (
            <section aria-labelledby="runs-heading" className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="runs-heading" className={sectionLabel}>
                  Application activity
                </h2>
                <p className="text-xs text-muted-foreground">
                  Only a confirmed submission includes an employer receipt.
                </p>
              </div>
              {runsError && (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {runsError}
                </p>
              )}
              {runsLoading ? (
                <SkeletonRows count={2} label="Loading application activity" />
              ) : runs.length ? (
                <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
                  <div
                    aria-hidden
                    className="hidden grid-cols-[minmax(0,1fr)_minmax(0,15rem)_7rem_1rem] gap-4 border-b bg-muted/40 px-4 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase sm:grid"
                  >
                    <span>Position</span>
                    <span>Status</span>
                    <span className="text-right">Updated</span>
                    <span />
                  </div>
                  <ul>
                    {visibleRuns.map((run) => (
                      <li key={run.id} className="border-b last:border-b-0">
                        <Link
                          href={`/applications/${run.id}`}
                          className="group/run grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors duration-150 ease-out-expo outline-none hover:bg-accent/45 focus-visible:bg-accent/45 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_7rem_1rem] sm:gap-x-4"
                        >
                          <span className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1">
                            <CompanyMark name={run.company} />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">
                                {run.title || "Preparing your application"}
                              </span>
                              <span className="block truncate text-[13px] text-muted-foreground">
                                {run.company || "Employer"}
                              </span>
                            </span>
                          </span>
                          <span className="col-span-2 col-start-1 row-start-2 grid min-w-0 gap-1.5 sm:col-span-1 sm:col-start-auto sm:row-start-auto">
                            <RunStatus
                              status={run.status}
                              className="w-fit max-w-full"
                            />
                            <RunProgress status={run.status} />
                          </span>
                          <span className="col-start-3 row-start-2 text-right text-[13px] text-muted-foreground tabular-nums sm:col-start-auto sm:row-start-auto">
                            {run.updated_at && (
                              <time
                                dateTime={run.updated_at}
                                title={new Date(
                                  run.updated_at
                                ).toLocaleString()}
                              >
                                {relativeTime(run.updated_at)}
                              </time>
                            )}
                          </span>
                          <ChevronRight className="col-start-3 row-start-1 size-4 justify-self-end text-muted-foreground transition-transform duration-150 ease-out-expo group-hover/run:translate-x-0.5 sm:col-start-auto sm:row-start-auto" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                !runsError &&
                (runFilter === "all" ? (
                  <div className="rounded-xl border border-dashed px-6 py-10 text-center">
                    <Send className="mx-auto size-8 text-muted-foreground/60" />
                    <p className="mt-3 font-heading text-lg">
                      No applications yet
                    </p>
                    <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
                      Choose Tailor &amp; apply on a job. We draft the
                      application, you approve it, then we submit it for you.
                    </p>
                    <ol className="mx-auto mt-5 flex max-w-md flex-wrap items-center justify-center gap-x-2 gap-y-2 text-[13px] text-muted-foreground">
                      {(
                        [
                          ["Tailor", Sparkles],
                          ["Review", Eye],
                          ["Submit", Send],
                        ] as const
                      ).map(([label, Icon], index) => (
                        <li key={label} className="flex items-center gap-2">
                          {index > 0 && (
                            <ChevronRight
                              aria-hidden
                              className="size-3.5 text-muted-foreground/50"
                            />
                          )}
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
                            <span className="text-[11px] font-medium tabular-nums">
                              {index + 1}
                            </span>
                            <Icon className="size-3.5" />
                            <span className="font-medium text-foreground/80">
                              {label}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ol>
                    <div className="mt-5 flex justify-center">
                      <Button asChild>
                        <Link href="/jobs">Browse matches</Link>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed px-4 py-3.5 text-sm text-muted-foreground">
                    No applications currently have this status.
                  </p>
                ))
              )}
              {runCounts[runFilter] > 50 && (
                <nav
                  aria-label="Application pages"
                  className="flex items-center justify-end gap-3 pt-2"
                >
                  <Button
                    variant="outline"
                    disabled={runsLoading || runPage === 0}
                    onClick={() => {
                      setRunsLoading(true)
                      setRunPage((page) => page - 1)
                    }}
                  >
                    Previous applications
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {runPage + 1} of {Math.ceil(runCounts[runFilter] / 50)}
                  </span>
                  <Button
                    variant="outline"
                    disabled={
                      runsLoading || (runPage + 1) * 50 >= runCounts[runFilter]
                    }
                    onClick={() => {
                      setRunsLoading(true)
                      setRunPage((page) => page + 1)
                    }}
                  >
                    Next applications
                  </Button>
                </nav>
              )}
            </section>
          )}

          {showOutcomes && (
            <section aria-labelledby="outcomes-heading" className="space-y-2">
              <h2 id="outcomes-heading" className={sectionLabel}>
                Marked on Jobs
              </h2>

              {loading && archivedJobs.length === 0 ? (
                <SkeletonRows count={4} label="Loading outcomes" />
              ) : archivedJobs.length === 0 ? (
                <div className="rounded-xl border border-dashed px-6 py-10 text-center">
                  <Inbox className="mx-auto size-8 text-muted-foreground/60" />
                  <p className="mt-3 font-heading text-lg">
                    {filtered
                      ? "Nothing matches these filters"
                      : "No outcomes yet"}
                  </p>
                  <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
                    {filtered
                      ? "Widen the filters to see every job you applied to or rejected."
                      : "Jobs you mark applied or dismiss on the Jobs page are tracked here."}
                  </p>
                  <div className="mt-5 flex justify-center gap-2">
                    {filtered && (
                      <Button
                        onClick={() => {
                          setStatusFilter("all")
                        }}
                      >
                        Clear filters
                      </Button>
                    )}
                    <Button asChild variant="outline">
                      <Link href="/jobs">Browse jobs</Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
                  {archivedJobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      onStatus={setStatus}
                      disabled={statusPending}
                    >
                      {job.status === "applied" &&
                        followupOrder.has(job.id) && (
                          <ApplicationFollowup
                            jobId={job.id}
                            title={job.title}
                            company={job.company}
                          />
                        )}
                    </JobRow>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </AppShell>
  )
}

async function refreshState(setState: (state: SimpleAppState) => void) {
  const jobs: SimpleAppState["jobs"] = []
  let offset = 0
  let generation: string | null = null
  for (;;) {
    const params = new URLSearchParams({
      view: "saved",
      limit: "200",
      offset: String(offset),
    })
    if (generation) params.set("generation", generation)
    const res = await fetch(`/api/state?${params}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "Could not load applications.")
    if (generation && generation !== data.generation) {
      jobs.length = 0
      offset = 0
    }
    generation = data.generation
    jobs.push(...data.state.jobs)
    setState({ ...data.state, jobs: [...jobs] })
    offset += data.state.jobs.length
    if (offset >= data.total || !data.state.jobs.length)
      return data.matching.stale as boolean
  }
}
