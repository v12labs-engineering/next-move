"use client"

import { useEffect, useId, useState } from "react"
import { ArrowUpRight, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { followupMessage } from "@/lib/applications/followup"
import type { FollowupContact } from "@/lib/server/applications/followup"

type FollowupProps = { title: string; company: string } & (
  | { id: string; jobId?: never }
  | { id?: never; jobId: string }
)

function FollowupPerson({
  person,
  title,
  company,
}: {
  person: FollowupContact
  title: string
  company: string
}) {
  const [copyFeedback, setCopyFeedback] = useState("")
  const message = followupMessage(person, title, company)

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message)
      setCopyFeedback("Message copied.")
    } catch {
      setCopyFeedback("Couldn’t copy. Select the message to copy it manually.")
    }
  }

  return (
    <li className="space-y-2.5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium break-words">{person.name}</p>
          <p className="break-words text-muted-foreground">
            {person.title} · {person.reason}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a
            href={person.profileUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${person.name}’s LinkedIn profile`}
          >
            LinkedIn <ArrowUpRight />
          </a>
        </Button>
      </div>
      <p className="rounded-md bg-muted/50 p-2.5 text-sm leading-relaxed break-words select-text">
        {message}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Copy message for ${person.name}`}
          onClick={copyMessage}
        >
          <Copy /> Copy message
        </Button>
        <p role="status" className="text-xs text-muted-foreground">
          {copyFeedback}
        </p>
      </div>
    </li>
  )
}

export function ApplicationFollowup({
  id,
  jobId,
  title,
  company,
}: FollowupProps) {
  const heading = useId()
  const [contacts, setContacts] = useState<FollowupContact[] | null>(null)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const busy = contacts === null && !error

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>

    async function loadContacts(remaining: number) {
      try {
        const response = await fetch(
          jobId
            ? "/api/applications/manual-followup"
            : `/api/applications/${id}/followup`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(jobId ? { jobId } : {}),
            signal: controller.signal,
          }
        )
        if (controller.signal.aborted) return
        if (response.status === 202 && remaining > 0) {
          timer = setTimeout(() => void loadContacts(remaining - 1), 3_000)
          return
        }
        const data = await response.json()
        if (!response.ok || response.status === 202) throw new Error(data.error)
        if (!Array.isArray(data.contacts))
          throw new Error("Contact lookup is unavailable.")
        if (!controller.signal.aborted) setContacts(data.contacts)
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error && error.message
              ? error.message
              : "Contact lookup is unavailable."
          )
      }
    }

    void loadContacts(6)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [id, jobId, retry])

  return (
    <section
      aria-labelledby={jobId ? undefined : heading}
      aria-label={jobId ? `Follow up on ${title}` : undefined}
      className={
        jobId
          ? "space-y-2"
          : "space-y-3 rounded-xl border bg-card p-4 shadow-xs"
      }
    >
      <h2 id={jobId ? undefined : heading} className="text-sm font-semibold">
        Follow up on your application
      </h2>
      {error && (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setError("")
              setRetry((attempt) => attempt + 1)
            }}
          >
            Retry suggestions
          </Button>
        </>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          Finding people to contact…
        </p>
      )}
      <div aria-live="polite" aria-busy={busy}>
        {contacts?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No matching profiles found at this company.
          </p>
        )}
        {!!contacts?.length && (
          <>
            <ul className="divide-y rounded-lg border">
              {contacts.map((person) => (
                <FollowupPerson
                  key={person.profileUrl}
                  person={person}
                  title={title}
                  company={company}
                />
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Suggestions are based on job titles and company affiliation.
              Profile data from BlitzAPI via Firecrawl Alexandria.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
