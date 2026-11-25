"use client"
import { useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import {
  ArrowUpRight,
  ChevronDown,
  Clock,
  Flame,
  FileText,
  Send,
  Star,
  X,
} from "lucide-react"

import type { Job, JobStatus } from "@/lib/jobs"
import { indiaJobBoardCredit } from "@/lib/jobs/india-job-boards"
import {
  employmentTypeLabels,
  experienceLevelLabels,
  formatPostedSalary,
} from "@/lib/jobs/posting-details"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { VisaSignal } from "@/components/jobs/visa-signal"
import { cn, relativeTime, webUrl } from "@/lib/utils"
import { MatchScore } from "@/components/jobs/match-score"
import { applicationUnavailableReason } from "@/lib/applications"
import { CompanyMark } from "@/components/jobs/company-mark"
import { PrepareApplicationButton } from "@/components/applications/prepare-application-button"

const statusLabels: Record<JobStatus, string> = {
  new: "New",
  interested: "Interested",
  applied: "Applied",
  dismissed: "Dismissed",
}

function fitLabel(match: Job["match"]) {
  if (!match) return null
  if (match.eligible) return { text: "Strong fit", tone: "text-primary" }
  if (match.relevant)
    return { text: "Relevant · details to confirm", tone: "text-foreground/80" }
  return { text: "Review fit", tone: "text-muted-foreground" }
}

function isEmployerFeed(job: Job) {
  return /^(ashby|greenhouse|lever):/.test(job.source)
}

export function JobRow({
  job,
  onStatus,
  disabled = false,
  active = false,
  expanded: expandedProp,
  leaving = false,
  needsVisa = true,
  onActivate,
  onToggle,
  children,
}: {
  job: Job
  disabled?: boolean
  active?: boolean
  expanded?: boolean
  leaving?: boolean
  needsVisa?: boolean
  onActivate?: () => void
  onToggle?: () => void
  onStatus: (id: string, s: JobStatus) => void
  children?: ReactNode
}) {
  const [expandedLocal, setExpandedLocal] = useState(false)
  const expanded = expandedProp ?? expandedLocal
  const boardCredit = indiaJobBoardCredit(job.source, job.url)
  const [description, setDescription] = useState<string | null>(
    job.description ?? null
  )
  const [descriptionError, setDescriptionError] = useState("")
  const [descriptionAttempt, setDescriptionAttempt] = useState(0)
  useEffect(() => {
    if (!expanded || description !== null) return
    const controller = new AbortController()
    async function loadDescription() {
      try {
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(job.id)}/description`,
          { signal: controller.signal }
        )
        const data = await response.json()
        if (!response.ok)
          throw new Error(data.error || "Could not load the job description.")
        if (!controller.signal.aborted) {
          setDescription(data.description ?? "")
          setDescriptionError("")
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setDescriptionError(
            error instanceof Error
              ? error.message
              : "Could not load the job description."
          )
      }
    }
    void loadDescription()
    return () => controller.abort()
  }, [expanded, description, job.id, descriptionAttempt])
  const fit = fitLabel(job.match)
  const posting = job.postingDetails
  const gaps =
    job.match?.gaps.filter((g) => !g.startsWith("Title does not")) ?? []

  return (
    <li
      data-job-id={job.id}
      tabIndex={-1}
      onFocus={onActivate}
      onMouseEnter={onActivate}
      className={cn(
        "group/row relative scroll-my-24 border-b outline-none last:border-b-0",
        "transition-[background-color,opacity,translate] duration-200 ease-out-expo",
        active && "bg-accent/45",
        leaving && "pointer-events-none translate-x-6 opacity-0"
      )}
    >
      <div className="grid grid-cols-1 items-start gap-x-4 gap-y-2 px-4 py-3.5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          {job.match && (
            <MatchScore
              score={job.match.score}
              reasons={job.match.reasons}
              gaps={job.match.gaps}
            />
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <a
                href={webUrl(job.url)}
                target="_blank"
                rel="noreferrer"
                className="group/link inline-flex min-w-0 items-center gap-1 font-medium decoration-primary/40 underline-offset-4 hover:underline"
              >
                <span className="truncate">{job.title}</span>
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out-expo group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5" />
              </a>
              {job.status !== "new" && (
                <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
                  {statusLabels[job.status]}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground">
              <span className="flex min-w-0 items-center gap-1.5">
                <CompanyMark
                  name={job.company}
                  url={job.url}
                  className="size-4 rounded-[4px] text-[8px]"
                />
                <span className="truncate">
                  <span className="text-foreground/80">{job.company}</span> ·{" "}
                  {job.city ? `${job.city}, ` : ""}
                  {job.country}
                  {job.remote !== "unknown" && ` · ${job.remote}`}
                </span>
              </span>
              {fit && (
                <span className={cn("font-medium", fit.tone)}>{fit.text}</span>
              )}
              {boardCredit && (
                <a
                  href={webUrl(boardCredit.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {boardCredit.name}
                </a>
              )}
              {job.postedDate && (
                <time
                  dateTime={job.postedDate}
                  title={new Date(job.postedDate).toLocaleDateString(
                    undefined,
                    { dateStyle: "medium" }
                  )}
                  suppressHydrationWarning
                  className={cn(
                    "inline-flex items-center gap-1",
                    job.freshness === "fresh" &&
                      "font-medium text-orange-600 dark:text-orange-400"
                  )}
                >
                  {job.freshness === "fresh" ? (
                    <Flame className="size-3.5" />
                  ) : (
                    <Clock className="size-3.5" />
                  )}
                  {boardCredit?.dateLabel ?? "Posted"}{" "}
                  {relativeTime(job.postedDate)}
                </time>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 sm:justify-end">
          <div
            className={cn(
              "flex items-center gap-1 transition-opacity duration-150 sm:opacity-0 sm:group-focus-within/row:opacity-100 sm:group-hover/row:opacity-100",
              active && "sm:opacity-100"
            )}
          >
            <Button variant="ghost" size="icon-sm" asChild>
              <Link
                href={`/resumes/new?job=${encodeURIComponent(job.id)}`}
                title="Tailor resume only (T)"
                aria-label="Tailor resume only"
                aria-keyshortcuts="t"
              >
                <FileText />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Interested (I)"
              aria-label="Mark interested"
              aria-keyshortcuts="i"
              disabled={disabled}
              onClick={() => onStatus(job.id, "interested")}
            >
              <Star />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Mark applied (A)"
              aria-label="Mark applied"
              aria-keyshortcuts="a"
              disabled={disabled}
              onClick={() => onStatus(job.id, "applied")}
            >
              <Send />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Dismiss (D)"
              aria-label="Dismiss"
              aria-keyshortcuts="d"
              disabled={disabled}
              onClick={() => onStatus(job.id, "dismissed")}
              className="hover:text-destructive"
            >
              <X />
            </Button>
          </div>
          <PrepareApplicationButton
            compact
            jobId={job.id}
            unavailableReason={applicationUnavailableReason(job)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide details" : "Show details"}
            onClick={onToggle ?? (() => setExpandedLocal((value) => !value))}
          >
            <ChevronDown
              className={cn(
                "transition-transform duration-200 ease-out-expo",
                expanded && "rotate-180"
              )}
            />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="grid animate-in gap-5 border-t border-dashed px-4 py-4 duration-200 ease-out-expo fade-in slide-in-from-top-1 sm:grid-cols-[1fr_auto]">
          <div className="min-w-0 space-y-3 text-sm">
            {needsVisa && <VisaSignal value={job.visaSignal} />}
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              <div>
                <dt className="text-xs text-muted-foreground">Salary</dt>
                <dd>
                  {posting?.salary
                    ? formatPostedSalary(posting.salary)
                    : "Unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Employment type
                </dt>
                <dd>
                  {posting?.employmentTypes
                    ?.map((type) => employmentTypeLabels[type])
                    .join(", ") || "Unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Experience level
                </dt>
                <dd>
                  {posting?.experienceLevel
                    ? experienceLevelLabels[posting.experienceLevel]
                    : "Unknown"}
                </dd>
              </div>
            </dl>
            {job.isActive === false && (
              <p className="text-muted-foreground">
                No longer in the current source feed.
              </p>
            )}
            {job.match && job.match.reasons.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-semibold tracking-tight">
                  Why it fits
                </h3>
                <ul className="space-y-1">
                  {job.match.reasons.map((reason) => (
                    <li key={reason} className="flex gap-2">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-primary" />
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {gaps.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-semibold tracking-tight">
                  To confirm
                </h3>
                <ul className="space-y-1 text-muted-foreground">
                  {gaps.map((gap) => (
                    <li key={gap} className="flex gap-2">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-amber-500" />
                      {gap}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <section aria-label="Job description" className="space-y-2">
              <h3 className="text-sm font-semibold tracking-tight">
                Job description
              </h3>
              {descriptionError ? (
                <div role="alert" className="text-muted-foreground">
                  <p>{descriptionError}</p>
                  <Button
                    variant="link"
                    size="sm"
                    className="px-0"
                    onClick={() => {
                      setDescriptionError("")
                      setDescriptionAttempt((attempt) => attempt + 1)
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : description === null ? (
                <p role="status" className="text-muted-foreground">
                  Loading job description…
                </p>
              ) : description.trim() ? (
                <p className="leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {description}
                </p>
              ) : (
                <p className="text-muted-foreground">
                  No description is available for this listing.{" "}
                  <a
                    href={webUrl(job.url)}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    View the original posting
                  </a>
                  .
                </p>
              )}
            </section>
            <p className="text-xs text-muted-foreground">
              {job.sponsorVerified && (
                <span className="font-medium text-emerald-700 dark:text-emerald-300">
                  Verified sponsor ·{" "}
                </span>
              )}
              Source:{" "}
              {boardCredit ? (
                <a
                  href={webUrl(boardCredit.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {boardCredit.name}
                </a>
              ) : isEmployerFeed(job) ? (
                `${job.company} careers`
              ) : (
                <a
                  className="underline underline-offset-2"
                  href="https://www.arbeitnow.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  {job.source}
                </a>
              )}
              {job.postedDate ? "" : " · Posting date unknown"}
              {job.lastCheckedAt
                ? ` · Checked ${relativeTime(job.lastCheckedAt)}`
                : ""}
              . Confirm requirements with the employer before applying.
            </p>
          </div>
          <div className="flex max-w-64 flex-col gap-1 sm:items-end sm:text-right">
            <p className="text-xs text-muted-foreground">
              {applicationUnavailableReason(job) ||
                "Tailor & apply uses your tailored draft for this job (or tailors one now) and sends it as a PDF. Missing answers are requested before sending."}
            </p>
            <Button variant="link" size="sm" asChild className="px-0">
              <Link href={`/resumes/new?job=${encodeURIComponent(job.id)}`}>
                <FileText />
                Tailor resume only
              </Link>
            </Button>
          </div>
        </div>
      )}
      {children && <div className="px-4 pb-3.5">{children}</div>}
    </li>
  )
}

export function TriageHints() {
  return (
    <p className="hidden items-center gap-3 text-xs text-muted-foreground lg:flex">
      <span className="flex items-center gap-1">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd> move
      </span>
      <span className="flex items-center gap-1">
        <Kbd>↵</Kbd> details
      </span>
      <span className="flex items-center gap-1">
        <Kbd>T</Kbd> tailor
      </span>
      <span className="flex items-center gap-1">
        <Kbd>I</Kbd> interested
      </span>
      <span className="flex items-center gap-1">
        <Kbd>A</Kbd> applied
      </span>
      <span className="flex items-center gap-1">
        <Kbd>D</Kbd> dismiss
      </span>
    </p>
  )
}
