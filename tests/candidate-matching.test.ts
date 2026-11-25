import assert from "node:assert/strict"
import test from "node:test"
import { candidateSchema, type Candidate } from "@/lib/candidate"
import { matchJob, relevantJobTitle } from "@/lib/matching"
import type { Job } from "@/lib/jobs"
import { assembleResume } from "@/lib/resume"
import { safeNext, readJson } from "@/lib/server/http"

const candidate: Candidate = {
  fullName: "Alice Example",
  headline: "Backend engineer",
  currentLocation: "Bengaluru",
  experienceYears: 5,
  targetRoles: ["Backend Engineer"],
  skills: ["Python", "Postgres"],
  targetCountries: ["Germany"],
  workModes: ["hybrid"],
  sponsorshipRequired: true,
  excludedCompanies: [],
  resumeText:
    "Built reliable Python APIs with Postgres for a payments product.\n\nLed incident response and improved monitoring with the operations team.",
}
const job: Job = {
  id: "job",
  title: "Backend Engineer",
  company: "Example",
  country: "Germany",
  remote: "hybrid",
  url: "https://example.com/jobs/1",
  description:
    "Build Python APIs using Postgres. Requires 3 years of experience.",
  visaSignal: "strong",
  visaSignalSource: "rules",
  sponsorVerified: false,
  freshness: "ok",
  source: "test",
  status: "new",
  seenAt: "2026-10-29",
}

