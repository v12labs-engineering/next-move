import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { build } from "esbuild"

// Run the real workflow control flow, replacing only its queue, database and
// computation boundaries. No workflow runner, user database or network is used.
const modulePromise = build({
  entryPoints: ["lib/server/matching/dispatch.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "matching-boundaries",
      setup(builder) {
        const modules: Record<string, string> = {
          workflow: "export async function sleep() {}",
          "workflow/api": `export async function start(workflow,args) {
            return globalThis.__matchingModeTest.start(workflow,args)
          }`,
          "@/lib/server/supabase-server": `export function supabaseServerClient() {
            return globalThis.__matchingModeTest.db
          }`,
          "./supabase-server": `export function supabaseServerClient() {
            return globalThis.__matchingModeTest.db
          }`,
          "@/lib/server/matching/build": `
            export async function processMatchBatch(user) {
              globalThis.__matchingModeTest.computed.push(user); return true
            }
            export async function finalizeMatchBuild(user) {
              globalThis.__matchingModeTest.published.push(user); return true
            }`,
          "@/workflows/auto-apply":
            "export async function autoApplyWorkflow() {}",
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

type Call = {
  workflow: (...args: unknown[]) => Promise<unknown>
  args: unknown[]
}

function fixture(t: TestContext) {
  const calls: Call[] = [],
    computed: string[] = [],
    published: string[] = [],
    claimed = new Set<string>()
  let queued: string[] = [],
    heartbeat = 0,
    profileChecks = 0
  const harness = {
    calls,
    computed,
    published,
    queueUsers(users: string[]) {
      queued = users
    },
    profileChecks: () => profileChecks,
    async start(workflow: Call["workflow"], args: unknown[]) {
      calls.push({ workflow, args })
      return { runId: `fixture-${calls.length}` }
    },
    db: {
      async rpc(name: string, args?: { p_user?: string }) {
        if (name === "claim_account_matching") {
          const user = args?.p_user
          assert.ok(user)
          if (claimed.has(user)) return { data: null, error: null }
          claimed.add(user)
          return {
            data: { token: "fixture-token", profileVersion: 1 },
            error: null,
          }
        }
        if (name === "claim_matching_dispatcher")
          return { data: "fixture-dispatcher", error: null }
        if (name === "heartbeat_matching_dispatcher")
          return { data: heartbeat++ === 0, error: null }
        throw new Error(`Unexpected matching RPC: ${name}`)
      },
      from(table: string) {
        const operations: [string, unknown[]][] = []
        const chain: Record<string, (...args: unknown[]) => unknown> = {}
        for (const method of ["select", "order", "limit", "eq", "not", "gt"])
          chain[method] = (...args) => {
            operations.push([method, args])
            return chain
          }
        chain.maybeSingle = async () => {
          assert.equal(table, "account_profiles")
          profileChecks++
          const user = operations.find(
            ([method, args]) => method === "eq" && args[0] === "user_id"
          )?.[1][1]
          // The synthetic profile has autoApply enabled; false must bypass it.
          return { data: { user_id: user }, error: null }
        }
        chain.then = (resolve, reject) => {
          const users = table === "account_profiles" ? ["primary"] : queued
          assert.ok(["account_profiles", "account_match_state"].includes(table))
          return Promise.resolve({
            data: users.map((user_id) => ({ user_id })),
            error: null,
          }).then(
            resolve as (value: unknown) => unknown,
            reject as (reason: unknown) => unknown
          )
        }
        return chain
      },
    },
  }
  Object.defineProperty(globalThis, "__matchingModeTest", {
    value: harness,
    configurable: true,
  })
  t.after(() => Reflect.deleteProperty(globalThis, "__matchingModeTest"))
  return harness
}

test("collection matching publishes and preserves no-auto-apply through queued and continued work", async (t) => {
  const f = fixture(t),
    { dispatchMatchingSweep } = await modulePromise
  await dispatchMatchingSweep({ autoApply: false })
  const sweep = f.calls[0]
  assert.equal(sweep.workflow.name, "matchingSweepWorkflow")
  assert.deepEqual(sweep.args, [false])
  await sweep.workflow(...sweep.args)
  const primary = f.calls.find(
    (call) => call.workflow.name === "accountMatchingWorkflow"
  )!
  const queue = f.calls.find(
    (call) => call.workflow.name === "matchingQueueWorkflow"
  )!
  assert.equal(queue.args[1], false)

  f.queueUsers(["queued"])
  await queue.workflow(...queue.args)
  f.queueUsers(["continuation"])
  await primary.workflow(...primary.args)
  f.queueUsers([])
  for (const call of f.calls.filter(
    (call) =>
      call.workflow.name === "accountMatchingWorkflow" && call !== primary
  ))
    await call.workflow(...call.args)

  const accountCalls = f.calls.filter(
    (call) => call.workflow.name === "accountMatchingWorkflow"
  )
  assert.deepEqual(accountCalls.map((call) => call.args[0]).sort(), [
    "continuation",
    "primary",
    "queued",
  ])
  assert.ok(accountCalls.every((call) => call.args[3] === false))
  assert.deepEqual(f.computed.sort(), ["continuation", "primary", "queued"])
  assert.deepEqual(f.published.sort(), ["continuation", "primary", "queued"])
  assert.equal(f.profileChecks(), 0)
  assert.equal(
    f.calls.filter((call) => call.workflow.name === "autoApplyWorkflow").length,
    0
  )
})

test("existing matching callers retain automatic applications by default", async (t) => {
  const f = fixture(t),
    { dispatchMatchingSweep } = await modulePromise
  await dispatchMatchingSweep()
  const sweep = f.calls[0]
  assert.deepEqual(sweep.args, [true])
  await sweep.workflow(...sweep.args)
  const account = f.calls.find(
    (call) => call.workflow.name === "accountMatchingWorkflow"
  )!
  assert.equal(account.args[3], true)
  await account.workflow(...account.args)
  assert.deepEqual(f.published, ["primary"])
  assert.equal(f.profileChecks(), 1)
  assert.equal(
    f.calls.filter((call) => call.workflow.name === "autoApplyWorkflow").length,
    1
  )
})
