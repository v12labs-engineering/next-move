import { sleep } from "workflow"
import { checkBoatBatch } from "@/lib/server/applications/boat-batch"

export async function stopIdleBoatBatchWorkflow(batchId: string) {
  "use workflow"
  let checkAt: string | null
  do {
    checkAt = await stopIdleBoatBatchStep(batchId)
    if (checkAt) await sleep(new Date(checkAt))
  } while (checkAt)
}

async function stopIdleBoatBatchStep(batchId: string) {
  "use step"
  return await checkBoatBatch(batchId)
}
