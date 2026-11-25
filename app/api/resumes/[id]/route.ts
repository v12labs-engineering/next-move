import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { apiError, HttpError, privateJson, readJson } from "@/lib/server/http"
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db, user } = await requireAccount()
    const id = z.uuid().parse((await context.params).id)
    const { content } = z
      .object({ content: z.string().trim().min(1).max(50000) })
      .strict()
      .parse(await readJson(request, 210000))
    const { data, error } = await db
      .from("resume_drafts")
      .update({ content })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(404, "Resume not found.")
    return privateJson({ ok: true })
  } catch (error) {
    return apiError(error)
  }
}
