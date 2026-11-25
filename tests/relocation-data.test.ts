import assert from "node:assert/strict"
import test from "node:test"

import {
  type AppState,
  type Company,
  type ImportPayload,
  type JobLead,
  type Person,
  applicationReadiness,
  buildSearchCommands,
  dashboardWarnings,
  initialState,
  mergeImportedRecordsIntoState,
  recommendDailyActions,
  scoreAllJobs,
  withSeedDefaults,
} from "../lib/location/relocation-data"
import { defaultSupabaseProjectUrl, supabaseProjectRef } from "../lib/supabase"

// Synthetic test records (no demo fixtures — the app ships with zero seed data).
function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "c-test",
    name: "Test Sponsor B.V.",
    country: "Netherlands",
    city: "Amsterdam",
    website: "https://test-sponsor.example",
    careersUrl: "https://test-sponsor.example/careers",
    sponsorSource: "Netherlands IND recognised sponsors (live)",
    sponsorCategory: "Official sponsor register + careers crawl",
    officialSourceUrl:
      "https://ind.nl/en/public-register-recognised-sponsors/public-register-work",
    lastChecked: "2026-06-25",
    visaSignal: "strong",
    hiringHistorySignal: "Recognised sponsor",
    relevanceScore: 80,
    openRoles: 2,
    outreachStatus: "not_started",
    confidence: "high",
    notes: "",
    ...overrides,
  }
}

function makeJob(overrides: Partial<JobLead> = {}): JobLead {
  return {
    id: "j-test",
    title: "Senior Software Engineer, AI Platform",
    companyId: "c-test",
    country: "Netherlands",
    city: "Amsterdam",
    workMode: "hybrid",
    sourceUrl: "https://test-sponsor.example/careers/job-1",
    sourceType: "official_sponsor",
    roleType: "Senior AI Platform Engineer",
    seniority: "senior",
    visaConfidence: "strong",
    relocationSignal: "Company is on an official sponsor register.",
    salary: "Unknown",
    jobScore: 0,
    countryScore: 92,
    status: "discovered",
    resumeVariant: "Applied AI Engineer",
    notes: "",
    createdAt: "2026-06-25",
    refreshedAt: "2026-06-25",
    ...overrides,
  }
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "p-test",
    name: "Engineering recruiter",
    companyId: "c-test",
    role: "Engineering recruiter",
    sourceUrl: "https://www.linkedin.com/company/test/people/",
    relationshipStatus: "research",
    notes: "",
    ...overrides,
  }
}

function makePayload(overrides: Partial<ImportPayload> = {}): ImportPayload {
  return {
    sourceId: "collect-netherlands",
    sourceName: "Netherlands IND recognised sponsors (live)",
    companies: [makeCompany()],
    jobs: [makeJob()],
    people: [makePerson()],
    log: "test payload",
    ...overrides,
  }
}

function stateWithImports(): AppState {
  return {
    ...initialState,
    companies: [makeCompany()],
    jobs: [makeJob()],
    people: [makePerson()],
    drafts: [],
  }
}

test("initial state starts without pipeline records", () => {
  assert.equal(initialState.companies.length, 0)
  assert.equal(initialState.jobs.length, 0)
  assert.equal(initialState.people.length, 0)
  assert.equal(initialState.drafts.length, 0)
  assert.equal(initialState.aiSearchRuns.length, 0)
  assert.equal(initialState.refreshLog.length, 0)
  assert.equal(initialState.profile.baseResumeFileName, "")
  assert.equal(initialState.profile.baseResumeText, "")
  assert.ok(initialState.sources.every((source) => source.found === 0))
  assert.ok(
    initialState.sources.every((source) => source.lastRun === "Not run")
  )
})

test("scoreAllJobs penalizes remote roles without relocation signal", () => {
  const state = stateWithImports()
  const sponsorBacked = state.jobs[0]
  const remote: JobLead = {
    ...sponsorBacked,
    id: "j-remote-no-relocation",
    workMode: "remote_no_relocation",
    visaConfidence: "weak",
    relocationSignal: "Remote listing; no relocation signal yet",
  }
  const scored = scoreAllJobs({
    ...state,
    jobs: [sponsorBacked, remote],
  })
  const remoteScore = scored.find((job) => job.id === remote.id)
  const sponsorBackedScore = scored.find((job) => job.id === sponsorBacked.id)

  assert.ok(remoteScore)
  assert.ok(sponsorBackedScore)
  assert.ok(remoteScore.jobScore < sponsorBackedScore.jobScore)
})

