
export type TargetCountry =
  | "Australia"
  | "Germany"
  | "Netherlands"
  | "Ireland"
  | "Sweden"
  | "Denmark"
  | "Japan"
  | "UAE"
  | "Spain"
  | "Portugal"
  | "Poland"
  | "France"
  | "Finland"

export type VisaConfidence =
  | "confirmed"
  | "strong"
  | "possible"
  | "weak"
  | "no"

export type PipelineStatus =
  | "discovered"
  | "shortlisted"
  | "needs_tailoring"
  | "applied"
  | "follow_up_due"
  | "recruiter_replied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "archived"

export type ResumeVariant =
  | "Staff Product Engineer / Full-Stack"
  | "Founding Engineer"
  | "Applied AI Engineer"
  | "AI Solutions Architect / Technical Consultant"

export type SourceType =
  | "official_sponsor"
  | "career_page"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "linkedin"
  | "wellfound"
  | "ai_search"
  | "crawler"
  | "stagehand"
  | "manual"
  | "arbeitnow"
  | "remotive"
  | "remoteok"
  | "themuse"
  | "adzuna"

export interface CountryScore {
  country: TargetCountry
  city: string
  score: number
  safety: number
  healthcare: number
  childcare: number
  spouseRights: number
  englishFriendly: number
  residencePath: number
  costPressure: "low" | "medium" | "high"
  notes: string
}

export interface Company {
  id: string
  name: string
  country: TargetCountry
  city: string
  website: string
  careersUrl: string
  sponsorSource: string
  sponsorCategory: string
  officialSourceUrl: string
  lastChecked: string
  visaSignal: VisaConfidence
  hiringHistorySignal: string
  relevanceScore: number
  openRoles: number
  outreachStatus: "not_started" | "queued" | "drafted" | "contacted" | "warm"
  confidence: "high" | "medium" | "low"
  notes: string
}

export interface JobLead {
  description?: string
  id: string
  title: string
  companyId: string
  country: TargetCountry
  city: string
  workMode: "onsite" | "hybrid" | "remote" | "remote_no_relocation"
  sourceUrl: string
  sourceType: SourceType
  roleType: string
  seniority: "senior" | "staff" | "principal" | "founding" | "lead"
  visaConfidence: VisaConfidence
  relocationSignal: string
  salary: string
  jobScore: number
  countryScore: number
  status: PipelineStatus
  resumeVariant: ResumeVariant
  aiFitScore?: number
  aiVisaScore?: number
  aiOverallScore?: number
  aiSummary?: string
  aiWhy?: string[]
  aiRisks?: string[]
  aiLastAnalyzedAt?: string
  applicationDate?: string
  followUpDate?: string
  notes: string
  createdAt: string
  refreshedAt: string
}

export interface Person {
  id: string
  name: string
  companyId: string
  role: string
  sourceUrl: string
  relationshipStatus:
    | "unknown"
    | "research"
    | "drafted"
    | "contacted"
    | "replied"
  lastContactDate?: string
  nextFollowUpDate?: string
  notes: string
}

export interface Draft {
  id: string
  jobId?: string
  companyId?: string
  personId?: string
  kind: "resume_summary" | "cover_note" | "founder_outreach" | "why_me" | "interview_prep"
  title: string
  body: string
  updatedAt: string
}

export interface SourceConnector {
  id: string
  name: string
  type: SourceType
  country?: TargetCountry
  status: "ready" | "needs_login" | "not_configured" | "limited"
  lastRun: string
  found: number
  notes: string
}

export interface AISearchPass {
  id: string
  country: TargetCountry
  roleAngle: string
  strategy: "relocation" | "startup" | "ats"
  queryHint: string
  maxJobs: number
  jobsFound: number
}

export interface AISearchRun {
  id: string
  sourceId: string
  sourceName: string
  provider: string
  endpoint: string
  model: string
  startedAt: string
  importedAt: string
  jobsFound: number
  companiesFound: number
  peopleFound: number
  searchPasses: AISearchPass[]
  notes: string
}

export interface AILaneOverride {
  id: string
  country: TargetCountry
  strategy: AISearchPass["strategy"]
  state: "recommended" | "deprioritized"
  updatedAt: string
}

export interface ImportPayload {
  sourceId: string
  sourceName: string
  companies: Company[]
  jobs: JobLead[]
  people: Person[]
  log: string
  aiSearchRun?: AISearchRun
}

export interface ImportMergeSummary {
  sourceId: string
  sourceName: string
  importedCompanies: number
  importedJobs: number
  importedPeople: number
  addedCompanies: number
  addedJobs: number
  addedPeople: number
  duplicateCompanies: number
  duplicateJobs: number
  duplicatePeople: number
  addedJobIds: string[]
}

export interface ImportMergeResult {
  state: AppState
  sources: ImportMergeSummary[]
  addedCompanies: number
  addedJobs: number
  addedPeople: number
  duplicateCompanies: number
  duplicateJobs: number
  duplicatePeople: number
  addedJobIds: string[]
}

export interface ApplicationReadiness {
  ready: boolean
  score: number
  missing: string[]
  checklist: Array<{
    label: string
    done: boolean
  }>
}

export interface DailyAction {
  id: string
  kind: "apply" | "draft" | "follow_up" | "packet" | "source" | "research"
  priority: "urgent" | "high" | "medium" | "low"
  title: string
  detail: string
  jobId?: string
  companyId?: string
  personId?: string
  sourceId?: string
  score: number
}

export interface DashboardWarning {
  id: string
  kind:
    | "weak_visa"
    | "family_risk"
    | "stale_application"
    | "missing_salary"
    | "missing_location"
    | "remote_no_relocation"
  severity: "high" | "medium" | "low"
  title: string
  detail: string
  jobId: string
  companyId: string
}

export interface SearchCommand {
  id: string
  source: "linkedin" | "google" | "wellfound" | "career_pages" | "founder_signal"
  country: TargetCountry
  title: string
  query: string
  url: string
  notes: string
}

export interface PromptTemplate {
  id: string
  name: string
  kind: Draft["kind"]
  prompt: string
}

export interface CandidateProfile {
  headline: string
  targetOutcome: string
  positioning: string
  familyRequirements: string[]
  targetRoles: string[]
  proofPoints: string[]
  aiEndpoint: string
  aiModel: string
  profileRoot: string
  baseResumeFileName: string
  baseResumeText: string
  baseResumeUpdatedAt?: string
}

