import { z } from "zod"
import { after } from "next/server"
import { requireAccount } from "@/lib/server/session"
import { setAccountJobStatus } from "@/lib/server/account-store"
import { apiError, privateJson, readJson } from "@/lib/server/http"
import { queueTelegramFollowup } from "@/lib/server/telegram/followup"
const input = z
  .object({
    id: z.string().min(1).max(500),
    status: z.enum(["new", "interested", "applied", "dismissed"]),
  })
  .strict()
export async function PATCH(request: Request) {
  try {
    const account = await requireAccount()
    const body = input.parse(await readJson(request, 2000))
    await setAccountJobStatus(account, body.id, body.status)
    if (body.status === "applied")
      after(() => queueTelegramFollowup(account.user.id, body.id))
    return privateJson({ ok: true })
  } catch (error) {
    return apiError(error)
  }
}
