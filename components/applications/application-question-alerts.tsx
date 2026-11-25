"use client"
import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, ChevronDown, CircleHelp } from "lucide-react"
import type { QuestionAlert } from "@/lib/applications/questions"

export function ApplicationQuestionAlerts({ pathname }: { pathname: string }) {
  const [alerts, setAlerts] = useState<QuestionAlert[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    const load = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const response = await fetch("/api/application-questions/alerts", {
          cache: "no-store",
        })
        if (response.status === 401) return
        if (!response.ok) throw new Error("Alerts unavailable")
        const data = await response.json()
        if (active) {
          setAlerts(data.alerts)
          setError(false)
        }
      } catch {
        if (active) setError(true)
      }
    }
    void load()
    const timer = setInterval(load, 15000)
    window.addEventListener("focus", load)
    window.addEventListener("application-questions-changed", load)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener("focus", load)
      window.removeEventListener("application-questions-changed", load)
    }
  }, [pathname])
  if (error)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Application alerts could not refresh.{" "}
        <Link href="/applications" className="underline">
          Check applications
        </Link>
      </p>
    )
  if (!alerts.length) return null
  return (
    <section
      aria-label="Applications need answers"
      className="overflow-hidden rounded-xl border border-amber-500/25 bg-card shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div role="status" className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            <CircleHelp className="size-4" />
          </span>
          <div>
            <p className="text-[13px] font-medium">
              {alerts.length} application{alerts.length === 1 ? "" : "s"} need
              {alerts.length === 1 ? "s" : ""} your answers
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Answer the missing questions to continue.
            </p>
          </div>
        </div>
        <Link
          href="/inbox"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9"
        >
          Open inbox <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      <details className="group border-t border-amber-500/15">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          View applications needing answers
          <ChevronDown
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-3 border-t px-4 py-3">
          <ul className="grid divide-y text-sm">
            {alerts.slice(0, 3).map((alert) => (
              <li
                key={alert.applicationId}
                className="min-w-0 py-2 first:pt-0 last:pb-0"
              >
                <Link
                  className="text-[13px] font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  href={`/applications/${alert.applicationId}`}
                >
                  {alert.company} · {alert.title}
                </Link>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {alert.questions
                    .slice(0, 2)
                    .map((q) => q.label)
                    .join(" · ")}
                  {alert.questions.length > 2
                    ? ` · ${alert.questions.length - 2} more`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <Link
              className="underline"
              href="/preferences#application-profile-section"
            >
              Complete your application profile
            </Link>
            {" · "}
            <Link className="underline" href="/applications/questions">
              Review saved answers
            </Link>
          </p>
        </div>
      </details>
    </section>
  )
}
