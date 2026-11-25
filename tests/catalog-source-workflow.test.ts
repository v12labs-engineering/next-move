import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { build } from "esbuild"
import type { AdvanceReceipt } from "../lib/server/catalog/source-worker"

// Exercise the actual workflow decisions; provider work, database RPCs and the
// matching queue are boundary fakes. This does not simulate durable step replay.
const workflowModule = build({
  entryPoints: ["workflows/catalog-source.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "catalog-source-boundaries",
      setup(builder) {
        const modules: Record<string, string> = {
          workflow: `export function getWorkflowMetadata() {
            return { workflowRunId: "workflow-fixture" }
          }`,
          "@/lib/server/catalog/source-worker": `export async function advanceCollection(delivery, options) {
            return globalThis.__catalogWorkflowTest.advance(delivery, options)
          }`,
          "@/lib/server/supabase-server": `export function supabaseServerClient() {
            return globalThis.__catalogWorkflowTest.db
          }`,
          "@/lib/server/matching/dispatch": `export async function dispatchMatchingSweep(options) {
            return globalThis.__catalogWorkflowTest.match(options)
          }`,
          "@/lib/server/catalog/retention":
            "export async function cleanupCatalog() {}",
        }
        builder.onResolve({ filter: /.*/ }, (args) =>
          args.path in modules
            ? { path: args.path, namespace: "fixture" }
            : undefined
        )
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: modules[args.path],
          loader: "js",
        }))
      },
    },
  ],
}).then(
  async (result) =>
    import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
    )
)

const firstTask = "00000000-0000-4000-8000-000000000001"
const nextTask = "00000000-0000-4000-8000-000000000002"
type Delivery = { taskId: string; dispatchGeneration: number }
type RpcCall = { name: string; args: Record<string, unknown> }
type RpcResult = { data: unknown; error: Error | null }

function fixture(
  t: TestContext,
  receipts: AdvanceReceipt[],
  rpc?: (call: RpcCall) => RpcResult,
  match?: () => void
) {
  const advances: Delivery[] = []
  const matches: { autoApply: boolean }[] = []
  const rpcs: RpcCall[] = []
  const harness = {
    advances,
    matches,
    rpcs,
    async advance(delivery: Delivery) {
      advances.push(delivery)
      const receipt = receipts.shift()
      assert.ok(receipt, "Unexpected additional collection attempt")
      assert.equal(receipt.taskId, delivery.taskId)
      return receipt
    },
    async match(options: { autoApply: boolean }) {
      matches.push(options)
      match?.()
    },
    db: {
      async rpc(name: string, args: Record<string, unknown> = {}) {
        const call = { name, args }
        rpcs.push(call)
        if (rpc) return rpc(call)
        if (name === "confirm_catalog_task_continuation")
          return { data: true, error: null }
        if (name === "claim_catalog_workflow_delivery")
          return { data: null, error: null }
        throw new Error(`Unexpected workflow RPC: ${name}`)
      },
    },
  }
  Object.defineProperty(globalThis, "__catalogWorkflowTest", {
    value: harness,
    configurable: true,
  })
  t.after(() => Reflect.deleteProperty(globalThis, "__catalogWorkflowTest"))
  return harness
}

test("new scheduled runs leave further delivery to cron after 32 segments", async (t) => {
  const receipts = Array.from({ length: 32 }, () => ({
    taskId: firstTask,
    status: "completed" as const,
    result: { jobs: 1 },
  }))
  const lastReceipt = receipts.at(-1)
  const f = fixture(t, receipts, ({ name }) => {
    assert.equal(name, "claim_catalog_workflow_delivery")
    return {
      data: { task_id: firstTask, dispatch_generation: 1 },
      error: null,
    }
  })
  const { catalogSourceWorkflow } = await workflowModule
  assert.deepEqual(
    await catalogSourceWorkflow(firstTask, 1, "bounded"),
    lastReceipt
  )
  assert.equal(f.advances.length, 32)
  assert.equal(f.rpcs.length, 31)
  assert.deepEqual(f.matches, [])
})

