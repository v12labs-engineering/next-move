import { sessionClient } from "@/lib/server/session"
import { safeNext } from "@/lib/server/http"
import { NextResponse } from "next/server"
export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  if (code) {
    const db = await sessionClient()
    const { error } = await db.auth.exchangeCodeForSession(code)
    if (!error)
      return NextResponse.redirect(
        new URL(safeNext(url.searchParams.get("next")), url.origin),
        { headers: { "Cache-Control": "private, no-store" } }
      )
  }
  return NextResponse.redirect(new URL("/sign-in?error=expired", url.origin))
}
