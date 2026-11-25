import { redirect } from "next/navigation"
import { requirePageAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { Logo } from "@/components/shell/logo"
import { OnboardingForm } from "@/components/onboarding/onboarding-form"
export default async function OnboardingPage() {
  const account = await requirePageAccount(false)
  const profile = await getCandidate(account)
  if (profile) redirect("/jobs")
  return (
    <main className="min-h-svh bg-background px-4 py-8 sm:py-14">
      <Logo className="mx-auto mb-10 max-w-xl" />
      <OnboardingForm />
    </main>
  )
}
