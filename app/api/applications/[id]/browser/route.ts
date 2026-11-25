import { z } from "zod"
import { apiError } from "@/lib/server/http"
import { requireAccount } from "@/lib/server/session"
import { applicationBrowserLiveUrl } from "@/lib/server/applications/browser-assistance"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const account = await requireAccount()
    const id = (await context.params).id
    const revision = z.coerce
      .number()
      .int()
      .positive()
      .parse(new URL(request.url).searchParams.get("revision"))
    const url = await applicationBrowserLiveUrl(account, id, revision)
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    })
  } catch (error) {
    return apiError(error)
  }
}
