import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const endpoint = "http://127.0.0.1:3000/api/cron/jobs"
const defaultStateFile = "/var/lib/catalog-scheduler/state.json"
const numeric = (value) => Number.isSafeInteger(value) && value >= 0

class TickFailure extends Error {
  constructor(reason, retryAt) {
    super(reason)
    this.retryAt = retryAt
  }
}

function schedulerReceipt(value) {
  const receipt = value?.scheduler
  if (
    value?.ok !== true ||
    value?.accepted !== true ||
    value?.complete !== false ||
    receipt?.mode !== "source-tasks" ||
    !["admitted", "recovered", "dispatched", "dispatchErrors"].every((key) =>
      numeric(receipt[key])
    ) ||
    typeof receipt.matchingDispatched !== "boolean" ||
    !receipt.health ||
    typeof receipt.health !== "object" ||
    Array.isArray(receipt.health)
  )
    throw new Error("invalid_scheduler_receipt")
  // Keep operational counters only. Never persist arbitrary response/error text.
  const health = Object.fromEntries(
    ["overdueIndia", "dueIndia", "pendingIndia", "failedIndia", "staleIndia"]
      .filter((key) => numeric(receipt.health[key]))
      .map((key) => [key, receipt.health[key]])
  )
  if (["healthy", "degraded", "stalled"].includes(receipt.health.status))
    health.status = receipt.health.status
  return {
    mode: receipt.mode,
    admitted: receipt.admitted,
    recovered: receipt.recovered,
    dispatched: receipt.dispatched,
    dispatchErrors: receipt.dispatchErrors,
    matchingDispatched: receipt.matchingDispatched,
    health,
  }
}

/** A local admission/recovery tick, never a claim that collection completed. */
export async function triggerLocalCatalog(
  secret,
  {
    transport = fetch,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    requestTimeoutMs = 12_000,
  } = {}
) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("cron_secret_missing")
  let reason = "request_failed"
  for (let attempt = 0; attempt < 3; attempt++) {
    let response
    try {
      response = await transport(endpoint, {
        method: "GET",
        headers: { authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch {
      // Network exception messages may include credentials; discard them.
      reason = "request_failed"
    }
    let delay = 1000 * 2 ** attempt
    if (response) {
      if (response.status === 202) {
        try {
          return {
            attempts: attempt + 1,
            receipt: schedulerReceipt(await response.json()),
          }
        } catch {
          throw new Error("invalid_scheduler_receipt")
        }
      }
      reason = `http_${response.status}`
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403)
        throw new Error(reason)
      if (response.status !== 429 && response.status < 500)
        throw new Error(reason)
      const retry = response.headers.get("retry-after")
      if (retry !== null) {
        const seconds = /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - now()
        // The next minute tick retries admission. Never sleep across cron ticks.
        if (Number.isFinite(seconds) && seconds > 3000)
          throw new TickFailure(
            `${reason}_retry_later`,
            new Date(now() + seconds).toISOString()
          )
        if (Number.isFinite(seconds)) delay = Math.max(delay, seconds, 0)
      }
    }
    if (attempt < 2) await wait(delay)
  }
  throw new Error(reason)
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {}
    throw error
  }
}

async function saveState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 })
  await rename(temporary, path)
}

export function schedulerHealthy(state, now = Date.now()) {
  const success = Date.parse(state.lastSuccessAt ?? "")
  return (
    state.version === 1 &&
    Number.isFinite(success) &&
    success <= now + 5000 &&
    now - success <= 180_000 &&
    state.consecutiveFailures === 0
  )
}

/** Filesystem ownership prevents overlapping startup/manual/minute ticks.
 * @param {{secret?: string, stateFile?: string, transport?: typeof fetch,
 * wait?: (ms: number) => Promise<void>, now?: () => number,
 * log?: (value: object) => void}} [options]
 */
