"use client"

import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  LoaderCircle,
  Pause,
  RotateCcw,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  applicationProgressSteps,
  canRetryApplicationStep,
  type ApplicationTask,
} from "@/lib/applications/pipeline"
import { statusLabel, type ApplicationRun } from "@/lib/applications"
import { cn, relativeTime } from "@/lib/utils"

const tones = {
  done: {
    icon: Check,
    color: "text-emerald-700 dark:text-emerald-300",
    surface: "bg-emerald-500/10",
    segment: "bg-emerald-500",
    label: "Complete",
  },
  running: {
    icon: LoaderCircle,
    color: "text-primary dark:text-blue-300",
    surface: "bg-primary/8",
    segment: "bg-primary motion-safe:animate-pulse",
    label: "In progress",
  },
  waiting: {
    icon: Clock,
    color: "text-muted-foreground",
    surface: "bg-muted",
    segment: "bg-muted-foreground/15",
    label: "Pending",
  },
  retry: {
    icon: RotateCcw,
    color: "text-amber-700 dark:text-amber-300",
    surface: "bg-amber-500/10",
    segment: "bg-amber-500",
    label: "Retry scheduled",
  },
  blocked: {
    icon: CircleAlert,
    color: "text-amber-700 dark:text-amber-300",
    surface: "bg-amber-500/10",
    segment: "bg-amber-500",
    label: "Needs attention",
  },
  stopped: {
    icon: Pause,
    color: "text-muted-foreground",
    surface: "bg-muted",
    segment: "bg-muted-foreground/40",
    label: "Paused",
  },
  failed: {
    icon: X,
    color: "text-destructive",
    surface: "bg-destructive/10",
    segment: "bg-destructive",
    label: "Retries exhausted",
  },
}
type StepTone = keyof typeof tones

