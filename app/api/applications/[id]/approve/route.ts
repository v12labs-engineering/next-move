import { z } from "zod"
import { start } from "workflow/api"
import { submitApplicationWorkflow } from "@/workflows/applications"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import { ownedApplication, rpcError } from "@/lib/server/applications/store"
import { packetSchema, missingAnswers } from "@/lib/applications"
import { rememberChoicesSchema } from "@/lib/applications/questions"
export async function POST(
  request: Request,
  c: { params: Promise<{ id: string }> }
) {
  try {
    const account = await requireAccount()
    const id = (await c.params).id
    const body = z
      .object({
        revision: z.number().int().positive(),
        consent: z.literal(true),
        answers: packetSchema.shape.answers.optional(),
        resume: packetSchema.shape.resume.optional(),
        remember: rememberChoicesSchema.default({}),
      })
      .strict()
      .parse(await readJson(request, 140000))
    const run = await ownedApplication(account, id)
    if (
      run.revision !== body.revision ||
      !(
        run.status === "ready" ||
        (body.answers && run.automatic && run.status === "needs_attention")
      )
    )
      throw new HttpError(409, "Reload and review the current application.")
    if ((body.answers === undefined) !== (body.resume === undefined))
      throw new HttpError(422, "Send the answers and resume together.")
    if (body.answers === undefined && Object.keys(body.remember).length)
      throw new HttpError(
        422,
        "Save your answer reuse choices before approving."
      )
    const packet = packetSchema.parse(
      body.answers
        ? { ...run.packet, answers: body.answers, resume: body.resume }
        : run.packet
    )
    const missing = missingAnswers(packet)
    if (missing.length)
      throw new HttpError(
        422,
        `Complete or review: ${missing.slice(0, 3).join("; ")}.`
      )
    const approved = body.answers
      ? await account.db.rpc("save_application_review", {
          p_id: id,
          p_revision: body.revision,
          p_answers: packet.answers,
          p_resume: packet.resume,
          p_remember: body.remember,
          p_continue: true,
        })
      : await account.db.rpc("approve_application", {
          p_id: id,
          p_revision: body.revision,
        })
    rpcError(approved.error)
    if (!approved.data)
      throw new HttpError(
        409,
        "The application changed. Reload before approving."
      )
    await start(submitApplicationWorkflow, [
      id,
      body.answers ? approved.data : body.revision,
    ])
    return privateJson({ ok: true }, 202)
  } catch (e) {
    return apiError(e)
  }
}
