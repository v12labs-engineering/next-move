import assert from "node:assert/strict"
import test from "node:test"
import {
  companyDomain,
  logoCandidates,
  nameSlug,
  platformSlug,
} from "../lib/jobs/company-logo"

test("uses the employer's own careers site", () => {
  assert.equal(
    companyDomain("https://careers.crunchyroll.com/jobs/123"),
    "crunchyroll.com"
  )
  assert.equal(companyDomain("https://boards.greenhouse.io/acme/1"), null)
  assert.equal(companyDomain("not a url"), null)
})

test("reads the employer slug from hiring platforms", () => {
  assert.equal(platformSlug("https://boards.greenhouse.io/acme/jobs/1"), "acme")
  assert.equal(platformSlug("https://jobs.ashbyhq.com/linear/abc"), "linear")
  assert.equal(platformSlug("https://acme.wd5.myworkdayjobs.com/x"), "acme")
  assert.equal(platformSlug("https://careers.acme.com/x"), null)
})

test("strips legal suffixes from company names", () => {
  assert.equal(nameSlug("Crunchyroll, LLC"), "crunchyroll")
  assert.equal(nameSlug("Booking.com B.V."), "bookingcom")
  assert.equal(nameSlug("Siemens AG"), "siemens")
  assert.equal(nameSlug("Acme Holdings Ltd"), "acme")
})

test("tries the known domain before guesses", () => {
  const domains = logoCandidates("Crunchyroll, LLC", "crunchyroll.com")
  assert.equal(domains[0], "crunchyroll.com")
  assert.deepEqual(logoCandidates("Linear Orbit Inc", "linear").slice(0, 2), [
    "linearorbit.com",
    "linearorbit.io",
  ])
  assert.ok(logoCandidates("Linear Orbit Inc", "linear").includes("linear.com"))
})