test("onboarding rejects incomplete, oversized and forged ownership inputs", () => {
  assert.ok(candidateSchema.safeParse(candidate).success)
  for (const patch of [
    { fullName: "" },
    { skills: [] },
    { targetCountries: [] },
    { resumeText: "short" },
    { experienceYears: -1 },
    { userId: "forged" },
    { resumeText: "x".repeat(30001) },
  ]) {
    assert.equal(
      candidateSchema.safeParse({ ...candidate, ...patch }).success,
      false
    )
  }
})
test("different candidates get different evidence scores for the same job", () => {
  const good = matchJob(job, candidate)
  const other = matchJob(job, {
    ...candidate,
    targetRoles: ["Designer"],
    skills: ["Figma"],
  })
  assert.equal(good.score, 100)
  assert.ok(good.score > other.score)
  assert.ok(good.reasons.some((r) => r.includes("Python")))
})
test("optional locations preserve legacy profiles and reject orphaned or excessive locations", () => {
  const place = { id: 1, country: "Germany", name: "Berlin", region: "Berlin" }
  assert.ok(candidateSchema.safeParse(candidate).success)
  assert.deepEqual(
    candidateSchema.parse({ ...candidate, targetLocations: [place, place] })
      .targetLocations,
    [place]
  )
  assert.equal(
    candidateSchema.safeParse({
      ...candidate,
      targetLocations: [{ ...place, country: "Canada" }],
    }).success,
    false
  )
  assert.equal(
    candidateSchema.safeParse({
      ...candidate,
      targetLocations: Array.from({ length: 6 }, (_, index) => ({
        ...place,
        id: index + 1,
      })),
    }).success,
    false
  )
})
test("city preferences constrain their country while missing cities remain explicit unknowns", () => {
  const profile: Candidate = {
    ...candidate,
    targetCountries: ["Canada", "Germany"],
    targetLocations: [
      { id: 6167865, country: "Canada", name: "Toronto", region: "Ontario" },
    ],
  }
  const located = { ...job, country: "Canada", city: "Toronto, Ontario" }
  assert.equal(matchJob(located, profile).eligible, true)
  assert.ok(
    matchJob(located, profile).reasons.some((reason) =>
      reason.includes("Preferred location")
    )
  )
  for (const city of ["Vancouver", "Torontoville"]) {
    const result = matchJob({ ...located, city }, profile)
    assert.equal(result.eligible, false)
    assert.equal(result.reviewable, false)
  }
  for (const city of [undefined, "Canada", "Remote", "Remote, Canada"]) {
    const result = matchJob({ ...located, city }, profile)
    assert.equal(result.eligible, false)
    assert.equal(result.reviewable, true)
    assert.ok(result.gaps.some((gap) => gap.includes("City not stated")))
  }
  assert.equal(
    matchJob({ ...located, city: "Toronto, Prince Edward Island" }, profile)
      .reviewable,
    false
  )
  const ambiguous = matchJob({ ...located, city: "Toronto" }, profile)
  assert.equal(ambiguous.reviewable, true)
  assert.equal(ambiguous.eligible, false)
  assert.ok(ambiguous.gaps.some((gap) => gap.includes("regional location")))
  assert.equal(matchJob(job, profile).eligible, true)
  assert.equal(
    matchJob(
      { ...located, city: "Vancouver" },
      { ...profile, targetLocations: [] }
    ).eligible,
    true
  )
  const unicode = {
    ...profile,
    targetLocations: [
      { id: 2, country: "Canada", name: "Québec", region: null },
    ],
  }
  assert.equal(matchJob({ ...located, city: "Quebec" }, unicode).eligible, true)
})
test("destinations outside the original source list are canonicalized and match jobs", () => {
  const profile = candidateSchema.parse({
    ...candidate,
    targetCountries: [
      " canada ",
      "CA",
      "Singapore",
      "UK",
      "United Arab Emirates",
    ],
  })
  assert.deepEqual(profile.targetCountries, [
    "Canada",
    "Singapore",
    "United Kingdom",
    "UAE",
  ])
  assert.equal(matchJob({ ...job, country: "Canada" }, profile).eligible, true)
  assert.equal(
    matchJob({ ...job, country: "Singapore" }, profile).eligible,
    true
  )
  assert.equal(matchJob(job, profile).eligible, false)
  for (const value of ["Not a country", "Worldwide", "", "x".repeat(101)]) {
    assert.equal(
      candidateSchema.safeParse({ ...candidate, targetCountries: [value] })
        .success,
      false
    )
  }
})
test("preferences, sponsorship and required experience gate eligibility", () => {
  assert.equal(matchJob(job, candidate).eligible, true)
  assert.equal(
    matchJob(job, { ...candidate, targetCountries: ["Japan"] }).eligible,
    false
  )
  assert.equal(
    matchJob(job, { ...candidate, excludedCompanies: ["example"] }).eligible,
    false
  )
  assert.equal(
    matchJob(job, { ...candidate, workModes: ["onsite"] }).eligible,
    false
  )
  assert.equal(
    matchJob(job, { ...candidate, experienceYears: 1 }).eligible,
    false
  )
  assert.equal(
    matchJob({ ...job, visaSignal: "possible" }, candidate).eligible,
    false
  )
  assert.equal(
    matchJob(
      { ...job, visaSignal: "possible" },
      { ...candidate, sponsorshipRequired: false }
    ).eligible,
    true
  )
})
test("home-country jobs need no sponsorship signal", () => {
  const home = { ...candidate, currentLocation: "Berlin, Germany" }
  const result = matchJob({ ...job, visaSignal: "weak" }, home)
  assert.equal(result.score, 100)
  assert.equal(result.eligible, true)
  assert.equal(
    result.gaps.some((gap) => gap.includes("Sponsorship")),
    false
  )
  assert.equal(
    matchJob({ ...job, visaSignal: "no" }, candidate).reviewable,
    false
  )
})
test("work mode preferences are hard filters", () => {
  const remoteOnly: Candidate = { ...candidate, workModes: ["remote"] }
  const shown = (overrides: Partial<Job>) =>
    matchJob({ ...job, ...overrides }, remoteOnly).reviewable
  assert.equal(shown({ remote: "remote" }), true)
  assert.equal(shown({ remote: "onsite" }), false)
  assert.equal(shown({ remote: "hybrid" }), false)
  assert.equal(shown({ remote: "unknown" }), true)
  assert.equal(
    shown({
      remote: "remote",
      description: `${job.description} Expect 3 days a week in the office.`,
    }),
    false
  )
  assert.equal(
    matchJob(
      { ...job, remote: "unknown" },
      {
        ...candidate,
        workModes: ["remote", "hybrid", "onsite"],
      }
    ).reviewable,
    true
  )
})
test("experience band hides roles far below or above the candidate", () => {
  const senior: Candidate = { ...candidate, experienceYears: 10 }
  const shown = (overrides: Partial<Job>, profile = senior) =>
    matchJob({ ...job, ...overrides }, profile).reviewable
  const years = (text: string) => ({
    description: `Build Python APIs using Postgres. Requires ${text}.`,
  })
  assert.equal(shown(years("4+ years of experience")), false)
  assert.equal(shown(years("6+ years of experience")), true)
  assert.equal(shown(years("12+ years of experience")), false)
  assert.equal(shown(years("8-10 years of professional experience")), true)
  assert.equal(shown(years("2 years of Kubernetes experience")), true)
  assert.equal(
    shown({ title: "Junior Backend Engineer", description: "Python" }),
    false
  )
  assert.equal(
    shown(years("12+ years of experience"), {
      ...candidate,
      experienceYears: null,
    }),
    true
  )
})
test("title-inferred levels are open-ended; stated N+ years set the level", () => {
  const veteran: Candidate = { ...candidate, experienceYears: 14 }
  const shown = (overrides: Partial<Job>, profile = veteran) =>
    matchJob({ ...job, ...overrides }, profile).reviewable
  assert.equal(
    shown({ title: "Principal Backend Engineer", description: "Python" }),
    true
  )
  assert.equal(
    shown({ title: "Senior Backend Engineer", description: "Python" }),
    true
  )
  assert.equal(
    shown({ description: "Requirements:\n- 5+ years of experience\n- Python" }),
    false
  )
  assert.equal(
    shown({ description: "Requirements:\n- 10+ years of experience\n- Python" }),
    true
  )
  assert.equal(
    shown(
      { description: "You bring 2-4 years of experience with Python." },
      { ...candidate, experienceYears: 10 }
    ),
    false
  )
})
test("company history is not read as the experience requirement", () => {
  const shown = (description: string) =>
    matchJob({ ...job, description }, candidate).reviewable
  assert.equal(
    shown(
      "Acme brings 25 years of experience in logistics. Build Python APIs."
    ),
    true
  )
  assert.equal(
    shown("We have 20 years of experience shipping software. Python role."),
    true
  )
  assert.equal(
    shown("About you:\n- 12+ years of experience building APIs"),
    false
  )
})
test("unstated work mode is reviewable but never eligible for remote-only candidates", () => {
  const unknown = { ...job, remote: "unknown" as const }
  const flexible = matchJob(unknown, {
    ...candidate,
    workModes: ["remote", "hybrid"],
  })
  assert.equal(flexible.reviewable, true)
  assert.ok(flexible.gaps.includes("Work arrangement is not stated"))
  const remoteOnly = matchJob(unknown, { ...candidate, workModes: ["remote"] })
  assert.equal(remoteOnly.reviewable, true)
  assert.equal(remoteOnly.eligible, false)
  assert.ok(
    remoteOnly.gaps.includes(
      "Work arrangement is not stated; confirm the role is remote"
    )
  )
})
test("selected cities do not filter out remote roles", () => {
  const profile: Candidate = {
    ...candidate,
    workModes: ["remote"],
    targetLocations: [
      { id: 1, name: "Munich", region: "Bavaria", country: "Germany" },
    ],
  }
  const remote = matchJob({ ...job, remote: "remote", city: "Berlin" }, profile)
  assert.equal(remote.reviewable, true)
  assert.equal(remote.eligible, true)
  assert.ok(!remote.gaps.includes("Outside your selected locations"))
  const onsite = matchJob(
    { ...job, remote: "onsite", city: "Berlin" },
    { ...profile, workModes: ["onsite"] }
  )
  assert.equal(onsite.reviewable, false)
})
test("common software titles relate to software engineer targets", () => {
  const lead: Candidate = { ...candidate, targetRoles: ["Lead Software Engineer"] }
  const relevant = (title: string) => matchJob({ ...job, title }, lead).relevant
  for (const title of [
    "Software Development Engineer II",
    "SDE 3",
    "Member of Technical Staff - Platform Engineering",
    "Senior Python Engineer - Data",
    "Java Developer",
    "Platform Engineer III",
  ])
    assert.equal(relevant(title), true, title)
  for (const title of [
    "Staff Mechanical Design Engineer",
    "Data Analyst",
    "Software Development Engineer Intern",
  ])
    assert.equal(relevant(title), false, title)
  assert.equal(
    matchJob(
      { ...job, title: "Java Developer" },
      { ...candidate, targetRoles: ["Data Engineer"] }
    ).relevant,
    false
  )
})
test("only real attendance cues turn a remote posting hybrid", () => {
  const remoteOnly: Candidate = { ...candidate, workModes: ["remote"] }
  const shown = (description: string) =>
    matchJob({ ...job, remote: "remote", description }, remoteOnly).reviewable
  assert.equal(shown("Hybrid cloud engineer working on Python APIs."), true)
  assert.equal(shown("Remote or hybrid available. Python and Postgres."), true)
  assert.equal(shown("Python role, 3 days a week in the office."), false)
  assert.equal(shown("This is a hybrid role based in Berlin."), false)
})
test("a title match with few skills cannot reach the auto-apply threshold", () => {
  const broad = {
    ...candidate,
    skills: ["Python", "Go", "Rust", "Kafka", "Terraform"],
  }
  assert.ok(matchJob(job, broad).score < 80)
})
test("missing descriptions are visible and skill aliases preserve word boundaries", () => {
  assert.ok(
    matchJob({ ...job, description: "" }, candidate).gaps.some((g) =>
      g.includes("unavailable")
    )
  )
  const aliases = matchJob(
    { ...job, description: "We use PostgreSQL and CPython" },
    candidate
  )
  assert.ok(aliases.reasons.some((r) => r.includes("Postgres")))
  assert.equal(
    aliases.reasons.some((r) => r.includes("Python")),
    false
  )
})
test("tailoring preserves source facts, rejects invented blocks and deduplicates", () => {
  const result = assembleResume(candidate.resumeText, {
    blockIds: ["block-2", "block-2"],
  })
  assert.equal(result.highlights.length, 1)
  assert.ok(candidate.resumeText.includes(result.highlights[0].text))
  assert.ok(result.content.endsWith(candidate.resumeText))
  assert.throws(() =>
    assembleResume(candidate.resumeText, { blockIds: ["invented"] })
  )
  assert.throws(() => assembleResume(candidate.resumeText, { blockIds: [] }))
})
test("auth redirect rejects external and control-character targets", () => {
  for (const target of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
  ])
    assert.equal(safeNext(target), "/jobs")
  assert.equal(safeNext("/profile"), "/profile")
})
test("JSON requests enforce byte limits, content type and same origin", async () => {
  const req = (body: string, origin = "https://example.com") =>
    new Request("https://example.com/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json", origin },
      body,
    })
  await assert.rejects(readJson(req("{}", "https://evil.example")), /origin/)
  await assert.rejects(
    readJson(req('"' + "x".repeat(100) + '"'), 10),
    /too large/
  )
  assert.deepEqual(await readJson(req('{"ok":true}')), { ok: true })
})

