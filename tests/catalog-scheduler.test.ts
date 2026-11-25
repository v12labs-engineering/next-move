import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { dispatchScheduledCatalog } from "@/lib/server/catalog/scheduler"

const taskOne = "00000000-0000-4000-8000-000000000001"
const taskTwo = "00000000-0000-4000-8000-000000000002"
const lease = "00000000-0000-4000-8000-000000000003"
const intent = (id: string) => ({
  id,
  task_id: id,
  dispatch_generation: 1,
  lease_token: lease,
})

function fixture(
  options: {
    intents?: ReturnType<typeof intent>[]
    failAdmission?: boolean
    admissionErrors?: number
    advancedBeforeAck?: boolean
    bytes?: number
  } = {}
) {
  const calls: { name: string; body: Record<string, unknown> }[] = []
  const db = createClient("https://fixture.example", "not-a-real-key", {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        const name = url.pathname.split("/").at(-1)!
        const body = JSON.parse(String(init?.body ?? "{}"))
        calls.push({ name, body })
        switch (name) {
          case "catalog_storage_usage":
            return Response.json({ database_bytes: options.bytes ?? 1_000_000 })
          case "catalog_capacity_control":
            return Response.json({ budget_bytes: 400 * 1024 * 1024 })
          case "recover_catalog_source_tasks":
            return Response.json([])
          case "admit_catalog_scheduled_tasks":
            return options.failAdmission
              ? Response.json(
                  { message: "Injected database failure" },
                  { status: 400 }
                )
              : Response.json({
                  admitted: [intent(taskOne)],
                  errors: Array.from(
                    { length: options.admissionErrors ?? 0 },
                    () => ({
                      source: taskTwo,
                      error: "Untrusted SQL failure detail",
                    })
                  ),
                })
          case "claim_catalog_scheduled_outbox":
            return Response.json(options.intents ?? [intent(taskOne)])
          case "confirm_catalog_task_outbox":
            return Response.json(!options.advancedBeforeAck)
          case "read_catalog_source_task":
            return Response.json({ state: "pending", dispatch_generation: 2 })
          case "claim_catalog_scheduler_maintenance":
            return Response.json(null)
          case "record_catalog_scheduler_tick":
            return new Response(null, { status: 204 })
          case "catalog_scheduler_health":
            return Response.json({ dueIndia: 1, overdueIndia: 0 })
          default:
            throw new Error(`Unexpected scheduler request ${name}`)
        }
      },
    },
  })
  return { db, calls }
}

test("scheduled admission never joins the legacy global refresh", async () => {
  const f = fixture()
  const result = await dispatchScheduledCatalog(f.db, {
    enqueueSource: async (id, generation) => {
      assert.equal(id, taskOne)
      assert.equal(generation, 1)
      return "workflow-one"
    },
    enqueueMatching: async () => {},
  })
  assert.equal(result.mode, "source-tasks")
  assert.equal(result.dispatched, 1)
  assert.equal(result.dispatchErrors, 0)
  assert.ok(!f.calls.some(({ name }) => name === "claim_catalog_refresh"))
  assert.deepEqual(
    f.calls.find((c) => c.name === "confirm_catalog_task_outbox")?.body,
    {
      p_id: taskOne,
      p_token: lease,
      p_message_id: "workflow-one",
    }
  )
})

test("one failed queue send leaves its intent recoverable without blocking other sources", async () => {
  const f = fixture({ intents: [intent(taskOne), intent(taskTwo)] })
  const result = await dispatchScheduledCatalog(f.db, {
    enqueueSource: async (id) => {
      if (id === taskOne) throw new Error("Queue acknowledgement lost")
      return "workflow-two"
    },
    enqueueMatching: async () => {},
  })
  assert.equal(result.dispatched, 1)
  assert.deepEqual(result.errors, ["source_dispatch_failed"])
  const confirmed = f.calls.filter(
    (c) => c.name === "confirm_catalog_task_outbox"
  )
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].body.p_id, taskTwo)
  assert.equal(result.matchingDispatched, true)
})

test("partial admission failures are reported while admitted work still dispatches", async () => {
  const f = fixture({ admissionErrors: 2 })
  const result = await dispatchScheduledCatalog(f.db, {
    enqueueSource: async () => "workflow-one",
    enqueueMatching: async () => {},
  })
  assert.equal(result.admitted, 1)
  assert.equal(result.dispatched, 1)
  assert.equal(result.matchingDispatched, true)
  assert.equal(result.dispatchErrors, 2)
  assert.deepEqual(result.errors, ["source_admission_failed"])
  assert.ok(
    f.calls.some(
      (c) =>
        c.name === "record_catalog_scheduler_tick" &&
        c.body.p_error === "source_admission_failed"
    )
  )
  assert.equal(
    JSON.stringify(result).includes("Untrusted SQL failure detail"),
    false
  )
})

test("a fast source may advance before its queue acknowledgement returns", async () => {
  const f = fixture({ advancedBeforeAck: true })
  const result = await dispatchScheduledCatalog(f.db, {
    enqueueSource: async () => "workflow-one",
    enqueueMatching: async () => {},
  })
  assert.equal(result.dispatched, 1)
  assert.equal(result.dispatchErrors, 0)
  assert.ok(f.calls.some((c) => c.name === "read_catalog_source_task"))
})

test("matching dispatch recovers on a later tick even without another publication", async () => {
  const f = fixture({ intents: [] })
  let attempts = 0
  const dependencies = {
    enqueueSource: async () => assert.fail("No pending source delivery"),
    enqueueMatching: async () => {
      if (++attempts === 1) throw new Error("Matching queue unavailable")
    },
  }
  const first = await dispatchScheduledCatalog(f.db, dependencies)
  assert.equal(first.matchingDispatched, false)
  assert.deepEqual(first.errors, ["matching_dispatch_failed"])
  const second = await dispatchScheduledCatalog(f.db, dependencies)
  assert.equal(second.matchingDispatched, true)
  assert.equal(second.dispatchErrors, 0)
  assert.equal(attempts, 2)
})

test("admission failures and capacity pauses still permit matching recovery", async () => {
  for (const options of [
    { failAdmission: true },
    { bytes: 500 * 1024 * 1024 },
  ]) {
    const f = fixture(options)
    const result = await dispatchScheduledCatalog(f.db, {
      enqueueSource: async () => assert.fail("Admission was blocked"),
      enqueueMatching: async () => {},
    })
    assert.equal(result.matchingDispatched, true)
    assert.equal(result.dispatched, 0)
    assert.equal(result.dispatchErrors, 1)
    assert.ok(
      f.calls.some(
        (c) => c.name === "record_catalog_scheduler_tick" && c.body.p_error
      )
    )
  }
})
