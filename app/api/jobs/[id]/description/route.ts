import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { apiError, HttpError, privateJson } from "@/lib/server/http"
import { hydrateCatalogDescriptions } from "@/lib/server/catalog/content"

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { db } = await requireAccount()
    const id = z
      .string()
      .min(1)
      .max(500)
      .parse((await context.params).id)
    const { data, error } = await db
      .from("job_catalog")
      .select("id,description,description_ref")
      .eq("id", id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(404, "Job not found.")
    const [job] = await hydrateCatalogDescriptions(db, [data])
    return privateJson({ ok: true, description: job.description })
  } catch (error) {
    return apiError(error)
  }
}
