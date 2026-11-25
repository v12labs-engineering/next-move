import { AuthGate } from "@/components/shell/auth-gate"
import { InboxPage } from "@/components/inbox-page"
export default function Page() {
  return (
    <AuthGate>
      <InboxPage />
    </AuthGate>
  )
}
