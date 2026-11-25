import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { catalogSources } from "@/lib/server/catalog/feeds"
import {
  parseAshby,
  parseArbeitnow,
  parseGreenhouse,
} from "@/lib/server/catalog/connectors/board-apis"
const source = catalogSources[0]

test("Greenhouse HTML preserves qualification and benefit section boundaries", () => {
  const html =
    "<h2>What It Takes:</h2><ul><li>Five years building Python services and SQL APIs.</li></ul><h2>Nice to have:</h2><p>React experience.</p><h2>Benefits</h2><p>Training and health insurance provided.</p>"
  for (const content of [
    html,
    html
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  ]) {
    const rows = parseGreenhouse(
      {
        id: "greenhouse:example",
        kind: "greenhouse",
        company: "Example",
        board: "example",
      },
      {
        jobs: [
          {
            id: 1,
            title: "Software Engineer",
            absolute_url: "https://boards.greenhouse.io/example/jobs/1",
            location: { name: "Hyderabad, India" },
            content,
          },
        ],
      }
    )
    assert.equal(rows.length, 1)
    assert.match(rows[0].description, /What It Takes:\nFive years/)
    assert.match(rows[0].description, /\nNice to have:\nReact experience\./)
    assert.match(rows[0].description, /\nBenefits\nTraining/)
  }
})
const description =
  "Build customer software using TypeScript and PostgreSQL. We provide visa sponsorship for this position. Collaborate with the engineering team."

test("Greenhouse reads explicit India city and remote labels without guessing country from a bare city", () => {
  const firstPublished = "2026-11-12T12:00:00Z"
  const rows = parseGreenhouse(
    {
      id: "greenhouse:example",
      kind: "greenhouse",
      company: "Example",
      board: "example",
    },
    {
      jobs: [
        "India - Pune; India - Mumbai",
        "Remote - India",
        "IND, Remote",
        "IND Remote",
        "Kolkata, West Bengal. India",
        "Pune, IND",
        "Pune",
        "London - Hybrid, United Kingdom",
      ].map((name, id) => ({
        id,
        title: "Software Engineer",
        absolute_url: `https://boards.greenhouse.io/example/jobs/${id}`,
        location: { name },
        content: description,
        first_published: firstPublished,
      })),
    }
  )
  assert.deepEqual(
    rows.map(({ country, city, work_mode }) => [country, city, work_mode]),
    [
      ["India", "Pune", "unknown"],
      ["India", "Mumbai", "unknown"],
      ["India", null, "remote"],
      ["India", null, "remote"],
      ["India", null, "remote"],
      ["India", "Kolkata, West Bengal", "unknown"],
      ["India", "Pune", "unknown"],
      ["United Kingdom", "London - Hybrid", "unknown"],
    ]
  )
  assert.ok(rows.every((row) => row.posted_at === "2026-11-12T12:00:00.000Z"))
})

