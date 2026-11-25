import { requirePageAccount } from "@/lib/server/session"
export async function AuthGate({ children }: { children: React.ReactNode }) {
  await requirePageAccount()
  return <>{children}</>
}
