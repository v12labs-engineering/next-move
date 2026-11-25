import assert from "node:assert/strict"
import test from "node:test"
import { parsePublicFeed } from "@/lib/server/catalog/connectors/public-feeds"
import { inspectProfessionalFeed } from "../scripts/lib/professional-job-portals.mjs"

test("professional feed policy preserves explicit countries over conflicting location text", () => {
  const page = new URL("https://weworkremotely.com/remote-jobs.rss")
  const portal = {
    company: "We Work Remotely",
    url: page.href,
    feed: { kind: "xml" as const, url: page.href },
  }
  for (const location of ["Worldwide", "Bengaluru", "India"]) {
    const body = `<rss><channel><item><title>Acme: Accountant</title><link>https://weworkremotely.com/remote-jobs/accountant</link><location>${location}</location><country>DE</country><description>Monthly accounting and budgeting.</description></item></channel></rss>`
    assert.deepEqual(
      parsePublicFeed(body, page, { kind: "xml", publisher: portal.company })
        .postings[0].countries,
      ["Germany"]
    )
    assert.deepEqual(
      inspectProfessionalFeed(body, page, portal).jobs,
      [],
      location
    )
    const india = inspectProfessionalFeed(
      body.replace("<country>DE", "<country>IN"),
      page,
      portal
    )
    assert.deepEqual(india.jobs[0]?.countries, ["India"])
  }
})

test("Himalayas source facts retain foreign and timezone restrictions before consumer filtering", () => {
  const page = new URL(
    "https://himalayas.app/jobs/api/search?country=IN&page=1"
  )
  const body = JSON.stringify({
    offset: 0,
    totalCount: 5,
    jobs: [
      {
        title: "Accountant",
        companyName: "Example",
        applicationLink: "https://himalayas.app/jobs/accountant",
        guid: "https://himalayas.app/jobs/accountant",
        description: "<p>Accounting</p>",
        locationRestrictions: [{ alpha2: "US", name: "United States" }],
        timezoneRestrictions: ["UTC-5:30"],
        expiryDate: "2020-01-01T00:00:00Z",
      },
      {
        title: "Delivery Driver",
        companyName: "Example",
        applicationLink: "https://himalayas.app/jobs/driver",
        guid: "https://himalayas.app/jobs/driver",
        locationRestrictions: [],
        timezoneRestrictions: [],
      },
    ],
  })
  const raw = parsePublicFeed(body, page, {
    kind: "himalayas",
    publisher: "Himalayas",
  })
  assert.equal(raw.postings.length, 2)
  assert.deepEqual(raw.postings[0].countries, ["United States"])
  assert.deepEqual(raw.postings[0].locationRestrictions, ["US"])
  assert.deepEqual(raw.postings[0].timezoneRestrictions, ["UTC-5:30"])
  assert.equal(raw.postings[0].expiresAt, "2020-01-01T00:00:00Z")
  assert.deepEqual(raw.postings[0].locations, ["Remote"])
  assert.deepEqual(raw.postings[1].locations, ["Worldwide"])
  assert.equal(raw.postings[1].postedAt, null)
  assert.equal(raw.next?.searchParams.get("page"), "2")
  assert.equal(raw.window, null)
  const filtered = inspectProfessionalFeed(body, page, {
    company: "Himalayas",
    url: page.href,
    feed: { kind: "himalayas", url: page.href },
  })
  assert.equal(filtered.jobs.length, 0)
})

test("Remotive and Remote OK source facts preserve every profession and stated location", () => {
  for (const fixture of [
    {
      kind: "remotive" as const,
      publisher: "Remotive",
      page: "https://remotive.com/api/remote-jobs",
      payload: {
        jobs: [
          {
            title: "Accountant",
            company_name: "Example",
            url: "https://remotive.com/remote-jobs/accountant",
            candidate_required_location: "Germany",
            publication_date: "2026-01-01",
            description: "Accounting",
          },
        ],
      },
    },
    {
      kind: "remote-ok" as const,
      publisher: "Remote OK",
      page: "https://remoteok.com/api",
      payload: [
        { legal: "Feed attribution" },
        {
          position: "Delivery Driver",
          company: "Example",
          url: "https://remoteok.com/remote-jobs/driver",
          location: "India",
          date: "2026-01-02",
        },
      ],
    },
  ]) {
    const raw = parsePublicFeed(
      JSON.stringify(fixture.payload),
      new URL(fixture.page),
      fixture
    )
    assert.equal(raw.postings.length, 1)
    assert.equal(raw.window, "Publisher's recent feed window")
    assert.equal(raw.next, null)
    assert.equal(
      raw.postings[0].title,
      fixture.kind === "remotive" ? "Accountant" : "Delivery Driver"
    )
    assert.deepEqual(raw.postings[0].locations, [
      fixture.kind === "remotive" ? "Germany" : "India",
    ])
  }
})

