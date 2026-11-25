import Browserbase from "@browserbasehq/sdk"
import { z } from "zod"
import type { Page } from "playwright-core"
import { TelegramVerificationBridge } from "./telegram-verification-bridge"
import { HttpError } from "@/lib/server/http"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { ownedApplication, type ApplicationAccount } from "./store"
import { notifyBrowserAssistance } from "@/lib/server/telegram/browser-assistance"
import {
  assistanceStages,
  HUMAN_VERIFICATION_WAIT_MS,
  ApplicationSubmissionError,
  type AssistanceStage,
} from "@/lib/applications/pipeline"

export { HUMAN_VERIFICATION_WAIT_MS } from "@/lib/applications/pipeline"
const assistanceSchema = z.object({
  // Browserbase uses UUIDs; Boat sessions use opaque bx_ identifiers.
  sessionId: z.union([z.uuid(), z.string().regex(/^bx_[A-Za-z0-9_-]{1,64}$/)]),
  expiresAt: z.iso.datetime(),
})
const assistanceCode = "human_verification_required"
type Database = ReturnType<typeof supabaseServerClient>

// The worker keeps its existing connection and network guard alive. Nothing
// reconnects, fills or clicks Submit during this bounded human-only wait.
export async function waitForApplicationHuman(
  db: Database,
  id: string,
  revision: number,
  sessionId: string,
  ready: () => Promise<boolean>,
  until = Infinity,
  at: AssistanceStage = assistanceStages[2],
  fieldHelp = false,
  page?: Page,
  codeOnly = false
) {
  const sending = at.status === "submitting"
  // The wait shares the worker's execution limit. A window too short for a
  // person to act is not offered, so the run fails inside its own catch.
  const ends = Math.min(Date.now() + HUMAN_VERIFICATION_WAIT_MS, until)
  if (ends - Date.now() < 30_000)
    throw new Error(
      fieldHelp
        ? "Unsupported employer control"
        : "Human verification required; assistance time expired"
    )
  const expiresAt = new Date(ends).toISOString()
  const bridge =
    page && !fieldHelp
      ? await TelegramVerificationBridge.connect(db, page, {
          id,
          revision,
          sessionId,
          expiresAt,
          at,
          codeOnly,
        })
      : null
  if (codeOnly && !bridge)
    throw new ApplicationSubmissionError("verification_unavailable")
  const code = bridge
    ? "telegram_verification_required"
    : fieldHelp
      ? "employer_control_help"
      : assistanceCode
  const published = await db
    .from("application_tasks")
    .update({
      output: {
        browserAssistance: assistanceSchema.parse({ sessionId, expiresAt }),
      },
      error_code: code,
      message: bridge
        ? codeOnly
          ? "An employer verification code is needed. Reply to the latest code prompt in Telegram; the application continues automatically."
          : "Verification or receipt review is waiting in Telegram. Use the latest picture, control buttons or verification-code prompt there."
        : fieldHelp
          ? "A form control needs your help. Open the employer browser and finish the reviewed fields using your saved answers. Do not submit or navigate away; sending is blocked while you help. Automation resumes after the reviewed values match."
          : sending
            ? "The employer page needs your attention. Open the employer browser here within three minutes to complete verification or inspect the result. Do not submit again; sending will not be retried."
            : "The employer page needs your attention. Open the employer browser here within three minutes to sign in or complete verification. Nothing has been submitted.",
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", id)
    .eq("revision", revision)
    .eq("stage", at.stage)
    .eq("state", "running")
    .select("application_id")
    .maybeSingle()
  if (published.error) throw published.error
  if (!published.data)
    throw new Error("Application task lease no longer active")
  try {
    if (bridge) await bridge.start()
    else
      await notifyBrowserAssistance(id, revision, fieldHelp).catch(() => {
        console.warn("Browser assistance alert could not be delivered")
      })
    while (Date.now() < Date.parse(expiresAt)) {
      const current = await db
        .from("application_runs")
        .select("status,revision,approved_revision")
        .eq("id", id)
        .single()
      if (current.error) throw current.error
      if (
        current.data.status !== at.status ||
        current.data.revision !== revision ||
        (at.status !== "preparing" &&
          current.data.approved_revision !== revision)
      )
        throw new Error("Approval no longer active")
      if (await ready()) return
      if (bridge && (await bridge.poll(ready))) return
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(
      fieldHelp
        ? "Unsupported employer control"
        : "Human verification required; assistance time expired"
    )
  } finally {
    const cleared = await db
      .from("application_tasks")
      .update({
        output: null,
        error_code: null,
        message: "",
        updated_at: new Date().toISOString(),
      })
      .eq("application_id", id)
      .eq("revision", revision)
      .eq("stage", at.stage)
      .eq("state", "running")
      .eq("error_code", code)
    if (cleared.error) throw cleared.error
  }
}

async function assistanceFor(
  account: ApplicationAccount,
  id: string,
  revision: number
) {
  const run = await ownedApplication(account, id)
  const at = assistanceStages.find((item) => item.status === run.status)
  if (
    !at ||
    run.revision !== revision ||
    (at.status !== "preparing" && run.approved_revision !== revision)
  )
    throw new HttpError(
      409,
      "This employer browser is no longer waiting for help."
    )
  // Task outputs have no authenticated SELECT grant. Only the owned run above
  // authorizes this service read; no provider session ID is accepted from clients.
  const task = await supabaseServerClient()
    .from("application_tasks")
    .select("output")
    .eq("application_id", id)
    .eq("revision", revision)
    .eq("stage", at.stage)
    .eq("state", "running")
    .in("error_code", [
      assistanceCode,
      "employer_control_help",
      "telegram_verification_required",
    ])
    .maybeSingle()
  if (task.error) throw task.error
  const assistance = assistanceSchema.safeParse(
    task.data?.output?.browserAssistance
  )
  if (
    !assistance.success ||
    Date.parse(assistance.data.expiresAt) <= Date.now()
  )
    throw new HttpError(
      410,
      "This employer browser has expired. Check the application status before trying again."
    )
  return assistance.data
}

export async function applicationBrowserLiveUrl(
  account: ApplicationAccount,
  id: string,
  revision: number
) {
  const assistance = await assistanceFor(account, id, revision)
  if (!z.uuid().safeParse(assistance.sessionId).success)
    throw new HttpError(
      409,
      "Live browser access is unavailable for this session. Check the application's Telegram verification prompt."
    )
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY,
    fetch: globalThis.fetch,
    maxRetries: 0,
    timeout: 10000,
  })
  const session = await bb.sessions.retrieve(assistance.sessionId)
  if (
    session.projectId !== process.env.BROWSERBASE_PROJECT_ID ||
    session.status !== "RUNNING"
  )
    throw new HttpError(410, "This employer browser has ended.")
  const links = await bb.sessions.debug(assistance.sessionId, { expiresIn: 60 })
  const url = new URL(links.debuggerFullscreenUrl)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      url.hostname === "browserbase.com" ||
      url.hostname.endsWith(".browserbase.com")
    )
  )
    throw new Error("Invalid browser assistance destination")
  const latest = await assistanceFor(account, id, revision)
  if (latest.sessionId !== assistance.sessionId)
    throw new HttpError(
      409,
      "The employer browser changed. Reload the application."
    )
  return url.toString()
}
