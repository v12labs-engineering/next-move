import {
  prepareApplication,
  sendApplication,
  queuePreparedAutomaticApplication,
  recoverInterruptedApplicationSubmission,
} from "@/lib/server/applications/worker"
import { sleep } from "workflow"
import { applicationQueueRetryAt } from "@/lib/server/applications/queue"

export async function prepareApplicationWorkflow(id: string) {
  "use workflow"
  let retryAt = await prepareStep(id)
  while (retryAt) {
    await sleep(new Date(retryAt))
    retryAt = await prepareStep(id)
  }
  const revision = await queueAutomaticStep(id)
  if (revision !== null) await submitUntilSettled(id, revision)
}
async function queueAutomaticStep(id: string) {
  "use step"
  return await queuePreparedAutomaticApplication(id)
}
queueAutomaticStep.maxRetries = 0
async function prepareStep(id: string) {
  "use step"
  const retryAt = await prepareApplication(id)
  return retryAt ?? (await applicationQueueRetryAt(id, "queued_prepare"))
}
prepareStep.maxRetries = 0

export async function submitApplicationWorkflow(id: string, revision: number) {
  "use workflow"
  await submitUntilSettled(id, revision)
}

async function submitUntilSettled(id: string, revision: number) {
  while (true) {
    let scheduled
    try {
      scheduled = await submissionStep(id, revision)
    } catch (error) {
      scheduled = await recoverSubmissionStep(id, revision)
      if (!scheduled) throw error
    }
    if (!scheduled) return
    await sleep(new Date(scheduled.retryAt))
    revision = scheduled.revision
  }
}

async function recoverSubmissionStep(id: string, revision: number) {
  "use step"
  return await recoverInterruptedApplicationSubmission(id, revision)
}

async function submissionStep(id: string, revision: number) {
  "use step"
  // The database authorizes pre-send retries and at most one extra attempt
  // after an unverifiable automatic send, each fenced by a new revision.
  const scheduled = await sendApplication(id, revision)
  if (scheduled) return scheduled
  const retryAt = await applicationQueueRetryAt(id, "queued", revision)
  return retryAt ? { revision, retryAt } : null
}
submissionStep.maxRetries = 0
