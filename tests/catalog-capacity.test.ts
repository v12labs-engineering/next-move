import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { readCatalogCapacity } from "@/lib/server/catalog/health"
import { syncCatalog } from "@/lib/server/catalog/sync"

test("capacity respects the lower server/database budget and fails closed for unavailable usage", async () => {
  let bytes: number | null = 419649203
  let databaseLimit = 400 * 1024 * 1024
  const db = createClient("https://fixture.example", "fixture-only", {
    global: {
      fetch: async (input) => {
        const url = String(input)
        return Response.json(
          url.includes("catalog_storage_usage")
            ? { database_bytes: bytes }
            : { budget_bytes: databaseLimit }
        )
      },
    },
  })
  assert.equal((await readCatalogCapacity(db)).available, false)
  bytes = 80 * 1024 * 1024
  databaseLimit = 70 * 1024 * 1024
  assert.equal(
    (await readCatalogCapacity(db, 100 * 1024 * 1024)).available,
    false
  )
  databaseLimit = 100 * 1024 * 1024
  assert.equal(
    (await readCatalogCapacity(db, 70 * 1024 * 1024)).available,
    false
  )
  assert.equal(
    (await readCatalogCapacity(db, 90 * 1024 * 1024)).available,
    true
  )
  bytes = null
  await assert.rejects(readCatalogCapacity(db), /unavailable/)
})

test("full storage blocks collection before any public feed request", async (t) => {
  const original = globalThis.fetch
  const keys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ] as const
  const previous = keys.map((key) => process.env[key])
  t.after(() => {
    globalThis.fetch = original
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key]
      else process.env[key] = previous[i]
    })
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only"
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(
      url.hostname,
      "fixture.example",
      "No public feed request is allowed when storage is full"
    )
    return Response.json(
      url.pathname.endsWith("catalog_storage_usage")
        ? { database_bytes: 419649203 }
        : { budget_bytes: 419430400 }
    )
  }
  await assert.rejects(syncCatalog(), /storage budget reached/)
})
