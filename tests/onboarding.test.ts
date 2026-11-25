import assert from "node:assert/strict"
import test from "node:test"
import {
  candidateFromResume,
  candidateSchema,
  type Candidate,
} from "@/lib/candidate"
import {
  groundResumeInsights,
  estimateExperienceYears,
  type ResumeInsights,
} from "@/lib/resume/profile"
import { matchJob } from "@/lib/matching"
import type { Job } from "@/lib/jobs"

const source = `Alex Example\nBackend Engineer\nBerlin\n\nBackend Engineer | Example Systems | 2020–Present\nBuilt Python APIs using Postgres. Reduced API errors by 20%.\n\nSoftware Engineer | Example Tools | 2018–2022\nMaintained monitoring tools.\n\nBSc Computer Science | Example University\n\nProject Atlas: Python monitoring tool.`
const extracted: ResumeInsights = {
  fullName: { value: "Alex Example", quote: "Alex Example" },
  headline: { value: "Backend Engineer", quote: "Backend Engineer" },
  currentLocation: { value: "Berlin", quote: "Berlin" },
  skills: [
    { value: "Python", quote: "Built Python APIs using Postgres." },
    { value: "Postgres", quote: "Built Python APIs using Postgres." },
  ],
  experience: [
    {
      title: "Backend Engineer",
      company: "Example Systems",
      startYear: 2020,
      endYear: null,
      current: true,
      quote: "Backend Engineer | Example Systems | 2020–Present",
    },
    {
      title: "Software Engineer",
      company: "Example Tools",
      startYear: 2018,
      endYear: 2022,
      current: false,
      quote: "Software Engineer | Example Tools | 2018–2022",
    },
  ],
  education: [
    {
      qualification: "BSc Computer Science",
      institution: "Example University",
      quote: "BSc Computer Science | Example University",
    },
  ],
  projects: [
    { value: "Project Atlas", quote: "Project Atlas: Python monitoring tool." },
  ],
  achievements: ["Reduced API errors by 20%."],
}

test("one resume produces a reviewable complete profile with career, education and project evidence", () => {
  const candidate = candidateFromResume(source, extracted, 2026)
  assert.equal(candidate.fullName, "Alex Example")
  assert.equal(candidate.experienceYears, 8)
  assert.deepEqual(candidate.skills, ["Python", "Postgres"])
  assert.equal(candidate.resumeInsights?.education.length, 1)
  assert.equal(candidate.resumeInsights?.projects.length, 1)
  assert.equal(
    candidateSchema.safeParse({ ...candidate, targetCountries: ["Germany"] })
      .success,
    true
  )
})

test("a missing model name falls back to an explicitly labelled résumé name", () => {
  for (const header of [
    "Name: Maya D’Souza-Wong\nSenior Software Engineer",
    "Résumé\nFull name: A. P. J. Abdul Kalam | Backend Engineer",
    "Full name: 李 小龍\nBackend Engineer",
  ]) {
    const expected = header.includes("Maya")
      ? "Maya D’Souza-Wong"
      : header.includes("Kalam")
        ? "A. P. J. Abdul Kalam"
        : "李 小龍"
    const text = header + "\nSkills: Python and Postgres"
    const candidate = candidateFromResume(
      text,
      { ...extracted, fullName: null },
      2026
    )
    assert.equal(candidate.fullName, expected)
    const name = candidate.resumeInsights?.fullName
    assert.ok(
      name && text.includes(name.quote) && name.quote.includes(expected)
    )
  }
})

test("ambiguous headers, job titles and reference names stay unknown", () => {
  for (const header of [
    "Backend Engineer\ncontact@example.test",
    "Acme Systems | Backend Engineer",
    "Name: Alex Example\nName: Pat Example\nBackend Engineer",
    "Work Experience\nBackend Engineer\nReferences: Maria Example",
    "North London\nProfessional Summary\nBackend Engineer at Example Systems",
    "San Francisco\nalex@example.test\nSenior Software Engineer",
    "Resume Of Alex Example\nSenior Software Engineer\nalex@example.test",
    "Acme Consulting\nalex@example.test\nSenior Software Engineer",
    "Maya D’Souza-Wong\nSenior Software Engineer",
  ]) {
    const candidate = candidateFromResume(
      header,
      { ...extracted, fullName: null },
      2026
    )
    assert.equal(candidate.fullName, "", header)
    assert.equal(candidate.resumeInsights?.fullName, null, header)
  }
})