test("sponsorship needs evidence abroad but never blocks home-country jobs", () => {
  const eligible = (overrides: Partial<Job>, profile = candidate) =>
    matchJob({ ...job, ...overrides }, profile).eligible
  assert.equal(eligible({ visaSignal: "confirmed" }), true)
  assert.equal(eligible({ visaSignal: "possible" }), false)
  assert.equal(eligible({ visaSignal: "possible", sponsorVerified: true }), true)
  assert.equal(eligible({ visaSignal: "weak", sponsorVerified: true }), false)
  assert.equal(
    matchJob({ ...job, visaSignal: "no" }, candidate).reviewable,
    false
  )
  const local = { ...candidate, currentLocation: "Berlin, Germany" }
  assert.equal(eligible({ visaSignal: "no" }, local), true)
  assert.equal(eligible({ visaSignal: "possible" }, local), true)
})

test("six matching skills earn full skill credit however long the skill list", () => {
  const tools = ["Python", "Postgres", "Kafka", "Redis", "Docker", "Terraform"]
  const posting = { ...job, description: `Build APIs with ${tools.join(", ")}.` }
  const short = matchJob(posting, { ...candidate, skills: tools }).score
  const long = matchJob(posting, {
    ...candidate,
    skills: [...tools, ...Array.from({ length: 30 }, (_, i) => `Tool${i}`)],
  }).score
  assert.equal(long, short)
})

