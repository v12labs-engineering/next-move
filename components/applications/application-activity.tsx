"use client"

import type { ReactNode } from "react"
import {
  Ban,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock,
  Eye,
  LoaderCircle,
  Send,
  type LucideIcon,
} from "lucide-react"
import { statusLabel, type ApplicationRun } from "@/lib/applications"
import { cn, relativeTime } from "@/lib/utils"

export type ApplicationEvent = {
  id: number
  status: string
  revision: number
  created_at: string
}

const runStatus: Record<
  string,
  { icon: LucideIcon; tone: string; title: string }
> = {
  queued_prepare: {
    title: "Waiting to prepare",
    icon: Clock,
    tone: "bg-muted text-foreground/80",
  },
  preparing: {
    title: "Preparing application",
    icon: LoaderCircle,
    tone: "bg-muted text-foreground/80",
  },
  ready: {
    title: "Ready for your review",
    icon: Eye,
    tone: "bg-primary/12 text-primary",
  },
  queued: {
    title: "Waiting to send",
    icon: Clock,
    tone: "bg-muted text-foreground/80",
  },
  running: {
    title: "Checking application",
    icon: Send,
    tone: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  },
  submitting: {
    title: "Sending application",
    icon: Send,
    tone: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  },
  submitted: {
    title: "Submission confirmed",
    icon: CircleCheck,
    tone: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  submission_unknown: {
    title: "Ready to retry",
    icon: CircleHelp,
    tone: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  },
  needs_attention: {
    title: "Your attention needed",
    icon: CircleAlert,
    tone: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  },
  cancelled: {
    title: "Application cancelled",
    icon: Ban,
    tone: "bg-muted text-muted-foreground",
  },
}

export function RunStatus({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  const { icon: Icon, tone } = runStatus[status] ?? {
    icon: Clock,
    tone: "bg-muted text-foreground/80",
  }
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
        tone,
        className
      )}
    >
      {status === "running" || status === "submitting" ? (
        <span aria-hidden className="relative flex size-1.5 shrink-0">
          <span className="absolute inset-0 rounded-full bg-current opacity-60 motion-safe:animate-ping" />
          <span className="relative size-1.5 rounded-full bg-current" />
        </span>
      ) : (
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            status === "preparing" && "animate-spin motion-reduce:animate-none"
          )}
        />
      )}
      {statusLabel(status)}
    </span>
  )
}

export function ApplicationStatusCard({
  run,
  children,
}: {
  run: ApplicationRun
  children?: ReactNode
}) {
  const {
    icon: Icon,
    tone,
    title: defaultTitle,
  } = runStatus[run.status] ?? {
    icon: Clock,
    tone: "bg-muted text-muted-foreground",
    title: statusLabel(run.status),
  }

  const title =
    run.automatic && run.status === "ready"
      ? statusLabel(run.status, run)
      : defaultTitle
  return (
    <section aria-label="Application status" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Application status
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          Version {run.revision}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="p-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                tone
              )}
            >
              <Icon
                className={cn(
                  "size-4",
                  run.status === "preparing" && "motion-safe:animate-spin"
                )}
              />
            </span>
            <div className="min-w-0 self-center">
              <p className="text-base leading-snug font-medium tracking-tight text-balance">
                {title}
              </p>
            </div>
          </div>
          {run.message && (
            <p className="mt-3 text-[13px] leading-relaxed wrap-break-word text-muted-foreground">
              {run.message}
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            <time
              dateTime={run.updated_at}
              title={new Date(run.updated_at).toLocaleString()}
            >
              Updated {relativeTime(run.updated_at)}
            </time>
          </p>
        </div>
        {children}
      </div>
    </section>
  )
}

export function ApplicationHistory({ events }: { events: ApplicationEvent[] }) {
  const ordered = [...events].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id
  )
  const recent = ordered.slice(0, 3)
  const earlier = ordered.slice(3)

  function eventRow(event: ApplicationEvent) {
    const {
      icon: Icon,
      tone,
      title,
    } = runStatus[event.status] ?? {
      icon: Clock,
      tone: "bg-muted text-muted-foreground",
      title: statusLabel(event.status),
    }
    return (
      <li
        key={event.id}
        className="flex items-start gap-3 border-b py-3.5 last:border-0"
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
            tone
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug font-medium">
            {event.status === "ready" ? "Application prepared" : title}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <time
              dateTime={event.created_at}
              title={new Date(event.created_at).toLocaleString()}
            >
              {relativeTime(event.created_at)}
            </time>
            <span aria-hidden>·</span>
            <span>Version {event.revision}</span>
          </p>
        </div>
      </li>
    )
  }

  return (
    <section aria-label="Application history" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">History</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {events.length} {events.length === 1 ? "event" : "events"}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        {recent.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">
            No activity recorded yet.
          </p>
        ) : (
          <ol aria-label="Recent application activity" className="px-4">
            {recent.map(eventRow)}
          </ol>
        )}
        {earlier.length > 0 && (
          <details className="group border-t">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              Show {earlier.length} earlier{" "}
              {earlier.length === 1 ? "event" : "events"}
              <ChevronDown
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <ol
              aria-label="Earlier application activity"
              start={4}
              className="border-t px-4"
            >
              {earlier.map(eventRow)}
            </ol>
          </details>
        )}
      </div>
    </section>
  )
}
