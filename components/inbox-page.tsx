"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ChevronRight, CircleCheck, Inbox } from "lucide-react"

import { AppShell } from "@/components/shell/app-shell"
import { RunStatus } from "@/components/applications/application-review"
import { CompanyMark } from "@/components/jobs/company-mark"
import { FacetFilter } from "@/components/ui/facet-filter"
import { publishNavCounts } from "@/lib/nav-counts"
import { relativeTime } from "@/lib/utils"
import type { QuestionAlert } from "@/lib/applications/questions"

type NeedsItem = {
  id: string
  status: string
  automatic: boolean
  title: string
  company: string
  updated_at: string
}

type ActivityEvent = {
  id: number
  applicationId: string
  status: string
  created_at: string
  title: string
  company: string
}

type NeedsFilter = "all" | "ready" | "needs_attention" | "submission_unknown"

const asks: Record<string, { label: string; action: string }> = {
  ready: { label: "Approve to submit", action: "Review & approve" },
  needs_attention: { label: "Needs your input", action: "Resolve" },
  submission_unknown: {
    label: "Ready to retry",
    action: "Try again",
  },
}

const eventText: Record<string, string> = {
  queued_prepare: "Queued for preparation",
  preparing: "Preparing application",
  ready: "Application prepared",
  queued: "In submission queue",
  running: "Filling the application",
  submitting: "Submitting",
  submitted: "Submitted",
  submission_unknown: "Ready to retry",
  needs_attention: "Paused for your input",
  cancelled: "Cancelled",
}

const sectionLabel = "text-sm font-semibold tracking-tight"

export function InboxPage() {
  const [needs, setNeeds] = useState<NeedsItem[]>([])
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [alerts, setAlerts] = useState<Map<string, QuestionAlert>>(new Map())
  const [filter, setFilter] = useState<NeedsFilter>("all")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    const load = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const [inbox, questions] = await Promise.all([
          fetch("/api/inbox", { cache: "no-store" }),
          fetch("/api/application-questions/alerts", { cache: "no-store" }),
        ])
        const data = await inbox.json()
        if (!inbox.ok) throw new Error(data.error || "Could not load inbox.")
        const questionData = questions.ok ? await questions.json() : null
        if (!active) return
        setNeeds(data.needs)
        setEvents(data.events)
        if (questionData)
          setAlerts(
            new Map(
              (questionData.alerts as QuestionAlert[]).map((alert) => [
                alert.applicationId,
                alert,
              ])
            )
          )
        setError("")
        publishNavCounts({ applications: data.needs.length })
      } catch (err) {
        if (active)
          setError(err instanceof Error ? err.message : "Could not load inbox.")
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = setInterval(load, 10000)
    window.addEventListener("focus", load)
    window.addEventListener("application-questions-changed", load)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener("focus", load)
      window.removeEventListener("application-questions-changed", load)
    }
  }, [])

  const visibleNeeds = useMemo(
    () => needs.filter((item) => filter === "all" || item.status === filter),
    [needs, filter]
  )
  const countOf = (status: string) =>
    String(needs.filter((item) => item.status === status).length)

  return (
    <AppShell
      title="Inbox"
      description={
        loading ? (
          "Loading…"
        ) : needs.length ? (
          <strong className="font-semibold text-foreground">
            {needs.length} need{needs.length === 1 ? "s" : ""} you
          </strong>
        ) : (
          "Nothing needs you right now."
        )
      }
    >
      <div
        role="toolbar"
        aria-label="Filters"
        className="-mx-4 flex [scrollbar-width:none] items-center gap-2 overflow-x-auto border-b bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:z-20 lg:-mx-10 lg:px-10"
      >
        <FacetFilter
          title="Needs"
          value={filter}
          allValue="all"
          onChange={setFilter}
          options={[
            { value: "all", label: "Everything" },
            {
              value: "ready",
              label: "Questions & review",
              hint: countOf("ready"),
            },
            {
              value: "needs_attention",
              label: "Input needed",
              hint: countOf("needs_attention"),
            },
            {
              value: "submission_unknown",
              label: "Ready to retry",
              hint: countOf("submission_unknown"),
            },
          ]}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <section aria-labelledby="needs-heading" className="space-y-2">
        <h2 id="needs-heading" className={sectionLabel}>
          Needs you
        </h2>
        {loading ? (
          <div className="h-24 animate-pulse rounded-xl border bg-muted/40" />
        ) : visibleNeeds.length ? (
          <ul className="overflow-hidden rounded-xl border bg-card shadow-xs">
            {visibleNeeds.map((item) => {
              const ask =
                item.status === "ready" && item.automatic
                  ? {
                      label: "Answer missing questions",
                      action: "Answer & continue",
                    }
                  : asks[item.status]
              const questions = alerts.get(item.id)?.questions ?? []
              return (
                <li key={item.id} className="border-b last:border-b-0">
                  <Link
                    href={`/applications/${item.id}`}
                    className="group/item flex items-center gap-3 px-4 py-3 transition-colors duration-150 ease-out-expo outline-none hover:bg-accent/45 focus-visible:bg-accent/45"
                  >
                    <CompanyMark name={item.company} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {ask?.label ?? "Needs you"} · {item.company}
                      </span>
                      <span className="block truncate text-[13px] text-muted-foreground">
                        {questions.length
                          ? questions
                              .slice(0, 2)
                              .map((q) => q.label)
                              .join(" · ") +
                            (questions.length > 2
                              ? ` · ${questions.length - 2} more`
                              : "")
                          : item.title}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-[13px] text-muted-foreground tabular-nums sm:block">
                      <time dateTime={item.updated_at}>
                        {relativeTime(item.updated_at)}
                      </time>
                    </span>
                    <span className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium group-hover/item:bg-background">
                      {ask?.action ?? "Open"}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out-expo group-hover/item:translate-x-0.5" />
                  </Link>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed px-6 py-8 text-center">
            <CircleCheck className="mx-auto size-7 text-muted-foreground/60" />
            <p className="mt-2 text-sm text-muted-foreground">
              {filter === "all"
                ? "You're all caught up. Approvals and questions from your applications show up here."
                : "Nothing of this kind needs you."}
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="activity-heading" className="space-y-2">
        <h2 id="activity-heading" className={sectionLabel}>
          Recent activity
        </h2>
        {loading ? (
          <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
        ) : events.length ? (
          <ol className="overflow-hidden rounded-xl border bg-card">
            {events.map((event) => (
              <li key={event.id} className="border-b last:border-b-0">
                <Link
                  href={`/applications/${event.applicationId}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-accent/45 sm:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_6rem]"
                >
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-medium">{event.company}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {eventText[event.status] ?? event.status}
                    </span>
                  </span>
                  <RunStatus
                    status={event.status}
                    className="hidden w-fit sm:inline-flex"
                  />
                  <time
                    dateTime={event.created_at}
                    title={new Date(event.created_at).toLocaleString()}
                    className="text-right text-[13px] text-muted-foreground tabular-nums"
                  >
                    {relativeTime(event.created_at)}
                  </time>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <div className="rounded-xl border border-dashed px-6 py-8 text-center">
            <Inbox className="mx-auto size-7 text-muted-foreground/60" />
            <p className="mt-2 text-sm text-muted-foreground">
              No application activity yet.
            </p>
          </div>
        )}
      </section>
    </AppShell>
  )
}
