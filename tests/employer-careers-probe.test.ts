import assert from "node:assert/strict"
import test from "node:test"
import {
  probeEmployerCareers,
  showsPublicCareers,
} from "../scripts/lib/employer-careers-probe.mjs"

const company = {
  url: "https://example.com/",
  legalName: "Example Software Private Limited",
  registrationId: "U12345KA2020PTC012345",
  verified: true,
}
const home =
  "<title>Example Software</title><main>Example Software builds and supports infrastructure software.</main>"
const careers =
  "<title>Example Software Careers</title><main><h1>Current Job Openings</h1><p>Join our team building infrastructure software. Apply for a position in the engineering team.</p></main>"
const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } })

function fixture(routes: Record<string, () => Response>) {
  const requests: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    return routes[url]?.() ?? new Response(null, { status: 404 })
  }
  return { requests, fetch, guard: async () => {} }
}

test("confirms a misspelled careers path and ignores a catch-all homepage", async () => {
  const routes = fixture({
    "https://example.com/": () => html(home),
    "https://example.com/career": () => html(home),
    "https://example.com/carrer": () =>
      html(careers.replace("Careers", "Carrer")),
  })
  const result = await probeEmployerCareers(company, routes)
  assert.equal(result.result, "public_careers_found")
  assert.equal(result.links.length, 1)
  assert.equal(result.links[0].url, "https://example.com/carrer")
  assert.deepEqual(result.links[0].evidence, result.links[0].url)
})

test("discovers an unlinked career subdomain and follows a public ATS redirect", async () => {
  const routes = fixture({
    "https://example.com/": () => html(home),
    "https://career.example.com/": () =>
      Response.redirect("https://jobs.lever.co/example"),
    "https://jobs.lever.co/example": () => html(careers),
  })
  const result = await probeEmployerCareers(company, routes)
  assert.equal(result.links[0].url, "https://jobs.lever.co/example")
  assert.equal(result.links[0].evidence, "https://career.example.com/")
  assert.ok(routes.requests.includes("https://jobs.lever.co/robots.txt"))
})

test("saves a verified website that is itself a careers landing page", async () => {
  const url = "https://career.example.com/"
  const routes = fixture({ [url]: () => html(careers) })
  const result = await probeEmployerCareers({ ...company, url }, routes)
  assert.equal(result.links[0].url, url)
})

test("requires employer hiring content rather than a recruiting service or a job detail", () => {
  const service =
    "<title>Permanent Recruitment Agency</title><main><h1>Recruitment Services</h1><p>Our consultants support hiring and recruitment for a broad range of customers.</p></main>"
  const team =
    "<title>Executive Recruitment Agency</title><main><h1>Our Team</h1><p>We provide talent acquisition and recruiter services for corporate customers.</p><a>Join our team</a></main>"
  const detail =
    "<title>Business Account Executive | Careers at Example</title><main><h1>Business Account Executive</h1><p>Apply for a position with our company through our website application.</p></main>"
  const recruitment =
    "<title>Recruitment</title><main><h1>Recruitment</h1><h2>Current</h2><h2>Open Positions</h2><p>Submit your application through our employer hiring form.</p></main>"
  assert.equal(
    showsPublicCareers(service, new URL("/recruitment-services", company.url)),
    false
  )
  assert.equal(
    showsPublicCareers(team, new URL("/our-team", company.url)),
    false
  )
  assert.equal(
    showsPublicCareers(
      detail,
      new URL("/careers/business-account-executive", company.url)
    ),
    false
  )
  assert.equal(
    showsPublicCareers(recruitment, new URL("/recruitment", company.url)),
    true
  )
  assert.equal(
    showsPublicCareers(careers, new URL("/careers", company.url)),
    true
  )
})

test("uses the About page to confirm the legal company and find a careers link", async () => {
  const routes = fixture({
    "https://example.com/": () => html(home + '<a href="/about-us">About</a>'),
    "https://example.com/about-us": () =>
      html(
        '<title>About Example</title><main>Example Software Private Limited<a href="/company-hiring">Careers</a></main>'
      ),
    "https://example.com/company-hiring": () => html(careers),
  })
  const result = await probeEmployerCareers(
    { ...company, verified: false },
    routes
  )
  assert.equal(result.websiteEvidence, "https://example.com/about-us")
  assert.equal(result.links[0].url, "https://example.com/company-hiring")
  assert.equal(result.links[0].evidence, result.websiteEvidence)
})

test("respects robots and leaves credential-gated pages out of public results", async () => {
  const routes = fixture({
    "https://example.com/": () => html(home),
    "https://example.com/robots.txt": () =>
      new Response("User-agent: *\nDisallow: /carrer\n"),
    "https://example.com/carrer": () => html(careers),
    "https://example.com/careers": () =>
      html(
        careers.replace(
          "</main>",
          '<form action="/login"><input type="password"></form></main>'
        )
      ),
  })
  const result = await probeEmployerCareers(company, routes)
  assert.equal(result.links.length, 0)
  assert.ok(!routes.requests.includes("https://example.com/carrer"))
})
