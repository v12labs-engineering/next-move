import { start } from "workflow/api"
import { prepareApplicationWorkflow } from "@/workflows/applications"
import type { ApplicationRun } from "@/lib/applications"
import {
  applicationTelegramAction,
  parseApplicationTelegramAction,
} from "@/lib/telegram/applications"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { HttpError } from "@/lib/server/http"
import { ownedApplication, rpcError } from "@/lib/server/applications/store"
import { applicationBrowserLiveUrl } from "@/lib/server/applications/browser-assistance"
import { sendTelegram, type TelegramButton } from "./api"
import { deliverTelegram } from "./delivery"

const waiting = ["ready", "needs_attention"]
function heading(run: ApplicationRun) {
  return run.packet
    ? `${run.packet.company} · ${run.packet.title}`
    : "Your application"
}
function buttons(run: ApplicationRun): TelegramButton[][] {
  const action = (
    text: string,
    value: "review" | "retry" | "browser" | "status"
  ) => [
    {
      text,
      callback_data: applicationTelegramAction(run.id, run.revision, value),
    },
  ]
  if (["preparing", "running", "submitting"].includes(run.status))
    return [action("Check status", "status")]
  if (run.status === "submission_unknown" || run.status === "submitted")
    return []
  return [
    ...(waiting.includes(run.status) && run.automatic && run.packet
      ? [action("Continue questions & review", "review")]
      : []),
    ...(run.status === "needs_attention" &&
    run.automatic &&
    (run.prepare_attempts ?? 0) < 3
      ? [action("Retry preparation", "retry")]
      : []),
  ]
}
async function showStatus(thread: string, run: ApplicationRun) {
  const state =
    run.status === "submission_unknown"
      ? "Ready to retry. Open this application in the app and select Try again to continue."
      : run.status === "submitted"
        ? `Submission confirmed.${run.receipt ? `\n${run.receipt.text}\nConfirmed: ${run.receipt.confirmedAt}` : ""}`
        : run.message || `Current stage: ${run.status.replaceAll("_", " ")}.`
  await sendTelegram(
    thread,
    `${heading(run)}\n\n${state}\n\nUse /applications to choose another application.`,
    buttons(run)
  )
}
export async function listTelegramApplications(thread: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return
  const db = supabaseServerClient()
  const connection = await db
    .from("telegram_connections")
    .select("user_id")
    .eq("thread_id", thread)
    .maybeSingle()
  if (connection.error) throw connection.error
  if (!connection.data) {
    await sendTelegram(
      thread,
      "Connect this Telegram account in Preferences first."
    )
    return
  }
  const runs = await db
    .from("application_runs")
    .select(
      "id,revision,status,title:packet->>title,company:packet->>company",
      { count: "exact" }
    )
    .eq("user_id", connection.data.user_id)
    .in("status", [
      "ready",
      "queued_prepare",
      "queued",
      "needs_attention",
      "preparing",
      "running",
      "submitting",
      "submission_unknown",
      "submitted",
    ])
    .order("updated_at", { ascending: false })
    .order("id")
    .range(offset, offset + 9)
  if (runs.error) throw runs.error
  if (!runs.data.length) {
    await sendTelegram(thread, "No application is waiting for you right now.")
    return
  }
  await sendTelegram(
    thread,
    "Choose an application to check progress or answer missing questions. Auto-apply continues after the last required answer. Verification codes are requested here when needed.",
    [
      ...runs.data.map((run) => [
        {
          text: `${[run.company, run.title].filter(Boolean).join(" · ") || "Application"} · ${run.status.replaceAll("_", " ")}`.slice(
            0,
            100
          ),
          callback_data: applicationTelegramAction(
            run.id,
            run.revision,
            "review"
          ),
        },
      ]),
      ...(offset > 0 || offset + 10 < (runs.count || 0)
        ? [
            [
              ...(offset > 0
                ? [
                    {
                      text: "‹ Previous",
                      callback_data: `apps:${Math.max(0, offset - 10)}`,
                    },
                  ]
                : []),
              ...(offset + 10 < (runs.count || 0)
                ? [
                    {
                      text: "More applications ›",
                      callback_data: `apps:${offset + 10}`,
                    },
                  ]
                : []),
            ],
          ]
        : []),
    ]
  )
}
export async function continueTelegramApplication(
  thread: string,
  data: string,
  messageId: string
) {
  const action = parseApplicationTelegramAction(data)
  if (!action) {
    await sendTelegram(
      thread,
      "That button is unavailable. Send /applications to choose the current application."
    )
    return
  }
  const db = supabaseServerClient()
  const connection = await db
    .from("telegram_connections")
    .select("user_id")
    .eq("thread_id", thread)
    .maybeSingle()
  if (connection.error) throw connection.error
  if (!connection.data) {
    await sendTelegram(
      thread,
      "This Telegram account is disconnected. Reconnect in Preferences."
    )
    return
  }
  const account = { db, user: { id: connection.data.user_id } }
  let run: ApplicationRun
  try {
    run = await ownedApplication(account, action.id)
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error
    await sendTelegram(
      thread,
      "That application is unavailable for this Telegram account."
    )
    return
  }
  if (run.revision !== action.revision) {
    await sendTelegram(
      thread,
      "That application changed. Send /applications for its current actions."
    )
    return
  }
  if (action.action === "browser") {
    try {
      const url = await applicationBrowserLiveUrl(account, run.id, run.revision)
      // The callback's verified private sender owns this application. Mint only
      // an expiring link on demand; recheck connection before sending it.
      const current = await db
        .from("telegram_connections")
        .select("user_id")
        .eq("thread_id", thread)
        .eq("user_id", account.user.id)
        .maybeSingle()
      if (current.error) throw current.error
      if (!current.data) return
      await sendTelegram(
        thread,
        `${heading(run)}\n\nOpen the original employer browser now; this link expires in 60 seconds. Finish verification or the reviewed fields, then return here. ${run.status === "submitting" ? "Do not submit again; we are checking the receipt." : "Do not submit or navigate away. Automation continues after the page is verified."}\n\nDesktop works best for typing.`,
        [
          [{ text: "Open employer browser", url }],
          [
            {
              text: "Check status",
              callback_data: applicationTelegramAction(
                run.id,
                run.revision,
                "status"
              ),
            },
          ],
        ]
      )
    } catch (error) {
      if (!(error instanceof HttpError) || ![409, 410].includes(error.status))
        throw error
      await sendTelegram(
        thread,
        "This live verification window has ended. No new browser or submission was started. Send /applications to check the result before deciding what to do next."
      )
    }
    return
  }
  if (
    action.action === "status" ||
    !waiting.includes(run.status) ||
    !run.automatic
  ) {
    await showStatus(thread, run)
    return
  }
  if (action.action === "review" && !run.packet) {
    await showStatus(thread, run)
    return
  }
  const selected = await db.rpc("continue_telegram_application", {
    p_thread: thread,
    p_application: run.id,
    p_revision: run.revision,
    p_action: action.action,
    p_message: messageId,
  })
  try {
    rpcError(selected.error)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    await sendTelegram(thread, error.message)
    return
  }
  if (!selected.data) {
    await sendTelegram(
      thread,
      "This action changed, was already handled, or cannot be retried safely. Send /applications to check its current status."
    )
    return
  }
  if (action.action === "retry") {
    try {
      await start(prepareApplicationWorkflow, [run.id])
    } catch {
      console.warn("Telegram preparation dispatch remains queued")
    }
    await sendTelegram(
      thread,
      `${heading(run)}\n\nPreparation is queued again. We will bring any missing questions and review back here. This does not authorize a new submission.`
    )
  } else await deliverTelegram(connection.data.user_id)
}
