import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  runLocalCatalogTick,
  schedulerHealthy,
  triggerLocalCatalog,
} from "../scripts/catalog/local-catalog-tick.mjs"

const secret = "synthetic-local-cron-secret-must-never-appear"
const receipt = {
  ok: true,
  accepted: true,
  complete: false,
  scheduler: {
    mode: "source-tasks",
    admitted: 4,
    recovered: 1,
    dispatched: 4,
    dispatchErrors: 0,
    matchingDispatched: true,
    health: { overdueIndia: 2, failedIndia: 1, status: "degraded" },
  },
}
const response = () => Response.json(receipt, { status: 202 })

test("missing local credentials cannot send any request", async () => {
  for (const credential of [undefined, "short"]) {
    await assert.rejects(
      triggerLocalCatalog(credential, {
        transport: async () => {
          throw new Error("unexpected request")
        },
      }),
      /cron_secret_missing/
    )
  }
})

async function statePath(t: {
  after: (callback: () => Promise<void>) => void
}) {
  const directory = await mkdtemp(join(tmpdir(), "local-catalog-cron-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, "state.json")
}

test("local admission retries transient failure and sends credentials only to loopback", async () => {
  const delays: number[] = []
  let calls = 0
  const result = await triggerLocalCatalog(secret, {
    transport: async (input, options) => {
      calls++
      assert.equal(input, "http://127.0.0.1:3000/api/cron/jobs")
      assert.ok(options)
      assert.equal(options.redirect, "error")
      assert.equal(
        new Headers(options.headers).get("authorization"),
        `Bearer ${secret}`
      )
      assert.ok(options.signal)
      if (calls === 1) throw new Error(`Never log this credential: ${secret}`)
      if (calls === 2) return new Response(secret, { status: 503 })
      return response()
    },
    wait: async (ms: number) => {
      delays.push(ms)
    },
  })
  assert.equal(calls, 3)
  assert.deepEqual(delays, [1000, 2000])
  assert.equal(result.attempts, 3)
  assert.equal(result.receipt.mode, "source-tasks")
  assert.equal(result.receipt.health.overdueIndia, 2)
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test("unauthorized and legacy accepted responses are not reported healthy", async () => {
  let calls = 0
  await assert.rejects(
    triggerLocalCatalog(secret, {
      transport: async () => {
        calls++
        return new Response(secret, { status: 401 })
      },
    }),
    /http_401/
  )
  assert.equal(calls, 1)
  await assert.rejects(
    triggerLocalCatalog(secret, {
      transport: async () =>
        Response.json(
          {
            ok: true,
            accepted: true,
            complete: false,
            refresh: { id: "legacy" },
          },
          { status: 202 }
        ),
    }),
    /invalid_scheduler_receipt/
  )
  await assert.rejects(
    triggerLocalCatalog(secret, {
      transport: async () => Response.json(receipt),
    }),
    /http_200/
  )
})

test("request timeouts are bounded and exhaust after three attempts", async () => {
  let calls = 0
  await assert.rejects(
    triggerLocalCatalog(secret, {
      requestTimeoutMs: 10,
      transport: async (_input, options) => {
        calls++
        assert.ok(options)
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => reject(new Error(secret)),
            { once: true }
          )
          // Keep this test process alive; AbortSignal timers intentionally unref.
          setTimeout(() => reject(new Error("fixture failed to abort")), 50)
        })
      },
      wait: async () => {},
    }),
    /request_failed/
  )
  assert.equal(calls, 3)
})

test("long server Retry-After survives process ticks and does not block cron", async (t) => {
  const stateFile = await statePath(t),
    events: unknown[] = []
  let clock = Date.now(),
    calls = 0
  const options = {
    secret,
    stateFile,
    now: () => clock,
    log: (event: unknown) => events.push(event),
    transport: async () => {
      calls++
      return new Response(secret, {
        status: 429,
        headers: { "retry-after": "300" },
      })
    },
  }
  await assert.rejects(runLocalCatalogTick(options), /http_429_retry_later/)
  assert.equal(calls, 1)
  clock += 60_000
  assert.deepEqual(await runLocalCatalogTick(options), { skipped: true })
  assert.equal(calls, 1)
  clock += 241_000
  const recovered = await runLocalCatalogTick({
    ...options,
    transport: async () => {
      calls++
      return response()
    },
  })
  assert.equal(calls, 2)
  assert.ok("consecutiveFailures" in recovered)
  assert.equal(recovered.consecutiveFailures, 0)
  assert.equal(schedulerHealthy(recovered, clock), true)
  assert.equal(JSON.stringify(events).includes(secret), false)
})

test("a failed tick is persisted without credentials and a later tick recovers health", async (t) => {
  const stateFile = await statePath(t),
    events: unknown[] = []
  const options = {
    secret,
    stateFile,
    log: (event: unknown) => events.push(event),
    wait: async () => {},
  }
  await assert.rejects(
    runLocalCatalogTick({
      ...options,
      transport: async () => {
        throw new Error(`raw ${secret}`)
      },
    }),
    /request_failed/
  )
  const failed = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(failed.consecutiveFailures, 1)
  assert.equal(schedulerHealthy(failed), false)
  const recovered = await runLocalCatalogTick({
    ...options,
    transport: async () => response(),
  })
  assert.equal(schedulerHealthy(recovered), true)
  assert.equal(schedulerHealthy(recovered, Date.now() + 181_000), false)
  assert.equal(JSON.stringify(events).includes(secret), false)
  assert.equal((await readFile(stateFile, "utf8")).includes(secret), false)
  assert.ok(
    events.some(
      (event) =>
        (event as { recoveredAfterFailures?: number })
          .recoveredAfterFailures === 1
    )
  )
})

test("overlapping startup and minute ticks share one HTTP request", async (t) => {
  const stateFile = await statePath(t)
  let release!: () => void,
    entered!: () => void,
    calls = 0
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const options = {
    secret,
    stateFile,
    log: () => {},
    transport: async () => {
      calls++
      entered()
      await blocked
      return response()
    },
  }
  const first = runLocalCatalogTick(options)
  await started
  assert.deepEqual(await runLocalCatalogTick(options), { skipped: true })
  release()
  await first
  assert.equal(calls, 1)
})

test("stale India sources degrade the freshness log while successful ticks remain live", async (t) => {
  const stateFile = await statePath(t),
    events: { status?: string }[] = []
  for (const staleIndia of [2, 0]) {
    const result = await runLocalCatalogTick({
      secret,
      stateFile,
      log: (event: { status?: string }) => events.push(event),
      transport: async () =>
        Response.json(
          {
            ...receipt,
            scheduler: {
              ...receipt.scheduler,
              health: { staleIndia, dueIndia: 0 },
            },
          },
          { status: 202 }
        ),
    })
    assert.equal(schedulerHealthy(result), true)
    assert.equal(events.at(-1)?.status, staleIndia ? "degraded" : "accepted")
    const persisted = JSON.parse(await readFile(stateFile, "utf8"))
    assert.equal(persisted.receipt.health.staleIndia, staleIndia)
  }
})

test("a crash before or after lock ownership write can recover on later ticks", async (t) => {
  const stateFile = await statePath(t)
  for (const withOwner of [false, true]) {
    const lock = `${stateFile}.lock`,
      old = Date.now() - 121_000
    await mkdir(lock)
    if (withOwner)
      await writeFile(
        join(lock, "owner.json"),
        JSON.stringify({ startedAt: old, ownership: "dead-worker" })
      )
    else await utimes(lock, new Date(old), new Date(old))
    const result = await runLocalCatalogTick({
      secret,
      stateFile,
      log: () => {},
      transport: async () => response(),
    })
    assert.equal(schedulerHealthy(result), true)
  }
})
