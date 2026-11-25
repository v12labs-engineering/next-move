import assert from "node:assert/strict"
import test from "node:test"
import {
  dedupeIndiaJobs,
  type IndiaJobObservation,
} from "../scripts/india/dedupe-india-job-postings.mjs"
import { inspectProfessionalFeed } from "../scripts/lib/professional-job-portals.mjs"
import {
  inspectRegistryJobPage,
  normalizedPosting,
} from "../scripts/lib/registry-job-postings.mjs"

const source = new URL("https://employer.com/careers/")
const inspect = (body: string, page = source) =>
  inspectRegistryJobPage(body, page, source, "Example Private Limited")

const observation: IndiaJobObservation = {
  kind: "monitored",
  id: "monitor-pune",
  source: "greenhouse:example",
  url: "https://job-boards.greenhouse.io/example/jobs/123456",
  title: "Senior Software Engineer",
  company: "Example Technologies",
  location: "Pune",
  postedAt: "2026-11-11T00:00:00Z",
  description: Array.from(
    { length: 20 },
    (_, index) =>
      `Responsibility ${index} includes reviewing production changes and documenting customer impact.`
  ).join(" "),
}

test("dedupe preserves each location for the same requisition and keeps a separate requisition", () => {
  const rows = dedupeIndiaJobs([
    observation,
    { ...observation, id: "monitor-bengaluru", location: "Bengaluru" },
    {
      ...observation,
      kind: "portal",
      id: "listing",
      source: "board",
      url: "https://www.example.com/jobs?gh_jid=123456&utm_source=board",
    },
    {
      ...observation,
      id: "other-requisition",
      url: "https://job-boards.greenhouse.io/example/jobs/987654",
    },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.find((row) => row.evidence.length === 3)?.locations, [
    "Bengaluru",
    "Pune",
  ])
})

test("dedupe connects corroborated syndicated descriptions and keeps conflicting cities separate", () => {
  const a: IndiaJobObservation = {
    ...observation,
    kind: "portal",
    id: "a",
    source: "first",
    url: "https://first.example.com/jobs/111",
    location: null,
  }
  const b: IndiaJobObservation = {
    ...a,
    id: "b",
    source: "second",
    url: "https://second.example.com/jobs/222",
    location: "Pune",
    description: "Read the posting. " + a.description,
  }
  const merged = dedupeIndiaJobs([a, b])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].match, "syndicated_description")
  assert.equal(dedupeIndiaJobs([{ ...a, location: "Chennai" }, b]).length, 2)
})

test("Himalayas distinguishes India country and timezone restrictions from worldwide roles", () => {
  const url = new URL("https://himalayas.app/jobs/api/search?country=IN")
  const posting = (
    slug: string,
    locationRestrictions: unknown[],
    timezoneRestrictions: (number | string)[]
  ) => ({
    title: "Senior Software Engineer",
    companyName: "Example Technologies",
    applicationLink: `https://himalayas.app/companies/example/jobs/${slug}?utm_source=feed`,
    guid: `https://himalayas.app/companies/example/jobs/${slug}`,
    locationRestrictions,
    timezoneRestrictions,
  })
  const result = inspectProfessionalFeed(
    JSON.stringify({
      jobs: [
        posting("in", [{ alpha2: "IN", name: "India" }], []),
        posting("ist", [], ["UTC+5:30"]),
        posting("numeric-ist", ["India"], [5.5]),
        posting("negative-offset", [], ["UTC-5:30"]),
        posting("numeric-negative-offset", [], [-5.5]),
        posting("us", [{ alpha2: "US", name: "United States" }], []),
        posting("unrestricted", [], []),
      ],
    }),
    url,
    {
      company: "Himalayas",
      url: url.href,
      feed: { kind: "himalayas", url: url.href },
    }
  )
  assert.deepEqual(
    result.jobs.map((job) => job.location),
    ["Remote (India)", "Remote (India)", "Remote (India)", "Remote (worldwide)"]
  )
  assert.ok(result.jobs.every((job) => job.url.endsWith("?utm_source=feed")))
})