test("withSeedDefaults restores missing real source connectors", () => {
  const olderState = {
    ...initialState,
    sources: initialState.sources.filter(
      (source) => source.id === "s-ai-websearch"
    ),
  }
  const migrated = withSeedDefaults(olderState)

  assert.ok(migrated.sources.some((source) => source.id === "s-ai-websearch"))
  assert.ok(migrated.sources.some((source) => source.id === "s-research-crawl"))
  assert.equal(migrated.aiSearchRuns.length, 0)
})

test("initial sources include the dedicated research crawl connector", () => {
  const researchSource = initialState.sources.find(
    (source) => source.id === "s-research-crawl"
  )

  assert.ok(researchSource)
  assert.equal(researchSource.type, "crawler")
  assert.match(researchSource.notes, /research dataset/i)
})

test("withSeedDefaults collapses duplicate companies, jobs, and people", () => {
  const duplicatedState: AppState = {
    ...initialState,
    companies: [
      {
        id: "c-dup-a",
        name: "Nova AI",
        country: "Germany",
        city: "Berlin",
        website: "https://nova.ai",
        careersUrl: "https://nova.ai/jobs",
        sponsorSource: "Manual target",
        sponsorCategory: "Needs verification",
        officialSourceUrl: "",
        lastChecked: "2026-06-16",
        visaSignal: "possible" as const,
        hiringHistorySignal: "First copy",
        relevanceScore: 52,
        openRoles: 1,
        outreachStatus: "queued" as const,
        confidence: "medium" as const,
        notes: "First copy",
      },
      {
        id: "c-dup-b",
        name: "Nova AI",
        country: "Germany",
        city: "Berlin",
        website: "https://nova.ai",
        careersUrl: "https://nova.ai/jobs",
        sponsorSource: "Career page",
        sponsorCategory: "Employer-sponsored",
        officialSourceUrl: "",
        lastChecked: "2026-06-17",
        visaSignal: "strong" as const,
        hiringHistorySignal: "Second copy",
        relevanceScore: 88,
        openRoles: 3,
        outreachStatus: "drafted" as const,
        confidence: "high" as const,
        notes: "Second copy",
      },
    ],
    jobs: [
      {
        id: "j-dup-a",
        title: "Senior AI Engineer",
        companyId: "c-dup-b",
        country: "Germany",
        city: "Berlin",
        workMode: "hybrid",
        sourceUrl: "https://nova.ai/jobs/1",
        sourceType: "career_page",
        roleType: "AI Engineer",
        seniority: "senior",
        visaConfidence: "possible",
        relocationSignal: "Manual entry",
        salary: "Unknown",
        jobScore: 68,
        countryScore: 88,
        status: "discovered",
        resumeVariant: "Applied AI Engineer",
        notes: "First job copy",
        createdAt: "2026-06-16",
        refreshedAt: "2026-06-16",
      },
      {
        id: "j-dup-b",
        title: "Senior AI Engineer",
        companyId: "c-dup-a",
        country: "Germany",
        city: "Berlin",
        workMode: "hybrid",
        sourceUrl: "https://nova.ai/jobs/1",
        sourceType: "linkedin",
        roleType: "AI Engineer",
        seniority: "senior",
        visaConfidence: "strong",
        relocationSignal: "Manual entry",
        salary: "Unknown",
        jobScore: 81,
        countryScore: 88,
        status: "shortlisted",
        resumeVariant: "Applied AI Engineer",
        notes: "Second job copy",
        createdAt: "2026-06-16",
        refreshedAt: "2026-06-17",
      },
    ],
    people: [
      {
        id: "p-dup-a",
        name: "Hiring recruiter",
        companyId: "c-dup-b",
        role: "Recruiter",
        sourceUrl: "https://www.linkedin.com/in/nova",
        relationshipStatus: "research",
        notes: "First person copy",
      },
      {
        id: "p-dup-b",
        name: "Hiring recruiter",
        companyId: "c-dup-a",
        role: "Recruiter",
        sourceUrl: "https://www.linkedin.com/in/nova",
        relationshipStatus: "contacted",
        notes: "Second person copy",
      },
    ],
    drafts: [],
  }

  const deduped = withSeedDefaults(duplicatedState)

  assert.equal(deduped.companies.length, 1)
  assert.equal(deduped.jobs.length, 1)
  assert.equal(deduped.people.length, 1)
  assert.equal(deduped.jobs[0].companyId, deduped.companies[0].id)
  assert.equal(deduped.people[0].companyId, deduped.companies[0].id)
})

