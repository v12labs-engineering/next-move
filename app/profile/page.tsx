import { requirePageAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { OnboardingForm } from "@/components/onboarding/onboarding-form"
import { AppShell } from "@/components/shell/app-shell"
export default async function ProfilePage() {
  const account = await requirePageAccount(false)
  const profile = await getCandidate(account)
  return (
    <AppShell
      title="Your profile"
      description="Your resume and background. They drive how jobs are ranked for you."
    >
      <OnboardingForm
        initial={profile?.candidate}
        version={profile?.version}
        editing="profile"
      />
    </AppShell>
  )
}
