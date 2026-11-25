import { requireOperator } from "@/lib/server/operator"
import { dispatchMatchingSweep } from "@/lib/server/matching/dispatch"
import { apiError, privateJson } from "@/lib/server/http"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(request: Request) {
  try {
    requireOperator(request)
    await dispatchMatchingSweep()
    return privateJson({ ok: true, accepted: true }, 202)
  } catch (error) {
    return apiError(error)
  }
}
