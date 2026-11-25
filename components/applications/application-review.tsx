"use client"
import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  ArrowUpRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Eye,
  LoaderCircle,
  Send,
} from "lucide-react"
import { AppShell } from "@/components/shell/app-shell"
import {
  ApplicationHistory,
  ApplicationStatusCard,
  type ApplicationEvent,
} from "@/components/applications/application-activity"
import { ApplicationResume } from "@/components/applications/application-resume"
import { ApplicationFollowup } from "@/components/applications/application-followup"
import { ApplicationTaskProgress } from "@/components/applications/application-task-progress"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  editableStatuses,
  missingAnswers,
  statusLabel,
  type ApplicationRun,
  type ApplicationPacket,
} from "@/lib/applications"
import { cn, relativeTime } from "@/lib/utils"
import { canReuseQuestion, type ReuseScope } from "@/lib/applications/questions"
import {
  assistanceStage,
  employerAuthMessage,
  needsManualApplication,
  type ApplicationTask,
} from "@/lib/applications/pipeline"

export { RunStatus } from "@/components/applications/application-activity"

const panel = "rounded-xl border bg-card shadow-xs"
const control =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-base shadow-none outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:bg-muted/40 disabled:opacity-100 sm:text-sm"

export function ApplicationReview({
  id,
  followupEnabled = false,
}: {
  id: string
  followupEnabled?: boolean
}) {
  const [run, setRun] = useState<ApplicationRun | null>(null),
    [packet, setPacket] = useState<ApplicationPacket | null>(null),
    [events, setEvents] = useState<ApplicationEvent[]>([])
  const [tasks, setTasks] = useState<ApplicationTask[]>([])
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [consent, setConsent] = useState(false)
  const loadedRevision = useRef<string | null>(null)
  const [remember, setRemember] = useState<Record<string, ReuseScope>>({})
  const [reuseChoices, setReuseChoices] = useState<Record<string, ReuseScope>>(
    {}
  )
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const r = await fetch(`/api/applications/${id}`, { cache: "no-store" })
        const d = await r.json()
        if (!r.ok) throw new Error(d.error)
        if (active) {
          setEvents(d.events)
          setTasks(d.tasks || [])
          setReuseChoices(d.reuseChoices || {})
          if (!dirty) {
            if (loadedRevision.current !== `${id}:${d.application.revision}`) {
              setConsent(false)
              setRemember({})
            }
            loadedRevision.current = `${id}:${d.application.revision}`
            setRun(d.application)
            setPacket(d.application.packet)
          }
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not load application."
          )
      }
    }
    void load()
    const timer = setInterval(load, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [id, dirty])
  async function action(path: string, method: string, body: unknown) {
    setBusy(true)
    setError("")
    try {
      const r = await fetch(`/api/applications/${id}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      const refreshed = await fetch(`/api/applications/${id}`, {
        cache: "no-store",
      })
      const data = await refreshed.json()
      if (!refreshed.ok) throw new Error(data.error)
      setRun(data.application)
      setPacket(data.application.packet)
      setEvents(data.events)
      setTasks(data.tasks || [])
      setReuseChoices(data.reuseChoices || {})
      setDirty(false)
      setConsent(false)
      setRemember({})
      window.dispatchEvent(new Event("application-questions-changed"))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save application.")
    } finally {
      setBusy(false)
    }
  }
  function answer(key: string, value: string | string[]) {
    if (!packet) return
    setPacket({ ...packet, answers: { ...packet.answers, [key]: value } })
    setDirty(true)
    setConsent(false)
    const scope = reuseChoices[key]
    if (scope) setRemember((current) => ({ [key]: scope, ...current }))
  }
  const applyManually = !!run && needsManualApplication(run, tasks)
  const editable =
    !!run && !applyManually && editableStatuses.includes(run.status)
  const missing = packet ? missingAnswers(packet) : []
  const questions =
    packet?.fields.filter((field) => field.kind !== "resume") ?? []
  const browserNeedsHelp =
    !!run &&
    tasks.some(
      (task) =>
        task.revision === run.revision &&
        !!assistanceStage(task.stage, run.status) &&
        task.state === "running" &&
        ["human_verification_required", "employer_control_help"].includes(
          task.error_code || ""
        )
    )
  const telegramNeedsCode =
    !!run?.automatic &&
    tasks.some(
      (task) =>
        task.revision === run.revision &&
        !!assistanceStage(task.stage, run.status) &&
        task.state === "running" &&
        task.error_code === "telegram_verification_required"
    )
  const preparing =
    !!run && ["queued_prepare", "preparing"].includes(run.status)
  const canRetry =
    !!run &&
    !applyManually &&
    ["needs_attention", "cancelled"].includes(run.status) &&
    (run.prepare_attempts === undefined || run.prepare_attempts < 3)
  const canRetryUnconfirmed = !!run && run.status === "submission_unknown"
  const canCancel =
    !!run &&
    [
      "queued_prepare",
      "preparing",
      "ready",
      "queued",
      "needs_attention",
    ].includes(run.status)
  return (
    <AppShell
      title={
        packet?.title || (run ? "Preparing your application" : "Application")
      }
      description={
        run ? (
          <>
            {packet?.company && (
              <span className="text-foreground/80">{packet.company} · </span>
            )}
            <span role="status">
              {applyManually
                ? "Manual application required"
                : statusLabel(run.status, run)}
            </span>
          </>
        ) : undefined
      }
      actions={
        run && (
          <Button variant="outline" asChild>
            <a href={run.target_url} target="_blank" rel="noreferrer">
              {applyManually ? "Apply manually" : "Open employer application"}
              <ArrowUpRight />
            </a>
          </Button>
        )
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
      {!run ? (
        <div
          role="status"
          aria-busy
          className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
        >
          <span className="sr-only">Loading application</span>
          <div className={cn(panel, "grid gap-4 p-4")}>
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} className="grid gap-2">
                <span className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                <span className="h-9 w-full animate-pulse rounded-md bg-muted/70" />
              </span>
            ))}
          </div>
          <div className={cn(panel, "grid h-fit gap-3 p-4")}>
            <span className="h-6 w-32 animate-pulse rounded-md bg-muted" />
            <span className="h-3 w-4/5 animate-pulse rounded bg-muted/70" />
            <span className="h-9 w-full animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
          <div className="grid min-w-0 gap-6">
            {applyManually && (
              <p role="status" className={cn(panel, "p-4 text-sm")}>
                {employerAuthMessage} Nothing has been submitted.
              </p>
            )}
            {telegramNeedsCode && (
              <section
                className={cn(panel, "space-y-3 p-4")}
                aria-live="polite"
              >
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <CircleAlert className="size-4" /> Verification code needed
                </h2>
                <p className="text-sm text-muted-foreground">
                  Reply to the latest code prompt in Telegram with the code sent
                  by the employer. We keep this application open for up to three
                  minutes and continue automatically after verification.
                </p>
                <p className="text-xs text-muted-foreground">
                  Codes are used only for this verification and are never saved
                  as application answers. Employer confirmation is still
                  required.
                </p>
              </section>
            )}
            {browserNeedsHelp && (
              <section
                className={cn(panel, "space-y-3 p-4")}
                aria-live="polite"
              >
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <CircleAlert className="size-4" /> The employer page needs
                  your attention
                </h2>
                <p className="text-sm text-muted-foreground">
                  {tasks.some(
                    (t) =>
                      t.revision === run.revision &&
                      t.state === "running" &&
                      t.error_code === "employer_control_help"
                  )
                    ? "Finish the reviewed fields in the same employer browser using your saved answers. Do not submit or navigate away. Sending is blocked while you help. We resume after the reviewed values match and recheck the entire form."
                    : run.status === "submitting"
                      ? "Open the same employer browser to complete verification or inspect the result. It stays available for up to three minutes. We recheck after verification. If the page already reports success, do not submit again. The app never repeats a submit action. Desktop works best for typing."
                      : "Open the same employer browser to sign in or complete verification. It stays available for up to three minutes. We continue automatically once the page is clear. Nothing has been submitted. Desktop works best for typing."}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  You control the employer page in this window. Changes made
                  there are not copied into your saved application answers.
                </p>
                <Button asChild>
                  <a
                    href={`/api/applications/${id}/browser?revision=${run.revision}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open employer browser <ArrowUpRight />
                  </a>
                </Button>
              </section>
            )}
            {run.receipt && (
              <section className={cn(panel, "overflow-hidden")}>
                <div className="flex flex-col gap-4 bg-emerald-500/8 p-5 ring-1 ring-emerald-500/30 ring-inset motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:fade-in sm:flex-row sm:items-center">
                  <svg
                    aria-hidden
                    viewBox="0 0 48 48"
                    className="size-12 shrink-0 text-emerald-600 dark:text-emerald-400"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="24" cy="24" r="21" className="opacity-30" />
                    <path
                      d="M15 24.5l6 6 12-13"
                      strokeDasharray="64"
                      className="motion-safe:animate-[draw_0.6s_0.2s_ease-out_both]"
                    />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-heading text-xl text-balance sm:text-2xl">
                      Submitted to {packet?.company || "the employer"}
                    </h2>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Confirmed by the employer{" "}
                      <time
                        dateTime={run.receipt.confirmedAt}
                        title={new Date(
                          run.receipt.confirmedAt
                        ).toLocaleString()}
                        suppressHydrationWarning
                      >
                        {relativeTime(run.receipt.confirmedAt)}
                      </time>
                    </p>
                  </div>
                  <Button asChild variant="outline" className="w-fit">
                    <Link href="/jobs">
                      Find similar roles <ArrowUpRight />
                    </Link>
                  </Button>
                </div>
                <div className="p-4">
                  <h2 className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300">
                    <CircleCheck className="size-4" />
                    Employer confirmation
                  </h2>
                  <p className="mt-2 text-sm whitespace-pre-line">
                    {run.receipt.text}
                  </p>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    Confirmed{" "}
                    {new Date(run.receipt.confirmedAt).toLocaleString()} ·
                    Approved version {run.approved_revision}
                  </p>
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      Receipt details
                    </summary>
                    <p className="mt-1 break-all">{run.receipt.url}</p>
                    <p className="break-all">
                      Resume SHA-256: {run.receipt.resumeHash}
                    </p>
                  </details>
                </div>
              </section>
            )}

            {followupEnabled &&
              run.status === "submitted" &&
              run.receipt &&
              run.job_id &&
              packet?.company.trim() && (
                <ApplicationFollowup
                  key={id}
                  id={id}
                  title={packet.title}
                  company={packet.company}
                />
              )}

            {packet ? (
              <>
                <section aria-label="Employer questions" className="space-y-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-sm font-semibold tracking-tight">
                      Employer questions
                    </h2>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {questions.length}{" "}
                      {questions.length === 1 ? "question" : "questions"}
                    </span>
                  </div>
                  <div className={cn(panel, "overflow-hidden")}>
                    <p className="border-b bg-muted/20 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
                      Review your details and complete any missing answers.
                      Salary, immigration, personal statements and consent are
                      never guessed.
                    </p>
                    <ul>
                      {questions.map((f) => {
                        const val = packet.answers[f.id] || ""
                        const evidence = packet.answerEvidence?.[f.id]
                        const selected = Array.isArray(val)
                          ? val
                          : val
                            ? [val]
                            : []
                        return (
                          <li
                            key={f.id}
                            className="grid gap-3 border-b p-4 last:border-b-0 sm:p-5"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <label
                                className="min-w-0 text-sm leading-relaxed font-medium wrap-break-word"
                                htmlFor={`answer-${f.id}`}
                              >
                                {f.label}
                                {f.required && (
                                  <span className="sr-only"> *</span>
                                )}
                              </label>
                              <span
                                aria-hidden
                                className="mt-0.5 shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                              >
                                {f.required ? "Required" : "Optional"}
                              </span>
                            </div>
                            {f.help && (
                              <p className="text-[13px] whitespace-pre-line text-muted-foreground">
                                {f.help}
                              </p>
                            )}
                            {packet.answerSources?.[f.id] === val && (
                              <p className="text-xs text-muted-foreground">
                                Suggested from a verbatim resume passage. Review
                                and adapt it before approval.
                              </p>
                            )}
                            {evidence &&
                              JSON.stringify(evidence.answer) ===
                                JSON.stringify(val) && (
                                <details className="group rounded-lg border border-dashed text-xs text-muted-foreground">
                                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                                    How this answer was filled
                                    <ChevronDown
                                      aria-hidden
                                      className="size-3.5 shrink-0 transition-transform group-open:rotate-180"
                                    />
                                  </summary>
                                  <p className="px-3 pb-3 leading-relaxed whitespace-pre-line">
                                    {evidence.source}
                                  </p>
                                  {evidence.confirmedAt && (
                                    <p className="px-3 pb-3">
                                      Profile confirmed{" "}
                                      {new Date(
                                        evidence.confirmedAt
                                      ).toLocaleDateString()}
                                    </p>
                                  )}
                                </details>
                              )}
                            {packet.rememberedAnswers?.[f.id] && (
                              <p className="flex items-start gap-1.5 text-xs text-primary dark:text-blue-300">
                                <CircleCheck
                                  aria-hidden
                                  className="mt-0.5 size-3.5 shrink-0"
                                />
                                Filled from your saved answer. You can change it
                                below.
                              </p>
                            )}
                            {f.kind === "unsupported" ? (
                              <p className="flex items-start gap-1.5 text-[13px] text-amber-700 dark:text-amber-300">
                                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                                {f.required
                                  ? "Automation is paused because this employer control is not supported yet."
                                  : "Optional unsupported field: left blank."}
                              </p>
                            ) : f.kind === "checkbox" &&
                              f.options.length > 0 ? (
                              <fieldset
                                className="grid gap-2"
                                aria-label={f.label}
                              >
                                {f.options.map((o) => (
                                  <label
                                    key={o}
                                    className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2.5 text-sm leading-relaxed hover:bg-muted/40"
                                  >
                                    <input
                                      type="checkbox"
                                      className="mt-0.5 size-4 accent-primary"
                                      disabled={!editable || busy}
                                      checked={selected.includes(o)}
                                      onChange={(e) =>
                                        answer(
                                          f.id,
                                          e.target.checked
                                            ? [...selected, o]
                                            : selected.filter((v) => v !== o)
                                        )
                                      }
                                    />
                                    {o}
                                  </label>
                                ))}
                              </fieldset>
                            ) : [
                                "select",
                                "radio",
                                "yesno",
                                "combobox",
                              ].includes(f.kind) && f.options.length > 0 ? (
                              <Select
                                required={f.required}
                                disabled={!editable || busy}
                                value={
                                  selected[0]
                                    ? `option-${f.options.indexOf(selected[0])}`
                                    : ""
                                }
                                onValueChange={(value) =>
                                  answer(
                                    f.id,
                                    value === "unanswered"
                                      ? ""
                                      : f.options[Number(value.slice(7))]
                                  )
                                }
                              >
                                <SelectTrigger
                                  className="w-full min-w-0"
                                  id={`answer-${f.id}`}
                                >
                                  <SelectValue placeholder="Choose an answer" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="unanswered">
                                    Choose an answer
                                  </SelectItem>
                                  {f.options.map((o, index) =>
                                    o ? (
                                      <SelectItem
                                        key={index}
                                        value={`option-${index}`}
                                      >
                                        {o}
                                      </SelectItem>
                                    ) : null
                                  )}
                                </SelectContent>
                              </Select>
                            ) : f.kind === "textarea" ||
                              f.kind === "cover_letter" ? (
                              <textarea
                                className={cn(
                                  control,
                                  f.kind === "cover_letter"
                                    ? "min-h-56 py-2"
                                    : "min-h-28 py-2"
                                )}
                                id={`answer-${f.id}`}
                                aria-required={f.required}
                                disabled={!editable || busy}
                                value={selected[0] || ""}
                                onChange={(e) => answer(f.id, e.target.value)}
                                maxLength={5000}
                              />
                            ) : (
                              <Input
                                id={`answer-${f.id}`}
                                type={
                                  [
                                    "select",
                                    "radio",
                                    "yesno",
                                    "combobox",
                                    "checkbox",
                                  ].includes(f.kind)
                                    ? "text"
                                    : f.kind
                                }
                                placeholder={
                                  [
                                    "select",
                                    "radio",
                                    "yesno",
                                    "combobox",
                                    "checkbox",
                                  ].includes(f.kind)
                                    ? "Type your answer"
                                    : undefined
                                }
                                aria-required={f.required}
                                className="h-11 rounded-lg bg-background shadow-none disabled:bg-muted/40 disabled:opacity-100 dark:bg-background dark:disabled:bg-muted/40"
                                disabled={!editable || busy}
                                value={selected[0] || ""}
                                onChange={(e) =>
                                  answer(
                                    f.id,
                                    f.kind === "checkbox"
                                      ? e.target.value
                                        ? [e.target.value]
                                        : []
                                      : e.target.value
                                  )
                                }
                                maxLength={5000}
                              />
                            )}
                            {editable &&
                              f.kind !== "unsupported" &&
                              canReuseQuestion(f) && (
                                <label className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                                  Reuse this answer
                                  <Select
                                    disabled={busy || !selected.length}
                                    value={
                                      remember[f.id] ??
                                      reuseChoices[f.id] ??
                                      "all"
                                    }
                                    onValueChange={(value) => {
                                      setRemember((current) => ({
                                        ...current,
                                        [f.id]: value as ReuseScope,
                                      }))
                                      setDirty(true)
                                      setConsent(false)
                                    }}
                                  >
                                    <SelectTrigger
                                      aria-label={`Reuse answer: ${f.label}`}
                                      size="sm"
                                      className="max-w-full text-xs text-foreground"
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="never">
                                        Ask again next time
                                      </SelectItem>
                                      <SelectItem value="employer">
                                        Reuse for this employer
                                      </SelectItem>
                                      <SelectItem value="all">
                                        Reuse across employers
                                      </SelectItem>
                                    </SelectContent>
                                  </Select>
                                </label>
                              )}
                            {editable &&
                              f.kind !== "unsupported" &&
                              !canReuseQuestion(f) && (
                                <p className="text-xs text-muted-foreground">
                                  Saved in your history. Consent and
                                  declarations must be confirmed for each
                                  application.
                                </p>
                              )}
                          </li>
                        )
                      })}
                    </ul>
                    {questions.length === 0 && (
                      <p className="p-4 text-[13px] text-muted-foreground">
                        {run.automatic && !run.receipt
                          ? "The agent will ask here only if it needs new information from you."
                          : "No additional employer questions."}
                      </p>
                    )}
                    <p className="border-t bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                      When you save or continue, your answers stay private and
                      are reused for matching questions in future applications.
                      You can change this for each answer.
                    </p>
                  </div>
                </section>

                <ApplicationResume
                  id={id}
                  revision={run.revision}
                  value={packet.resume}
                  readOnly={!editable}
                  busy={busy}
                  dirty={dirty}
                  onChange={(resume) => {
                    setPacket({ ...packet, resume })
                    setDirty(true)
                    setConsent(false)
                  }}
                />

                <details className="group overflow-hidden rounded-xl border bg-card shadow-xs">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    Employer notices, application limits and privacy information
                    <ChevronDown
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <p className="border-t px-4 py-3 text-[13px] leading-relaxed whitespace-pre-line text-muted-foreground">
                    {packet.notices ||
                      "Review the employer's application page for their privacy policy."}
                  </p>
                </details>
              </>
            ) : (
              <div className="rounded-lg border border-dashed px-6 py-10 text-center">
                {preparing ? (
                  <LoaderCircle className="mx-auto size-8 animate-spin text-muted-foreground/60" />
                ) : (
                  <CircleHelp className="mx-auto size-8 text-muted-foreground/60" />
                )}
                <p className="mt-3 font-heading text-lg">
                  {preparing
                    ? run.automatic
                      ? "Preparing your application"
                      : "Reading the employer form"
                    : "No application details yet"}
                </p>
                <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">
                  {canRetry
                    ? "Preparation stopped before saving the form. Load it again to review the employer's questions and your resume."
                    : canRetryUnconfirmed
                      ? "Try again to continue with your saved application."
                      : run.message ||
                        "Questions and your tailored resume appear here once preparation finishes."}
                </p>
                {canRetry && (
                  <Button
                    className="mt-4"
                    disabled={busy}
                    onClick={() =>
                      action("", "POST", {
                        action: "retry",
                        revision: run.revision,
                      })
                    }
                  >
                    {busy ? <LoaderCircle className="animate-spin" /> : <Eye />}
                    Load application form
                  </Button>
                )}
              </div>
            )}
          </div>

          <aside className="grid min-w-0 gap-6 self-start">
            <ApplicationStatusCard run={run}>
              {packet && editable && (
                <div className="grid gap-3 border-t p-4">
                  <div
                    className={cn(
                      "grid gap-2",
                      ["ready", "needs_attention"].includes(run.status) &&
                        "grid-cols-2"
                    )}
                  >
                    {["ready", "needs_attention"].includes(run.status) && (
                      <Button
                        variant="outline"
                        className="min-h-11 min-w-0 rounded-lg px-2 text-xs whitespace-normal shadow-none"
                        aria-label="Fill saved answers and resume details"
                        disabled={busy}
                        onClick={() =>
                          action("", "POST", {
                            action: "autofill",
                            revision: run.revision,
                            answers: packet.answers,
                            resume: packet.resume,
                            remember,
                          })
                        }
                      >
                        Use saved answers
                      </Button>
                    )}
                    {
                      <Button
                        variant="outline"
                        className="min-h-11 min-w-0 rounded-lg px-2 text-xs whitespace-normal shadow-none"
                        disabled={busy || !dirty}
                        onClick={() =>
                          action("", "PATCH", {
                            revision: run.revision,
                            answers: packet.answers,
                            resume: packet.resume,
                            remember,
                          })
                        }
                      >
                        {run.automatic
                          ? "Save & continue"
                          : "Save changes for review"}
                      </Button>
                    }
                  </div>
                  {dirty && (
                    <p className="text-[13px] text-amber-700 dark:text-amber-300">
                      {run.automatic
                        ? "Saving your answers resumes auto-apply once all required information is complete."
                        : "Saving any change removes your previous approval."}
                    </p>
                  )}
                  {missing.length > 0 && (
                    <p className="flex items-start gap-1.5 text-[13px] text-amber-700 dark:text-amber-300">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      {missing.length} question
                      {missing.length === 1 ? " needs" : "s need"} an answer.
                    </p>
                  )}
                  {!run.automatic && (
                    <label className="flex items-start gap-2.5 text-xs leading-relaxed text-muted-foreground">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={consent}
                        disabled={busy || dirty || run.status !== "ready"}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>
                        I reviewed this exact resume, every answer and the
                        employer notices. I authorize sending this application
                        to {packet.company} using an isolated cloud browser. The
                        employer and browser provider will receive the
                        application data shown here.
                      </span>
                    </label>
                  )}
                  {run.automatic && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Auto-apply is enabled for {packet.company}. Save any new
                      answers and the application will continue automatically.
                      No separate approval is needed.
                    </p>
                  )}
                  {(!run.automatic || missing.length > 0 || dirty) && (
                    <Button
                      className="min-h-11 w-full rounded-lg shadow-none hover:bg-primary/90 active:translate-y-0 active:shadow-none"
                      disabled={
                        busy ||
                        (!run.automatic && (dirty || !consent)) ||
                        missing.length > 0 ||
                        !(
                          run.status === "ready" ||
                          (run.automatic && run.status === "needs_attention")
                        )
                      }
                      onClick={() =>
                        action(
                          run.automatic ? "" : "/approve",
                          run.automatic ? "PATCH" : "POST",
                          {
                            revision: run.revision,
                            ...(!run.automatic ? { consent: true } : {}),
                            ...(run.automatic
                              ? {
                                  answers: packet.answers,
                                  resume: packet.resume,
                                  remember,
                                }
                              : {}),
                          }
                        )
                      }
                    >
                      {busy ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Send />
                      )}
                      {busy
                        ? "Continuing…"
                        : run.automatic
                          ? "Save & continue"
                          : "Approve & submit application"}
                    </Button>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Status changes to submitted only after employer
                    confirmation.{" "}
                    {run.automatic
                      ? "You'll only be asked for missing answers or a verification code."
                      : "Human verification pauses automation."}
                  </p>
                </div>
              )}

              {(canRetry || canRetryUnconfirmed || canCancel) && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2">
                  {canRetryUnconfirmed && (
                    <div className="space-y-2 py-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          action("", "POST", {
                            action: "retry_unconfirmed",
                            revision: run.revision,
                          })
                        }
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                  {canRetry && packet && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 rounded-lg border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-muted"
                      disabled={busy}
                      onClick={() =>
                        action("", "POST", {
                          action: "retry",
                          revision: run.revision,
                        })
                      }
                    >
                      Retry preparation
                    </Button>
                  )}
                  {canCancel && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 rounded-lg px-2 text-xs text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={() =>
                        action("", "POST", {
                          action: "cancel",
                          revision: run.revision,
                        })
                      }
                    >
                      Cancel application
                    </Button>
                  )}
                </div>
              )}
            </ApplicationStatusCard>

            <ApplicationTaskProgress
              run={run}
              tasks={tasks}
              busy={busy}
              onRetry={(task) =>
                action("", "POST", {
                  action: "retry_step",
                  revision: run.revision,
                  stage: task.stage,
                })
              }
            />

            <ApplicationHistory events={events} />
          </aside>
        </div>
      )}
    </AppShell>
  )
}
