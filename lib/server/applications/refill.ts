import { supabaseServerClient } from "@/lib/server/supabase-server"
import type { Account } from "@/lib/server/session"
import { packetSchema, type ApplicationPacket } from "@/lib/applications"

// Service credentials are confined here. Every write includes authenticated
// ownership, expected revision and idle state; editing invalidates old approval.
export async function saveRefilledPacket(
  account: Account,
  id: string,
  revision: number,
  packet: ApplicationPacket
) {
  const saved = await supabaseServerClient()
    .from("application_runs")
    .update({
      packet: packetSchema.parse(packet),
      revision: revision + 1,
      approved_packet: null,
      approved_revision: null,
      approved_at: null,
      auto_submit_requested_at: null,
      message:
        "Updated from your application profile. Review or continue the application.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", account.user.id)
    .eq("revision", revision)
    .eq("status", "ready")
    .select("id")
    .maybeSingle()
  if (saved.error) throw saved.error
  return saved.data ? revision + 1 : null
}