export function ApplicationTaskProgress({
  run,
  tasks,
  busy,
  onRetry,
}: {
  run: ApplicationRun
  tasks: ApplicationTask[]
  busy: boolean
  onRetry: (task: ApplicationTask) => void
}) {
  const steps = applicationProgressSteps(tasks, run).map(
    ({ stage, label, task }) => {
      const tone: StepTone =
        task?.state === "retry_wait"
          ? ["queued_prepare", "preparing", "queued", "running"].includes(
              run.status
            )
            ? "retry"
            : "stopped"
          : task?.state === "blocked"
            ? "blocked"
            : task?.state === "failed"
              ? "failed"
              : task?.state === "running"
                ? ["preparing", "running", "submitting"].includes(run.status)
                  ? "running"
                  : "stopped"
                : task?.state === "completed" ||
                    (stage === "confirm" && run.receipt)
                  ? "done"
                  : "waiting"
      return { stage, label, task, tone }
    }
  )
  const done = steps.filter((step) => step.tone === "done").length
  const current = run.receipt
    ? undefined
    : (steps.find((step) =>
        ["blocked", "failed", "retry"].includes(step.tone)
      ) ??
      steps.find((step) => ["running", "stopped"].includes(step.tone)) ??
      steps.find((step) => step.tone === "waiting"))
  const currentIndex = current ? steps.indexOf(current) : -1
  const next = steps
    .slice(currentIndex + 1)
    .find((step) => step.tone === "waiting")
  const cancelled = run.status === "cancelled"
  const tone =
    tones[
      cancelled
        ? "stopped"
        : run.status === "submission_unknown"
          ? "blocked"
          : (current?.tone ?? "done")
    ]
  const Icon = !cancelled && !current && run.receipt ? CircleCheck : tone.icon
  const currentStatus = cancelled
    ? "Cancelled"
    : run.status === "submission_unknown"
      ? "Ready to retry"
      : run.receipt
        ? "Submission confirmed"
        : current?.tone === "waiting"
          ? statusLabel(run.status, run)
          : tone.label

  function retryButton(task: ApplicationTask | undefined) {
    return task && canRetryApplicationStep(task, run) ? (
      <Button
        variant="outline"
        size="sm"
        className="mt-3 min-h-11 gap-2"
        disabled={busy}
        onClick={() => onRetry(task)}
      >
        <RotateCcw aria-hidden className="size-3.5" />
        Retry this step
      </Button>
    ) : null
  }

  function retryTime(task: ApplicationTask | undefined) {
    return task?.next_retry_at &&
      ["queued_prepare", "queued"].includes(run.status) ? (
      <p className="mt-2 text-xs text-muted-foreground">
        Retry after{" "}
        <time dateTime={task.next_retry_at}>
          {new Date(task.next_retry_at).toLocaleString()}
        </time>
      </p>
    ) : null
  }

  return (
    <section aria-label="Application progress" className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Application progress
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{done}</span> /{" "}
          {steps.length} complete
        </span>
      </div>

      <div
        role="progressbar"
        aria-label="Tasks completed"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${steps.length} tasks complete`}
        className="flex gap-1.5"
      >
        {steps.map((step) => (
          <span
            key={step.stage}
            aria-hidden
            className={cn(
              "h-1.5 flex-1 rounded-full",
              tones[step.tone].segment
            )}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="p-4" aria-live="polite" aria-atomic="true">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-2 text-xs font-medium",
                tone.color
              )}
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-lg",
                  tone.surface
                )}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    "size-3.5",
                    !cancelled &&
                      current?.tone === "running" &&
                      "motion-safe:animate-spin"
                  )}
                />
              </span>
              {currentStatus}
            </span>
            {current && !cancelled && (
              <span className="font-mono text-[11px] text-muted-foreground">
                STEP {String(currentIndex + 1).padStart(2, "0")}
              </span>
            )}
          </div>
          <p className="text-lg leading-snug font-medium tracking-tight text-balance">
            {cancelled
              ? "Application cancelled"
              : run.status === "submission_unknown"
                ? "Try this application again"
                : (current?.label ??
                  (run.receipt
                    ? "Employer receipt verified"
                    : "All tasks complete"))}
          </p>
          {current?.task?.message && (
            <p className="mt-2 text-[13px] leading-relaxed wrap-break-word text-muted-foreground">
              {run.status === "submission_unknown"
                ? "Try again to continue with your saved application."
                : current.task.message}
            </p>
          )}
          {current?.task && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {current.task.attempts > 1 && (
                <span>Attempt {current.task.attempts}</span>
              )}
              <time
                dateTime={current.task.updated_at}
                title={new Date(current.task.updated_at).toLocaleString()}
              >
                Updated {relativeTime(current.task.updated_at)}
              </time>
            </p>
          )}
          {retryTime(current?.task)}
          {retryButton(current?.task)}
        </div>
        {next && !cancelled && current?.tone === "running" && (
          <div className="flex items-start gap-2 border-t bg-muted/30 px-4 py-3 text-xs">
            <ArrowRight
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
            <p className="leading-relaxed text-muted-foreground">
              Up next <span className="ml-1 text-foreground">{next.label}</span>
            </p>
          </div>
        )}
      </div>

      <details className="group rounded-xl border bg-card">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          View all {steps.length} tasks
          <ChevronDown
            aria-hidden
            className="size-3.5 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
          />
        </summary>
        <ol className="border-t px-4">
          {steps.map(({ stage, label, task, tone: stepTone }, index) => {
            const style = tones[stepTone]
            const StepIcon = style.icon
            return (
              <li
                key={stage}
                aria-current={
                  stage === current?.stage && !cancelled ? "step" : undefined
                }
                className="border-b py-3 last:border-0"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p
                    className={cn(
                      "min-w-0 flex-1 text-[13px] leading-snug",
                      stepTone === "running"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {label}
                    {!task && <span className="sr-only">: {style.label}</span>}
                  </p>
                  {stepTone !== "waiting" && (
                    <StepIcon
                      aria-hidden
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        style.color,
                        stepTone === "running" && "motion-safe:animate-spin"
                      )}
                    />
                  )}
                </div>
                {task && (
                  <div className="mt-1.5 pl-6 text-xs leading-relaxed wrap-break-word text-muted-foreground">
                    <p>
                      {style.label}
                      {task.attempts > 1
                        ? ` · Attempt ${task.attempts}`
                        : ""} ·{" "}
                      <time
                        dateTime={task.updated_at}
                        title={new Date(task.updated_at).toLocaleString()}
                      >
                        {relativeTime(task.updated_at)}
                      </time>
                    </p>
                    {task.message && (
                      <p className="mt-1">
                        {run.status === "submission_unknown" &&
                        ["submit", "confirm"].includes(stage)
                          ? "Try again to continue with your saved application."
                          : task.message}
                      </p>
                    )}
                    {stage !== current?.stage && (
                      <>
                        {retryTime(task)}
                        {retryButton(task)}
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </details>
    </section>
  )
}