test("a competing continuation publisher stops this workflow before collecting twice", async (t) => {
  const f = fixture(
    t,
    [
      {
        taskId: firstTask,
        status: "pending",
        reason: "page_budget",
        dispatchGeneration: 8,
      },
    ],
    ({ name }) => {
      assert.equal(name, "confirm_catalog_task_continuation")
      return { data: false, error: null }
    }
  )
  const { catalogSourceWorkflow } = await workflowModule
  const result = await catalogSourceWorkflow(firstTask, 7)
  assert.deepEqual(result, { taskId: firstTask, status: "handed_off" })
  assert.deepEqual(f.advances, [{ taskId: firstTask, dispatchGeneration: 7 }])
  assert.deepEqual(f.rpcs, [
    {
      name: "confirm_catalog_task_continuation",
      args: {
        p_task: firstTask,
        p_generation: 8,
        p_message_id: "workflow-fixture",
      },
    },
  ])
  assert.deepEqual(f.matches, [])
})

test("bounded source segments resume with their returned generation and match only the published result", async (t) => {
  const completed: AdvanceReceipt = {
    taskId: firstTask,
    status: "completed",
    result: { jobs: 20 },
  }
  const f = fixture(t, [
    {
      taskId: firstTask,
      status: "pending",
      reason: "page_budget",
      dispatchGeneration: 8,
    },
    {
      taskId: firstTask,
      status: "pending",
      reason: "request_budget",
      dispatchGeneration: 9,
    },
    completed,
  ])
  const { catalogSourceWorkflow } = await workflowModule
  assert.deepEqual(await catalogSourceWorkflow(firstTask, 7), completed)
  assert.deepEqual(
    f.advances,
    [7, 8, 9].map((dispatchGeneration) => ({
      taskId: firstTask,
      dispatchGeneration,
    }))
  )
  assert.deepEqual(
    f.rpcs
      .filter((call) => call.name === "confirm_catalog_task_continuation")
      .map((call) => call.args.p_generation),
    [8, 9]
  )
  assert.deepEqual(f.matches, [{ autoApply: false }])
})

test("a matching queue outage does not stop collection from draining the next source", async (t) => {
  const completed: AdvanceReceipt = {
    taskId: nextTask,
    status: "completed",
    result: { jobs: 30 },
  }
  let claims = 0
  const f = fixture(
    t,
    [
      { taskId: firstTask, status: "completed", result: { jobs: 20 } },
      completed,
    ],
    ({ name }) => {
      assert.equal(name, "claim_catalog_workflow_delivery")
      return {
        data:
          claims++ === 0 ? { task_id: nextTask, dispatch_generation: 4 } : null,
        error: null,
      }
    },
    () => {
      throw new Error("matching queue unavailable")
    }
  )
  const { catalogSourceWorkflow } = await workflowModule
  assert.deepEqual(await catalogSourceWorkflow(firstTask, 1), completed)
  assert.deepEqual(f.advances, [
    { taskId: firstTask, dispatchGeneration: 1 },
    { taskId: nextTask, dispatchGeneration: 4 },
  ])
  assert.deepEqual(f.matches, [{ autoApply: false }, { autoApply: false }])
  assert.equal(claims, 2)
})

