"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  X,
  Zap,
} from "lucide-react"

import { AppShell, isTypingTarget } from "@/components/shell/app-shell"
import { JobRow, TriageHints } from "@/components/jobs/job-row"
import { FreshJobSearch } from "@/components/jobs/fresh-job-search"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SkeletonRows } from "@/components/ui/skeleton-rows"
import { FacetFilter, ToggleFilter } from "@/components/ui/facet-filter"
import { primeCommandJobs } from "@/components/shell/command-menu"
import { publishNavCounts } from "@/lib/nav-counts"
import { webUrl } from "@/lib/utils"
import {
  matchJobStatuses,
  matchPostingWindows,
  matchWorkModes,
  type MatchPage,
} from "@/lib/matching/page"
import type { JobStatus, SimpleAppState } from "@/lib/jobs"
import { visaLabels, type VisaConfidence } from "@/lib/location/relocation-data"
import { autoApplyEligible, visaNeeded } from "@/lib/applications/auto-apply"
import type { Candidate } from "@/lib/candidate"
import { JOB_SEARCH_COUNTRY } from "@/lib/location/countries"
import { visaSignalStyles } from "@/components/jobs/visa-signal"

const PAGE_SIZE = 25
const emptySearch = { query: "", city: "", company: "" }
const searchFields = [
  {
    key: "query",
    label: "Keywords",
    placeholder: "Job title or keywords",
    maxLength: 200,
  },
  { key: "city", label: "City", placeholder: "e.g. Hyderabad", maxLength: 120 },
  {
    key: "company",
    label: "Company",
    placeholder: "Company name",
    maxLength: 200,
  },
] as const
const workModeLabels = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: "Unspecified",
}
const statusLabels = {
  all: "All statuses",
  new: "To review",
  interested: "Interested",
  applied: "Applied",
  dismissed: "Dismissed",
}
const postingWindowLabels = {
  day: "Past 24 hours",
  week: "Past week",
  month: "Past month",
}

