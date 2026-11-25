import assert from "node:assert/strict"
import test from "node:test"
import { countryOptions } from "@/lib/location/countries"
import { worldwideDiscoveryBatch } from "@/lib/server/catalog/discovery/worldwide"
import { discoverWithBrowserbase } from "@/lib/server/catalog/discovery/browserbase"

test("worldwide batches cover every selectable destination exactly once with bounded queries and no implicit wrap", () => {
  const first = worldwideDiscoveryBatch(0)
  const batches = Array.from({ length: first.batchCount }, (_, i) =>
    worldwideDiscoveryBatch(i)
  )
  const countries = batches.flatMap((b) => b.countries)
  assert.equal(first.totalCountries, 249)
  assert.equal(countries.length, countryOptions.length)
  assert.equal(new Set(countries).size, countryOptions.length)
  assert.deepEqual([...countries].sort(), [...countryOptions].sort())
  assert.ok(
    batches.every(
      (b) =>
        b.queries.length <= 24 && b.queries.every((q) => q.query.length <= 200)
    )
  )
  assert.ok(batches.every((b) => b.queries.length * b.maxUrlsPerQuery <= 50))
  assert.equal(batches.at(-1)!.nextBatch, null)
  assert.throws(() => worldwideDiscoveryBatch(first.batchCount), /batch/)
  assert.throws(() => worldwideDiscoveryBatch(-1), /batch/)
  assert.throws(() => worldwideDiscoveryBatch(0.5), /batch/)
})

test("the first batch spans markets outside the initial India/Singapore pilot and retains explicit country provenance", () => {
  const b = worldwideDiscoveryBatch(0)
  for (const country of [
    "United States",
    "Germany",
    "Brazil",
    "South Africa",
    "Japan",
    "Australia",
    "Nigeria",
    "Mexico",
    "UAE",
  ])
    assert.ok(b.countries.includes(country), country)
  assert.ok(
    b.queries
      .filter((q) => q.country === "UAE")
      .every((q) => q.query.includes("United Arab Emirates"))
  )
  assert.equal(b.queries.length, b.countries.length * 2)
})

test("per-query admission prevents the first country from consuming the whole global URL budget", async () => {
  let requests = 0
  const result = await discoverWithBrowserbase(
    ["software Brazil", "software Japan", "software Kenya"],
    {
      apiKey: "fixture-key",
      maxBrowsers: 0,
      maxUrls: 6,
      maxUrlsPerQuery: 2,
      knownSourceIds: new Set(["ashby:existing"]),
      fetch: async () => {
        requests++
        return Response.json({
          requestId: `search-${requests}`,
          results: [
            { url: "https://jobs.ashbyhq.com/existing" },
            ...Array.from({ length: 10 }, (_, i) => ({
              url: `https://jobs.ashbyhq.com/employer${requests}-${i}`,
            })),
          ],
        })
      },
      discover: async () => {
        throw new Error(
          "Direct observed boards do not require extra page discovery"
        )
      },
    }
  )
  assert.equal(requests, 3)
  assert.equal(result.complete, true)
  assert.equal(result.candidates.length, 6)
  assert.ok(result.origin.searches.every((s) => s.selectedUrls === 2))
  assert.deepEqual(
    result.candidates.map((c) => c.id),
    [
      "ashby:employer1-0",
      "ashby:employer1-1",
      "ashby:employer2-0",
      "ashby:employer2-1",
      "ashby:employer3-0",
      "ashby:employer3-1",
    ]
  )
  assert.ok(result.candidates.every((c) => !("countries" in c)))
})
