import { requireAccount } from "@/lib/server/session"
import { apiError, HttpError } from "@/lib/server/http"
import { ownedApplication } from "@/lib/server/applications/store"
import { pdfResponse, resumeDocx, resumePdf } from "@/lib/server/resume/pdf"
export async function GET(r: Request, c: { params: Promise<{ id: string }> }) {
  try {
    const run = await ownedApplication(
      await requireAccount(),
      (await c.params).id
    )
    if (!run.packet) throw new HttpError(404, "Resume is not ready.")
    const params = new URL(r.url).searchParams
    if (params.get("format") === "docx") return resumeDocx(run.packet.resume)
    return pdfResponse(
      await resumePdf(run.packet.resume),
      "resume.pdf",
      params.has("inline")
    )
  } catch (e) {
    return apiError(e)
  }
}
