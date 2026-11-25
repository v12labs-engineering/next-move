import { z } from "zod"
import { start } from "workflow/api"
import { prepareApplicationWorkflow } from "@/workflows/applications"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import { ownedApplication, rpcError } from "@/lib/server/applications/store"
import { packetSchema, type ApplicationPacket } from "@/lib/applications"
import { rememberChoicesSchema } from "@/lib/applications/questions"
import { applicationProfileSchema } from "@/lib/applications/profile"
import { preparationStages } from "@/lib/applications/pipeline"
import { resolvePacketAnswers } from "@/lib/server/applications/answer-resolver"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { fillApplicationIdentity } from "@/lib/applications/answers"
import { continueAutomaticApplication } from "@/lib/server/applications/queue"
import {
  fillApplicationMemory,
  applicationReuseChoices,
  savedAnswerLibrary,
} from "@/lib/server/applications/question-memory"
type Context = { params: Promise<{ id: string }> }
export async function GET(_r: Request, c: Context) {
  try {
    const account = await requireAccount()
    const id = (await c.params).id
    const application = await ownedApplication(account, id)
    const [events, reuseChoices, tasks] = await Promise.all([
      account.db
        .from("application_events")
        .select("id,status,revision,created_at")
        .eq("application_id", id)
        .order("created_at")
        .limit(100),
      application.packet &&
      ["ready", "needs_attention", "queued"].includes(application.status)
        ? applicationReuseChoices(id, application.packet)
        : Promise.resolve({}),
      account.db
        .from("application_tasks")
        .select(
          "stage,revision,state,attempts,error_code,message,next_retry_at,updated_at"
        )
        .eq("application_id", id)
        .order("revision", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(100),
    ])
    if (events.error) throw events.error
    if (tasks.error) throw tasks.error
    return privateJson({
      application,
      events: events.data,
      reuseChoices,
      tasks: tasks.data,
    })
  } catch (e) {
    return apiError(e)
  }
}
export async function PATCH(request: Request, c: Context) {
  try {
    const account = await requireAccount()
    const id = (await c.params).id
    const run = await ownedApplication(account, id)
    const body = z
      .object({
        revision: z.number().int().positive(),
        answers: packetSchema.shape.answers,
        resume: packetSchema.shape.resume,
        remember: rememberChoicesSchema.default({}),
      })
      .strict()
      .parse(await readJson(request, 140000))
    if (!run.packet) throw new HttpError(409, "Preparation must finish first.")
    const result = await account.db.rpc("save_application_review", {
      p_id: id,
      p_revision: body.revision,
      p_answers: body.answers,
      p_resume: body.resume,
      p_remember: body.remember,
      p_continue: false,
    })
    rpcError(result.error)
    const queued = await continueAutomaticApplication(id)
    return privateJson({ revision: result.data, queued: queued !== null })
  } catch (e) {
    return apiError(e)
  }
}
export async function POST(request: Request, c: Context) {
  try {
    const account = await requireAccount()
    const id = (await c.params).id
    const run = await ownedApplication(account, id)
    const body = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("retry_step"),
            revision: z.number().int().positive(),
            stage: z.enum(preparationStages),
          })
          .strict(),
        z
          .object({
            action: z.enum(["retry", "retry_unconfirmed", "cancel"]),
            revision: z.number().int().positive(),
          })
          .strict(),
        z
          .object({
            action: z.literal("autofill"),
            revision: z.number().int().positive(),
            answers: packetSchema.shape.answers,
            resume: packetSchema.shape.resume,
            remember: rememberChoicesSchema.default({}),
          })
          .strict(),
      ])
      .parse(await readJson(request, 140000))
    if (body.action === "retry_unconfirmed") {
      const result = await account.db.rpc("retry_unconfirmed_application", {
        p_id: id,
        p_revision: body.revision,
      })
      rpcError(result.error)
      if (!result.data)
        throw new HttpError(
          409,
          "This application can no longer be retried. Reload its current status."
        )
      const queued = await continueAutomaticApplication(id)
      return privateJson({ revision: result.data, queued: queued !== null })
    }
    if (body.action === "retry_step") {
      const retried = await account.db.rpc("retry_application_step", {
        p_id: id,
        p_revision: body.revision,
        p_stage: body.stage,
      })
      rpcError(retried.error)
      if (!retried.data)
        throw new HttpError(
          409,
          "This step can no longer be retried. Reload the application and check its retry allowance."
        )
      await start(prepareApplicationWorkflow, [id])
      return privateJson({ revision: retried.data })
    }
    if (body.action === "autofill") {
      if (
        !run.packet ||
        run.revision !== body.revision ||
        !["ready", "needs_attention"].includes(run.status)
      )
        throw new HttpError(409, "Reload and review the current application.")
      const profile = await account.db
        .from("account_profiles")
        .select("data")
        .eq("user_id", account.user.id)
        .single()
      if (profile.error) throw profile.error
      let packet: ApplicationPacket = await fillApplicationMemory(
        id,
        packetSchema.parse({
          ...run.packet,
          answers: body.answers,
          resume: body.resume,
        })
      )
      const applicationProfile = profile.data.data.applicationProfile
        ? applicationProfileSchema.parse(profile.data.data.applicationProfile)
        : undefined
      const job = run.job_id
        ? await account.db
            .from("job_catalog")
            .select("country")
            .eq("id", run.job_id)
            .maybeSingle()
        : null
      if (job?.error) throw job.error
      packet.applicationContext = {
        country: job?.data?.country || "",
        profile: applicationProfile,
        jobDescription: packet.applicationContext?.jobDescription || "",
      }
      packet = await resolvePacketAnswers(
        packet,
        async () => {
          const quota = await account.db.rpc("reserve_tailoring_attempt")
          if (quota.error || !quota.data)
            throw new Error("AI allowance reached")
        },
        undefined,
        await savedAnswerLibrary(id)
      )
      packet = fillApplicationIdentity(packet, {
        fullName: profile.data.data.fullName,
        resumeText: profile.data.data.resumeText,
        email: account.user.email || "",
      })
      const saved = await account.db.rpc("save_application_review", {
        p_id: id,
        p_revision: body.revision,
        // Teach question memory only from answers the candidate submitted.
        // Newly generated fills stay suggestions until reviewed or continued.
        p_answers: body.answers,
        p_resume: body.resume,
        p_remember: body.remember,
        p_continue: false,
      })
      rpcError(saved.error)
      if (!saved.data)
        throw new HttpError(409, "Reload and review the current application.")
      const evidence = await supabaseServerClient()
        .from("application_runs")
        .update({ packet })
        .eq("id", id)
        .eq("user_id", account.user.id)
        .eq("revision", saved.data)
        .eq("status", "ready")
        .select("id")
        .maybeSingle()
      if (evidence.error) throw evidence.error
      if (!evidence.data)
        throw new HttpError(
          409,
          "The application changed. Reload before filling again."
        )
      const queued = await continueAutomaticApplication(id)
      return privateJson({ revision: saved.data, queued: queued !== null })
    }
    const result =
      body.action === "retry"
        ? await account.db.rpc("retry_application_preparation_revision", {
            p_id: id,
            p_revision: body.revision,
          })
        : await account.db.rpc("cancel_application", {
            p_id: id,
            p_revision: body.revision,
          })
    rpcError(result.error)
    if (!result.data)
      throw new HttpError(
        409,
        "This action is no longer available. Reload the application."
      )
    if (body.action === "retry") await start(prepareApplicationWorkflow, [id])
    return privateJson({ ok: true })
  } catch (e) {
    return apiError(e)
  }
}