const raw = {
  title: "Senior Software Engineer",
  jobUrl: "https://jobs.ashbyhq.com/n8n/real-id",
  isListed: true,
  workplaceType: "Hybrid",
  isRemote: true,
  descriptionPlain: description,
  publishedAt: "2026-10-20T12:00:00Z",
  address: {
    postalAddress: { addressCountry: "DEU", addressLocality: "Berlin" },
  },
  secondaryLocations: [
    {
      location: "Amsterdam",
      address: {
        postalAddress: { addressCountry: "NLD", addressLocality: "Amsterdam" },
      },
    },
  ],
}
test("employer feed retains real descriptions and explicit locations without treating hybrid as remote", () => {
  const rows = parseAshby(source, { jobs: [raw, { ...raw, isListed: false }] })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].work_mode, "hybrid")
  assert.equal(rows[0].country, "Germany")
  assert.equal(rows[1].country, "Netherlands")
  assert.equal(rows[0].description, description)
  assert.equal(rows[0].visa_signal, "confirmed")
  assert.equal(rows[0].sponsor_verified, false)
  assert.equal(parseAshby(source, { jobs: [raw] })[0].id, rows[0].id)
})
test("ambiguous geography, missing descriptions and invalid URLs do not become job recommendations", () => {
  assert.deepEqual(
    parseAshby(source, {
      jobs: [
        { ...raw, address: {}, secondaryLocations: [], location: "Worldwide" },
      ],
    }),
    []
  )
  assert.deepEqual(
    parseAshby(source, { jobs: [{ ...raw, jobUrl: "javascript:alert(1)" }] }),
    []
  )
  assert.deepEqual(
    parseAshby(source, { jobs: [{ ...raw, descriptionPlain: "" }] }),
    []
  )
  assert.throws(() => parseAshby(source, { bad: "schema" }))
})
test("feeds retain explicitly named countries beyond the original destination list", () => {
  const rows = parseAshby(source, {
    jobs: [
      {
        ...raw,
        address: {
          postalAddress: { addressCountry: "CA", addressLocality: "Toronto" },
        },
        secondaryLocations: [
          { address: { postalAddress: { addressCountry: "Singapore" } } },
        ],
      },
    ],
  })
  assert.deepEqual(
    rows.map((row) => row.country),
    ["Canada", "Singapore"]
  )
  const boardRows = parseArbeitnow({
    data: [
      {
        slug: "canada",
        company_name: "Example",
        title: "Backend Engineer",
        description,
        location: "Toronto, Canada",
        url: "https://example.com/jobs/canada",
      },
    ],
  })
  assert.equal(boardRows[0].country, "Canada")
})
test("board metadata does not invent sponsorship or onsite work", () => {
  const rows = parseArbeitnow({
    data: [
      {
        slug: "real",
        company_name: "Example",
        title: "Engineer",
        description:
          "<p>" +
          "Build TypeScript APIs and PostgreSQL services. ".repeat(4) +
          "</p>",
        location: "Berlin",
        url: "https://www.arbeitnow.com/jobs/example",
        remote: false,
        created_at: 1792497600,
      },
    ],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].work_mode, "unknown")
  assert.equal(rows[0].visa_signal, "possible")
})
test("catalogue snapshots publish atomically, expire safely and protect customer history", async () => {
  const db = new PGlite()
  try {
    await db.exec(
      "create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role;create type visa_confidence as enum('confirmed','possible','no');create table job_catalog(id text primary key,title text not null,company text not null,country text not null,city text,url text not null,description text not null,work_mode text not null,visa_signal visa_confidence,sponsorship_evidence text,sponsor_verified boolean,source text,posted_at timestamptz,discovered_at timestamptz default now());grant all on job_catalog to service_role;create table saved_draft(job_id text references job_catalog(id));"
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290002_live_catalog.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const row = parseAshby(source, { jobs: [raw] })[0]
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select claim_catalog_source($1)", [source.id]),
      /permission denied/
    )
    await db.exec("set role service_role")
    assert.equal(
      (
        await db.query<{ claimed: boolean }>(
          "select claim_catalog_source($1) claimed",
          [source.id]
        )
      ).rows[0].claimed,
      true
    )
    assert.equal(
      (
        await db.query<{ claimed: boolean }>(
          "select claim_catalog_source($1) claimed",
          [source.id]
        )
      ).rows[0].claimed,
      false
    )
    await db.query("select publish_catalog_source($1,$2::jsonb,true)", [
      source.id,
      JSON.stringify([row]),
    ])
    await db.exec("reset role")
    await db.query("insert into saved_draft values($1)", [row.id])
    await db.exec("set role service_role")
    await assert.rejects(
      db.query("select publish_catalog_source($1,$2::jsonb,true)", [
        source.id,
        JSON.stringify([{ ...row, source: "wrong" }]),
      ]),
      /Source mismatch/
    )
    assert.equal(
      (
        await db.query<{ is_active: boolean }>(
          "select is_active from job_catalog"
        )
      ).rows[0].is_active,
      true
    )
    await db.query("select publish_catalog_source($1,'[]',false)", [source.id])
    assert.equal(
      (
        await db.query<{ is_active: boolean }>(
          "select is_active from job_catalog"
        )
      ).rows[0].is_active,
      true
    )
    await db.query("select publish_catalog_source($1,'[]',true)", [source.id])
    assert.equal(
      (
        await db.query<{ is_active: boolean }>(
          "select is_active from job_catalog"
        )
      ).rows[0].is_active,
      false
    )
    await db.exec("reset role")
    assert.equal((await db.query("select * from saved_draft")).rows.length, 1)
  } finally {
    await db.close()
  }
})

test("country-scoped visa commitments are not copied to every secondary location", () => {
  const job = {
    ...raw,
    descriptionPlain:
      "We can sponsor visas to Germany; for any other country, you need to have existing right to work. Build reliable TypeScript applications with the engineering team.",
  }
  const rows = parseAshby(source, { jobs: [job] })
  assert.equal(
    rows.find((r) => r.country === "Germany")?.visa_signal,
    "confirmed"
  )
  assert.equal(rows.find((r) => r.country === "Netherlands")?.visa_signal, "no")
  assert.doesNotThrow(() =>
    parseAshby(source, {
      jobs: [{ ...raw, secondaryLocations: [{ address: null }] }],
    })
  )
})

test("Ashby retains same-country cities for matching without changing the listing identity", async () => {
  const { catalogJob } = await import("@/lib/server/catalog/job")
  const { matchJob } = await import("@/lib/matching")
  const { emptyCandidate } = await import("@/lib/candidate")
  const address = (city: string) => ({
    postalAddress: { addressCountry: "IN", addressLocality: city },
  })
  const posting = {
    ...raw,
    address: address("Bengaluru"),
    secondaryLocations: [
      { location: "Hyderabad", address: address("Hyderabad") },
      { location: "Bengaluru", address: address("Bengaluru") },
    ],
  }
  const rows = parseAshby(source, { jobs: [posting] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].city, "Bengaluru; Hyderabad")
  const original = parseAshby(source, {
    jobs: [{ ...posting, secondaryLocations: [] }],
  })[0]
  assert.equal(rows[0].id, original.id)
  const reordered = parseAshby(source, {
    jobs: [
      {
        ...posting,
        address: address("Hyderabad"),
        secondaryLocations: [
          { location: "Bengaluru", address: address("Bengaluru") },
        ],
      },
    ],
  })[0]
  assert.equal(reordered.id, original.id)
  const job = catalogJob({
    ...rows[0],
    is_active: true,
    last_checked_at: new Date().toISOString(),
    discovered_at: new Date().toISOString(),
  })
  for (const name of ["Bengaluru", "Hyderabad"]) {
    const match = matchJob(job, {
      ...emptyCandidate,
      targetCountries: ["India"],
      targetRoles: ["Software Engineer"],
      targetLocations: [{ id: 1, country: "India", name, region: null }],
      workModes: ["hybrid"],
      sponsorshipRequired: false,
      skills: ["TypeScript", "PostgreSQL"],
      experienceYears: 5,
    })
    assert.equal(match.eligible, true, `${name}: ${match.gaps.join(", ")}`)
  }
})
