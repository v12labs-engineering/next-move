import { z } from "zod"
import type { Account } from "@/lib/server/session"
import { HttpError } from "@/lib/server/http"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import type { ApplicationRun } from "@/lib/applications"
import { APPLICATION_SEND_STALE_MS } from "@/lib/applications/pipeline"
export type ApplicationAccount = Pick<Account, "db"> & {
  user: Pick<Account["user"], "id">
}
export async function ownedApplication(
  account: ApplicationAccount,
  id: string
) {
  z.uuid().parse(id)
  const result = await account.db
    .from("application_runs")
    .select(
      "id,job_id,target_url,status,revision,packet,approved_revision,prepare_attempts,message,receipt,created_at,updated_at,started_at,auto_submit_requested_at,automatic"
    )
    .eq("id", id)
    .eq("user_id", account.user.id)
    .maybeSingle()
  if (result.error) throw result.error
  if (!result.data) throw new HttpError(404, "Application not found.")
  const run = result.data as ApplicationRun
  // If a worker died, do not leave a permanent spinner or retry a possibly sent
  // application. Compare the original timestamp to avoid racing a live worker.
  if (
    ["preparing", "running", "submitting"].includes(run.status) &&
    Date.now() - new Date(run.updated_at).getTime() >
      (run.status === "preparing" ? 10 * 60_000 : APPLICATION_SEND_STALE_MS)
  ) {
    if (run.automatic && ["queued_prepare", "preparing"].includes(run.status)) {
      // Scheduled recovery reclaims preparation with a new worker token.
      // A progress read must preserve that durable dispatch intent.
      return run
    }
    const uncertain = run.status === "submitting"
    const update = {
      status: uncertain ? "submission_unknown" : "needs_attention",
      message: uncertain
        ? "Try again to continue with your saved application."
        : "This run stopped before submission. Review or retry preparation.",
      updated_at: new Date().toISOString(),
    }
    const changed = await supabaseServerClient()
      .from("application_runs")
      .update(update)
      .eq("id", id)
      .eq("user_id", account.user.id)
      .eq("status", run.status)
      .eq("updated_at", run.updated_at)
      .select("id,status,revision,approved_revision,message,updated_at")
      .maybeSingle()
    if (changed.error) throw changed.error
    if (changed.data) Object.assign(run, update, changed.data)
  }
  return run
}
export function rpcError(error: { code?: string; message?: string } | null) {
  if (!error) return
  if (error.code === "P0001") {
    // Only expose known admission reasons; arbitrary database messages may
    // contain private packet values. Limits do not go away after a reload.
    switch (error.message) {
      case "Completed step checkpoint unavailable":
        throw new HttpError(
          409,
          "Saved inputs for this step are unavailable. Retry preparation to reload the application."
        )
      case "Monthly AI limit reached":
        throw new HttpError(
          429,
          "Your AI request allowance for the past 30 days is used up. Resume analysis, tailoring and AI application navigation share this allowance. Try again when earlier usage falls outside the 30-day window."
        )
      case "Monthly application limit reached":
        throw new HttpError(
          429,
          "Your application allowance for the past 30 days is used up. Try again when earlier applications fall outside the 30-day window."
        )
      case "Daily preparation limit reached":
        throw new HttpError(
          429,
          "Your daily application preparation limit is reached. Try again later."
        )
      case "Daily AI limit reached":
        throw new HttpError(
          429,
          "Your daily AI request allowance is used up. Try again after midnight UTC."
        )
      case "Complete your profile":
        throw new HttpError(
          422,
          "Complete your profile before starting an application."
        )
      case "Unsupported or expired listing":
        throw new HttpError(
          422,
          "This listing is closed or has not been checked recently. Refresh jobs and review its availability."
        )
      case "A public HTTPS listing is required":
        throw new HttpError(422, "A public HTTPS job link is required.")
    }
    throw new HttpError(
      409,
      "The application could not be updated. Reload and review it before trying again."
    )
  }
  throw error
}
