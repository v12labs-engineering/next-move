import { requireAccount } from "@/lib/server/session"
import { apiError, privateJson } from "@/lib/server/http"
export async function POST() {
  try {
    await requireAccount()
    return privateJson(
      {
        error: "Update target countries in your profile.",
        profileUrl: "/profile",
      },
      405
    )
  } catch (error) {
    return apiError(error)
  }
}
export const DELETE = POST
