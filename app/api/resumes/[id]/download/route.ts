import { resumeDraftContent } from "@/lib/resume"
import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { apiError, HttpError } from "@/lib/server/http"
import { pdfResponse, resumeDocx, resumePdf } from "@/lib/server/resume/pdf"
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db, user } = await requireAccount()
    const id = z.uuid().parse((await context.params).id)
    const { data, error } = await db
      .from("resume_drafts")
      .select("content,evidence")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(404, "Resume not found.")
    const params = new URL(request.url).searchParams
    const content = resumeDraftContent(data.content, data.evidence)
    if (params.get("format") === "docx") return resumeDocx(content)
    return pdfResponse(
      await resumePdf(content),
      "resume.pdf",
      params.has("inline")
    )
  } catch (error) {
    return apiError(error)
  }
}