export interface AppState {
  profile: CandidateProfile
  countries: CountryScore[]
  companies: Company[]
  jobs: JobLead[]
  people: Person[]
  drafts: Draft[]
  sources: SourceConnector[]
  promptTemplates: PromptTemplate[]
  aiSearchRuns: AISearchRun[]
  aiLaneOverrides: AILaneOverride[]
  refreshLog: string[]
}

export const pipelineLabels: Record<PipelineStatus, string> = {
  discovered: "Discovered",
  shortlisted: "Shortlisted",
  needs_tailoring: "Needs tailoring",
  applied: "Applied",
  follow_up_due: "Follow-up due",
  recruiter_replied: "Recruiter replied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  archived: "Archived",
}

export const pipelineOrder: PipelineStatus[] = [
  "discovered",
  "shortlisted",
  "needs_tailoring",
  "applied",
  "follow_up_due",
  "recruiter_replied",
  "interviewing",
  "offer",
  "rejected",
  "archived",
]

export const visaLabels: Record<VisaConfidence, string> = {
  confirmed: "Confirmed",
  strong: "Strong",
  possible: "Possible",
  weak: "Weak",
  no: "No",
}

export const resumeVariants: ResumeVariant[] = [
  "Staff Product Engineer / Full-Stack",
  "Founding Engineer",
  "Applied AI Engineer",
  "AI Solutions Architect / Technical Consultant",
]

export const targetCountries: TargetCountry[] = [
  "Australia",
  "Germany",
  "Netherlands",
  "Ireland",
  "Sweden",
  "Denmark",
  "Japan",
  "UAE",
]

const familyRequirements = [
  "Safe for families with young children",
  "Strong healthcare access",
  "Reasonable childcare and schooling path",
  "Low corruption and predictable legal system",
  "Stable visa path for spouse and children",
  "Spouse work rights where possible",
  "Realistic path to long-term residence",
  "English-friendly enough for the first 1-2 years",
  "Better work-life balance than India startup intensity",
]

export const initialState: AppState = {
  profile: {
    headline: "Relocation interviews in 6 months",
    targetOutcome:
      "Get relocation interviews for visa-sponsored senior/staff engineering, AI engineering, founding engineer, and technical consulting roles.",
    positioning:
      "Senior product engineer and AI systems builder who can take ambiguous business problems, design the product, build the system, and ship production AI workflows.",
    familyRequirements,
    targetRoles: [
      "Founding Engineer / Staff Product Engineer at AI startups",
      "Senior Full-Stack Engineer with AI/product focus",
      "AI Engineer / Applied AI Engineer",
      "Solutions Architect / Technical Consultant for AI automation",
    ],
    proofPoints: [
      "11+ years building software products",
      "Built VocalDesk AI phone agents",
      "Building V12 Labs as an AI automation company",
      "Shipped client and partner systems",
      "Strong with product, architecture, and customer ambiguity",
    ],
    aiEndpoint: "http://127.0.0.1:8317/v1",
    aiModel: "gpt-5.5",
    profileRoot: "/Users/sharathreddychalla/.v12labs-agents/profiles",
    baseResumeFileName: "",
    baseResumeText: "",
    baseResumeUpdatedAt: undefined,
  },
  countries: [
    {
      country: "Netherlands",
      city: "Amsterdam / Eindhoven",
      score: 92,
      safety: 9,
      healthcare: 9,
      childcare: 8,
      spouseRights: 9,
      englishFriendly: 9,
      residencePath: 8,
      costPressure: "high",
      notes: "Best first importer because IND recognized sponsors create a strong company discovery engine.",
    },
    {
      country: "Germany",
      city: "Berlin / Munich",
      score: 88,
      safety: 9,
      healthcare: 9,
      childcare: 8,
      spouseRights: 8,
      englishFriendly: 7,
      residencePath: 9,
      costPressure: "medium",
      notes: "Strong skilled-worker path and deep engineering market; language matters more over time.",
    },
    {
      country: "Australia",
      city: "Sydney / Melbourne",
      score: 86,
      safety: 9,
      healthcare: 8,
      childcare: 7,
      spouseRights: 8,
      englishFriendly: 10,
      residencePath: 8,
      costPressure: "high",
      notes: "Excellent family fit, but sponsorship speed and cost of living need close filtering.",
    },
    {
      country: "Ireland",
      city: "Dublin",
      score: 83,
      safety: 8,
      healthcare: 7,
      childcare: 7,
      spouseRights: 8,
      englishFriendly: 10,
      residencePath: 8,
      costPressure: "high",
      notes: "English-first and tech-heavy, with housing pressure as the main family constraint.",
    },
    {
      country: "Denmark",
      city: "Copenhagen",
      score: 82,
      safety: 10,
      healthcare: 9,
      childcare: 9,
      spouseRights: 8,
      englishFriendly: 8,
      residencePath: 7,
      costPressure: "high",
      notes: "Outstanding family quality of life; smaller hiring market means sharper targeting.",
    },
    {
      country: "Sweden",
      city: "Stockholm",
      score: 81,
      safety: 9,
      healthcare: 8,
      childcare: 9,
      spouseRights: 8,
      englishFriendly: 8,
      residencePath: 7,
      costPressure: "medium",
      notes: "Strong family and startup fit, but current hiring climate should be monitored.",
    },
    {
      country: "France",
      city: "Paris / Lyon",
      score: 80,
      safety: 8,
      healthcare: 9,
      childcare: 9,
      spouseRights: 8,
      englishFriendly: 6,
      residencePath: 8,
      costPressure: "high",
      notes: "Passeport Talent (Tech visa) is fast for senior engineers; large AI/startup market in Paris.",
    },
    {
      country: "Spain",
      city: "Madrid / Barcelona",
      score: 79,
      safety: 9,
      healthcare: 9,
      childcare: 8,
      spouseRights: 8,
      englishFriendly: 6,
      residencePath: 8,
      costPressure: "medium",
      notes: "Highly Qualified Professional visa + lower cost of living; strong family quality of life.",
    },
    {
      country: "Portugal",
      city: "Lisbon / Porto",
      score: 78,
      safety: 9,
      healthcare: 8,
      childcare: 8,
      spouseRights: 8,
      englishFriendly: 8,
      residencePath: 9,
      costPressure: "medium",
      notes: "Tech Visa and friendly residence path; very English-friendly tech scene, lower cost than NL/IE.",
    },
    {
      country: "Finland",
      city: "Helsinki",
      score: 78,
      safety: 10,
      healthcare: 9,
      childcare: 10,
      spouseRights: 8,
      englishFriendly: 8,
      residencePath: 7,
      costPressure: "medium",
      notes: "Specialist fast-track residence permit (~2 weeks); outstanding childcare and family safety.",
    },
    {
      country: "Poland",
      city: "Warsaw / Kraków",
      score: 74,
      safety: 8,
      healthcare: 7,
      childcare: 7,
      spouseRights: 7,
      englishFriendly: 7,
      residencePath: 7,
      costPressure: "low",
      notes: "Growing engineering hub with low cost of living; good entry point into the EU.",
    },
    {
      country: "Japan",
      city: "Tokyo / Fukuoka",
      score: 75,
      safety: 10,
      healthcare: 8,
      childcare: 7,
      spouseRights: 6,
      englishFriendly: 5,
      residencePath: 7,
      costPressure: "medium",
      notes: "Very safe with a growing AI/startup market; language and spouse work path need attention.",
    },
    {
      country: "UAE",
      city: "Dubai / Abu Dhabi",
      score: 72,
      safety: 9,
      healthcare: 8,
      childcare: 7,
      spouseRights: 6,
      englishFriendly: 10,
      residencePath: 4,
      costPressure: "high",
      notes: "Fast relocation and strong English usage; weaker long-term residence path.",
    },
  ],
  companies: [],
  jobs: [],
  people: [],
  drafts: [],
  sources: [
    {
      id: "s-ai-websearch",
      name: "AI web search sweep",
      type: "ai_search",
      status: "ready",
      lastRun: "Not run",
      found: 0,
      notes:
        "Uses cliproxy with web search to find fresh visa-relevant jobs and exact source links.",
    },
    {
      id: "s-research-crawl",
      name: "Research crawl dataset",
      type: "crawler",
      status: "ready",
      lastRun: "Not run",
      found: 0,
      notes:
        "Fetches seeded company and careers pages, extracts page content, and chunks it into a reusable research dataset.",
    },
  ],
  promptTemplates: [
    {
      id: "pt-outreach",
      name: "Founder/recruiter outreach",
      kind: "founder_outreach",
      prompt:
        "Write a concise relocation-aware founder/recruiter outreach note for Sharath. Emphasize senior product engineering, AI systems, VocalDesk, V12 Labs, and production workflow automation. Avoid hype. Ask for a conversation.",
    },
    {
      id: "pt-summary",
      name: "Role-specific resume summary",
      kind: "resume_summary",
      prompt:
        "Write a 4-bullet resume summary for this role. Use Sharath's strongest positioning and tailor it to the company, role, visa context, and country.",
    },
    {
      id: "pt-cover",
      name: "Short cover note",
      kind: "cover_note",
      prompt:
        "Write a short cover note for this role. Keep it direct, practical, and relocation-aware. Mention product engineering, AI systems, VocalDesk, V12 Labs, and ask for confirmation of visa and family relocation support.",
    },
    {
      id: "pt-why-me",
      name: "Why-me bullets",
      kind: "why_me",
      prompt:
        "Write 5 concise why-me bullets for this role. Tie Sharath's senior product engineering, AI systems, VocalDesk, V12 Labs, ambiguous startup execution, and customer-facing delivery to the company's likely needs.",
    },
    {
      id: "pt-interview",
      name: "Interview talking points",
      kind: "interview_prep",
      prompt:
        "Create interview talking points for a senior builder relocating with family. Include proof points, questions about sponsorship, and concise examples from VocalDesk and V12 Labs.",
    },
  ],
  aiSearchRuns: [],
  aiLaneOverrides: [],
  refreshLog: [],
}

