import { requirePageAccount } from "@/lib/server/session"
import { getCandidate } from "@/lib/server/account-store"
import { OnboardingForm } from "@/components/onboarding/onboarding-form"
import { AppShell } from "@/components/shell/app-shell"
import { TelegramSettings } from "@/components/telegram-settings"
export default async function PreferencesPage() {
  const account = await requirePageAccount(false)
  const profile = await getCandidate(account)
  return (
    <AppShell
      title="Preferences"
      description="Where and how you want to work, and what happens automatically."
    >
      <TelegramSettings />
      <OnboardingForm
        initial={profile?.candidate}
        version={profile?.version}
        editing="preferences"
      />
    </AppShell>
  )
}