test("reads listed jobs from a graph, retains explicit locations and excludes expired postings", () => {
  const entries = [
    {
      "@type": "JobPosting",
      title: "Software Engineer",
      url: "/jobs/engineer?utm_source=test",
      description: "<p>Build distributed systems.</p>",
      jobLocation: {
        address: { addressCountry: "IN", addressLocality: "Pune" },
      },
    },
    {
      "@type": "JobPosting",
      title: "Former vacancy",
      url: "/jobs/expired",
      validThrough: "2001-01-01",
    },
    { "@type": "Organization", name: "An employer" },
  ]
  const result = inspect(
    '<script type="application/ld+json">' +
      JSON.stringify({ "@graph": entries }) +
      "</script>"
  )
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].url, "https://employer.com/jobs/engineer")
  assert.deepEqual(result.jobs[0].countries, ["India"])
})

test("distinguishes jobs sharing a listing URL from a speculative resume intake form", () => {
  const result = inspect(
    "<main><h1>Careers</h1><form><button>Submit your resume</button></form>" +
      '<article class="job-card" data-job-id="1"><h2>Software Engineer</h2><button>Apply now</button></article>' +
      '<article class="job-card" data-job-id="2"><h2>Support Lead</h2><button>Apply now</button></article></main>'
  )
  assert.deepEqual(
    result.jobs.map((row) => row.title),
    ["Software Engineer", "Support Lead"]
  )
  assert.equal(new Set(result.jobs.map((row) => row.key)).size, 2)
})

test("requires job detail evidence and keeps pagination and sign-in outcomes separate", () => {
  const listing = inspect(
    '<main><a href="https://employer.com/jobs/123">Data Engineer</a>' +
      '<a rel="next" href="?page=2">Next</a></main>'
  )
  assert.equal(listing.jobs.length, 0)
  assert.equal(listing.details[0].href, "https://employer.com/jobs/123")
  assert.equal(listing.next[0].search, "?page=2")
  assert.equal(
    inspect("<title>Sign In</title><form><input type='password'></form>").gate,
    "auth_required"
  )
  const detail = inspect(
    "<main><h1>Data Engineer</h1><h2>Responsibilities</h2>Build pipelines." +
      "<h2>Qualifications</h2>SQL and Python. <a href='/apply/123'>Apply now</a></main>",
    listing.details[0]
  )
  assert.equal(detail.jobs[0]?.method, "job_detail")
})

test("uses the same Greenhouse posting identity for an employer embed and the hosted board", () => {
  const input = {
    title: "Data Engineer",
    company: "Example",
    location: null,
    countries: [],
    postedAt: null,
    description: "",
    evidence: source.href,
    method: "ats" as const,
  }
  const hosted = normalizedPosting({
    ...input,
    url: "https://job-boards.greenhouse.io/example/jobs/123",
  })
  const embedded = normalizedPosting({
    ...input,
    url: "https://employer.com/job?gh_jid=123&utm_source=boards",
  })
  assert.ok(hosted && embedded)
  assert.equal(hosted.key, embedded.key)
})

test("reads an employer's inline posting without treating the job's stated headcount as postings", () => {
  const result = inspect(
    "<main><section><h2>Current Openings</h2>" +
      "<div><h4>Business Development Executive</h4><p>2 Open Positions</p>" +
      '<a href="mailto:hr@employer.com">Apply Now</a></div></section></main>'
  )
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].url, "https://employer.com/careers")
  assert.equal(result.jobs[0].title, "Business Development Executive")
})

test("follows an advertised jobs list and reads detail fields under an employer's generic heading", () => {
  const result = inspect(
    '<a href="https://careers.employer.com/search-jobs">View all open positions</a>'
  )
  assert.deepEqual(
    result.listings.map((url) => url.href),
    ["https://careers.employer.com/search-jobs"]
  )
  const detail = inspect(
    "<main><h1>Career With Us</h1><h2>Website Designer</h2>" +
      "<p>Location : Mumbai, India</p><p>Experience : 1–3 years</p>" +
      "<p>Qualification : Computer science degree</p><p>Skills : HTML</p></main>",
    new URL("https://employer.com/CareerDetail/Website-Designer")
  )
  assert.equal(detail.jobs[0]?.title, "Website Designer")
  assert.deepEqual(detail.jobs[0]?.countries, ["India"])
  assert.equal(
    inspect(
      '<main><div class="job-card" data-job-id="x"><h2>Share this job</h2><button>Apply now</button></div></main>'
    ).jobs.length,
    0
  )
})
