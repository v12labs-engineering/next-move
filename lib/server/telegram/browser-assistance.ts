import { supabaseServerClient } from "@/lib/server/supabase-server"
import { telegramEnabled } from "./config"
import { sendTelegram } from "./api"
import { applicationTelegramAction } from "@/lib/telegram/applications"

// Best-effort alert for an already connected account, sent once by the claimed
// worker. A callback verifies the linked sender before minting a live-view link.
export async function notifyBrowserAssistance(
  id: string,
  revision: number,
  fields = false
) {
  if (!telegramEnabled()) return
  const db = supabaseServerClient(10000)
  const run = await db
    .from("application_runs")
    .select("user_id,status,title:packet->>title,company:packet->>company")
    .eq("id", id)
    .eq("revision", revision)
    .in("status", ["preparing", "running", "submitting"])
    .maybeSingle()
  if (run.error) throw run.error
  if (!run.data) return
  const connection = await db
    .from("telegram_connections")
    .select("thread_id")
    .eq("user_id", run.data.user_id)
    .maybeSingle()
  if (connection.error) throw connection.error
  if (!connection.data) return
  const label =
    [run.data.company, run.data.title].filter(Boolean).join(" · ") ||
    "Your application"
  await sendTelegram(
    connection.data.thread_id,
    `${label}\n\n` +
      (fields
        ? "A form control needs your help. Open the live employer browser below and finish the reviewed fields using your saved answers. Do not submit or navigate away. Sending is blocked during this help window; the app will recheck afterwards."
        : run.data.status !== "submitting"
          ? "The employer needs you to sign in or complete verification. Open the live employer browser below while the session is available. We continue once the page is clear. Nothing has been submitted."
          : "The employer needs human verification. Open the live employer browser below while the session is available. This is the same browser. Do not submit again. We will recheck the receipt afterwards; it has not been confirmed yet.") +
      "\n\nAn expired window will show its current status; it will never restart or resend automatically.",
    [
      [
        {
          text: "Open live employer browser",
          callback_data: applicationTelegramAction(id, revision, "browser"),
        },
      ],
      [
        {
          text: "Check status",
          callback_data: applicationTelegramAction(id, revision, "status"),
        },
      ],
    ]
  )
}
