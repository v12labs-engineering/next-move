import assert from "node:assert/strict"
import test from "node:test"
import { fetchCatalogPage } from "@/lib/server/catalog/feeds"

test("board pagination continues beyond page three using only the trusted source endpoint", async () => {
  const urls: string[] = []
  const result = await fetchCatalogPage(
    { id: "arbeitnow", kind: "arbeitnow", company: "Arbeitnow", board: null },
    3,
    {
      fetch: async (url) => {
        urls.push(String(url))
        return Response.json({
          data: [],
          links: { next: "https://www.arbeitnow.com/api/job-board-api?page=4" },
        })
      },
    }
  )
  assert.equal(result.nextPage, 4)
  assert.deepEqual(urls, ["https://www.arbeitnow.com/api/job-board-api?page=3"])
  await assert.rejects(
    fetchCatalogPage(
      { id: "arbeitnow", kind: "arbeitnow", company: "Arbeitnow", board: null },
      1,
      {
        fetch: async () =>
          Response.json({
            data: [],
            links: { next: "https://private.example/?page=2" },
          }),
      }
    ),
    /pagination/
  )
})

test("rate limiting retries without marking a failed fetch as a complete empty snapshot", async () => {
  let requests = 0
  const result = await fetchCatalogPage(
    {
      id: "ashby:example",
      kind: "ashby",
      company: "Example",
      board: "example",
    },
    1,
    {
      fetch: async () =>
        ++requests === 1
          ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
          : Response.json({ jobs: [] }),
    }
  )
  assert.equal(requests, 2)
  assert.equal(result.requests, 2)
  assert.equal(result.nextPage, null)
  await assert.rejects(
    fetchCatalogPage(
      {
        id: "ashby:example",
        kind: "ashby",
        company: "Example",
        board: "example",
      },
      1,
      {
        fetch: async () =>
          new Response(null, { status: 503, headers: { "retry-after": "60" } }),
      }
    ),
    /503/
  )
})

test("catalogText lets connectors override Accept but not User-Agent", async () => {
  const { catalogText } = await import("@/lib/server/catalog/feeds")
  let headers = new Headers()
  await catalogText(
    "https://example.com/jobs",
    {
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers)
        return new Response("ok")
      },
    },
    { headers: { Accept: "text/html", "User-Agent": "spoof" } }
  )
  assert.equal(headers.get("Accept"), "text/html")
  assert.equal(headers.get("User-Agent"), "JobSearchCatalog/1.0")
})
