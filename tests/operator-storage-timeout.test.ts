import assert from "node:assert/strict"
import test from "node:test"
import { supabaseServerClient } from "@/lib/server/supabase-server"

test("catalogue operator requests carry a deadline that aborts stalled database transport", async (t) => {
  const original = globalThis.fetch,
    oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  t.after(() => {
    globalThis.fetch = original
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only-key"
  let aborted = false
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json([])), 1000)
      const abort = () => {
        clearTimeout(timer)
        aborted = true
        reject(init?.signal?.reason)
      }
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener("abort", abort, { once: true })
    })
  const result = await supabaseServerClient(20)
    .from("job_source_directory")
    .select("id")
  assert.equal(aborted, true)
  assert.ok(result.error)
})

test("a worker-wide cancellation reaches both database and description-object requests", async (t) => {
  const original = globalThis.fetch,
    oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
    oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  t.after(() => {
    globalThis.fetch = original
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only-key"
  const controller = new AbortController(),
    reason = new Error("Worker budget exhausted")
  const reasons: unknown[] = []
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        reasons.push(init?.signal?.reason)
        reject(init?.signal?.reason)
      }
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener("abort", abort, { once: true })
    })
  const client = supabaseServerClient(1000, controller.signal)
  const timer = setTimeout(() => controller.abort(reason), 20)
  t.after(() => clearTimeout(timer))
  const [rows, object] = await Promise.all([
    client.from("job_source_directory").select("id"),
    client.storage.from("fixture-public-descriptions").download("fixture.bin"),
  ])
  assert.ok(rows.error)
  assert.ok(object.error)
  assert.ok(reasons.length >= 2)
  assert.ok(reasons.every((value) => value === reason))
})
