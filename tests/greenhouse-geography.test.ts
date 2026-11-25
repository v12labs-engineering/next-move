import assert from "node:assert/strict"
import test from "node:test"
import { type RawSourcePosting } from "@/lib/server/catalog/feeds"
import { parseGreenhouse } from "@/lib/server/catalog/connectors/board-apis"
import { validateCandidate } from "@/lib/server/catalog/discovery/validate"

const source = {
  id: "greenhouse:example",
  kind: "greenhouse" as const,
  board: "example",
  company: "Example",
}
const job = {
  id: 123,
  title: "Software Engineer",
  absolute_url: "https://job-boards.greenhouse.io/example/jobs/123",
  content:
    "Build software services and customer APIs using TypeScript, Python and SQL. Collaborate with engineers to maintain reliable production systems.",
  first_published: "2026-11-12T12:00:00Z",
  location: { name: "Hyderabad" },
}

test("Greenhouse resolves a stated city using its matching provider office address in both catalog and source facts", () => {
  const facts: RawSourcePosting[] = []
  const rows = parseGreenhouse(
    source,
    {
      jobs: [
        {
          ...job,
          offices: [
            { name: "Hyderabad", location: "Hyderabad, Telangana, India" },
          ],
        },
      ],
    },
    (fact) => facts.push(fact)
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].country, "India")
  assert.equal(rows[0].city, "Hyderabad")
  assert.deepEqual(facts[0].countries, ["India"])
  assert.deepEqual(facts[0].locations, ["Hyderabad"])
})

test("Greenhouse reads structured Base Country multi-select metadata without mapping a city heuristically", () => {
  const rows = parseGreenhouse(source, {
    jobs: [
      {
        ...job,
        location: { name: "Bangalore" },
        metadata: [{ name: "Base Country", value: ["India"] }],
      },
    ],
  })
  assert.equal(rows[0].country, "India")
  assert.equal(rows[0].city, "Bangalore")
  assert.deepEqual(
    parseGreenhouse(source, {
      jobs: [{ ...job, location: { name: "Bangalore" } }],
    }),
    []
  )
})

test("Greenhouse does not inherit an unrelated office, ambiguous office country or multi-country field", () => {
  for (const variant of [
    {
      location: { name: "Remote" },
      offices: [{ name: "Hyderabad", location: "Hyderabad, Telangana, India" }],
    },
    {
      location: { name: "Bangalore" },
      offices: [{ name: "Hyderabad", location: "Hyderabad, Telangana, India" }],
    },
    {
      location: { name: "Hyderabad" },
      offices: [
        { name: "Hyderabad", location: "Hyderabad, India" },
        { name: "Hyderabad", location: "Hyderabad, Pakistan" },
      ],
    },
    {
      location: { name: "Hyderabad" },
      metadata: [{ name: "Base Country", value: ["India", "Pakistan"] }],
    },
  ])
    assert.deepEqual(
      parseGreenhouse(source, { jobs: [{ ...job, ...variant }] }),
      []
    )
})

test("Greenhouse's explicit job country takes precedence over an office or metadata country", () => {
  const facts: RawSourcePosting[] = []
  const rows = parseGreenhouse(
    source,
    {
      jobs: [
        {
          ...job,
          location: { name: "London, United Kingdom" },
          metadata: [{ name: "Base Country", value: ["India"] }],
        },
      ],
    },
    (fact) => facts.push(fact)
  )
  assert.equal(rows[0].country, "United Kingdom")
  assert.deepEqual(facts[0].countries, ["United Kingdom"])
})

test("discovery admits country evidence from the exact office attached to a Greenhouse posting", async () => {
  const result = await validateCandidate(
    {
      ...source,
      expected_company: "Example",
      historical_checked_at: null,
      evidence_url: "https://job-boards.greenhouse.io/example",
    },
    async (url) =>
      url.endsWith("/example")
        ? { name: "Example" }
        : {
            jobs: [
              {
                ...job,
                offices: [
                  {
                    name: "Hyderabad",
                    location: "Hyderabad, Telangana, India",
                  },
                ],
              },
            ],
          }
  )
  assert.equal(result.status, "verified")
  assert.equal(result.accepted_count, 1)
  assert.deepEqual(result.countries, ["India"])
})
