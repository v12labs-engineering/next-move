"use client"
import { useState } from "react"
import { FileText, Globe, MailCheck, Send } from "lucide-react"
import { createBrowserSupabaseClient } from "@/lib/supabase"
import { Logo } from "@/components/shell/logo"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MIN_ONBOARDING_EXPERIENCE_YEARS } from "@/lib/candidate/onboarding"

const values = [
  {
    icon: FileText,
    text: "Upload your resume once. We build your profile from it.",
  },
  {
    icon: Globe,
    text: "See jobs in the countries you choose, ranked by fit with a clear visa signal.",
  },
  {
    icon: Send,
    text: "Tailor, apply and track every application in one place.",
  },
]

export function SignInForm({ expired = false }: { expired?: boolean }) {
  const [email, setEmail] = useState("")
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(
    expired
      ? "That sign-in link could not be verified. Request a new link below."
      : ""
  )
  return (
    <main className="min-h-svh bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="hidden flex-col justify-between border-r bg-muted/40 p-12 lg:flex">
        <Logo />
        <div className="max-w-md space-y-8">
          <p className="font-heading text-[32px] leading-tight">
            Find your next role in software.
          </p>
          <ul className="space-y-4">
            {values.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm">
                <Icon
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Your profile and applications stay private.
        </p>
      </section>

      <div className="flex min-h-svh flex-col px-4 py-8 sm:px-8 lg:min-h-0 lg:justify-center lg:py-12">
        <div className="lg:hidden">
          <Logo />
        </div>
        <div className="mx-auto my-auto w-full max-w-sm space-y-6 py-10 lg:my-0 lg:py-0">
          <div className="space-y-2">
            <h1 className="font-heading text-[28px] leading-tight">
              Sign in or create an account
            </h1>
            <p className="text-sm text-muted-foreground">
              For software professionals with {MIN_ONBOARDING_EXPERIENCE_YEARS}+
              years of experience. We’ll email you a secure sign-in link.
            </p>
          </div>
          {sent ? (
            <div
              role="status"
              className="flex animate-in items-start gap-3 rounded-xl border bg-card p-4 shadow-xs duration-200 ease-out-expo fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
            >
              <MailCheck
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <p className="text-sm">
                Check your email for your sign-in link. Open it in this browser.
              </p>
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={async (e) => {
                e.preventDefault()
                setPending(true)
                setError("")
                try {
                  const db = createBrowserSupabaseClient()
                  if (!db) throw new Error("Sign-in is not configured yet.")
                  const result = await db.auth.signInWithOtp({
                    email,
                    options: {
                      emailRedirectTo: `${window.location.origin}/auth/callback`,
                    },
                  })
                  if (result.error)
                    throw new Error(
                      "We couldn't send the sign-in link. Please try again shortly."
                    )
                  setSent(true)
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Sign-in failed."
                  )
                } finally {
                  setPending(false)
                }
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={254}
                />
              </div>
              <Button size="lg" disabled={pending}>
                {pending ? "Sending…" : "Continue with email"}
              </Button>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
