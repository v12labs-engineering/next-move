import { requireAccount } from "@/lib/server/session"
import { searchLocations } from "@/lib/server/location/search"
import { apiError, privateJson } from "@/lib/server/http"

export async function GET(request: Request) {
  try {
    await requireAccount()
    const params = new URL(request.url).searchParams
    return privateJson({
      locations: await searchLocations({
        country: params.get("country"),
        q: params.get("q"),
      }),
    })
  } catch (error) {
    return apiError(error)
  }
}
