import { sleep } from "workflow"
import { start } from "workflow/api"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  processMatchBatch,
  finalizeMatchBuild,
} from "@/lib/server/matching/build"
import { matchingMetric } from "@/lib/server/matching/metrics"

export async function accountMatchingWorkflow(
  userId: string,
  token: string,
  version: number,
  allowAutoApply = true
) {
  "use workflow"
  let published = false
  try {
    published = await buildMatches(userId, token, version)
  } catch {
    await failMatches(userId, token)
  }
  if (published && allowAutoApply) {
    try {
      await dispatchAutoApply(userId)
    } catch {
      console.warn(
        "Matches published, but automatic application dispatch needs recovery"
      )
    }
  }
  await continueMatching(userId, allowAutoApply)
}

export async function computeMatchBatch(
  userId: string,
  token: string,
  version: number
) {
  "use step"
  return processMatchBatch(userId, token, version)
}
computeMatchBatch.maxRetries = 2

export async function publishMatches(
  userId: string,
  token: string,
  version: number
) {
  "use step"
  return finalizeMatchBuild(userId, token, version)
}
publishMatches.maxRetries = 2

// Every batch is its own durable step; also the test/operator seam.
export async function buildMatches(
  userId: string,
  token: string,
  version: number
) {
  for (;;) {
    const result = await computeMatchBatch(userId, token, version)
    if (result === "needs_profile") return false
    if (result) break
  }
  return publishMatches(userId, token, version)
}

async function queuedAccounts(db: ReturnType<typeof supabaseServerClient>) {
  const waiting = await db
    .from("account_match_state")
    .select("user_id")
    .not("queued_at", "is", null)
    .order("queued_at")
    .order("user_id")
    .limit(16)
  if (waiting.error) throw waiting.error
  return waiting.data.map((row) => row.user_id as string)
}

async function dispatchClaims(
  userIds: Iterable<string>,
  allowAutoApply = true
) {
  for (const userId of userIds) {
    try {
      await dispatchClaim(userId, allowAutoApply)
    } catch {
      matchingMetric("failed", { dispatch: true })
    }
  }
}

async function continueMatching(userId: string, allowAutoApply = true) {
  "use step"
  // Drain older queued accounts first, then coalesce changes to this account.
  const waiting = await queuedAccounts(supabaseServerClient(30_000))
  await dispatchClaims(new Set([...waiting, userId]), allowAutoApply)
}

async function dispatchClaim(userId: string, allowAutoApply = true) {
  const db = supabaseServerClient(30_000)
  const claim = await db.rpc("claim_account_matching", { p_user: userId })
  if (claim.error) throw claim.error
  matchingMetric("admission", {
    admitted: Boolean(claim.data),
    queueWaitMs: claim.data?.queueWaitMs ?? 0,
  })
  if (!claim.data) return
  try {
    await start(accountMatchingWorkflow, [
      userId,
      claim.data.token,
      claim.data.profileVersion,
      allowAutoApply,
    ])
  } catch (error) {
    await db.rpc("fail_account_matching", {
      p_user: userId,
      p_token: claim.data.token,
    })
    throw error
  }
}

async function failMatches(userId: string, token: string) {
  "use step"
  const result = await supabaseServerClient(30_000).rpc(
    "fail_account_matching",
    { p_user: userId, p_token: token }
  )
  if (result.error) throw result.error
  matchingMetric("failed", { failed: true }, token)
}

export async function matchingSweepWorkflow(allowAutoApply = true) {
  "use workflow"
  let after: string | null = null
  for (;;) {
    const next = await dispatchMatchBatch(after, allowAutoApply)
    if (!next) {
      await wakeMatchingQueue(allowAutoApply)
      return
    }
    after = next
  }
}

async function dispatchMatchBatch(
  after: string | null,
  allowAutoApply = true
): Promise<string | null> {
  "use step"
  const db = supabaseServerClient(30_000)
  let query = db
    .from("account_profiles")
    .select("user_id")
    .order("user_id")
    .limit(100)
  if (after) query = query.gt("user_id", after)
  const users = await query
  if (users.error) throw users.error
  // Keyset traversal reaches every account; admissions queue when capacity is full.
  await dispatchClaims(
    users.data.map((row) => row.user_id),
    allowAutoApply
  )
  console.log("Matching sweep dispatched", { accounts: users.data.length })
  return users.data.length === 100 ? users.data.at(-1)!.user_id : null
}

async function dispatchAutoApply(userId: string) {
  "use step"
  const db = supabaseServerClient(30_000)
  const profile = await db
    .from("account_profiles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("data->autoApply->>enabled", "true")
    .maybeSingle()
  if (profile.error) throw profile.error
  if (!profile.data) return
  const { autoApplyWorkflow } = await import("@/workflows/auto-apply")
  await start(autoApplyWorkflow, [userId])
}

export async function wakeMatchingQueue(allowAutoApply = true) {
  "use step"
  const db = supabaseServerClient(30_000)
  const claim = await db.rpc("claim_matching_dispatcher")
  if (claim.error) throw claim.error
  if (!claim.data) return
  try {
    await start(matchingQueueWorkflow, [claim.data, allowAutoApply])
  } catch (error) {
    await db.rpc("release_matching_dispatcher", { p_token: claim.data })
    throw error
  }
}
export async function matchingQueueWorkflow(
  token: string,
  allowAutoApply = true
) {
  "use workflow"
  while (await drainMatchingQueue(token, allowAutoApply)) await sleep("15s")
}
async function drainMatchingQueue(token: string, allowAutoApply = true) {
  "use step"
  const db = supabaseServerClient(30_000)
  const heartbeat = await db.rpc("heartbeat_matching_dispatcher", {
    p_token: token,
  })
  if (heartbeat.error) throw heartbeat.error
  if (!heartbeat.data) return false
  await dispatchClaims(await queuedAccounts(db), allowAutoApply)
  return true
}