export const initialCountryScores = initialState.countries

const sourceTypeTrust: Record<SourceType, number> = {
  official_sponsor: 100,
  greenhouse: 95,
  lever: 94,
  ashby: 93,
  workable: 92,
  career_page: 88,
  wellfound: 80,
  ai_search: 60,
  crawler: 58,
  stagehand: 52,
  linkedin: 44,
  manual: 35,
  arbeitnow: 78,
  remotive: 70,
  remoteok: 66,
  themuse: 74,
  adzuna: 76,
}

const sourceTypeScoreBonus: Record<SourceType, number> = {
  official_sponsor: 12,
  greenhouse: 10,
  lever: 10,
  ashby: 10,
  workable: 10,
  career_page: 8,
  wellfound: 6,
  ai_search: 4,
  crawler: 5,
  stagehand: 4,
  linkedin: 2,
  manual: 1,
  arbeitnow: 6,
  remotive: 5,
  remoteok: 4,
  themuse: 6,
  adzuna: 6,
}

function higherTrustSourceType(primary: SourceType, secondary: SourceType) {
  return sourceTypeTrust[secondary] > sourceTypeTrust[primary]
    ? secondary
    : primary
}



export const sourceImportPayloads: Record<string, ImportPayload> = {}

function mergeMissingById<T extends { id: string }>(current: T[], seed: T[]) {
  const currentIds = new Set(current.map((item) => item.id))
  return [...current, ...seed.filter((item) => !currentIds.has(item.id))]
}

function normalizeKey(value?: string) {
  return (value ?? "").trim().toLowerCase().replaceAll(/\s+/g, " ")
}

function normalizeUrl(value?: string) {
  const trimmed = (value ?? "").trim()
  if (!trimmed || trimmed === "#") return ""

  try {
    const url = new URL(trimmed)
    url.hash = ""
    url.search = ""
    return `${url.hostname}${url.pathname}`.replace(/\/$/, "").toLowerCase()
  } catch {
    return normalizeKey(trimmed)
  }
}

function companyKey(company: Pick<Company, "name" | "country">) {
  return `${normalizeKey(company.name)}|${company.country}`
}

function companyUrlKey(company: Pick<Company, "website" | "careersUrl" | "officialSourceUrl">) {
  return [company.website, company.careersUrl, company.officialSourceUrl]
    .map(normalizeUrl)
    .find(Boolean)
}

