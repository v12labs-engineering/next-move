import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson } from "@/lib/server/http"
export async function GET() {
  try {
    const account = await requireAccount()
    const result = await account.db.rpc("application_question_alerts")
    if (result.error) throw result.error
    return privateJson({ alerts: result.data })
  } catch (error) {
    return apiError(error)
  }
}
