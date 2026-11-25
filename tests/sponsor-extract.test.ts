import assert from "node:assert/strict"
import test from "node:test"

import { selectJobLinks } from "../lib/server/sponsor-sources/extract-jobs"
import {
  pickCareersLink,
  normalizeWebsite,
} from "../lib/server/sponsor-sources/enrich"

test("selectJobLinks finds Greenhouse/Lever/Ashby postings, skips index pages", () => {
  const careers = "https://boards.greenhouse.io/acme"
  const links = [
    "https://boards.greenhouse.io/acme/jobs/4012345", // real posting
    "https://boards.greenhouse.io/acme", // index — skip
    "https://jobs.lever.co/acme/2b1c9f7a-3d4e-4a5b-9c8d-1e2f3a4b5c6d", // lever posting
    "https://jobs.ashbyhq.com/acme/9f8e7d6c-5b4a-3c2d-1e0f-a1b2c3d4e5f6", // ashby posting
    "https://jobs.workable.com/view/mDKZapbwG2HVEEbsdjd9Ta/hybrid-staff%2Fsenior-full-stack-engineer-in-hamburg-at-akeno",
    "https://acme.com/about", // unrelated — skip
    "https://acme.com/careers", // index — skip
  ]
  const jobs = selectJobLinks(careers, links)
  const urls = jobs.map((j) => j.url)
  assert.ok(urls.includes("https://boards.greenhouse.io/acme/jobs/4012345"))
  assert.ok(urls.some((u) => u.includes("lever.co/acme/2b1c9f7a")))
  assert.ok(urls.some((u) => u.includes("ashbyhq.com/acme/9f8e7d6c")))
  assert.ok(urls.some((u) => u.includes("jobs.workable.com/view/mDKZap")))
  assert.ok(!urls.includes("https://acme.com/about"))
  assert.ok(!urls.includes("https://acme.com/careers"))
  assert.equal(
    jobs.find((j) => j.url.includes("greenhouse"))?.ats,
    "greenhouse"
  )
})

test("selectJobLinks uses link text as title when available", () => {
  const careers = "https://boards.greenhouse.io/acme"
  const links = ["https://boards.greenhouse.io/acme/jobs/4012345"]
  const text = {
    "https://boards.greenhouse.io/acme/jobs/4012345": "Staff Software Engineer",
  }
  const jobs = selectJobLinks(careers, links, text)
  assert.equal(jobs[0].title, "Staff Software Engineer")
})

test("selectJobLinks derives a title from the slug when no link text", () => {
  const careers = "https://acme.com/careers"
  const links = ["https://acme.com/jobs/senior-backend-engineer-amsterdam"]
  const jobs = selectJobLinks(careers, links)
  assert.equal(jobs.length, 1)
  assert.match(jobs[0].title, /Senior Backend Engineer/i)
})

test("selectJobLinks rejects career-site navigation and filtered listing links", () => {
  const careers = "https://www.axon.com/careers"
  const links = [
    "https://www.axon.com/careers/all",
    "https://www.axon.com/careers/getting-hired",
    "https://www.axon.com/careers/early-career",
    "https://www.axon.com/careers/culture",
    "https://www.axon.com/careers/all?greenhouse-jobs-index%5BrefinementList%5D%5Blocation.name%5D%5B0%5D=Seattle#careers-all",
    "https://www.falck.com/careers/working-at-falck/career-and-development/",
    "https://www.apple.com/careers/us/work-at-apple.html",
    "https://www.apple.com/careers/global/media/acvideo/2021/index/redesign/us/hero/careers-index-cc-us-2021_1280x720h.mp4",
    "https://www.databricks.com/company/careers/open-positions?department=administration&itm_offer=open-positions",
    "https://jobs.acme.com/jobs/senior-platform-engineer-copenhagen",
  ]

  const jobs = selectJobLinks(careers, links)

  assert.deepEqual(
    jobs.map((job) => job.url),
    ["https://jobs.acme.com/jobs/senior-platform-engineer-copenhagen"]
  )
})

test("selectJobLinks dedupes repeated job URLs", () => {
  const careers = "https://boards.greenhouse.io/acme"
  const links = [
    "https://boards.greenhouse.io/acme/jobs/4012345",
    "https://boards.greenhouse.io/acme/jobs/4012345",
  ]
  assert.equal(selectJobLinks(careers, links).length, 1)
})

test("pickCareersLink picks careers/jobs links including localized ones", () => {
  const base = "https://acme.nl"
  assert.equal(
    pickCareersLink(base, ["/over-ons", "/werken-bij", "/contact"]),
    "https://acme.nl/werken-bij"
  )
  assert.equal(pickCareersLink(base, ["/about", "/contact"]), "")
})

test("normalizeWebsite adds scheme and strips trailing slash", () => {
  assert.equal(normalizeWebsite("acme.io"), "https://acme.io")
  assert.equal(normalizeWebsite("https://acme.io/"), "https://acme.io")
  assert.equal(normalizeWebsite(""), "")
})
