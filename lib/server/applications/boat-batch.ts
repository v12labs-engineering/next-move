import { createHmac, randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  boatApi,
  createBoatBrowser,
  hostBoatWorker,
  type BoatApi,
} from "./boat-api"

export type BoatBatchAccount = { userId: string; deadline: number }

type BrowserLease = {
  batchId: string
  sandboxId: string | null
  accessUrl: string | null
  expiresAt: string
}

function unavailable() {
  return Object.assign(
    new Error("Boat application batch is temporarily unavailable"),
    { status: 503 }
  )
}

const batchDatabase = () => supabaseServerClient(5_000)

export async function acquireBoatBatch(
  account: BoatBatchAccount,
  api: BoatApi,
  env: Partial<NodeJS.ProcessEnv>
) {
  const db = batchDatabase()
  const sessionId = randomUUID()
  const waitUntil = Math.min(Date.now() + 90_000, account.deadline)
  let lease: BrowserLease | null = null
  while (Date.now() < waitUntil) {
    const result = await db.rpc("acquire_application_boat_session", {
      p_user_id: account.userId,
      p_session_id: sessionId,
      p_seconds: Math.min(
        810,
        Math.ceil((account.deadline - Date.now()) / 1000) + 20
      ),
    })
    if (result.error) throw result.error
    lease = result.data as BrowserLease | null
    if (lease) break
    await delay(1_500)
  }
  if (!lease) throw unavailable()
  const { batchId, expiresAt } = lease
  let { sandboxId, accessUrl } = lease
  const workerToken = createHmac("sha256", env.BOAT_API_KEY || "")
    .update(`application-boat-batch:${batchId}`)
    .digest("hex")
  const release = async () => {
    const { error } = await db.rpc("release_application_boat_session", {
      p_batch_id: batchId,
      p_session_id: sessionId,
    })
    if (error) throw error
  }
  const drain = async () => {
    const { error } = await db
      .from("application_boat_batches")
      .update({ draining: true })
      .eq("id", batchId)
    if (error) throw error
  }
  try {
    if (batchId === sessionId && !sandboxId) {
      const { start } = await import("workflow/api")
      const { stopIdleBoatBatchWorkflow } =
        await import("@/workflows/boat-batch")
      await start(stopIdleBoatBatchWorkflow, [batchId])
      // Persist the attempt before sending it. The cleanup workflow can find a
      // VM by its unique name if the create response is lost.
      const creation = await db
        .from("application_boat_batches")
        .update({ creating_at: new Date().toISOString() })
        .eq("id", batchId)
      if (creation.error) throw creation.error
      const vm = await createBoatBrowser(
        api,
        env,
        workerToken,
        batchId,
        true
      ).catch(async (error) => {
        // A definite API rejection has no VM to recover. Transport errors
        // still need the provider-name lookup in the cleanup workflow.
        if ([400, 401, 402, 403, 404, 422, 429].includes(error?.status))
          await db
            .from("application_boat_batches")
            .update({ creating_at: null })
            .eq("id", batchId)
        throw error
      })
      const provisioned = await db
        .from("application_boat_batches")
        .update({ sandbox_id: vm.id })
        .eq("id", batchId)
      if (provisioned.error) throw provisioned.error
      sandboxId = vm.id
      accessUrl = (await hostBoatWorker(api, vm)).href
      const ready = await db
        .from("application_boat_batches")
        .update({ access_url: accessUrl })
        .eq("id", batchId)
      if (ready.error) throw ready.error
    }
    if (!sandboxId || !accessUrl) throw unavailable()
    return {
      sandboxId,
      accessUrl,
      workerToken,
      sessionId,
      expiresAt,
      release,
      drain,
    }
  } catch (error) {
    await release().catch(() =>
      console.warn("Boat browser lease will expire", { sessionId })
    )
    throw error
  }
}

export async function checkBoatBatch(batchId: string): Promise<string | null> {
  const db = batchDatabase()
  const result = await db.rpc("check_application_boat_batch", {
    p_batch_id: batchId,
  })
  if (result.error) throw result.error
  const batch = result.data as {
    checkAt?: string
    sandboxId?: string | null
    creatingAt?: string | null
  } | null
  if (!batch) return null
  if (batch.checkAt) return batch.checkAt
  const api = boatApi(process.env)
  let sandboxId = batch.sandboxId
  if (!sandboxId && batch.creatingAt) {
    // Only needed when provisioning lost its response before saving the ID.
    const name = `job-search-application-batch-${batchId}`
    const { sandboxes } = await api(
      "/sandboxes?limit=100",
      undefined,
      undefined,
      10_000
    )
    sandboxId = sandboxes?.find((sandbox) => sandbox.name === name)?.id
    if (sandboxId && !/^bx_[a-z0-9]{8}$/.test(sandboxId)) throw unavailable()
    // A missing response can mean that Boat is still creating the VM. Keep
    // the account fenced until it is found or the provider TTL has elapsed.
    if (!sandboxId && Date.now() < Date.parse(batch.creatingAt) + 33 * 60_000)
      return new Date(Date.now() + 30_000).toISOString()
  }
  if (sandboxId) {
    try {
      const path = `/sandboxes/${sandboxId}`
      const { sandbox } = await api(path, undefined, undefined, 10_000)
      if (sandbox?.state !== "archived" && sandbox?.state !== "stopped") {
        if (sandbox?.state !== "archiving" && sandbox?.state !== "stopping")
          await api(`${path}/stop`, {}, undefined, 10_000)
        return new Date(Date.now() + 10_000).toISOString()
      }
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
    }
    console.info("Boat application batch stopped", { sandboxId })
  }
  const removed = await db
    .from("application_boat_batches")
    .delete()
    .eq("id", batchId)
  if (removed.error) throw removed.error
  return null
}

export async function recoverBoatBatches() {
  if (!process.env.BOAT_API_KEY) return
  const { data, error } = await batchDatabase()
    .from("application_boat_batches")
    .select("id")
    .or(
      [
        "stopping.eq.true",
        `idle_since.lt.${new Date(Date.now() - 90_000).toISOString()}`,
        `reserved_at.lt.${new Date(Date.now() - 15 * 60_000).toISOString()}`,
      ].join(",")
    )
    .order("reserved_at")
    .limit(20)
  if (error?.code === "PGRST205" || error?.code === "42P01") return
  if (error) throw error
  await Promise.all(
    data.map(({ id }) =>
      checkBoatBatch(id).catch(() =>
        console.warn("Boat batch cleanup will retry", { batchId: id })
      )
    )
  )
}
