import { createClient } from "@supabase/supabase-js"

export function supabaseServerClient(timeoutMs?: number, signal?: AbortSignal) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      "Operator storage requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    )
  }

  return createClient(url, key, {
    auth: { persistSession: false },
    ...(timeoutMs || signal
      ? {
          db: { retry: false },
          global: {
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
              fetch(input, {
                ...init,
                signal: AbortSignal.any([
                  ...(init?.signal ? [init.signal] : []),
                  ...(signal ? [signal] : []),
                  ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : []),
                ]),
              }),
          },
        }
      : {}),
  })
}

export interface SupabaseErrorLike {
  code?: string
  message?: string
}

export function isMissingTable(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01"
}