function jobKey(job: Pick<JobLead, "companyId" | "title" | "country" | "city" | "roleType" | "sourceUrl">, companyLookup: Map<string, Company>) {
  const sourceUrl = normalizeUrl(job.sourceUrl)
  if (sourceUrl) return `url:${sourceUrl}`

  const company = companyLookup.get(job.companyId)
  const resolvedCompanyKey = company ? companyKey(company) : normalizeKey(job.companyId)
  return [
    resolvedCompanyKey,
    normalizeKey(job.title),
    job.country,
    normalizeKey(job.city),
    normalizeKey(job.roleType),
  ].join("|")
}

function personKey(person: Pick<Person, "companyId" | "name" | "role" | "sourceUrl">, companyLookup: Map<string, Company>) {
  const sourceUrl = normalizeUrl(person.sourceUrl)
  if (sourceUrl) return `url:${sourceUrl}`

  const company = companyLookup.get(person.companyId)
  const resolvedCompanyKey = company ? companyKey(company) : normalizeKey(person.companyId)
  return [resolvedCompanyKey, normalizeKey(person.name), normalizeKey(person.role)].join("|")
}

function draftKey(
  draft: Pick<Draft, "jobId" | "companyId" | "personId" | "kind" | "title">
) {
  return [
    draft.jobId ?? "",
    draft.companyId ?? "",
    draft.personId ?? "",
    draft.kind,
    normalizeKey(draft.title),
  ].join("|")
}

const visaConfidenceRank: Record<VisaConfidence, number> = {
  no: 0,
  weak: 1,
  possible: 2,
  strong: 3,
  confirmed: 4,
}

const confidenceRank: Record<Company["confidence"], number> = {
  low: 0,
  medium: 1,
  high: 2,
}

const outreachStatusRank: Record<Company["outreachStatus"], number> = {
  not_started: 0,
  queued: 1,
  drafted: 2,
  contacted: 3,
  warm: 4,
}

const pipelineStatusRank: Record<PipelineStatus, number> = {
  discovered: 0,
  shortlisted: 1,
  needs_tailoring: 2,
  applied: 3,
  follow_up_due: 4,
  recruiter_replied: 5,
  interviewing: 6,
  offer: 7,
  rejected: 8,
  archived: 9,
}

function preferText(primary: string, secondary: string) {
  const primaryValue = primary.trim()
  const secondaryValue = secondary.trim()
  if (!primaryValue) return secondaryValue
  if (!secondaryValue) return primaryValue
  if (/^(unknown|needs verification|manual lead|manual target)$/i.test(primaryValue)) {
    return secondaryValue
  }
  if (secondaryValue.length > primaryValue.length) return secondaryValue
  return primaryValue
}

function chooseLaterDate(primary?: string, secondary?: string) {
  if (!primary) return secondary
  if (!secondary) return primary
  return secondary > primary ? secondary : primary
}

function chooseEarlierDate(primary?: string, secondary?: string) {
  if (!primary) return secondary
  if (!secondary) return primary
  return secondary < primary ? secondary : primary
}

function chooseConfidence(
  primary: Company["confidence"],
  secondary: Company["confidence"]
) {
  return confidenceRank[secondary] > confidenceRank[primary] ? secondary : primary
}

function chooseVisaConfidence(primary: VisaConfidence, secondary: VisaConfidence) {
  return visaConfidenceRank[secondary] > visaConfidenceRank[primary]
    ? secondary
    : primary
}

function chooseOutreachStatus(
  primary: Company["outreachStatus"],
  secondary: Company["outreachStatus"]
) {
  return outreachStatusRank[secondary] > outreachStatusRank[primary]
    ? secondary
    : primary
}

function choosePipelineStatus(primary: PipelineStatus, secondary: PipelineStatus) {
  return pipelineStatusRank[secondary] > pipelineStatusRank[primary]
    ? secondary
    : primary
}

function mergeCompanyRecords(existing: Company, incoming: Company): Company {
  return {
    ...existing,
    name: preferText(existing.name, incoming.name),
    country: existing.country,
    city:
      normalizeKey(existing.city) === "unknown"
        ? incoming.city
        : preferText(existing.city, incoming.city),
    website: preferText(existing.website, incoming.website),
    careersUrl: preferText(existing.careersUrl, incoming.careersUrl),
    sponsorSource: preferText(existing.sponsorSource, incoming.sponsorSource),
    sponsorCategory: preferText(existing.sponsorCategory, incoming.sponsorCategory),
    officialSourceUrl: preferText(existing.officialSourceUrl, incoming.officialSourceUrl),
    lastChecked: chooseLaterDate(existing.lastChecked, incoming.lastChecked) ?? "",
    visaSignal: chooseVisaConfidence(existing.visaSignal, incoming.visaSignal),
    hiringHistorySignal: preferText(
      existing.hiringHistorySignal,
      incoming.hiringHistorySignal
    ),
    relevanceScore: Math.max(existing.relevanceScore, incoming.relevanceScore),
    openRoles: Math.max(existing.openRoles, incoming.openRoles),
    outreachStatus: chooseOutreachStatus(existing.outreachStatus, incoming.outreachStatus),
    confidence: chooseConfidence(existing.confidence, incoming.confidence),
    notes: preferText(existing.notes, incoming.notes),
  }
}

function mergeJobRecords(existing: JobLead, incoming: JobLead): JobLead {
  return {
    ...existing,
    title: preferText(existing.title, incoming.title),
    companyId: existing.companyId,
    country: existing.country,
    city: preferText(existing.city, incoming.city),
    workMode:
      existing.workMode === "remote_no_relocation"
        ? incoming.workMode
        : existing.workMode,
    sourceUrl: preferText(existing.sourceUrl, incoming.sourceUrl),
    sourceType: higherTrustSourceType(existing.sourceType, incoming.sourceType),
    roleType: preferText(existing.roleType, incoming.roleType),
    seniority: existing.seniority,
    visaConfidence: chooseVisaConfidence(existing.visaConfidence, incoming.visaConfidence),
    relocationSignal: preferText(existing.relocationSignal, incoming.relocationSignal),
    salary: preferText(existing.salary, incoming.salary),
    jobScore: Math.max(existing.jobScore, incoming.jobScore),
    countryScore: Math.max(existing.countryScore, incoming.countryScore),
    status: choosePipelineStatus(existing.status, incoming.status),
    resumeVariant: existing.resumeVariant,
    applicationDate: chooseEarlierDate(existing.applicationDate, incoming.applicationDate),
    followUpDate: chooseEarlierDate(existing.followUpDate, incoming.followUpDate),
    notes: preferText(existing.notes, incoming.notes),
    createdAt: chooseEarlierDate(existing.createdAt, incoming.createdAt) ?? existing.createdAt,
    refreshedAt: chooseLaterDate(existing.refreshedAt, incoming.refreshedAt) ?? existing.refreshedAt,
  }
}

