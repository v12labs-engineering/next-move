"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Search, LoaderCircle, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  jobSearchMessage,
  newMatchingJobs,
  searchIsActive,
  searchMatchesReady,
  type JobSearchResponse,
} from "@/lib/jobs/search"
import type { Job } from "@/lib/jobs"
import type { MatchPage } from "@/lib/matching/page"

export function FreshJobSearch({
  ready,
  onPublished,
  assessedAt,
  refreshControl,
  jobs = [],
  onShowNew,
  paginated = false,
  matching,
}: {
  ready: boolean
  assessedAt?: string
  refreshControl?: ReactNode
  onPublished: () => Promise<void>
  jobs?: Job[]
  onShowNew?: (since: string) => void
  paginated?: boolean
  matching?: Pick<MatchPage["matching"], "status" | "stale">
}) {
  const [result, setResult] = useState<JobSearchResponse>({ search: null })
  const [pending, setPending] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const [error, setError] = useState("")
  const [watch, setWatch] = useState(0)
  const [publishedMatchCount, setPublishedMatchCount] = useState<
    number | undefined
  >()
  const requestGeneration = useRef(0)
  const assessedAtRef = useRef(assessedAt)
  useEffect(() => {
    assessedAtRef.current = assessedAt
  }, [assessedAt])
  const delivered = useRef<{
    id: string
    published: number
    active: boolean
  } | null>(null)
  const request = useCallback(
    async (method: "GET" | "POST", signal?: AbortSignal) => {
      const response = await fetch("/api/job-search", {
        method,
        cache: "no-store",
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(60000),
        ]),
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      })
      const payload = await response.json()
      if (!response.ok)
        throw new Error(payload.error ?? "Live search could not be reached.")
      return payload as JobSearchResponse
    },
    []
  )
  const accept = useCallback(
    async (next: JobSearchResponse, initial = false) => {
      setResult(next)
      const search = next.search
      if (!search) return
      const previous = delivered.current
      const active = searchIsActive(search)
      const changed = !previous || previous.id !== search.id
      const publishedBefore = changed ? 0 : previous.published
      const newerThanLoaded =
        initial &&
        search.publishedSources > 0 &&
        assessedAtRef.current &&
        Date.parse(search.updatedAt) > Date.parse(assessedAtRef.current)
      if (
        newerThanLoaded ||
        (!initial &&
          (search.publishedSources > publishedBefore ||
            (!changed && previous.active && !active)))
      ) {
        setUpdating(true)
        try {
          await onPublished()
        } finally {
          setUpdating(false)
        }
      }
      delivered.current = {
        id: search.id,
        published: search.publishedSources,
        active,
      }
    },
    [onPublished]
  )

  useEffect(() => {
    if (!ready) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let first = watch === 0 && delivered.current === null
    async function poll() {
      if (document.hidden) {
        timer = setTimeout(poll, 15000)
        return
      }
      try {
        const generation = requestGeneration.current
        const next = await request("GET", controller.signal)
        if (
          controller.signal.aborted ||
          generation !== requestGeneration.current
        )
          return
        await accept(next, first)
        first = false
        setError("")
        if (searchIsActive(next.search) || next.blocked === "storage_limit")
          timer = setTimeout(
            poll,
            next.blocked === "storage_limit" ? 60000 : 15000
          )
      } catch {
        if (!controller.signal.aborted) {
          setError(
            "Live progress is temporarily unavailable. Your existing matches remain available."
          )
          timer = setTimeout(poll, 30000)
        }
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [ready, request, accept, watch])

  async function begin() {
    requestGeneration.current++
    setPending(true)
    setError("")
    try {
      const next = await request("POST")
      await accept(next)
      if (searchIsActive(next.search)) setWatch((value) => value + 1)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Live search could not start."
      )
      setWatch((value) => value + 1)
    } finally {
      setPending(false)
    }
  }
  const active = searchIsActive(result.search)
  const matchesReady = searchMatchesReady(result.search, assessedAt, matching)
  const newMatches =
    result.search && matchesReady
      ? paginated
        ? publishedMatchCount
        : newMatchingJobs(jobs, result.search.createdAt).length
      : undefined
  useEffect(() => {
    if (!paginated || !result.search || !matchesReady) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      view: "jobs",
      since: result.search.createdAt,
      limit: "1",
    })
    fetch(`/api/state?${params}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted)
          setPublishedMatchCount(data.total)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [paginated, result.search, matchesReady])
  const retryAt =
    result.retryAt ?? (!active ? result.search?.retryAt : undefined)
  const cooling = Boolean(retryAt && Date.parse(retryAt) > clock)
  useEffect(() => {
    if (!retryAt) return
    const remaining = Date.parse(retryAt) - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(remaining, 3600000)
    )
    return () => clearTimeout(timer)
  }, [retryAt, clock])
  return (
    <div className="flex max-w-sm flex-col items-start gap-2 sm:items-end">
      <div className="flex items-center gap-2">
        {refreshControl}
        <Button
          disabled={
            !ready ||
            pending ||
            active ||
            updating ||
            cooling ||
            result.blocked === "storage_limit" ||
            result.blocked === "disabled"
          }
          onClick={begin}
        >
          {pending || active || updating ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Search />
          )}
          {pending
            ? "Starting live search"
            : updating
              ? "Updating matches"
              : active
                ? "Checking for fresh jobs"
                : "Refresh jobs"}
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="max-w-[36ch] text-xs text-muted-foreground sm:text-right"
      >
        {error ||
          (updating
            ? "Fresh source results are ready. Updating your matches…"
            : jobSearchMessage(result, newMatches))}
        {cooling && retryAt && (
          <span className="block">
            Next request after{" "}
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            }).format(new Date(retryAt))}
            .
          </span>
        )}
      </p>
      {result.search && (newMatches ?? 0) > 0 && onShowNew && (
        <Button
          size="sm"
          className="rounded-full bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in motion-safe:slide-in-from-top-1"
          onClick={() => onShowNew(result.search!.createdAt)}
        >
          <Sparkles />
          Show {newMatches} new {newMatches === 1 ? "match" : "matches"}
        </Button>
      )}
    </div>
  )
}