for (const status of ["completed", "waiting", "failed"] as const) {
  test(`${status} sources release their workflow to another source immediately`, async (t) => {
    const settled: AdvanceReceipt =
      status === "completed"
        ? { taskId: firstTask, status, result: { jobs: 10 } }
        : {
            taskId: firstTask,
            status,
            reason: "provider_backoff",
            dispatchGeneration: 2,
          }
    const completed: AdvanceReceipt = {
      taskId: nextTask,
      status: "completed",
      result: { jobs: 20 },
    }
    let claimed = false
    const f = fixture(
      t,
      [
        settled,
        {
          taskId: nextTask,
          status: "pending",
          reason: "page_budget",
          dispatchGeneration: 5,
        },
        completed,
      ],
      ({ name, args }) => {
        if (name === "claim_catalog_workflow_delivery") {
          assert.deepEqual(args, { p_message_id: "workflow-fixture" })
          const data = claimed
            ? null
            : { task_id: nextTask, dispatch_generation: 4 }
          claimed = true
          return { data, error: null }
        }
        assert.equal(name, "confirm_catalog_task_continuation")
        assert.deepEqual(args, {
          p_task: nextTask,
          p_generation: 5,
          p_message_id: "workflow-fixture",
        })
        return { data: true, error: null }
      }
    )
    const { catalogSourceWorkflow } = await workflowModule
    assert.deepEqual(await catalogSourceWorkflow(firstTask, 1), completed)
    assert.deepEqual(f.advances, [
      { taskId: firstTask, dispatchGeneration: 1 },
      { taskId: nextTask, dispatchGeneration: 4 },
      { taskId: nextTask, dispatchGeneration: 5 },
    ])
    assert.deepEqual(
      f.matches,
      Array.from({ length: status === "completed" ? 2 : 1 }, () => ({
        autoApply: false,
      }))
    )
    assert.deepEqual(
      f.rpcs.map((call) => call.name),
      [
        "claim_catalog_workflow_delivery",
        "confirm_catalog_task_continuation",
        "claim_catalog_workflow_delivery",
      ]
    )
  })
}

test("a lost claim acknowledgement throws before collecting an unconfirmed next delivery", async (t) => {
  const f = fixture(
    t,
    [{ taskId: firstTask, status: "waiting", reason: "provider_backoff" }],
    ({ name }) => {
      assert.equal(name, "claim_catalog_workflow_delivery")
      return {
        data: null,
        error: new Error("claim committed but response lost"),
      }
    }
  )
  const { catalogSourceWorkflow } = await workflowModule
  await assert.rejects(
    catalogSourceWorkflow(firstTask, 1),
    /claim committed but response lost/
  )
  assert.deepEqual(f.advances, [{ taskId: firstTask, dispatchGeneration: 1 }])
  assert.deepEqual(f.matches, [])
  assert.equal(f.rpcs.length, 1)
})

test("a fenced stale delivery stops without matching or taking unrelated source work", async (t) => {
  const skipped: AdvanceReceipt = {
    taskId: firstTask,
    status: "skipped",
    reason: "stale_generation",
  }
  const f = fixture(t, [skipped])
  const { catalogSourceWorkflow } = await workflowModule
  assert.deepEqual(await catalogSourceWorkflow(firstTask, 1), skipped)
  assert.deepEqual(f.advances, [{ taskId: firstTask, dispatchGeneration: 1 }])
  assert.deepEqual(f.matches, [])
  assert.deepEqual(f.rpcs, [])
})

test("the final permitted segment finishes without acknowledging work it cannot process", async (t) => {
  t.mock.method(console, "info", () => {})
  const completed: AdvanceReceipt = {
    taskId: firstTask,
    status: "completed",
    result: { jobs: 20 },
  }
  const receipts: AdvanceReceipt[] = Array.from(
    { length: 999 },
    (_, index) => ({
      taskId: firstTask,
      status: "pending",
      reason: "page_budget",
      dispatchGeneration: index + 2,
    })
  )
  receipts.push(completed)
  const f = fixture(t, receipts, ({ name }) => {
    assert.equal(
      name,
      "confirm_catalog_task_continuation",
      "Must not acknowledge another source beyond the workflow segment limit"
    )
    return { data: true, error: null }
  })
  const { catalogSourceWorkflow } = await workflowModule
  assert.deepEqual(await catalogSourceWorkflow(firstTask, 1), completed)
  assert.equal(f.advances.length, 1000)
  assert.equal(f.rpcs.length, 999)
  assert.deepEqual(f.matches, [{ autoApply: false }])
})
