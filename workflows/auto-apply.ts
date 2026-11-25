import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  autoApplyForAccount,
  recoverPendingApplicationDispatches,
} from "@/lib/server/applications/auto-apply"

export async function autoApplyWorkflow(userId: string) {
  "use workflow"
  await recoverDispatchStep(null, userId)
  return await autoApplyStep(userId)
}
async function autoApplyStep(userId: string) {
  "use step"
  // Retries are safe: jobs that already have a run are never re-requested.
  const result = await autoApplyForAccount(userId)
  return { started: result.started.length, limited: result.limited }
}
autoApplyStep.maxRetries = 1

export async function autoApplySweepWorkflow() {
  "use workflow"
  let recoveryCursor: string | null = null
  do {
    recoveryCursor = await recoverDispatchStep(recoveryCursor)
  } while (recoveryCursor)
  let after: string | null = null
  for (;;) {
    const users = await autoApplyAccounts(after)
    if (!users.length) return
    // One account step at a time bounds demand on the database and providers.
    for (const userId of users) {
      try {
        await autoApplyStep(userId)
      } catch {
        console.warn(
          "Automatic application account step failed; scheduled recovery remains available"
        )
      }
    }
    after = users[users.length - 1]
  }
}
export async function autoApplyAccounts(
  after: string | null
): Promise<string[]> {
  "use step"
  let query = supabaseServerClient(30_000)
    .from("account_profiles")
    .select("user_id")
    .eq("data->autoApply->>enabled", "true")
    .order("user_id")
    .limit(100)
  if (after) query = query.gt("user_id", after)
  const result = await query
  if (result.error) throw result.error
  console.log("Auto-apply account page", { accounts: result.data.length })
  return result.data.map((row) => row.user_id)
}

async function recoverDispatchStep(after: string | null, userId?: string) {
  "use step"
  return await recoverPendingApplicationDispatches(after, userId)
}
