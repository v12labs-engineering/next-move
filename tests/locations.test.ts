import assert from "node:assert/strict"
import test from "node:test"
import { searchLocations } from "@/lib/server/location/search"
import { countryCode } from "@/lib/location/countries"

test("location search scopes suggestions to the selected country and populated places", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.hostname, "geocoding-api.open-meteo.com")
    assert.equal(url.searchParams.get("countryCode"), "CA")
    assert.equal(url.searchParams.get("name"), "Toronto")
    const city = {
      id: 6167865,
      name: "Toronto",
      country_code: "CA",
      admin1: "Ontario",
      feature_code: "PPLA",
    }
    return Response.json({
      results: [
        city,
        city,
        { ...city, id: 2, country_code: "US" },
        { ...city, id: 3, feature_code: "ADM1" },
      ],
    })
  })
  assert.deepEqual(await searchLocations({ country: "Canada", q: "Toronto" }), [
    { id: 6167865, name: "Toronto", country: "Canada", region: "Ontario" },
  ])
  assert.equal(countryCode("United Arab Emirates"), "AE")
  assert.equal(countryCode("UK"), "GB")
})

test("empty results stay empty, and invalid searches never call a provider", async (t) => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return Response.json({})
  })
  assert.deepEqual(
    await searchLocations({ country: "Canada", q: "Unknown" }),
    []
  )
  for (const input of [
    { country: "Invalid", q: "Toronto" },
    { country: "Canada", q: "T" },
    { country: "Canada", q: "x".repeat(81) },
  ]) {
    await assert.rejects(searchLocations(input))
  }
  assert.equal(calls, 1)
})

test("provider failures and malformed results are reported without fabricated suggestions", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({}, { status: 429 })
  )
  await assert.rejects(
    searchLocations({ country: "Canada", q: "Toronto" }),
    /Location search is unavailable/
  )
  mock.mock.mockImplementation(async () =>
    Response.json({ results: [{ id: "invalid" }] })
  )
  await assert.rejects(
    searchLocations({ country: "Canada", q: "Toronto" }),
    /Location search is unavailable/
  )
})