test("mergeImportedRecordsIntoState counts only net new records across duplicate sources", () => {
  const firstPayload = makePayload()
  const secondPayload: typeof firstPayload = {
    ...firstPayload,
    sourceId: "collect-denmark",
    sourceName: "Career pages",
  }

  const result = mergeImportedRecordsIntoState(initialState, [
    firstPayload,
    secondPayload,
  ])

  assert.equal(result.addedCompanies, firstPayload.companies.length)
  assert.equal(result.addedJobs, firstPayload.jobs.length)
  assert.equal(result.addedPeople, firstPayload.people.length)
  assert.equal(result.duplicateCompanies, secondPayload.companies.length)
  assert.equal(result.duplicateJobs, secondPayload.jobs.length)
  assert.equal(result.duplicatePeople, secondPayload.people.length)
  assert.equal(result.sources[0].addedJobs, firstPayload.jobs.length)
  assert.equal(result.sources[1].addedJobs, 0)
  assert.deepEqual(
    result.addedJobIds.sort(),
    firstPayload.jobs.map((job) => job.id).sort()
  )
})

test("prompt templates cover every MVP AI draft type", () => {
  const templateKinds = new Set(
    initialState.promptTemplates.map((template) => template.kind)
  )

  for (const kind of [
    "resume_summary",
    "cover_note",
    "founder_outreach",
    "why_me",
    "interview_prep",
  ] as const) {
    assert.ok(templateKinds.has(kind), `${kind} template missing`)
  }
})

test("applicationReadiness flags missing draft and contact data", () => {
  const state = stateWithImports()
  const job = state.jobs[0]
  assert.ok(job)

  const readiness = applicationReadiness(job, {
    ...state,
    people: [],
    drafts: [],
  })

  assert.equal(readiness.ready, false)
  assert.ok(readiness.missing.includes("Draft note exists"))
  assert.ok(readiness.missing.includes("Recruiter/founder contact exists"))
})

test("applicationReadiness blocks remote-only roles without relocation", () => {
  const state = stateWithImports()
  const job: JobLead = {
    ...state.jobs[0],
    workMode: "remote_no_relocation",
    relocationSignal: "Remote listing; no relocation signal yet",
  }
  assert.ok(job)

  const readiness = applicationReadiness(job, state)

  assert.equal(readiness.ready, false)
  assert.ok(readiness.missing.includes("Not remote-only without relocation"))
})

test("dashboardWarnings flags weak visa, family risk, and missing compensation", () => {
  const state = stateWithImports()
  const warningJob: JobLead = {
    ...state.jobs[0],
    country: "UAE",
    city: "Dubai",
    countryScore: 60,
    salary: "Unknown",
    visaConfidence: "weak",
    workMode: "remote_no_relocation",
    relocationSignal: "Remote listing; no relocation signal yet",
  }
  const warnings = dashboardWarnings({
    ...state,
    jobs: [warningJob],
  })

  assert.ok(warnings.some((warning) => warning.kind === "weak_visa"))
  assert.ok(warnings.some((warning) => warning.kind === "family_risk"))
  assert.ok(warnings.some((warning) => warning.kind === "missing_salary"))
  assert.ok(warnings.some((warning) => warning.kind === "remote_no_relocation"))
})

test("recommendDailyActions returns prioritized next steps", () => {
  const state = stateWithImports()
  const highFitJob: JobLead = {
    ...state.jobs[0],
    jobScore: 92,
    countryScore: 92,
    status: "shortlisted",
    followUpDate: undefined,
  }
  const actions = recommendDailyActions({
    ...state,
    jobs: [highFitJob],
    people: [],
    drafts: [],
  })

  assert.ok(actions.length > 0)
  assert.ok(actions.some((action) => action.kind === "packet"))
  assert.ok(actions.some((action) => action.kind === "draft"))
  assert.ok(actions.some((action) => action.kind === "source"))
  assert.ok(actions[0].score >= actions[actions.length - 1].score)
})

test("recommendDailyActions includes recruiter and founder contact follow-ups", () => {
  const state = stateWithImports()
  const followUpPerson: Person = {
    ...state.people[0],
    id: "p-due-follow-up",
    relationshipStatus: "drafted",
    nextFollowUpDate: "2026-06-17",
  }
  const actions = recommendDailyActions({
    ...state,
    people: [followUpPerson],
  })

  assert.ok(
    actions.some(
      (action) =>
        action.personId === followUpPerson.id && action.kind === "follow_up"
    )
  )
})

test("buildSearchCommands creates target-country visa searches", () => {
  const commands = buildSearchCommands(initialState)

  assert.ok(commands.length >= 30)
  assert.ok(
    commands.some(
      (command) =>
        command.country === "Netherlands" && command.query.includes("IND")
    )
  )
  assert.ok(
    commands.some(
      (command) =>
        command.source === "linkedin" && command.query.includes("visa")
    )
  )
  assert.ok(commands.every((command) => command.url.startsWith("https://")))
})

test("supabaseProjectRef extracts the configured project reference", () => {
  assert.equal(
    supabaseProjectRef(defaultSupabaseProjectUrl),
    "jzvgkjmhugogvpanwjyy"
  )
})
