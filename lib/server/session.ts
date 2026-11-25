import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { HttpError } from "@/lib/server/http"

export async function sessionClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new HttpError(503, "Sign-in is not configured.")
  const store = await cookies()
  return createServerClient(url, key, {
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(15_000),
          ]),
        })
        if (!response.ok) {
          const operation = /^\/rest\/v1\/(?:rpc\/)?([a-z_]+)$/.exec(
            new URL(input instanceof Request ? input.url : String(input))
              .pathname
          )?.[1]
          if (operation)
            // Never log the query string, headers, response body or profile.
            console.error("Database request failed", {
              operation,
              status: response.status,
            })
        }
        return response
      },
    },
    cookies: {
      getAll: () => store.getAll(),
      setAll(values) {
        try {
          for (const { name, value, options } of values)
            store.set(name, value, options)
        } catch {
          /* Server components cannot set cookies. Proxy refreshes the session. */
        }
      },
    },
  })
}

export function authenticationFailure(error: unknown) {
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined
  return typeof status === "number" && [400, 401, 403, 422].includes(status)
    ? new HttpError(401, "Please sign in to continue.")
    : new HttpError(
        503,
        "Sign-in is temporarily unavailable. Please try again."
      )
}

export async function requireAccount() {
  const db = await sessionClient()
  let result: Awaited<ReturnType<typeof db.auth.getUser>>
  try {
    result = await db.auth.getUser()
  } catch (error) {
    throw authenticationFailure(error)
  }
  const { data, error } = result
  if (error) throw authenticationFailure(error)
  if (!data.user || data.user.is_anonymous)
    throw new HttpError(401, "Please sign in to continue.")
  return { db, user: data.user }
}

export type Account = Awaited<ReturnType<typeof requireAccount>>

export async function requirePageAccount(onboarded = true) {
  let account: Account
  try {
    account = await requireAccount()
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/sign-in")
    throw error
  }
  if (onboarded) {
    const { data, error } = await account.db
      .from("account_profiles")
      .select("user_id")
      .eq("user_id", account.user.id)
      .maybeSingle()
    if (error) throw new Error("Could not load your account. Please try again.")
    if (!data) redirect("/onboarding")
  }
  return account
}
