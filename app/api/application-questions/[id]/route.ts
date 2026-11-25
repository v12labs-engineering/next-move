import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson, readJson, HttpError } from "@/lib/server/http"
import { formFieldSchema } from "@/lib/applications"
import { reuseScopeSchema, validSavedAnswer } from "@/lib/applications/questions"
import { rpcError } from "@/lib/server/applications/store"
type Context = { params: Promise<{ id: string }> }
export async function PATCH(request: Request, context: Context) {
  try {
    const account = await requireAccount()
    const id = z.uuid().parse((await context.params).id)
    const body = z
      .object({
        answer: z.union([
          z.string().max(5000),
          z.array(z.string().max(1000)).max(100),
        ]),
        scope: reuseScopeSchema,
      })
      .strict()
      .parse(await readJson(request, 20000))
    const row = await account.db
      .from("account_application_questions")
      .select("question")
      .eq("id", id)
      .eq("user_id", account.user.id)
      .maybeSingle()
    if (row.error) throw row.error
    if (!row.data) throw new HttpError(404, "Question not found.")
    if (
      !validSavedAnswer(formFieldSchema.parse(row.data.question), body.answer)
    )
      throw new HttpError(
        422,
        "Enter a valid answer using the question's current options."
      )
    const result = await account.db.rpc("update_application_question", {
      p_id: id,
      p_answer: body.answer,
      p_scope: body.scope,
    })
    rpcError(result.error)
    if (!result.data) throw new HttpError(404, "Question not found.")
    return privateJson({ ok: true })
  } catch (error) {
    return apiError(error)
  }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    const account = await requireAccount()
    const id = z.uuid().parse((await context.params).id)
    const result = await account.db
      .from("account_application_questions")
      .delete()
      .eq("id", id)
      .eq("user_id", account.user.id)
      .select("id")
      .maybeSingle()
    if (result.error) throw result.error
    if (!result.data) throw new HttpError(404, "Question not found.")
    return privateJson({ ok: true })
  } catch (error) {
    return apiError(error)
  }
}