export function JobsPage() {
  const [state, setState] = useState<SimpleAppState>({
    jobs: [],
    trackedCountries: [],
  })
  const [matchPage, setMatchPage] = useState<MatchPage | null>(null)
  const requestGeneration = useRef(0)
  const publishedGeneration = useRef<string | null>(null)
  const [statusPending, setStatusPending] = useState(false)
  const [jobStatus, setJobStatus] = useState<
    (typeof matchJobStatuses)[number] | "default"
  >("default")
  const [workMode, setWorkMode] = useState<
    (typeof matchWorkModes)[number] | "all"
  >("all")
  const [searchDraft, setSearchDraft] = useState(emptySearch)
  const [search, setSearch] = useState(emptySearch)
  const [visa, setVisa] = useState<VisaConfidence | "all">("all")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState("")
  const [initialLoading, setLoading] = useState(true)
  const [loadedFilters, setLoadedFilters] = useState<string | null>(null)
  const [failedFilters, setFailedFilters] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [eligibleOnly, setEligibleOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [newSince, setNewSince] = useState<string | null>(null)
  const [newestFirst, setNewestFirst] = useState(true)
  const [datePosted, setDatePosted] =
    useState<(typeof matchPostingWindows)[number]>("month")
  const [activeId, setActiveId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [leavingId, setLeavingId] = useState<string | null>(null)
  const [triaged, setTriaged] = useState(0)
  const [toast, setToast] = useState<{
    id: string
    previous: JobStatus
    label: string
  } | null>(null)
  const router = useRouter()
  const reloadPromise = useRef<Promise<void> | null>(null)
  const autoAttempted = useRef(new Set<string>())
  const [usage, setUsage] = useState<{
    applications_used: number
    applications_limit: number
    ai_used: number
    ai_limit: number
  } | null>(null)
  const [autoNotice, setAutoNotice] = useState<{
    started: number
    limited: boolean
  } | null>(null)

  useEffect(() => {
    let active = true
    fetch("/api/applications/auto")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data?.usage) setUsage(data.usage)
      })
      .catch(() => {})
    fetch("/api/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data?.profile) setCandidate(data.profile.candidate)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  async function setStatus(id: string, status: JobStatus) {
    if (statusPending) return
    setStatusPending(true)
    requestGeneration.current++
    const previous = state
    setState({
      ...state,
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, status } : job)),
    })

    try {
      const res = await fetch("/api/state/job-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      })
      if (!res.ok)
        throw new Error("Could not save this job status. Please try again.")
    } catch (err) {
      const old = previous.jobs.find((job) => job.id === id)?.status ?? "new"
      setState((current) => ({
        ...current,
        jobs: current.jobs.map((job) =>
          job.id === id ? { ...job, status: old } : job
        ),
      }))
      setError(err instanceof Error ? err.message : "Could not save.")
    } finally {
      setStatusPending(false)
    }
  }

  function setVisaFilter(value: VisaConfidence | "all") {
    setVisa(value)
    setPage(1)
  }

  function resetFilters() {
    setVisa("all")
    setEligibleOnly(false)
    setNewSince(null)
    setNewestFirst(true)
    setDatePosted("month")
    setJobStatus("default")
    setWorkMode("all")
    setSearchDraft(emptySearch)
    setSearch(emptySearch)
    setPage(1)
  }

  const needsVisa = useMemo(() => visaNeeded(candidate), [candidate])
  const showVisaFilter = needsVisa(JOB_SEARCH_COUNTRY)
  const visaFilter = showVisaFilter ? visa : "all"
  const filters = useMemo(() => {
    const params = new URLSearchParams({
      view: "jobs",
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
      visa: visaFilter,
      strict: String(eligibleOnly),
      sort: newestFirst ? "newest" : "score",
      datePosted,
    })
    for (const [key, value] of Object.entries(search)) {
      if (value) params.set(key, value)
    }
    if (workMode !== "all") params.set("workMode", workMode)
    if (jobStatus !== "default") params.set("jobStatus", jobStatus)
    if (newSince) params.set("since", newSince)
    return params.toString()
  }, [
    page,
    visaFilter,
    eligibleOnly,
    jobStatus,
    workMode,
    search,
    newestFirst,
    newSince,
    datePosted,
  ])
  const resultsCurrent = loadedFilters === filters
  const loading =
    initialLoading || (!resultsCurrent && failedFilters !== filters)
  const preparingMatches =
    matchPage?.matching.stale &&
    !matchPage.generation &&
    matchPage.matching.status !== "failed"

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++requestGeneration.current
      const params = new URLSearchParams(filters)
      if (publishedGeneration.current)
        params.set("generation", publishedGeneration.current)
      const result = await fetchMatchPage(params.toString(), signal)
      if (signal?.aborted || generation !== requestGeneration.current) return
      setState(result.state)
      publishedGeneration.current = result.generation
      setMatchPage(result)
      setLoadedFilters(filters)
      setFailedFilters(null)
      setError("")
      setLoading(false)
      if (result.offset === 0 && page !== 1) setPage(1)
      // A status change can remove the last item of the last page.
      if (result.total > 0 && result.offset >= result.total)
        setPage(Math.max(1, Math.ceil(result.total / PAGE_SIZE)))
      return result
    },
    [filters, page]
  )

  useEffect(() => {
    if (statusPending) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: MatchPage | undefined
    let attempts = 0
    async function poll() {
      try {
        if (document.visibilityState === "hidden") {
          timer = setTimeout(poll, 15000)
          return
        }
        if (!current) current = await load(controller.signal)
        else {
          const response = await fetch("/api/matches/status", {
            signal: controller.signal,
            cache: "no-store",
          })
          if (!response.ok)
            throw new Error("Could not check matching progress.")
          const status = (await response.json()) as Pick<
            MatchPage,
            "generation" | "matching"
          >
          if (controller.signal.aborted) return
          setError("")
          if (
            status.generation !== current.generation ||
            !status.matching.stale
          )
            current = await load(controller.signal)
          else {
            current = { ...current, matching: status.matching }
            setMatchPage((previous) =>
              previous ? { ...previous, matching: status.matching } : previous
            )
          }
        }
        if (
          (!current || current.matching.stale) &&
          !controller.signal.aborted
        ) {
          const base =
            current?.matching.status === "failed"
              ? 60000
              : Math.min(30000, 5000 * 2 ** Math.min(attempts++, 3))
          timer = setTimeout(poll, base + Math.floor(Math.random() * 1000))
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error ? err.message : "Could not load matches."
          )
          setLoading(false)
          setFailedFilters(filters)
          timer = setTimeout(poll, 15000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [load, statusPending, filters, matchPage?.matching.stale])

  const refresh = useCallback(() => {
    if (reloadPromise.current) return reloadPromise.current
    setRunning(true)
    const work = load()
      .then(() => {})
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Could not refresh matches."
        )
        throw err
      })
      .finally(() => {
        setRunning(false)
        reloadPromise.current = null
      })
    reloadPromise.current = work
    return work
  }, [load])
  const receiveFreshJobs = useCallback(async () => {
    if (reloadPromise.current) await reloadPromise.current.catch(() => {})
    await refresh()
  }, [refresh])

  const visible = resultsCurrent ? state.jobs : []
  const currentResults = resultsCurrent ? matchPage : null

  useEffect(() => {
    if (
      !resultsCurrent ||
      matchPage?.matching.stale ||
      !candidate?.autoApply?.enabled
    )
      return
    const jobIds = state.jobs
      .filter(
        (job) =>
          !autoAttempted.current.has(job.id) &&
          job.country === JOB_SEARCH_COUNTRY &&
          autoApplyEligible(candidate, job)
      )
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
      .slice(0, 20)
      .map((job) => job.id)
    if (!jobIds.length) return
    for (const id of jobIds) autoAttempted.current.add(id)
    fetch("/api/applications/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && (data.started.length || data.limited))
          setAutoNotice({ started: data.started.length, limited: data.limited })
      })
      .catch(() => {})
  }, [resultsCurrent, candidate, state.jobs, matchPage?.matching.stale])

  useEffect(() => {
    if (!resultsCurrent) return
    primeCommandJobs(state.jobs)
    publishNavCounts({ jobs: matchPage?.counts.new ?? 0 })
  }, [resultsCurrent, state.jobs, matchPage?.counts.new])

  const activeJobs =
    state.catalog?.coverage?.find((row) => row.country === JOB_SEARCH_COUNTRY)
      ?.activeVacancies ?? 0
  const total = currentResults?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pagedJobs = visible
  const start = total === 0 ? 0 : (currentResults?.offset ?? 0) + 1
  const end = total === 0 ? 0 : start + pagedJobs.length - 1
  const toReview = currentResults?.counts.toReview ?? 0
  const confirmed = currentResults?.counts.confirmed ?? 0
  const fresh = currentResults?.counts.fresh ?? 0
  const filtered =
    eligibleOnly ||
    visaFilter !== "all" ||
    Boolean(newSince) ||
    workMode !== "all" ||
    jobStatus !== "default" ||
    datePosted !== "month" ||
    Object.values(search).some(Boolean)

  function act(id: string, status: JobStatus) {
    const previous = state.jobs.find((job) => job.id === id)?.status ?? "new"
    const label = {
      new: "Moved back to new",
      interested: "Marked interested",
      applied: "Marked applied",
      dismissed: "Dismissed",
    }[status]
    if (status !== "new" && previous === "new") setTriaged((count) => count + 1)
    const hides =
      jobStatus === "default"
        ? status === "applied" || status === "dismissed"
        : jobStatus !== "all" && status !== jobStatus
    if (hides) {
      const index = pagedJobs.findIndex((job) => job.id === id)
      setActiveId(pagedJobs[index + 1]?.id ?? pagedJobs[index - 1]?.id ?? null)
      setLeavingId(id)
      setTimeout(() => {
        setLeavingId(null)
        setStatus(id, status)
      }, 180)
    } else {
      setStatus(id, status)
    }
    setToast({ id, previous, label })
  }

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (!pagedJobs.length) return
      const index = pagedJobs.findIndex((job) => job.id === activeId)
      const current = pagedJobs[index]
      const move = (next: number) => {
        const job = pagedJobs[Math.max(0, Math.min(pagedJobs.length - 1, next))]
        setActiveId(job.id)
        document
          .querySelector(`[data-job-id="${CSS.escape(job.id)}"]`)
          ?.scrollIntoView({ block: "nearest" })
      }
      const key = event.key.toLowerCase()
      if (key === "j" || key === "arrowdown") move(index + 1)
      else if (key === "k" || key === "arrowup") move(index - 1)
      else if (!current) return
      else if (
        key === "enter" &&
        !(
          event.target instanceof HTMLButtonElement ||
          event.target instanceof HTMLAnchorElement
        )
      )
        setExpandedId((id) => (id === current.id ? null : current.id))
      else if (key === "t")
        router.push(`/resumes/new?job=${encodeURIComponent(current.id)}`)
      else if (key === "o") {
        const url = webUrl(current.url)
        if (url) window.open(url, "_blank", "noreferrer")
      } else if (key === "i") act(current.id, "interested")
      else if (key === "a") act(current.id, "applied")
      else if (key === "d") act(current.id, "dismissed")
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <AppShell
      title="Opportunities"
      description={
        loading || preparingMatches ? (
          "Ranking roles against your experience…"
        ) : (
          <>
            <strong className="font-semibold text-foreground">
              {toReview} to review
            </strong>
            {showVisaFilter && (
              <>
                {" · "}
                <span className="text-emerald-700 dark:text-emerald-300">
                  {confirmed} with confirmed sponsorship
                </span>
              </>
            )}
            {" · "}
            {fresh} posted in the past 3 days
          </>
        )
      }
      actions={
        <FreshJobSearch
          ready={!loading}
          assessedAt={state.catalog?.assessedAt}
          matching={matchPage?.matching}
          onPublished={receiveFreshJobs}
          jobs={state.jobs}
          paginated
          onShowNew={(since) => {
            setNewSince(since)
            setNewestFirst(true)
            setPage(1)
          }}
          refreshControl={
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                running ? "Reloading saved matches" : "Reload saved matches"
              }
              aria-busy={running}
              title="Reload saved matches without checking career boards"
              disabled={loading || running}
              onClick={() => void refresh().catch(() => {})}
            >
              <RefreshCw
                aria-hidden="true"
                className={
                  running
                    ? "animate-spin motion-reduce:animate-none"
                    : undefined
                }
              />
            </Button>
          }
        />
      }
    >
      {error && (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {candidate && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-2.5 text-sm"
        >
          <Zap
            className={
              candidate.autoApply?.enabled
                ? "size-4 text-primary"
                : "size-4 text-muted-foreground"
            }
          />
          <span className="font-medium">
            {candidate.autoApply?.enabled
              ? `Auto-apply on · match ${candidate.autoApply.minScore}+`
              : "Auto-apply off"}
          </span>
          {usage && usage.ai_used >= usage.ai_limit && (
            <span className="text-destructive">
              AI allowance used up. Tailoring and AI navigation share this
              limit.
            </span>
          )}
          <span className="text-muted-foreground">
            {autoNotice
              ? `${autoNotice.started} application${autoNotice.started === 1 ? "" : "s"} started${autoNotice.limited ? " · monthly limit reached" : ""}.`
              : candidate.autoApply?.enabled
                ? "Strong matches are tailored and sent automatically."
                : "Send tailored applications to jobs above a match score."}
          </span>
          <span className="ml-auto flex gap-3">
            {autoNotice && (
              <Link
                href="/applications"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                View applications
              </Link>
            )}
            <Link
              href="/preferences#auto-apply-section"
              className="text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              {candidate.autoApply?.enabled ? "Change" : "Set up"}
            </Link>
          </span>
        </div>
      )}

      {Boolean(state.catalog?.failedSources) && (
        <p role="status" className="text-sm text-muted-foreground">
          Some employer feeds could not refresh. Showing the verified listings
          available now.
        </p>
      )}

      {Boolean(matchPage?.matching.stale) && visible.length > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {matchPage?.matching.status === "failed"
            ? "Could not update matches. Showing your last completed results; we’ll retry shortly."
            : "Updating your matches in the background. Showing your last completed results."}
        </p>
      )}

      <form
        aria-label="Search opportunities"
        className="grid grid-cols-2 items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault()
          const next = {
            query: searchDraft.query.trim(),
            city: searchDraft.city.trim(),
            company: searchDraft.company.trim(),
          }
          setSearchDraft(next)
          setSearch(next)
          setPage(1)
        }}
      >
        {searchFields.map(({ key, label, placeholder, maxLength }) => (
          <label
            key={key}
            className={
              key === "query"
                ? "col-span-2 grid gap-1.5 text-sm font-medium md:col-span-1"
                : "grid gap-1.5 text-sm font-medium"
            }
          >
            {label}
            <Input
              type="search"
              name={key}
              placeholder={placeholder}
              maxLength={maxLength}
              value={searchDraft[key]}
              onChange={(event) =>
                setSearchDraft({ ...searchDraft, [key]: event.target.value })
              }
            />
          </label>
        ))}
        <Button type="submit" className="col-span-2 h-11 md:col-span-1">
          <Search />
          Search
        </Button>
      </form>

      <div
        role="group"
        aria-label="Filters"
        className="-mx-4 flex flex-wrap items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:z-20 lg:-mx-10 lg:px-10"
      >
        <label htmlFor="date-posted" className="sr-only">
          Date posted
        </label>
        <Select
          value={datePosted}
          onValueChange={(value) => {
            setDatePosted(value as (typeof matchPostingWindows)[number])
            setPage(1)
          }}
        >
          <SelectTrigger
            id="date-posted"
            size="sm"
            className="shrink-0 font-medium sm:text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {matchPostingWindows.map((window) => (
              <SelectItem key={window} value={window}>
                {postingWindowLabels[window]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showVisaFilter && (
          <FacetFilter
            title="Visa"
            value={visa}
            allValue="all"
            onChange={setVisaFilter}
            options={[
              { value: "all" as const, label: "Any signal" },
              ...(Object.keys(visaLabels) as VisaConfidence[]).map((key) => ({
                value: key,
                label: visaLabels[key],
                icon: visaSignalStyles[key].icon,
              })),
            ]}
          />
        )}
        <ToggleFilter
          icon={Sparkles}
          pressed={eligibleOnly}
          onPressedChange={(next) => {
            setEligibleOnly(next)
            setPage(1)
          }}
        >
          Strong fit only
        </ToggleFilter>
        <FacetFilter
          title="Work arrangement"
          value={workMode}
          allValue="all"
          onChange={(value) => {
            setWorkMode(value)
            setPage(1)
          }}
          options={[
            { value: "all", label: "Any arrangement" },
            ...matchWorkModes.map((value) => ({
              value,
              label: workModeLabels[value],
            })),
          ]}
        />
        <FacetFilter
          title="Status"
          value={jobStatus}
          allValue="default"
          onChange={(value) => {
            setJobStatus(value)
            setPage(1)
          }}
          options={[
            { value: "default", label: "To review & interested" },
            ...matchJobStatuses.map((value) => ({
              value,
              label: statusLabels[value],
            })),
          ]}
        />
        <FacetFilter
          title="Sort"
          value={newestFirst ? "newest" : "score"}
          allValue="newest"
          onChange={(value) => {
            setNewestFirst(value === "newest")
            setPage(1)
          }}
          options={[
            { value: "newest", label: "Newest posted" },
            { value: "score", label: "Highest match score" },
          ]}
        />
        {newSince && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNewSince(null)
              setPage(1)
            }}
          >
            New discoveries · clear
            <X />
          </Button>
        )}
        {(filtered ||
          !newestFirst ||
          Object.values(searchDraft).some(Boolean)) && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset filters
            <X />
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Saved and applied jobs can appear outside the selected posting window.
      </p>

      <section aria-label="Matching roles" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span aria-live="polite">
            {loading || preparingMatches
              ? "Loading your matches"
              : `${total ? `${start}–${end} of ${total}` : "0 matches"} · ${activeJobs} active listings in ${JOB_SEARCH_COUNTRY}`}
          </span>
          <TriageHints />
        </div>

        {loading ? (
          <div className="space-y-3">
            {!matchPage && <MatchLoadingNotice />}
            <SkeletonRows count={6} label="Loading matching roles" />
          </div>
        ) : !error && visible.length === 0 && matchPage?.matching.stale ? (
          matchPage.matching.status === "failed" ? (
            <div
              role="status"
              className="flex flex-col items-center rounded-xl border bg-card px-6 py-10 text-center shadow-xs"
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <CircleAlert aria-hidden="true" className="size-6" />
              </span>
              <p className="mt-4 font-heading text-lg">
                Matching could not finish
              </p>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                We’ll retry shortly; your preferences are saved.
              </p>
              <Button
                className="mt-5"
                variant="outline"
                disabled={running}
                onClick={() => void refresh().catch(() => {})}
              >
                <RefreshCw
                  className={
                    running
                      ? "animate-spin motion-reduce:animate-none"
                      : undefined
                  }
                />
                Retry now
              </Button>
            </div>
          ) : (
            <MatchLoadingNotice />
          )
        ) : !error && visible.length === 0 && activeJobs > 0 && !filtered ? (
          <div className="flex animate-in flex-col items-center rounded-xl border bg-card px-6 py-10 text-center shadow-xs duration-300 zoom-in-95 fade-in motion-reduce:animate-none">
            <span className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CircleCheck aria-hidden="true" className="size-6" />
            </span>
            <p className="mt-4 font-heading text-lg">You’re all caught up</p>
            <p className="mt-2 max-w-[52ch] text-sm text-muted-foreground">
              {triaged > 0
                ? `You triaged ${triaged} ${triaged === 1 ? "role" : "roles"} this session. `
                : ""}
              Every match in this posting window has been reviewed. We’ll
              surface new roles here as sources refresh.
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button asChild variant="outline">
                <Link href="/preferences">Review preferences</Link>
              </Button>
            </div>
          </div>
        ) : !error && visible.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-10 text-center">
            <Inbox className="mx-auto size-8 text-muted-foreground/60" />
            <p className="mt-3 font-heading text-lg">
              {filtered
                ? "Nothing matches these filters"
                : `No listings in ${JOB_SEARCH_COUNTRY} yet`}
            </p>
            <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
              {filtered
                ? "Try a different search or clear the filters to see more matches."
                : "Sources may be missing or stale. Try refreshing later."}
            </p>
            <div className="mt-5 flex justify-center gap-2">
              {datePosted !== "month" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDatePosted("month")
                    setPage(1)
                  }}
                >
                  Include jobs from the past month
                </Button>
              )}
              {filtered && (
                <Button onClick={resetFilters}>Clear filters</Button>
              )}
              <Button asChild variant="outline">
                <Link href="/preferences">Review preferences</Link>
              </Button>
            </div>
          </div>
        ) : visible.length > 0 ? (
          <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
            {pagedJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onStatus={act}
                disabled={statusPending}
                active={job.id === activeId}
                expanded={job.id === expandedId}
                leaving={job.id === leavingId}
                needsVisa={needsVisa(job.country)}
                onActivate={() => setActiveId(job.id)}
                onToggle={() =>
                  setExpandedId((id) => (id === job.id ? null : job.id))
                }
              />
            ))}
          </ul>
        ) : null}

        {pageCount > 1 && (
          <div className="flex items-center justify-end gap-2 pt-2">
            <span className="mr-2 text-sm text-muted-foreground">
              Page {currentPage} of {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={currentPage >= pageCount}
              onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </section>

      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
      >
        {toast && (
          <div
            key={toast.id + toast.label}
            className="pointer-events-auto flex animate-in items-center gap-3 rounded-lg bg-foreground py-2 pr-2 pl-4 text-sm text-background shadow-xl duration-200 ease-out-expo fade-in slide-in-from-bottom-3"
          >
            {toast.label}
            <button
              type="button"
              className="rounded-md px-2.5 py-1 font-medium text-sidebar-primary transition-colors hover:bg-background/15 focus-visible:ring-2 focus-visible:ring-background/40 focus-visible:outline-none dark:text-primary"
              onClick={() => {
                setStatus(toast.id, toast.previous)
                setToast(null)
              }}
            >
              Undo
            </button>
          </div>
        )}
      </div>
    </AppShell>
  )
}

const matchStages = [
  { at: 0, label: "Reading your profile" },
  { at: 6000, label: "Scanning job sources in India" },
  { at: 18000, label: "Ranking matches" },
]

function MatchLoadingNotice() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const timers = matchStages
      .slice(1)
      .map((step, index) => setTimeout(() => setStage(index + 1), step.at))
    return () => timers.forEach(clearTimeout)
  }, [])
  return (
    <div
      role="status"
      className="flex flex-col items-center rounded-xl border bg-card px-6 py-10 text-center shadow-xs"
    >
      <p className="font-heading text-lg">Preparing your matches</p>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        We’re comparing your experience with jobs in India. Your first search
        can take about a minute.
      </p>
      <ol className="mt-5 grid w-full max-w-sm gap-3 text-left text-sm">
        {matchStages.map((step, index) => {
          const done = index < stage
          const current = index === stage
          return (
            <li
              key={index}
              aria-current={current ? "step" : undefined}
              className="grid grid-cols-[1.25rem_1fr] items-center gap-x-3"
            >
              <span
                className={
                  done
                    ? "flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    : current
                      ? "flex size-5 items-center justify-center text-primary"
                      : "flex size-5 items-center justify-center"
                }
              >
                {done ? (
                  <Check aria-hidden="true" className="size-3" />
                ) : current ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                )}
              </span>
              <span
                className={
                  current
                    ? "font-medium text-foreground"
                    : done
                      ? "text-muted-foreground"
                      : "text-muted-foreground/60"
                }
              >
                {step.label}
              </span>
              {current && (
                <span className="col-start-2 mt-1.5 h-0.5 overflow-hidden rounded-full bg-primary/10">
                  <span className="block h-full w-1/4 rounded-full bg-primary motion-safe:animate-[task-sweep_1.6s_ease-in-out_infinite]" />
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-5 max-w-sm text-sm text-muted-foreground">
        Your profile is saved. Matches will appear here automatically.
      </p>
    </div>
  )
}

async function fetchMatchPage(
  filters: string,
  signal?: AbortSignal
): Promise<MatchPage> {
  const res = await fetch(`/api/state?${filters}`, {
    cache: "no-store",
    signal,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? "Could not load matches.")
  return data
}
