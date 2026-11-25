"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

type Status = {
  configured: boolean
  connection: { label: string; connected_at: string } | null
  pending: { label: string | null; expiresAt: string } | null
}
async function load(signal?: AbortSignal): Promise<Status> {
  const response = await fetch("/api/notifications/telegram", {
    cache: "no-store",
    signal,
  })
  if (!response.ok) throw new Error("Telegram settings could not be loaded.")
  return response.json()
}
export function TelegramSettings() {
  const [status, setStatus] = useState<Status | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Telegram settings could not be loaded.")
      })
    return () => controller.abort()
  }, [])
  const waiting = !!url || !!status?.pending
  useEffect(() => {
    if (!waiting) return
    const controller = new AbortController()
    const refresh = () => {
      if (document.visibilityState !== "hidden")
        void load(controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) {
              setStatus(value)
              setError("")
              if (!value.pending || value.connection) setUrl(null)
            }
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setError("Connection status could not refresh. Try again.")
          })
    }
    const timer = setInterval(refresh, 5000)
    window.addEventListener("focus", refresh)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
    }
  }, [waiting])
  async function act(action: "connect" | "confirm" | "disconnect") {
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/notifications/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(data.error || "Telegram settings could not be updated.")
      setUrl(data.url || null)
      setStatus(await load())
    } catch (error) {
      setError(error instanceof Error ? error.message : "Try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      id="telegram-notifications"
      aria-labelledby="telegram-heading"
      className="mb-6 grid gap-4 rounded-xl border bg-card p-4 shadow-xs sm:p-6"
    >
      <div>
        <h2
          id="telegram-heading"
          className="text-sm font-semibold tracking-tight"
        >
          Telegram application notifications
        </h2>
        <p className="mt-1.5 max-w-[65ch] text-[13px] leading-relaxed text-muted-foreground">
          Get missing application questions on Telegram. Approve a suggested
          answer, edit it, and confirm when to continue.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!status && !error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading Telegram settings…
        </p>
      ) : !status ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void load()
              .then((value) => {
                setStatus(value)
                setError("")
              })
              .catch(() => setError("Telegram settings could not be loaded."))
          }}
        >
          Reload connection status
        </Button>
      ) : !status.configured ? (
        <p className="text-sm text-muted-foreground">
          Telegram notifications are not available yet. Application questions
          remain available in the app.
        </p>
      ) : status.connection ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm">
            Connected: {status.connection.label}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void act("disconnect")}
          >
            Disconnect Telegram
          </Button>
        </div>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I want application notifications on Telegram. Employer questions
              and my answers will be shared through Telegram. I can disconnect
              here or reply STOP.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={busy || !consent}
              onClick={() => void act("connect")}
            >
              {url ? "Get a new connection link" : "Connect Telegram"}
            </Button>
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline underline-offset-4"
              >
                Open Telegram and tap Start
              </a>
            ) : null}
          </div>
          {waiting ? (
            <p role="status" className="text-sm text-muted-foreground">
              Tap Start in the bot chat from your Telegram account. Return here
              to confirm the account within ten minutes.
            </p>
          ) : null}
          {status.pending?.label ? (
            <div className="grid justify-items-start gap-2">
              <p className="text-sm">
                Confirm this is your account:{" "}
                <strong>{status.pending.label}</strong>
              </p>
              <Button
                type="button"
                disabled={busy || !consent}
                onClick={() => void act("confirm")}
              >
                Confirm & enable notifications
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