test("grounded extracted names remain usable without a name label", () => {
  const text = "Maya D’Souza-Wong\nSenior Software Engineer\nmaya@example.test"
  const fact = { value: "Maya D’Souza-Wong", quote: "Maya D’Souza-Wong" }
  const candidate = candidateFromResume(
    text,
    { ...extracted, fullName: fact },
    2026
  )
  assert.equal(candidate.fullName, fact.value)
  assert.deepEqual(candidate.resumeInsights?.fullName, fact)
})
test("resume analysis does not invent search or immigration preferences", () => {
  const candidate = candidateFromResume(source, extracted, 2026)
  assert.deepEqual(candidate.targetCountries, [])
  assert.equal(candidateSchema.safeParse(candidate).success, false)
  assert.deepEqual(candidate.workModes, ["remote", "hybrid", "onsite"])
  assert.equal(candidate.sponsorshipRequired, null)
  assert.deepEqual(candidate.excludedCompanies, [])
})
test("unsupported model facts and invented source quotes are discarded", () => {
  const result = groundResumeInsights(source, {
    ...extracted,
    fullName: { value: "Invented Person", quote: "Alex Example" },
    currentLocation: { value: "London", quote: "London" },
    skills: [
      ...extracted.skills,
      { value: "Kubernetes", quote: "Built Python APIs using Postgres." },
    ],
    experience: [
      ...extracted.experience,
      { ...extracted.experience[0], company: "Invented Company" },
    ],
    education: [
      ...extracted.education,
      { ...extracted.education[0], institution: "Invented University" },
    ],
    projects: [
      {
        value: "Project Fiction",
        quote: "Project Atlas: Python monitoring tool.",
      },
    ],
    achievements: ["Increased revenue by 500%"],
  })
  assert.equal(result.fullName, null)
  assert.equal(result.currentLocation, null)
  assert.equal(result.skills.length, 2)
  assert.equal(result.experience.length, 2)
  assert.equal(result.education.length, 1)
  assert.deepEqual(result.projects, [])
  assert.deepEqual(result.achievements, [])
})
test("unsupported employment dates are unknown and overlapping roles count once", () => {
  const grounded = groundResumeInsights(source, {
    ...extracted,
    experience: [
      { ...extracted.experience[1], startYear: 2010, current: true },
    ],
  })
  assert.equal(grounded.experience[0].startYear, null)
  assert.equal(grounded.experience[0].current, false)
  assert.equal(estimateExperienceYears(grounded, 2026), null)
  assert.equal(estimateExperienceYears(extracted, 2026), 8)
  assert.equal(
    estimateExperienceYears({ ...extracted, experience: [] }, 2026),
    null
  )
})
test("incomplete resumes keep unknown facts and require only missing essentials at confirmation", () => {
  const blank = {
    fullName: null,
    headline: null,
    currentLocation: null,
    skills: [],
    experience: [],
    education: [],
    projects: [],
    achievements: [],
  }
  const candidate = candidateFromResume(
    source.replace("Alex Example\n", ""),
    blank,
    2026
  )
  assert.equal(candidate.fullName, "")
  assert.equal(candidate.currentLocation, null)
  assert.equal(candidate.experienceYears, null)
  assert.equal(candidateSchema.safeParse(candidate).success, false)
  assert.equal(
    candidateSchema.safeParse({
      ...candidate,
      fullName: "Alex Example",
      headline: "Engineer",
      targetRoles: ["Engineer"],
      skills: ["Python"],
      targetCountries: ["Germany"],
    }).success,
    true
  )
})
test("final profile remains strict and legacy profiles remain compatible", () => {
  const complete = {
    ...candidateFromResume(source, extracted, 2026),
    targetCountries: ["Germany"],
  }
  assert.equal(
    candidateSchema.safeParse({ ...complete, userId: "other" }).success,
    false
  )
  const legacy = { ...complete }
  delete legacy.resumeInsights
  assert.equal(
    candidateSchema.safeParse({
      ...legacy,
      currentLocation: "Berlin",
      experienceYears: 8,
      sponsorshipRequired: true,
    }).success,
    true
  )
})
test("unknown tenure and sponsorship do not masquerade as confirmed matching facts", () => {
  const candidate: Candidate = {
    ...candidateFromResume(source, extracted, 2026),
    targetCountries: ["Germany"],
    experienceYears: null,
  }
  const job: Job = {
    id: "job",
    title: "Backend Engineer",
    company: "Example",
    country: "Germany",
    remote: "hybrid",
    url: "https://example.com/job",
    description: "Python, Postgres. Requires 5 years of experience.",
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "ok",
    source: "test",
    status: "new",
    seenAt: "2026-10-29",
  }
  const match = matchJob(job, candidate)
  // Unknown sponsorship needs are treated as needed abroad.
  assert.equal(match.eligible, false)
  assert.equal(match.reviewable, true)
  assert.ok(match.gaps.some((g) => g.includes("duration is not established")))
  assert.ok(
    match.gaps.some((g) => g.includes("sponsorship needs are not specified"))
  )
  assert.equal(
    matchJob(job, { ...candidate, sponsorshipRequired: false }).eligible,
    true
  )
})