test("remote-from-home candidates need no visa for unrestricted remote roles abroad", () => {
  const abroad = { ...candidate, workModes: ["remote"] as Candidate["workModes"] }
  const home = { ...abroad, remoteFromHome: true }
  const remote = (description: string, overrides: Partial<Job> = {}) => ({
    ...job,
    remote: "remote" as const,
    visaSignal: "possible" as const,
    description: `Build Python APIs using Postgres. ${description}`,
    ...overrides,
  })
  const eligible = (j: Job, profile: Candidate) => matchJob(j, profile).eligible
  assert.equal(eligible(remote("Work from anywhere."), abroad), false)
  assert.equal(eligible(remote("Work from anywhere."), home), true)
  assert.equal(eligible(remote("You must be based in Germany."), home), false)
  assert.equal(eligible(remote("Authorized to work in the US."), home), false)
  assert.equal(eligible(remote("Remote (US only)."), home), false)
  assert.equal(
    eligible(remote("", { title: "Backend Engineer - US East" }), home),
    false
  )
  assert.equal(
    eligible(remote("", { visaSignal: "no" }), home),
    false
  )
  assert.equal(
    eligible(
      remote("Two days a week in the office.", { remote: "hybrid" }),
      { ...home, workModes: ["remote", "hybrid"] }
    ),
    false
  )
})

