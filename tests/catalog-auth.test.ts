import assert from "node:assert/strict"
import test from "node:test"
import { GET, POST } from "@/app/api/catalog/sync/route"
import { GET as scheduledGET } from "@/app/api/cron/jobs/route"

test("job feed synchronization rejects customers and missing operator configuration", async (t) => {
  const original = process.env.CRON_SECRET
  const discovery = process.env.SOURCE_DISCOVERY_ENABLED
  const durable = process.env.CATALOG_DURABLE_REFRESH_ENABLED
  t.after(() => {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
    if (discovery === undefined) delete process.env.SOURCE_DISCOVERY_ENABLED
    else process.env.SOURCE_DISCOVERY_ENABLED = discovery
    if (durable === undefined)
      delete process.env.CATALOG_DURABLE_REFRESH_ENABLED
    else process.env.CATALOG_DURABLE_REFRESH_ENABLED = durable
  })
  process.env.SOURCE_DISCOVERY_ENABLED = "true"
  process.env.CATALOG_DURABLE_REFRESH_ENABLED = "true"
  delete process.env.CRON_SECRET
  assert.equal(
    (await GET(new Request("https://example.com/api/catalog/sync"))).status,
    503
  )
  assert.equal(
    (await scheduledGET(new Request("https://example.com/api/cron/jobs")))
      .status,
    503
  )
  process.env.CRON_SECRET = "test-only-operator-secret-at-least-32-chars"
  for (const handler of [GET, POST, scheduledGET]) {
    const response = await handler(
      new Request("https://example.com/api/catalog/sync", {
        headers: {
          Authorization: "Bearer a-customer-cannot-trigger-ingestion",
        },
      })
    )
    assert.equal(response.status, 401)
    assert.match(response.headers.get("cache-control") ?? "", /no-store/)
  }
})