test("a product design resume suggests design roles and categories from its current work", () => {
  const resume = `Alex Example
Product Designer | Accessibility
Associate | Example Studio | 2016–2018
Product Designer | Example Studio | 2020–Present
Designed accessible prototypes in Figma and conducted usability testing.`
  const candidate = candidateFromResume(
    resume,
    {
      ...extracted,
      headline: {
        value: "Product Designer | Accessibility",
        quote: "Product Designer | Accessibility",
      },
      skills: [
        {
          value: "Figma",
          quote:
            "Designed accessible prototypes in Figma and conducted usability testing.",
        },
      ],
      experience: [
        {
          title: "Associate",
          company: "Example Studio",
          startYear: 2016,
          endYear: 2018,
          current: false,
          quote: "Associate | Example Studio | 2016–2018",
        },
        {
          title: "Product Designer",
          company: "Example Studio",
          startYear: 2020,
          endYear: null,
          current: true,
          quote: "Product Designer | Example Studio | 2020–Present",
        },
      ],
    },
    2026
  )
  assert.deepEqual(candidate.targetRoles, ["Product Designer"])
  assert.deepEqual(candidate.jobCategories, ["design"])
  assert.equal(candidate.resumeInsights?.experience.length, 2)
})

test("resume grounding does not turn part of a skill name into a different skill", () => {
  const result = groundResumeInsights("Built interfaces with JavaScript.", {
    ...extracted,
    skills: [
      { value: "Java", quote: "Built interfaces with JavaScript." },
      { value: "JavaScript", quote: "Built interfaces with JavaScript." },
    ],
  })
  assert.deepEqual(
    result.skills.map(({ value }) => value),
    ["JavaScript"]
  )
})

test("grouped skills and detached job bullets resolve to source evidence", () => {
  const resume = `Languages: TypeScript, JavaScript, Node.js, Go
Lead Software Engineer | Example Systems | 2020–Present
Built reliable APIs and coached engineers.`
  const candidate = candidateFromResume(
    resume,
    {
      ...extracted,
      fullName: null,
      headline: null,
      skills: [
        {
          value: "TypeScript, JavaScript, Node.js, Go",
          quote: "Languages: TypeScript, JavaScript, Node.js, Go",
        },
      ],
      experience: [
        {
          ...extracted.experience[0],
          title: "Lead Software Engineer",
          quote: "Built reliable APIs and coached engineers.",
        },
        {
          ...extracted.experience[0],
          company: "Unrelated employer",
          title: "Lead Software Engineer",
          quote: "Built reliable APIs and coached engineers.",
        },
      ],
    },
    2026
  )
  assert.deepEqual(candidate.skills, [
    "TypeScript",
    "JavaScript",
    "Node.js",
    "Go",
  ])
  assert.deepEqual(candidate.targetRoles, ["Lead Software Engineer"])
  assert.equal(candidate.experienceYears, 6)
  assert.deepEqual(
    candidate.resumeInsights?.experience.map(({ quote }) => quote),
    ["Lead Software Engineer | Example Systems | 2020–Present"]
  )
})