function mergePersonRecords(existing: Person, incoming: Person): Person {
  return {
    ...existing,
    companyId: existing.companyId,
    name: preferText(existing.name, incoming.name),
    role: preferText(existing.role, incoming.role),
    sourceUrl: preferText(existing.sourceUrl, incoming.sourceUrl),
    relationshipStatus:
      existing.relationshipStatus === "contacted" ||
      existing.relationshipStatus === "replied"
        ? existing.relationshipStatus
        : incoming.relationshipStatus,
    lastContactDate: chooseLaterDate(existing.lastContactDate, incoming.lastContactDate),
    nextFollowUpDate: chooseEarlierDate(
      existing.nextFollowUpDate,
      incoming.nextFollowUpDate
    ),
    notes: preferText(existing.notes, incoming.notes),
  }
}

function mergeDraftRecords(existing: Draft, incoming: Draft): Draft {
  return {
    ...existing,
    jobId: existing.jobId ?? incoming.jobId,
    companyId: existing.companyId ?? incoming.companyId,
    personId: existing.personId ?? incoming.personId,
    kind: existing.kind,
    title: preferText(existing.title, incoming.title),
    body: preferText(existing.body, incoming.body),
    updatedAt: chooseLaterDate(existing.updatedAt, incoming.updatedAt) ?? existing.updatedAt,
  }
}

export function dedupeAppState(state: AppState): AppState {
  const companies: Company[] = []
  const companyByNameKey = new Map<string, Company>()
  const companyByUrlKey = new Map<string, Company>()
  const companyIdAliases = new Map<string, string>()

  for (const company of state.companies ?? []) {
    const nameKey = `name:${companyKey(company)}`
    const urlKey = companyUrlKey(company)
    const existing = companyByNameKey.get(nameKey) ?? (urlKey ? companyByUrlKey.get(`url:${urlKey}`) : undefined)
    if (!existing) {
      companies.push(company)
      companyByNameKey.set(nameKey, company)
      if (urlKey) companyByUrlKey.set(`url:${urlKey}`, company)
      companyIdAliases.set(company.id, company.id)
      continue
    }

    const merged = mergeCompanyRecords(existing, company)
    const index = companies.findIndex((item) => item.id === existing.id)
    if (index >= 0) companies[index] = merged
    companyByNameKey.set(nameKey, merged)
    if (urlKey) companyByUrlKey.set(`url:${urlKey}`, merged)
    companyIdAliases.set(company.id, merged.id)
    companyIdAliases.set(existing.id, merged.id)
  }

  const remapCompanyId = (companyId: string) => companyIdAliases.get(companyId) ?? companyId
  const companyLookup = new Map(companies.map((company) => [company.id, company]))

  const jobs: JobLead[] = []
  const jobByKey = new Map<string, JobLead>()
  const jobIdAliases = new Map<string, string>()
  for (const job of state.jobs ?? []) {
    const remappedJob: JobLead = {
      ...job,
      companyId: remapCompanyId(job.companyId),
    }
    const key = jobKey(remappedJob, companyLookup)
    const existing = jobByKey.get(key)
    if (!existing) {
      jobs.push(remappedJob)
      jobByKey.set(key, remappedJob)
      jobIdAliases.set(remappedJob.id, remappedJob.id)
      continue
    }

    const merged = mergeJobRecords(existing, remappedJob)
    const index = jobs.findIndex((item) => item.id === existing.id)
    if (index >= 0) jobs[index] = merged
    jobByKey.set(key, merged)
    jobIdAliases.set(remappedJob.id, merged.id)
    jobIdAliases.set(existing.id, merged.id)
  }

  const people: Person[] = []
  const personByKey = new Map<string, Person>()
  const personIdAliases = new Map<string, string>()
  for (const person of state.people ?? []) {
    const remappedPerson: Person = {
      ...person,
      companyId: remapCompanyId(person.companyId),
    }
    const key = personKey(remappedPerson, companyLookup)
    const existing = personByKey.get(key)
    if (!existing) {
      people.push(remappedPerson)
      personByKey.set(key, remappedPerson)
      personIdAliases.set(remappedPerson.id, remappedPerson.id)
      continue
    }

    const merged = mergePersonRecords(existing, remappedPerson)
    const index = people.findIndex((item) => item.id === existing.id)
    if (index >= 0) people[index] = merged
    personByKey.set(key, merged)
    personIdAliases.set(remappedPerson.id, merged.id)
    personIdAliases.set(existing.id, merged.id)
  }

  const drafts: Draft[] = []
  const draftByKey = new Map<string, Draft>()
  for (const draft of state.drafts ?? []) {
    const remappedDraft: Draft = {
      ...draft,
      jobId: draft.jobId ? jobIdAliases.get(draft.jobId) ?? draft.jobId : draft.jobId,
      companyId: draft.companyId ? remapCompanyId(draft.companyId) : draft.companyId,
      personId: draft.personId
        ? personIdAliases.get(draft.personId) ?? draft.personId
        : draft.personId,
    }
    const key = draftKey(remappedDraft)
    const existing = draftByKey.get(key)
    if (!existing) {
      drafts.push(remappedDraft)
      draftByKey.set(key, remappedDraft)
      continue
    }

    const merged = mergeDraftRecords(existing, remappedDraft)
    const index = drafts.findIndex((item) => item.id === existing.id)
    if (index >= 0) drafts[index] = merged
    draftByKey.set(key, merged)
  }

  return {
    ...state,
    companies,
    jobs,
    people,
    drafts,
  }
}

