import { createBrowserClient } from "@supabase/ssr"

export const defaultSupabaseProjectUrl =
  "https://jzvgkjmhugogvpanwjyy.supabase.co"

export function supabaseProjectRef(url?: string | null) {
  if (!url) return null
  return url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i)?.[1] ?? null
}

export function supabaseConfigStatus() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  return {
    configured: Boolean(url && publishableKey),
    hasUrl: Boolean(url),
    hasAnonKey: Boolean(publishableKey),
    hasPublishableKey: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ),
    url,
    projectRef: supabaseProjectRef(url),
  }
}

export function hasSupabaseConfig() {
  return supabaseConfigStatus().configured
}

export function createBrowserSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !publishableKey) {
    return null
  }

  return createBrowserClient(url, publishableKey)
}