test("an explicit skills section supplies specific skills when analysis misses them", () => {
  const resume = `Technical skills
Programming: TypeScript, JavaScript, Node.js
AI & LLM Systems: LangGraph, RAG
Employment
Lead Software Engineer | Example Systems | 2020–Present`
  const result = groundResumeInsights(resume, {
    ...extracted,
    skills: [],
    experience: [
      {
        ...extracted.experience[0],
        title: "Lead Software Engineer | Example Systems",
        quote: "Lead Software Engineer | Example Systems | 2020–Present",
      },
    ],
  })
  assert.deepEqual(
    result.skills.map(({ value }) => value),
    ["TypeScript", "LangGraph", "JavaScript", "RAG", "Node.js"]
  )
  assert.equal(result.experience[0].title, "Lead Software Engineer")
})

test("dated employment headers fill missed roles and replace duplicate model entries", () => {
  const current =
    "Lead Software Engineer | Example Systems | India | Jul 2020 – Present"
  const earlier =
    "Software Engineer | Example Tools | India | May 2015 – Jul 2020"
  const resume = `PROFESSIONAL EXPERIENCE
${current}
Improved application reliability.
${earlier}
SELECTED PROJECTS
Example Project | Example Tools | India | 2017 – 2018`
  const repeated = {
    ...extracted.experience[0],
    title: "Lead Software Engineer",
    endYear: 2020,
    current: false,
    quote: current,
  }
  const candidate = candidateFromResume(
    resume,
    { ...extracted, experience: [repeated, repeated] },
    2026
  )
  assert.deepEqual(
    candidate.resumeInsights?.experience.map(({ title, current }) => [
      title,
      current,
    ]),
    [
      ["Lead Software Engineer", true],
      ["Software Engineer", false],
    ]
  )
  assert.equal(candidate.experienceYears, 11)
})

test("resume-based recommendations need role and description evidence", () => {
  const candidate = {
    ...candidateFromResume(source, extracted, 2026),
    targetCountries: ["Germany"],
    sponsorshipRequired: false,
  }
  const job: Job = {
    id: "job",
    title: "Backend Engineer",
    company: "Example",
    country: "Germany",
    remote: "hybrid",
    url: "https://example.com/job",
    description: "Build Python APIs using Postgres.",
    visaSignal: "possible",
    visaSignalSource: "rules",
    sponsorVerified: false,
    freshness: "ok",
    source: "test",
    status: "new",
    seenAt: "2026-10-29",
  }
  assert.equal(matchJob(job, candidate).reviewable, true)
  assert.equal(
    matchJob(
      {
        ...job,
        title: "Kubernetes Architect",
        description: "Own Kubernetes infrastructure and Docker CI/CD pipelines.",
      },
      { ...candidate, skills: ["Kubernetes", "Docker", "CI/CD"] }
    ).reviewable,
    false
  )
  for (const posting of [
    {
      ...job,
      description: "Develop distributed services in Java and Spring Boot.",
    },
    { ...job, description: "" },
    {
      ...job,
      title: "Frontend Engineer",
      description: "Frontend role building UI for Python and Postgres tools.",
    },
    {
      ...job,
      description: "Build Python APIs. Requires 9 years of experience.",
    },
    {
      ...job,
      description: "Build Python APIs.\nRequired skills: Python, Kubernetes.",
    },
  ]) {
    assert.equal(
      matchJob(posting, candidate).reviewable,
      false,
      posting.description
    )
  }
  assert.equal(
    matchJob(
      {
        ...job,
        description:
          "Required skills: Python, PostgreSQL.\nPreferred skills: Kubernetes.",
      },
      candidate
    ).reviewable,
    true
  )
})
