import { matchingMetric } from "./metrics"
import { start } from "workflow/api"
import {
  accountMatchingWorkflow,
  matchingSweepWorkflow,
  wakeMatchingQueue,
} from "@/workflows/matching"
import { supabaseServerClient } from "@/lib/server/supabase-server"

export async function dispatchAccountMatching(userId: string) {
  const db = supabaseServerClient(30_000)
  const claim = await db.rpc("claim_account_matching", { p_user: userId })
  if (claim.error) throw claim.error
  matchingMetric("admission", {
    admitted: Boolean(claim.data),
    queueWaitMs: claim.data?.queueWaitMs ?? 0,
  })
  if (!claim.data) {
    await wakeMatchingQueue()
    return
  }
  try {
    await start(accountMatchingWorkflow, [
      userId,
      claim.data.token,
      claim.data.profileVersion,
    ])
  } catch (error) {
    await db.rpc("fail_account_matching", {
      p_user: userId,
      p_token: claim.data.token,
    })
    throw error
  }
}

export async function dispatchMatchingSweep(
  options: { autoApply?: boolean } = {}
) {
  // Collection can refresh matches without submitting applications. Carry this
  // mode through every account workflow and queue continuation it creates.
  await start(matchingSweepWorkflow, [options.autoApply ?? true])
}