export function mergeImportedRecordsIntoState(
  state: AppState,
  payloads: ImportPayload[]
): ImportMergeResult {
  let nextState = dedupeAppState(state)
  const sources: ImportMergeSummary[] = []

  for (const payload of payloads) {
    const previousCompanyIds = new Set(nextState.companies.map((company) => company.id))
    const previousJobIds = new Set(nextState.jobs.map((job) => job.id))
    const previousPersonIds = new Set(nextState.people.map((person) => person.id))

    nextState = dedupeAppState({
      ...nextState,
      companies: [...nextState.companies, ...payload.companies],
      jobs: [...nextState.jobs, ...payload.jobs],
      people: [...nextState.people, ...payload.people],
    })

    const addedCompanyIds = nextState.companies
      .filter((company) => !previousCompanyIds.has(company.id))
      .map((company) => company.id)
    const addedJobIds = nextState.jobs
      .filter((job) => !previousJobIds.has(job.id))
      .map((job) => job.id)
    const addedPersonIds = nextState.people
      .filter((person) => !previousPersonIds.has(person.id))
      .map((person) => person.id)

    sources.push({
      sourceId: payload.sourceId,
      sourceName: payload.sourceName,
      importedCompanies: payload.companies.length,
      importedJobs: payload.jobs.length,
      importedPeople: payload.people.length,
      addedCompanies: addedCompanyIds.length,
      addedJobs: addedJobIds.length,
      addedPeople: addedPersonIds.length,
      duplicateCompanies: Math.max(0, payload.companies.length - addedCompanyIds.length),
      duplicateJobs: Math.max(0, payload.jobs.length - addedJobIds.length),
      duplicatePeople: Math.max(0, payload.people.length - addedPersonIds.length),
      addedJobIds,
    })
  }

  return {
    state: nextState,
    sources,
    addedCompanies: sources.reduce((sum, item) => sum + item.addedCompanies, 0),
    addedJobs: sources.reduce((sum, item) => sum + item.addedJobs, 0),
    addedPeople: sources.reduce((sum, item) => sum + item.addedPeople, 0),
    duplicateCompanies: sources.reduce((sum, item) => sum + item.duplicateCompanies, 0),
    duplicateJobs: sources.reduce((sum, item) => sum + item.duplicateJobs, 0),
    duplicatePeople: sources.reduce((sum, item) => sum + item.duplicatePeople, 0),
    addedJobIds: sources.flatMap((item) => item.addedJobIds),
  }
}

function mergeMissingCountries(current: CountryScore[], seed: CountryScore[]) {
  const currentIds = new Set(
    current.map((item) => `${item.country}:${item.city}`)
  )
  return [
    ...current,
    ...seed.filter((item) => !currentIds.has(`${item.country}:${item.city}`)),
  ]
}

export function withSeedDefaults(state: AppState): AppState {
  return dedupeAppState({
    ...state,
    profile: {
      ...initialState.profile,
      ...state.profile,
      familyRequirements:
        state.profile.familyRequirements?.length
          ? state.profile.familyRequirements
          : initialState.profile.familyRequirements,
      targetRoles:
        state.profile.targetRoles?.length
          ? state.profile.targetRoles
          : initialState.profile.targetRoles,
      proofPoints:
        state.profile.proofPoints?.length
          ? state.profile.proofPoints
          : initialState.profile.proofPoints,
    },
    countries: mergeMissingCountries(state.countries ?? [], initialState.countries),
    sources: mergeMissingById(state.sources ?? [], initialState.sources),
    promptTemplates: mergeMissingById(
      state.promptTemplates ?? [],
      initialState.promptTemplates
    ),
    companies: state.companies ?? [],
    jobs: state.jobs ?? [],
    people: state.people ?? [],
    drafts: state.drafts ?? [],
    aiSearchRuns: (state.aiSearchRuns ?? []).slice(0, 12),
    aiLaneOverrides: state.aiLaneOverrides ?? [],
    refreshLog: state.refreshLog?.length ? state.refreshLog : initialState.refreshLog,
  })
}

const visaWeight: Record<VisaConfidence, number> = {
  confirmed: 30,
  strong: 24,
  possible: 16,
  weak: 6,
  no: -40,
}

const seniorityWeight: Record<JobLead["seniority"], number> = {
  founding: 18,
  staff: 16,
  principal: 14,
  lead: 12,
  senior: 10,
}

export function scoreJob(job: JobLead, company?: Company, country?: CountryScore) {
  const roleFit =
    /founding|staff|ai|applied|product|solutions/i.test(
      `${job.title} ${job.roleType}`
    )
      ? 18
      : 8
  const companyFit = company ? Math.round(company.relevanceScore / 6) : 8
  const countryFit = country ? Math.round(country.score / 6) : 8
  const remotePenalty = job.workMode === "remote_no_relocation" ? -24 : 0
const sourceBonus =
    sourceTypeScoreBonus[job.sourceType]

  return Math.max(
    0,
    Math.min(
      100,
      visaWeight[job.visaConfidence] +
        seniorityWeight[job.seniority] +
        roleFit +
        companyFit +
        countryFit +
        sourceBonus +
        remotePenalty
    )
  )
}

export function scoreAllJobs(state: AppState): JobLead[] {
  return state.jobs.map((job) => {
    const company = state.companies.find((item) => item.id === job.companyId)
    const country = state.countries.find(
      (item) => item.country === job.country && job.city.includes(item.city.split(" / ")[0])
    )
    const fallbackCountry = state.countries.find(
      (item) => item.country === job.country
    )
    return {
      ...job,
      jobScore: scoreJob(job, company, country ?? fallbackCountry),
      countryScore: country?.score ?? fallbackCountry?.score ?? job.countryScore,
    }
  })
}

export function blendedJobRank(job: JobLead) {
  const base = Math.round((job.jobScore + job.countryScore) / 2)
  if (typeof job.aiOverallScore !== "number") return base
  return Math.round(base * 0.55 + job.aiOverallScore * 0.45)
}

export function companyFor(job: JobLead, companies: Company[]) {
  return companies.find((company) => company.id === job.companyId)
}

export function applicationReadiness(
  job: JobLead,
  state: Pick<AppState, "companies" | "drafts" | "people">
): ApplicationReadiness {
  const company = companyFor(job, state.companies)
  const hasDraft = state.drafts.some((draft) => draft.jobId === job.id)
  const hasContact = state.people.some((person) => person.companyId === job.companyId)
  const hasVisaSignal = job.visaConfidence === "confirmed" || job.visaConfidence === "strong"
  const hasFollowUp = Boolean(job.followUpDate)
  const hasResumeVariant = Boolean(job.resumeVariant)
  const hasSource = Boolean(job.sourceUrl && job.sourceUrl !== "#")
  const hasCompanyContext = Boolean(company?.notes && company.notes.length > 20)
  const isNotRemoteOnly = job.workMode !== "remote_no_relocation"

  const checklist = [
    { label: "Resume variant selected", done: hasResumeVariant },
    { label: "Visa signal is strong enough", done: hasVisaSignal },
    { label: "Source URL captured", done: hasSource },
    { label: "Company context captured", done: hasCompanyContext },
    { label: "Draft note exists", done: hasDraft },
    { label: "Recruiter/founder contact exists", done: hasContact },
    { label: "Follow-up date set", done: hasFollowUp },
    { label: "Not remote-only without relocation", done: isNotRemoteOnly },
  ]
  const missing = checklist.filter((item) => !item.done).map((item) => item.label)
  const score = Math.round(
    (checklist.filter((item) => item.done).length / checklist.length) * 100
  )

  return {
    ready: score >= 75 && isNotRemoteOnly && hasResumeVariant && hasSource,
    score,
    missing,
    checklist,
  }
}