test("resume titles become clean target roles, headline role first", async () => {
  const { targetRolesFrom } = await import("@/lib/candidate")
  assert.deepEqual(
    targetRolesFrom(
      "SENIOR DATA ENGINEER | TALEND | MICROSOFT FABRIC | AZURE DATA FACTORY",
      ["Senior Data Engineer – Talend", "Senior Consultant", "IT Analyst"]
    ),
    ["Senior Data Engineer", "Senior Consultant", "IT Analyst"]
  )
  assert.deepEqual(
    targetRolesFrom("Open to new opportunities", [
      "Software Engineer (Payments)",
      "Software Engineer, Platform",
      "Founding Engineer at Example",
    ]),
    ["Software Engineer", "Founding Engineer"]
  )
})
test("a profession family relates titles beyond the software engineer pattern", () => {
  const dataEngineer: Candidate = {
    ...candidate,
    experienceYears: 13,
    targetRoles: ["Senior Data Engineer – Talend", "Senior Consultant"],
    skills: ["Talend", "Microsoft Fabric", "Azure Data Factory", "PySpark", "SQL"],
  }
  const relevant = (title: string, description = job.description) =>
    matchJob({ ...job, title, description }, dataEngineer).relevant
  for (const title of [
    "Senior Data Engineer",
    "Data Platform Engineer",
    "Lead - Data Engineering",
    "Databricks Data Engineer (m/w/d)",
    "Principal Data Architect",
    "ETL Developer",
  ])
    assert.equal(relevant(title), true, title)
  for (const title of ["Java Developer", "Data Analyst", "Frontend Engineer"])
    assert.equal(relevant(title), false, title)
  // The candidate's own stack makes a software posting relevant without a title match.
  assert.equal(
    relevant(
      "Software Engineer - Analytics",
      "Own our Azure Data Factory and PySpark jobs, Microsoft Fabric lakehouse and SQL models."
    ),
    true
  )
  assert.equal(
    relevant("Software Engineer - Analytics", "Own our SQL models."),
    false
  )
  assert.equal(
    relevantJobTitle("Talend Developer", dataEngineer.targetRoles, dataEngineer.skills),
    true
  )
  assert.equal(
    relevantJobTitle("Software Engineer", dataEngineer.targetRoles, dataEngineer.skills),
    false
  )
})
