import assert from "node:assert/strict"
import test from "node:test"
import { autoApplyEligible, visaNeeded } from "../lib/applications/auto-apply"
import { emptyCandidate, type Candidate } from "../lib/candidate"
import { applicationProfileSchema } from "../lib/applications/profile"
import type { Job } from "../lib/jobs"

const candidate: Candidate = {
  ...emptyCandidate,
  currentLocation: "Berlin, Germany",
  sponsorshipRequired: true,
  autoApply: { enabled: true, minScore: 80 },
}
const matched = (score: number): NonNullable<Job["match"]> => ({
  score,
  reasons: [],
  gaps: [],
  relevant: true,
  reviewable: true,
  eligible: true,
})
const job = (overrides: Partial<Job> = {}): Job => ({
  id: "ashby:acme:1",
  title: "Engineer",
  company: "Acme",
  country: "Netherlands",
  remote: "hybrid",
  url: "https://jobs.ashbyhq.com/acme/00000000-0000-4000-8000-000000000001",
  visaSignal: "confirmed",
  visaSignalSource: "rules",
  sponsorVerified: true,
  freshness: "fresh",
  source: "ashby:acme",
  status: "new",
  seenAt: "2026-10-30T00:00:00Z",
  match: matched(85),
  ...overrides,
})

test("auto-apply sends new jobs at or above the threshold", () => {
  assert.equal(autoApplyEligible(candidate, job()), true)
  assert.equal(autoApplyEligible(candidate, job({ match: matched(80) })), true)
  assert.equal(autoApplyEligible(candidate, job({ match: matched(79) })), false)
})

test("auto-apply requires an eligible, reviewable match", () => {
  assert.equal(
    autoApplyEligible(
      candidate,
      job({ match: { ...matched(95), eligible: false } })
    ),
    false
  )
  assert.equal(
    autoApplyEligible(
      candidate,
      job({ match: { ...matched(95), reviewable: false } })
    ),
    false
  )
})

test("auto-apply never acts when off, reviewed, closed or unlinked", () => {
  assert.equal(
    autoApplyEligible(
      { ...candidate, autoApply: { enabled: false, minScore: 50 } },
      job()
    ),
    false
  )
  assert.equal(
    autoApplyEligible(candidate, job({ status: "dismissed" })),
    false
  )
  assert.equal(autoApplyEligible(candidate, job({ isActive: false })), false)
  assert.equal(
    autoApplyEligible(candidate, job({ url: "http://example.com/job" })),
    false
  )
})

test("a country the candidate cannot work in or be sponsored for is never auto-applied", () => {
  const applicationProfile = applicationProfileSchema.parse({
    enabled: true,
    confirmedAt: new Date().toISOString(),
    eligibility: [
      {
        country: "Netherlands",
        authorized: true,
        sponsorshipNow: false,
        sponsorshipFuture: false,
      },
      {
        country: "Germany",
        authorized: false,
        sponsorshipNow: true,
        sponsorshipFuture: true,
      },
      {
        country: "Canada",
        authorized: false,
        sponsorshipNow: false,
        sponsorshipFuture: null,
      },
    ],
  })
  const confirmed = { ...candidate, applicationProfile }
  assert.equal(
    visaNeeded({ ...candidate, sponsorshipRequired: false })("Japan"),
    false
  )
  assert.equal(visaNeeded(confirmed)("Netherlands"), false)
  assert.equal(visaNeeded(confirmed)("Germany"), true)
  assert.equal(
    autoApplyEligible(
      confirmed,
      job({ country: "Canada", visaSignal: "confirmed" })
    ),
    false
  )
})