function priorityFromScore(score: number): DailyAction["priority"] {
  if (score >= 90) return "urgent"
  if (score >= 75) return "high"
  if (score >= 55) return "medium"
  return "low"
}

export function recommendDailyActions(state: AppState): DailyAction[] {
  const actions: DailyAction[] = []
  const scoredJobs = scoreAllJobs(state)

  for (const job of scoredJobs) {
    if (job.status === "archived" || job.status === "rejected") continue
    const company = companyFor(job, state.companies)
    const readiness = applicationReadiness(job, state)
    const combinedScore = Math.round((job.jobScore + job.countryScore) / 2)
    const hasDraft = state.drafts.some((draft) => draft.jobId === job.id)
    const hasContact = state.people.some((person) => person.companyId === job.companyId)

    if (dueSoon(job.followUpDate) && ["applied", "follow_up_due", "recruiter_replied"].includes(job.status)) {
      actions.push({
        id: `follow-${job.id}`,
        kind: "follow_up",
        priority: "urgent",
        title: `Follow up on ${job.title}`,
        detail: `${company?.name ?? "Company"} follow-up is due ${job.followUpDate}. Keep it concise and ask about sponsorship timeline.`,
        jobId: job.id,
        companyId: job.companyId,
        score: 98,
      })
    }

    if (readiness.ready && job.status !== "applied") {
      actions.push({
        id: `apply-${job.id}`,
        kind: "apply",
        priority: priorityFromScore(combinedScore + 12),
        title: `Apply to ${job.title}`,
        detail: `${company?.name ?? "Company"} is packet-ready. Use ${job.resumeVariant} and confirm family relocation support.`,
        jobId: job.id,
        companyId: job.companyId,
        score: combinedScore + 12,
      })
    }

    if (!readiness.ready && combinedScore >= 75 && job.workMode !== "remote_no_relocation") {
      actions.push({
        id: `packet-${job.id}`,
        kind: "packet",
        priority: priorityFromScore(combinedScore),
        title: `Prepare packet for ${job.title}`,
        detail: readiness.missing.length
          ? `Missing: ${readiness.missing.slice(0, 3).join(", ")}.`
          : "Review the packet before applying.",
        jobId: job.id,
        companyId: job.companyId,
        score: combinedScore,
      })
    }

    if (!hasDraft && ["shortlisted", "needs_tailoring", "discovered"].includes(job.status)) {
      actions.push({
        id: `draft-${job.id}`,
        kind: "draft",
        priority: priorityFromScore(combinedScore - 5),
        title: `Draft outreach for ${job.title}`,
        detail: `${company?.name ?? "Company"} needs a tailored note before you apply or contact a recruiter.`,
        jobId: job.id,
        companyId: job.companyId,
        score: combinedScore - 5,
      })
    }

    if (!hasContact && /founding|startup|ai/i.test(`${job.title} ${job.roleType}`)) {
      actions.push({
        id: `research-${job.id}`,
        kind: "research",
        priority: priorityFromScore(combinedScore - 10),
        title: `Find a recruiter or founder at ${company?.name ?? "this company"}`,
        detail: "Direct contact matters for startup, AI, founding, and staff roles.",
        jobId: job.id,
        companyId: job.companyId,
        score: combinedScore - 10,
      })
    }
  }

  for (const source of state.sources) {
    if (source.status === "ready" || source.status === "limited") {
      const officialScore = source.type === "official_sponsor" ? 78 : 58
      actions.push({
        id: `source-${source.id}`,
        kind: "source",
        priority: source.type === "official_sponsor" ? "high" : "medium",
        title: `Refresh ${source.name}`,
        detail: source.notes,
        sourceId: source.id,
        score: officialScore,
      })
    }
  }

  for (const person of state.people) {
    const company = state.companies.find((item) => item.id === person.companyId)
    const companyScore = company?.relevanceScore ?? 60
    const hasDraft = state.drafts.some((draft) => draft.personId === person.id)

    if (
      dueSoon(person.nextFollowUpDate) &&
      ["drafted", "contacted", "replied"].includes(person.relationshipStatus)
    ) {
      actions.push({
        id: `person-follow-${person.id}`,
        kind: "follow_up",
        priority: person.relationshipStatus === "replied" ? "urgent" : "high",
        title: `Follow up with ${person.name}`,
        detail: `${company?.name ?? "Company"} contact is due ${person.nextFollowUpDate}. Keep it human and ask about role fit, sponsorship, and relocation timing.`,
        companyId: person.companyId,
        personId: person.id,
        score: person.relationshipStatus === "replied" ? 96 : 82,
      })
    }

    if (!hasDraft && ["research", "unknown"].includes(person.relationshipStatus)) {
      actions.push({
        id: `person-draft-${person.id}`,
        kind: "draft",
        priority: priorityFromScore(companyScore),
        title: `Draft outreach to ${person.name}`,
        detail: `${company?.name ?? "Company"} has a saved contact but no outreach draft yet.`,
        companyId: person.companyId,
        personId: person.id,
        score: companyScore,
      })
    }
  }

  return actions
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
}

function daysBetween(start?: string, end = "2026-06-16") {
  if (!start) return 0
  const startDate = new Date(`${start}T00:00:00`)
  const endDate = new Date(`${end}T00:00:00`)
  return Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000)
}

