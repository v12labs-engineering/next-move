import assert from "node:assert/strict"
import test from "node:test"
import {
  fetchCatalogPage,
  fetchSourcePage,
} from "@/lib/server/catalog/connectors"
import type { CatalogSource } from "@/lib/server/catalog/feeds"

const fixtures: {
  source: CatalogSource
  payload: unknown
  malformed: unknown
}[] = [
  {
    source: {
      id: "greenhouse:example",
      kind: "greenhouse",
      board: "example",
      company: "Example",
    },
    payload: {
      jobs: [
        {
          id: 1,
          title: "Accountant",
          absolute_url: "https://boards.greenhouse.io/example/jobs/1",
        },
      ],
    },
    malformed: {
      jobs: [
        {
          id: 1,
          title: "Accountant",
          absolute_url: "https://boards.greenhouse.io/example/jobs/1",
          content: 12,
        },
      ],
    },
  },
  {
    source: {
      id: "arbeitnow",
      kind: "arbeitnow",
      board: null,
      company: "Arbeitnow",
    },
    payload: {
      data: [
        {
          slug: "accountant",
          title: "Accountant",
          company_name: "Example",
          url: "https://example.com/jobs/1",
        },
      ],
      links: { next: null },
    },
    malformed: {
      data: [
        {
          slug: "accountant",
          title: "Accountant",
          company_name: "Example",
          url: "https://example.com/jobs/1",
          description: 12,
        },
      ],
      links: { next: null },
    },
  },
  {
    source: {
      id: "ashby:example",
      kind: "ashby",
      board: "example",
      company: "Example",
    },
    payload: {
      jobs: [
        {
          title: "Accountant",
          jobUrl: "https://jobs.ashbyhq.com/example/1",
          isListed: true,
          descriptionPlain: null,
          location: null,
          publishedAt: null,
        },
      ],
    },
    malformed: {
      jobs: [
        {
          title: "Accountant",
          jobUrl: "https://jobs.ashbyhq.com/example/1",
          isListed: true,
          descriptionPlain: 12,
        },
      ],
    },
  },
  {
    source: {
      id: "lever:example",
      kind: "lever",
      board: "example",
      company: "Example",
    },
    payload: [
      {
        text: "Accountant",
        hostedUrl: "https://jobs.lever.co/example/1",
        descriptionPlain: null,
        categories: null,
        createdAt: null,
      },
    ],
    malformed: [
      {
        text: "Accountant",
        hostedUrl: "https://jobs.lever.co/example/1",
        descriptionPlain: 12,
      },
    ],
  },
]

for (const { source, payload, malformed } of fixtures) {
  test(`${source.kind} raw facts retain unknown fields while catalog schema stays strict`, async () => {
    const options = { fetch: async () => Response.json(payload) }
    const raw = await fetchSourcePage(source, 1, options)
    assert.equal(raw.postings.length, 1)
    assert.equal(raw.postings[0].title, "Accountant")
    assert.equal(raw.postings[0].description, "")
    assert.deepEqual(raw.postings[0].locations, [])
    assert.deepEqual(raw.postings[0].countries, [])
    assert.equal(raw.postings[0].postedAt, null)
    await assert.rejects(fetchCatalogPage(source, 1, options))
    await assert.rejects(
      fetchSourcePage(source, 1, {
        fetch: async () => Response.json(malformed),
      })
    )
  })
}
