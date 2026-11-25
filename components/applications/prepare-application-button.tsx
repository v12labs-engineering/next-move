"use client"
import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, Check, LoaderCircle, WandSparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ApplicationRun } from "@/lib/applications"
import {
  employerAuthMessage,
  needsManualApplication,
  type ApplicationTask,
} from "@/lib/applications/pipeline"

export function PrepareApplicationButton({
  jobId,
  unavailableReason,
  compact = false,
}: {
  jobId: string
  unavailableReason?: string | null
  compact?: boolean
}) {
  const requesting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState("")
  const [error, setError] = useState("")
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!applicationId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch(`/api/applications/${applicationId}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        if (response.ok) {
          const { application, tasks } = (await response.json()) as {
            application: ApplicationRun
            tasks: ApplicationTask[]
          }
          if (controller.signal.aborted) return
          if (needsManualApplication(application, tasks)) {
            setManualUrl(application.target_url)
            return
          }
          if (
            ![
              "queued_prepare",
              "preparing",
              "queued",
              "running",
              "submitting",
            ].includes(application.status) &&
            !(
              application.status === "ready" &&
              application.auto_submit_requested_at
            )
          )
            return
        } else if ([401, 403, 404].includes(response.status)) {
          return
        }
      } catch {
        // A transient fetch failure can clear on the next status check.
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [applicationId])

  const manualNotice = manualUrl && (
    <span className="mt-1 block max-w-64 text-xs text-muted-foreground">
      <span role="status">{employerAuthMessage}</span>
      <a
        href={manualUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-1 flex items-center gap-1 font-medium text-primary underline"
      >
        Apply manually <ArrowUpRight aria-hidden className="size-3" />
      </a>
    </span>
  )
  const button = applicationId ? (
    <Button size="sm" variant="outline" asChild>
      <Link href={`/applications/${applicationId}`}>
        <Check />
        View application
      </Link>
    </Button>
  ) : (
    <Button
      size="sm"
      disabled={busy || !!unavailableReason}
      aria-busy={busy}
      title={
        unavailableReason ||
        "Add this job to your application queue. Jobs run one at a time."
      }
      aria-describedby={compact ? undefined : `apply-info-${jobId}`}
      onClick={async () => {
        if (requesting.current) return
        requesting.current = true
        setBusy(true)
        setError("")
        try {
          const r = await fetch("/api/applications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId, autoSubmit: true }),
          })
          const data = await r.json()
          if (!r.ok) throw new Error(data.error)
          setApplicationId(data.id)
          setConfirmation(
            ["queued_prepare", "queued"].includes(data.status)
              ? "Added to queue"
              : "Application saved"
          )
          window.dispatchEvent(new Event("application-questions-changed"))
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not prepare application."
          )
        } finally {
          requesting.current = false
          setBusy(false)
        }
      }}
    >
      {busy ? (
        <LoaderCircle className="animate-spin motion-reduce:animate-none" />
      ) : (
        <WandSparkles />
      )}
      {busy ? "Adding to queue…" : "Tailor & apply"}
    </Button>
  )
  if (compact)
    return (
      <span className="inline-flex flex-col items-end">
        {button}
        {manualNotice}
        {!manualUrl && confirmation && (
          <span role="status" className="mt-1 text-xs text-muted-foreground">
            {confirmation}
          </span>
        )}
        {error && (
          <span role="alert" className="mt-1 max-w-56 text-xs text-destructive">
            {error}
          </span>
        )}
      </span>
    )
  return (
    <div>
      {button}
      {manualNotice}
      {!manualUrl && confirmation && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {confirmation}
        </p>
      )}
      {!manualUrl && (
        <p
          id={`apply-info-${jobId}`}
          className="mt-1 max-w-64 text-xs text-muted-foreground"
        >
          {unavailableReason ||
            "Tailors your resume and applies automatically, one job at a time. We ask here for missing information and in Telegram for verification codes. Your resume is sent as a PDF through an isolated cloud browser."}
        </p>
      )}
      {error && (
        <p role="alert" className="max-w-64 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
