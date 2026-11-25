import { z } from "zod"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson } from "@/lib/server/http"
export async function GET(request: Request) {
  try {
    const account = await requireAccount()
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(new URL(request.url).searchParams.get("offset") || 0)
    const result = await account.db
      .from("account_application_questions")
      .select(
        "id,question,answer,reuse_scope,reuse_explicit,company,country,source_application_id,last_seen_at",
        { count: "exact" }
      )
      .eq("user_id", account.user.id)
      .order("last_seen_at", { ascending: false })
      .order("id")
      .range(offset, offset + 49)
    if (result.error) throw result.error
    return privateJson({ questions: result.data, total: result.count, offset })
  } catch (error) {
    return apiError(error)
  }
}
