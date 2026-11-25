import { sessionClient } from "@/lib/server/session"
import { checkOrigin, apiError } from "@/lib/server/http"
import { NextResponse } from "next/server"
export async function POST(request: Request) {
  try {
    checkOrigin(request)
    const db = await sessionClient()
    const { error } = await db.auth.signOut({ scope: "local" })
    if (error) throw error
    return NextResponse.redirect(new URL("/sign-in", request.url), 303)
  } catch (error) {
    return apiError(error)
  }
}