test("Jobicy keeps geography facts and returns only an advancing same-source cursor", () => {
  const page = new URL("https://jobicy.com/api/jobs?cursor=first")
  const data = {
    jobs: [
      {
        jobTitle: "Accountant",
        companyName: "Example",
        url: "https://jobicy.com/jobs/123-accountant",
        jobGeo: ["India", "Canada"],
        pubDate: 1767225600,
        jobDescription: "Accounting",
      },
    ],
    hasMore: true,
    nextCursor: "second",
  }
  const raw = parsePublicFeed(JSON.stringify(data), page, {
    kind: "jobicy",
    publisher: "Jobicy",
  })
  assert.deepEqual(raw.postings[0].locations, ["India, Canada"])
  assert.equal(raw.postings[0].postedAt, "2026-01-01T00:00:00.000Z")
  assert.equal(raw.next?.href, "https://jobicy.com/api/jobs?cursor=second")
  assert.throws(
    () =>
      parsePublicFeed(JSON.stringify({ ...data, nextCursor: "first" }), page, {
        kind: "jobicy",
        publisher: "Jobicy",
      }),
    /repeated its cursor/
  )
})

test("RSS parsing retains raw expiry and unknown details without widening publisher URLs", () => {
  const page = new URL("https://weworkremotely.com/remote-jobs.rss")
  const raw = parsePublicFeed(
    `<rss><channel>
    <item><title>Example: Accountant</title><link>https://weworkremotely.com/remote-jobs/accountant</link><location>Germany</location><country>DE</country><expires_at>2020-01-01</expires_at><description>Accounting</description></item>
    <item><title>Incomplete title</title><link>https://weworkremotely.com/remote-jobs/unknown</link></item>
    <item><title>Other: Accountant</title><link>https://unrelated.example/jobs/accountant</link></item>
  </channel></rss>`,
    page,
    { kind: "xml", publisher: "We Work Remotely" }
  )
  assert.equal(raw.postings.length, 1)
  assert.equal(raw.postings[0].title, "Accountant")
  assert.equal(raw.postings[0].company, "Example")
  assert.equal(raw.postings[0].expiresAt, "2020-01-01")
  assert.deepEqual(raw.postings[0].countries, ["Germany"])
  assert.deepEqual(
    raw.details.map((url) => url.href),
    ["https://weworkremotely.com/remote-jobs/unknown"]
  )
  assert.equal(raw.window, "Latest published feed window")
})

test("Hasjob Atom title mapping preserves employer and requires safe public links", () => {
  const raw = parsePublicFeed(
    `<feed>
    <entry><title>Finance Manager - Example</title><link href="https://hasjob.co/example/123"/><country>IN</country><published>2026-01-01</published><content>Finance</content></entry>
    <entry><title>Accountant - Example</title><link href="http://hasjob.co/example/456"/></entry>
  </feed>`,
    new URL("https://hasjob.co/feed"),
    { kind: "xml", publisher: "Hasjob" }
  )
  assert.equal(raw.postings.length, 1)
  assert.equal(raw.postings[0].title, "Finance Manager")
  assert.equal(raw.postings[0].company, "Example")
  assert.deepEqual(raw.postings[0].locations, ["India"])
})

test("professional feed adapter applies eligibility after raw parsing", () => {
  const page = new URL("https://remotive.com/api/remote-jobs")
  const body = JSON.stringify({
    jobs: ["Accountant", "Delivery Driver", "Software Engineer Intern"].map(
      (title, index) => ({
        title,
        company_name: "Example",
        url: `https://remotive.com/remote-jobs/${index}`,
        candidate_required_location: "India",
        description: "Professional role",
      })
    ),
  })
  assert.equal(
    parsePublicFeed(body, page, { kind: "remotive", publisher: "Remotive" })
      .postings.length,
    3
  )
  const result = inspectProfessionalFeed(body, page, {
    company: "Remotive",
    url: page.href,
    feed: { kind: "remotive", url: page.href },
  })
  assert.deepEqual(
    result.jobs.map((job) => job.title),
    ["Accountant"]
  )
})