export async function runLocalCatalogTick({
  secret = process.env.CRON_SECRET,
  stateFile = process.env.CATALOG_SCHEDULER_STATE_FILE ?? defaultStateFile,
  transport,
  wait,
  now = Date.now,
  log = (value) => console.log(JSON.stringify(value)),
} = {}) {
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
  const lock = `${stateFile}.lock`
  const ownership = randomUUID()
  async function claim() {
    try {
      await mkdir(lock)
      await writeFile(
        join(lock, "owner.json"),
        JSON.stringify({
          ownership,
          pid: process.pid,
          startedAt: now(),
        })
      )
      return true
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const owner = await readState(join(lock, "owner.json"))
      // A normal tick ends within 45 seconds. Expire an abandoned lock only
      // after two minutes, preserving ownership during startup races.
      let started = owner.startedAt
      if (!Number.isFinite(started)) {
        try {
          started = (await stat(lock)).mtimeMs
        } catch (statError) {
          if (statError.code === "ENOENT") return claim()
          throw statError
        }
      }
      if (now() - started < 120_000) return false
      const abandoned = `${lock}.expired.${process.pid}`
      try {
        await rename(lock, abandoned)
      } catch (renameError) {
        if (renameError.code === "ENOENT") return false
        throw renameError
      }
      await rm(abandoned, { recursive: true, force: true })
      return claim()
    }
  }
  if (!(await claim())) {
    log({ event: "catalog_scheduler_tick_skipped", reason: "tick_running" })
    return { skipped: true }
  }
  try {
    const previous = await readState(stateFile)
    if (Date.parse(previous.nextAttemptAt ?? "") > now()) {
      log({
        event: "catalog_scheduler_tick_skipped",
        reason: "backoff",
        nextAttemptAt: previous.nextAttemptAt,
      })
      return { skipped: true }
    }
    const startedAt = new Date(now()).toISOString()
    try {
      const result = await triggerLocalCatalog(secret, { transport, wait, now })
      const state = {
        version: 1,
        lastAttemptAt: startedAt,
        lastSuccessAt: new Date(now()).toISOString(),
        consecutiveFailures: 0,
        lastError: null,
        nextAttemptAt: null,
        ...result,
      }
      await saveState(stateFile, state)
      log({
        event: "catalog_scheduler_tick",
        status:
          result.receipt.dispatchErrors ||
          result.receipt.health.overdueIndia ||
          result.receipt.health.staleIndia ||
          result.receipt.health.failedIndia ||
          ["degraded", "stalled"].includes(result.receipt.health.status)
            ? "degraded"
            : "accepted",
        recoveredAfterFailures: previous.consecutiveFailures ?? 0,
        ...result,
      })
      return state
    } catch (error) {
      const reason =
        /^(cron_secret_missing|request_failed|invalid_scheduler_receipt|http_\d{3}(?:_retry_later)?)$/.test(
          error.message
        )
          ? error.message
          : "tick_failed"
      const state = {
        version: 1,
        lastAttemptAt: startedAt,
        lastSuccessAt: previous.lastSuccessAt ?? null,
        consecutiveFailures:
          (numeric(previous.consecutiveFailures)
            ? previous.consecutiveFailures
            : 0) + 1,
        lastError: reason,
        nextAttemptAt: error instanceof TickFailure ? error.retryAt : null,
      }
      await saveState(stateFile, state)
      log({ event: "catalog_scheduler_alert", ...state })
      throw new Error(reason)
    }
  } finally {
    const current = await readState(join(lock, "owner.json"))
    if (current.ownership === ownership)
      await rm(lock, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stateFile = process.env.CATALOG_SCHEDULER_STATE_FILE ?? defaultStateFile
  if (process.argv.includes("--health")) {
    const state = await readState(stateFile)
    if (!schedulerHealthy(state)) {
      console.error("Local catalog scheduler has no recent successful tick")
      process.exitCode = 1
    }
  } else {
    try {
      await runLocalCatalogTick({ stateFile })
    } catch {
      // The structured alert above is intentionally credential-free.
      process.exitCode = 1
    }
  }
}