export function dashboardWarnings(state: AppState): DashboardWarning[] {
  const warnings: DashboardWarning[] = []
  const scoredJobs = scoreAllJobs(state)

  for (const job of scoredJobs) {
    if (job.status === "archived" || job.status === "rejected") continue
    const company = companyFor(job, state.companies)
    const country = state.countries.find(
      (item) => item.country === job.country && job.city.includes(item.city.split(" / ")[0])
    ) ?? state.countries.find((item) => item.country === job.country)
    const companyName = company?.name ?? "Company"

    if (job.workMode === "remote_no_relocation") {
      warnings.push({
        id: `remote-${job.id}`,
        kind: "remote_no_relocation",
        severity: "high",
        title: `${job.title} has no relocation path`,
        detail: `${companyName} is remote-only in this lead. Keep it outside the main relocation push until sponsorship is confirmed.`,
        jobId: job.id,
        companyId: job.companyId,
      })
    }

    if (job.visaConfidence === "weak" || job.visaConfidence === "no") {
      warnings.push({
        id: `visa-${job.id}`,
        kind: "weak_visa",
        severity: job.visaConfidence === "no" ? "high" : "medium",
        title: `${companyName} has weak visa evidence`,
        detail: `${visaLabels[job.visaConfidence]} visa signal. Confirm sponsorship before spending serious tailoring time.`,
        jobId: job.id,
        companyId: job.companyId,
      })
    }

    if ((country?.score ?? job.countryScore) < 78) {
      warnings.push({
        id: `family-${job.id}`,
        kind: "family_risk",
        severity: "medium",
        title: `${job.city}, ${job.country} needs family review`,
        detail: `Family score is ${country?.score ?? job.countryScore}. Check spouse work rights, childcare, healthcare, and long-term residence before prioritizing.`,
        jobId: job.id,
        companyId: job.companyId,
      })
    }

    if (!job.salary || /unknown|check/i.test(job.salary)) {
      warnings.push({
        id: `salary-${job.id}`,
        kind: "missing_salary",
        severity: "low",
        title: `${job.title} is missing salary clarity`,
        detail: "Ask for range or level early so relocation economics do not surprise you later.",
        jobId: job.id,
        companyId: job.companyId,
      })
    }

    if (!job.city || /unknown|remote eu/i.test(job.city)) {
      warnings.push({
        id: `location-${job.id}`,
        kind: "missing_location",
        severity: "medium",
        title: `${job.title} needs location clarity`,
        detail: "Confirm actual city, hybrid expectations, and whether relocation is required or supported.",
        jobId: job.id,
        companyId: job.companyId,
      })
    }

    if (
      ["applied", "follow_up_due", "recruiter_replied", "interviewing"].includes(
        job.status
      ) &&
      daysBetween(job.followUpDate ?? job.applicationDate ?? job.refreshedAt) > 7
    ) {
      warnings.push({
        id: `stale-${job.id}`,
        kind: "stale_application",
        severity: "high",
        title: `${job.title} is stale`,
        detail: "Application has not moved recently. Follow up, refresh the contact, or archive it.",
        jobId: job.id,
        companyId: job.companyId,
      })
    }
  }

  const severityWeight: Record<DashboardWarning["severity"], number> = {
    high: 3,
    medium: 2,
    low: 1,
  }

  return warnings.sort(
    (a, b) => severityWeight[b.severity] - severityWeight[a.severity]
  )
}

function searchUrl(source: SearchCommand["source"], query: string) {
  if (source === "linkedin") {
    return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}`
  }
  if (source === "wellfound") {
    return `https://wellfound.com/jobs?keywords=${encodeURIComponent(query)}`
  }
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

export function buildSearchCommands(state: Pick<AppState, "profile">): SearchCommand[] {
  const roleQueries = [
    `"founding engineer" "visa sponsorship" AI`,
    `"staff product engineer" relocation "visa"`,
    `"applied AI engineer" "relocation support"`,
    `"AI solutions architect" "visa sponsorship"`,
  ]

  return targetCountries.flatMap((country) => {
    const baseRole = roleQueries[country === "UAE" ? 3 : country === "Japan" ? 2 : 0]
    const linkedinQuery = `${baseRole} ${country}`
    const googleQuery = `site:greenhouse.io OR site:lever.co OR site:ashbyhq.com "${country}" "visa sponsorship" ("AI Engineer" OR "Staff Engineer" OR "Founding Engineer")`
    const sponsorQuery =
      country === "Netherlands"
        ? `"IND recognised sponsor" "software engineer" "AI" "Amsterdam"`
        : `"${country}" "visa sponsorship" "software engineer" "relocation"`
    const founderQuery = `"hiring" "founding engineer" "AI" "${country}" ("visa" OR "relocation")`

    const commands: SearchCommand[] = [
      {
        id: `linkedin-${country}`,
        source: "linkedin",
        country,
        title: `${country} LinkedIn visa roles`,
        query: linkedinQuery,
        url: searchUrl("linkedin", linkedinQuery),
        notes: "Use with the shared LinkedIn profile; capture links and snippets only.",
      },
      {
        id: `boards-${country}`,
        source: "career_pages",
        country,
        title: `${country} Greenhouse/Lever/Ashby roles`,
        query: googleQuery,
        url: searchUrl("google", googleQuery),
        notes: "Good for structured company career pages and ATS-hosted roles.",
      },
      {
        id: `sponsor-${country}`,
        source: "google",
        country,
        title: `${country} sponsor-backed discovery`,
        query: sponsorQuery,
        url: searchUrl("google", sponsorQuery),
        notes:
          country === "Netherlands"
            ? "Pairs with the IND importer and sponsor-backed company records."
            : "Use to find companies with visible sponsorship or relocation language.",
      },
      {
        id: `founder-${country}`,
        source: "founder_signal",
        country,
        title: `${country} founder hiring signals`,
        query: founderQuery,
        url: searchUrl("google", founderQuery),
        notes: "Use for direct outreach targets when public job posts are weak.",
      },
    ]

    if (country !== "UAE") {
      const wellfoundQuery = `${state.profile.targetRoles[0]} ${country} visa sponsorship`
      commands.push({
        id: `wellfound-${country}`,
        source: "wellfound",
        country,
        title: `${country} startup roles`,
        query: wellfoundQuery,
        url: searchUrl("wellfound", wellfoundQuery),
        notes: "Startup-oriented search; verify sponsorship before spending time.",
      })
    }

    return commands
  })
}

export function dueSoon(date?: string) {
  if (!date) return false
  const now = new Date("2026-06-16T00:00:00")
  const due = new Date(`${date}T00:00:00`)
  const diff = due.getTime() - now.getTime()
  return diff <= 1000 * 60 * 60 * 24 * 3
}

export function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`
}
