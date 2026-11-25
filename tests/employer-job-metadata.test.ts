import assert from "node:assert/strict"
import test from "node:test"
import { readEmployerJobMetadata } from "../scripts/lib/employer-job-metadata.mjs"

test("employer job metadata requires matching employer, India eligibility and a live posting window", () => {
  const page = new URL("https://careers.example.com/jobs")
  const job = {
    "@type": "JobPosting",
    url: "/job/123",
    title: "Software Engineer",
    hiringOrganization: { name: "Example" },
    jobLocation: {
      address: { addressCountry: { name: "IN" }, addressLocality: "Pune" },
    },
    datePosted: "2026-11-13",
    validThrough: "2026-11-16",
  }
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [
      job,
      { ...job, title: "Software Engineer Intern" },
      { ...job, hiringOrganization: { name: "Different employer" } },
      { ...job, jobLocation: { address: { addressCountry: "US" } } },
      { ...job, validThrough: "2026-11-15" },
      { ...job, url: "https://different.example.com/job/123" },
      {
        ...job,
        url: "/job/321",
        jobLocation: undefined,
        jobLocationType: "TELECOMMUTE",
        applicantLocationRequirements: { name: "India" },
      },
    ],
  })}</script>`
  const result = readEmployerJobMetadata(
    page,
    html,
    (name) => name.toLowerCase(),
    "example",
    new Date("2026-11-16T12:30:00Z")
  )
  assert.deepEqual(
    result.map(({ url, city }) => [url, city]),
    [
      ["https://careers.example.com/job/123", "Pune"],
      ["https://careers.example.com/job/321", null],
    ]
  )
})
