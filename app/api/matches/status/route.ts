import { after } from "next/server"
import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson } from "@/lib/server/http"
import { dispatchAccountMatching } from "@/lib/server/matching/dispatch"
import { matchingMetric } from "@/lib/server/matching/metrics"

export async function GET() {
  try {
    const account = await requireAccount()
    const result = await account.db.rpc("read_account_matching_status")
    if (result.error) throw result.error
    const status = result.data
    if (status.matching.stale && status.matching.status !== "running")
      after(async () => {
        try {
          await dispatchAccountMatching(account.user.id)
        } catch {
          matchingMetric("failed", { dispatch: true })
        }
      })
    return privateJson(status)
  } catch (error) {
    return apiError(error)
  }
}
