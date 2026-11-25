import { NextResponse } from "next/server"
import { sessionClient } from "@/lib/server/session"
import { safeNext } from "@/lib/server/http"

// Supabase's server-side email-template flow. The one-time token is verified
// with Auth before a session cookie is created; an account ID is never enough.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const token_hash = url.searchParams.get("token_hash")
  if (
    token_hash &&
    token_hash.length <= 512 &&
    url.searchParams.get("type") === "email"
  ) {
    const db = await sessionClient()
    const { error } = await db.auth.verifyOtp({ token_hash, type: "email" })
    if (!error)
      return NextResponse.redirect(
        new URL(safeNext(url.searchParams.get("next")), url.origin),
        {
          headers: {
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
          },
        }
      )
  }
  return NextResponse.redirect(new URL("/sign-in?error=expired", url.origin), {
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}
