import { requireAccount } from "@/lib/server/session"
import { after } from "next/server"
import { readMatchPage } from "@/lib/server/matching/store"
import { dispatchAccountMatching } from "@/lib/server/matching/dispatch"
import { apiError, privateJson } from "@/lib/server/http"
export const dynamic = "force-dynamic"
export const maxDuration = 60
export async function GET(request: Request) {
  try {
    const account = await requireAccount()
    const page = await readMatchPage(account, new URL(request.url).searchParams)
    if (page.matching.stale)
      after(async () => {
        try {
          await dispatchAccountMatching(account.user.id)
        } catch {
          console.error("Could not dispatch account matching")
        }
      })
    return privateJson({ ok: true, ...page })
  } catch (error) {
    return apiError(error)
  }
}
