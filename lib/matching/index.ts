import type { Candidate } from "@/lib/candidate"
import type { Job } from "@/lib/jobs"
import { countryName } from "@/lib/location/countries"
import { visaNeeded } from "@/lib/applications/auto-apply"
import { isSoftwareRole } from "@/lib/jobs/software-roles"
import { classifyJobCategory, type JobCategory } from "@/lib/jobs/categories"

const locationSeparators = new RegExp("[^\\p{L}\\p{N}]+", "gu")
function normalizedLocation(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(locationSeparators, " ")
    .trim()
}

export interface Match {
  /** Retained for legacy score readers; does not represent category selection. */
  softwareRole?: boolean
  category?: JobCategory | null
  inScope?: boolean
  score: number
  reasons: string[]
  gaps: string[]
  eligible: boolean
  relevant: boolean
  reviewable: boolean
}

function normalize(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bnode\.?js\b/g, "nodejs")
    .replace(/\bnext\.?js\b/g, "nextjs")
    .replace(/\bpostgresql\b/g, "postgres")
    .replace(/\bfull[- ]?stack\b/g, "fullstack")
    .replace(/\bfront[- ]end\b/g, "frontend")
    .replace(/\bback[- ]end\b/g, "backend")
    .replace(/\bapis\b/g, "api")
}
/** "Senior Data Engineer – Talend", "Engineer (Payments)", "SWE, Platform" → the role itself. */
export function roleTitleCore(value: string) {
  const core = value
    .replace(/\s+[–—-]\s+.*$|[–—].*$|[:|(,].*$|\s(?:@|at)\s.*$/i, "")
    .trim()
  return core || value.trim()
}
function roleTitle(value: string) {
  return normalize(roleTitleCore(value))
    .replace(
      /\b(senior|sr|staff|principal|lead|founding|junior|jr)\b[.]?/g,
      " "
    )
    .replace(/\bdeveloper\b/g, "engineer")
    .replace(/\s+/g, " ")
    .trim()
}
// Professions inside the software scope. A target and a posting in the same
// family are related even when neither title says "software engineer".
// Cues use Unicode boundaries: "devopsé" is not "devops".
function cue(alternation: string) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`,
    "u"
  )
}
const roleFamilies: [string, RegExp][] = [
  ["frontend", cue("frontend|fullstack")],
  ["backend", cue("backend|fullstack")],
  [
    "data",
    cue(
      "data (platform |warehouse |integration |pipeline |infrastructure |solutions? |quality )?(engineer|engineering|architect|developer|modeler)|etl|elt|data warehous\\p{L}*|big data|analytics engineer|bi (developer|engineer|consultant)|business intelligence|databricks|snowflake|pyspark|spark|hadoop|talend|informatica|dbt|airflow|data factory|lakehouse"
    ),
  ],
  [
    "ml",
    cue(
      "machine learning|ml|ai|artificial intelligence|deep learning|nlp|computer vision|llm|llms|genai|generative ai|applied scientist|mlops"
    ),
  ],
  [
    "devops",
    cue(
      "(devops|devsecops|sre|site reliability|cloud|infrastructure|platform)\\s+(engineer|architect|developer|specialist)|devops|devsecops|sre|mlops"
    ),
  ],
  ["security", cue("security|appsec|penetration|offensive")],
  ["qa", cue("qa|quality assurance|test automation|sdet|tester|testing")],
  ["mobile", cue("ios|android|mobile|flutter|react native")],
  ["embedded", cue("embedded|firmware")],
  [
    "management",
    cue(
      "engineering manager|head of (software )?engineering|vp( of)? engineering|director of (software )?engineering|cto|chief technology officer"
    ),
  ],
]
function familiesOf(title: string) {
  const value = normalize(title)
  return roleFamilies.filter(([, cue]) => cue.test(value)).map(([name]) => name)
}
function relatedRole(title: string, target: string) {
  const a = roleTitle(title),
    b = roleTitle(target)
  if (contains(a, b)) return true
  const targetFamilies = familiesOf(target)
  if (targetFamilies.length) {
    const jobFamilies = familiesOf(title)
    if (targetFamilies.some((family) => jobFamilies.includes(family)))
      return true
  }
  const software =
    /\b(software|fullstack|frontend|backend|web|mobile|application)\s+(engineer|developer|programmer|architect)\b/
  if (!software.test(b)) return false
  if (software.test(a) && (/\bsoftware\b/.test(a) || /\bsoftware\b/.test(b)))
    return true
  // Common software titles that do not say "software engineer" outright.
  return (
    /\b(software\s+dev(elopment)?\s+engineer|sde|platform engineer)\b/.test(
      a
    ) ||
    /\bmember of technical staff\b/.test(normalize(title)) ||
    /\b(python|java|javascript|typescript|nodejs|golang|go|ruby|rails|react|net|kotlin|scala|php|ios|android)\s+engineer\b/.test(
      a
    )
  )
}
function contains(text: string, phrase: string) {
  const escaped = normalize(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}\\p{M}+#])${escaped}(?=$|[^\\p{L}\\p{N}\\p{M}+#])`,
    "iu"
  ).test(text)
}

const juniorTitle =
  /\b(junior|jr|intern|internship|graduate|apprentice|apprenticeship|working[ -]student|entry[ -]level|new[ -]grad|fresher|trainee)\b/i
const seniorTitle = /\b(lead|senior|sr|staff|principal|head)\b/i

function titleMatch(title: string, targetRoles: readonly string[]) {
  const normalizedTitle = normalize(title)
  const role = targetRoles.find((r) => contains(normalizedTitle, r))
  const related = !role && targetRoles.some((r) => relatedRole(title, r))
  const juniorMismatch =
    juniorTitle.test(title) && targetRoles.some((r) => seniorTitle.test(r))
  return { role, related, juniorMismatch }
}

/**
 * Title gate usable before loading description evidence. A title naming one of
 * the candidate's own tools ("Talend Developer", "Databricks Data Engineer") is
 * worth scoring in full even when it names no target role.
 */
export function relevantJobTitle(
  title: string,
  targetRoles: readonly string[],
  skills: readonly string[] = []
) {
  const { role, related, juniorMismatch } = titleMatch(title, targetRoles)
  if (juniorMismatch) return false
  if (role || related) return true
  const normalizedTitle = normalize(title)
  return skills.some((skill) => contains(normalizedTitle, skill))
}

// A posting may sit this far below or above the candidate's years and still show.
const TOO_JUNIOR_YEARS = 4
const SKILLS_FOR_FULL_CREDIT = 6
// A posting built on the candidate's own stack is relevant without a title
// match: several named tools, or a few with one in the title itself.
const SKILLS_FOR_FIT = 4
const SKILLS_FOR_TITLE_FIT = 3
const TOO_SENIOR_YEARS = 1
const OPEN_RANGE_YEARS = 2

// Only treat explicit lists of skill names as hard requirements. Requirements
// with alternatives or prose need interpretation that this scorer cannot do.
function requiredSkills(description: string) {
  return description.split(/\r?\n/).flatMap((line) => {
    const list =
      /^\s*[-*•]?\s*(?:required|must[ -]have) skills\s*:\s*(.+?)\s*\.?\s*$/i.exec(
        line
      )?.[1]
    if (
      !list ||
      /\b(?:or|and|either|years?|experience|proficiency)\b|\//i.test(list)
    )
      return []
    const names = list.split(",").map((name) => name.trim())
    return names.every((name) =>
      /^[\p{L}\p{N}.+#][\p{L}\p{N}.+# -]{0,59}$/u.test(name)
    )
      ? names
      : []
  })
}

const officeCues = [
  /\b(\d|one|two|three|four|five)\s+days?\s+(a|per)\s+week\s+(in\s+(the\s+)?office|on[- ]?site)\b/i,
  /(?<!\bremote\s*(?:or|and|\/)\s*)\bhybrid\s+(role|position|working|work\s+model|schedule|arrangement)\b/i,
  /\bmust be (on[- ]?site|in (the )?office)\b/i,
  /\boffice-based\b/i,
  /\bin-office\b/i,
]
const residencyCues = [
  /\b(?:must|need to|required to|should)\s+(?:be\s+)?(?:based|located|resid(?:e|ing)|living|live)\s+in\b/i,
  /\b(?:authori[sz]ed|eligible|permitted)\s+to\s+work\s+in\b/i,
  /\bright\s+to\s+work\s+in\b/i,
  /\b(?:US|U\.S\.|USA|UK|EU|Canada|Germany|Netherlands)[\s-]+(?:only|based|residents?)\b/i,
  /\bremote\s*(?:\(|-|–|,)\s*(?:US|U\.S\.|USA|UK|EU|Europe|Canada|Germany|Netherlands|United States)\b/i,
]

function residencyRequired(job: Pick<Job, "title" | "description">) {
  const text = `${job.title}\n${job.description ?? ""}`
  return (
    residencyCues.some((cue) => cue.test(text)) ||
    /\b(?:US|USA|UK|EU)\s+(?:East|West|Central)\b/i.test(job.title)
  )
}

function workMode(job: Pick<Job, "remote" | "description">) {
  return job.remote === "remote" &&
    officeCues.some((cue) => cue.test(job.description ?? ""))
    ? "hybrid"
    : job.remote
}

const yearsStated =
  /\b(\d{1,2})\s*(?:\+|(?:-|–|—|to)\s*(\d{1,2})\+?)?\s*years?'?\s+(?:of\s+)?(?:(?:professional|relevant|work)\s+)?experience\b/i
const requirementCue =
  /\b(you|your|candidates?|applicants?|require(d|s|ments?)?|must|minimum|at least|qualifications?|need(s|ed)?|should have|ideally|proven)\b/i
const companyCue = /\b(we|our|company|founded|brings|has over)\b/i
const requirementHeading =
  /\b(requirements|qualifications|what you('|’)ll (need|bring)|who you are|about you)\b/i
const sectionHeading = /^\s*(#+\s*.*|[^.!?]{1,80}:)\s*$/

/** The posting commits to sponsorship, or is silent and the employer is a registered sponsor. */
export function sponsorEvidence(
  job: Pick<Job, "visaSignal" | "sponsorVerified">
) {
  return (
    job.visaSignal === "confirmed" ||
    job.visaSignal === "strong" ||
    (job.visaSignal === "possible" && job.sponsorVerified)
  )
}

/** Posting experience band from stated requirements, else inferred from the title. */
function experienceBand(job: Pick<Job, "title" | "description">) {
  let inRequirements = false
  for (const line of (job.description ?? "").split(/\r?\n/)) {
    if (requirementHeading.test(line) && line.trim().length <= 80)
      inRequirements = true
    else if (sectionHeading.test(line)) inRequirements = false
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const stated = sentence.match(yearsStated)
      if (
        stated &&
        !companyCue.test(sentence) &&
        (inRequirements || requirementCue.test(sentence))
      )
        return {
          min: Number(stated[1]),
          max: stated[2] ? Number(stated[2]) : null,
          stated: true,
        }
    }
  }
  // "Staff Nurse" is an ordinary grade; only technical staff titles are senior.
  if (
    /\b(principal|lead|head)\b|\bstaff\s+(\w+\s+)?(engineer|developer|scientist|architect|designer)\b/i.test(
      job.title
    )
  )
    return { min: 8, max: null, stated: false }
  if (/\b(senior|sr)\b/i.test(job.title))
    return { min: 5, max: null, stated: false }
  if (juniorTitle.test(job.title)) return { min: 0, max: 2, stated: false }
  return null
}

export function matchJob(
  job: Job,
  profile: Candidate,
  relevantOverride?: boolean
): Match {
  const reasons: string[] = [],
    gaps: string[] = []
  let score = 0
  const description = normalize(job.description ?? "")
  const normalizedTitle = normalize(job.title)
  const hasResumeAnalysis = profile.resumeInsights !== undefined
  const country = profile.targetCountries.some((c) => c === job.country)
  const remote = workMode(job)
  if (!country) gaps.push("Outside your target countries")
  const locations = (profile.targetLocations ?? []).filter(
    (place) => place.country === job.country
  )
  const city = normalizedLocation(job.city ?? "")
  const cityDetail = ` ${city} `
    .replace(` ${normalizedLocation(job.country)} `, " ")
    .replace(/\b(remote|anywhere|nationwide|worldwide|hybrid)\b/g, "")
    .trim()
  const cityKnown = Boolean(
    cityDetail && countryName(job.city ?? "") !== job.country
  )
  const matchingCities = locations.filter((place) =>
    ` ${city} `.includes(` ${normalizedLocation(place.name)} `)
  )
  const regionUnknown =
    cityKnown &&
    matchingCities.some(
      (place) =>
        place.region &&
        !` ${city} `
          .replace(` ${normalizedLocation(place.name)} `, " ")
          .replace(` ${normalizedLocation(job.country)} `, " ")
          .trim()
    )
  const locationMatch =
    !locations.length ||
    (cityKnown &&
      matchingCities.some(
        (place) =>
          !place.region ||
          ` ${city} `.includes(` ${normalizedLocation(place.region)} `)
      ))
  if (locations.length) {
    if (!cityKnown)
      gaps.push(
        "City not stated; confirm whether this job supports your selected locations"
      )
    else if (locationMatch) reasons.push(`Preferred location: ${job.city}`)
    else if (regionUnknown)
      gaps.push("City matches; confirm the regional location")
    else if (remote !== "remote") gaps.push("Outside your selected locations")
  }
  const excluded = profile.excludedCompanies.some(
    (c) => c.toLowerCase() === job.company.trim().toLowerCase()
  )
  if (excluded) gaps.push("Company is on your exclusion list")
  const { role, related, juniorMismatch } = titleMatch(
    job.title,
    profile.targetRoles
  )
  if (role) {
    score += 35
    reasons.push(`Title matches ${role}`)
  } else gaps.push("Title does not explicitly match your target roles")
  if (related) {
    score += 30
    reasons.push("Related role in your target profession")
  }
  const skillTerms = new Map(
    profile.skills.map((skill) => [normalize(skill), skill])
  )
  const skills = [...skillTerms.values()].filter(
    (skill) =>
      contains(description, skill) ||
      (!hasResumeAnalysis && contains(normalizedTitle, skill))
  )
  // Skills rank jobs within a candidate's profession; shared tools alone do not
  // establish that civil, nursing, sales or software roles are interchangeable.
  const softwareRole = isSoftwareRole(job.title, job.description)
  const category = classifyJobCategory(job.title, job.description)
  const inScope =
    category !== null &&
    (profile.jobCategories ?? ["software"]).includes(category)
  const titleSkillFit =
    skills.length >= SKILLS_FOR_TITLE_FIT &&
    skills.some((skill) => contains(normalizedTitle, skill))
  const skillFit = skills.length >= SKILLS_FOR_FIT || titleSkillFit
  const jobFamilies =
    hasResumeAnalysis && softwareRole ? familiesOf(job.title) : []
  const targetFamilies = jobFamilies.length
    ? profile.targetRoles.flatMap(familiesOf)
    : []
  const specializationConflict =
    targetFamilies.length > 0 &&
    !jobFamilies.some((family) => targetFamilies.includes(family))
  const missingSkills = hasResumeAnalysis
    ? requiredSkills(job.description ?? "").filter(
        (skill) => !skillTerms.has(normalize(skill))
      )
    : []
  const resumeFit =
    !specializationConflict &&
    missingSkills.length === 0 &&
    skills.length > 0 &&
    (role !== undefined || related)
  const relevant =
    inScope &&
    (hasResumeAnalysis
      ? resumeFit
      : (relevantOverride ?? Boolean(role || related || skillFit))) &&
    !juniorMismatch
  if (!inScope) gaps.push("Outside your selected job categories")
  else if (hasResumeAnalysis && specializationConflict)
    gaps.push("Posting is in a different software specialization")
  else if (hasResumeAnalysis && !skills.length)
    gaps.push("Job description does not establish a match with your skills")
  else if (relevant && !role && !related)
    reasons.push(
      softwareRole ? "Built on your stack" : "Matches your listed skills"
    )
  if (missingSkills.length)
    gaps.push(
      `Required skills missing from your profile: ${missingSkills.join(", ")}`
    )
  if (juniorMismatch) gaps.push("Role level is below your selected seniority")
  // A posting names a handful of tools; long skill lists must not cap the score.
  if (skillTerms.size)
    score += Math.round(
      (45 * Math.min(skills.length, SKILLS_FOR_FULL_CREDIT)) /
        Math.min(skillTerms.size, SKILLS_FOR_FULL_CREDIT)
    )
  if (skills.length) reasons.push(`Listed skills: ${skills.join(", ")}`)
  if (!job.description)
    gaps.push(
      "Full job description unavailable; skill and experience fit is incomplete"
    )
  // Remote work from the candidate's own country needs no visa, unless the
  // posting ties the role to living or being authorised in its country.
  const remoteFromHome =
    profile.remoteFromHome === true &&
    remote === "remote" &&
    job.visaSignal !== "no" &&
    !residencyRequired(job)
  const needsVisa = !remoteFromHome && visaNeeded(profile)(job.country)
  const visa = sponsorEvidence(job)
  if (remoteFromHome && visaNeeded(profile)(job.country)) {
    score += 10
    reasons.push("Remote from your country, so no visa is needed")
  } else if (!needsVisa) score += 10
  else if (visa) {
    score += 10
    reasons.push(
      job.visaSignal === "possible"
        ? "Employer is a registered visa sponsor"
        : `Sponsorship signal: ${job.visaSignal}`
    )
  } else
    gaps.push(
      job.visaSignal === "no"
        ? "Posting explicitly rules out sponsorship"
        : "Sponsorship needs confirmation"
    )
  if (profile.sponsorshipRequired === null)
    gaps.push("Your sponsorship needs are not specified")
  // An unstated arrangement is shown for review, but a remote-only candidate
  // is never auto-applied to it.
  const remoteOnly = profile.workModes.join() === "remote"
  const mode = remote === "unknown" || profile.workModes.includes(remote)
  if (remote === "unknown" && remoteOnly)
    gaps.push("Work arrangement is not stated; confirm the role is remote")
  else if (remote === "unknown" && profile.workModes.length < 3)
    gaps.push("Work arrangement is not stated")
  else if (!mode)
    gaps.push(`Work mode (${remote}) does not match your preferences`)
  const band = experienceBand(job)
  const years = profile.experienceYears
  let experience = true
  if (band && years === null)
    gaps.push(
      "Your experience duration is not established; check this requirement"
    )
  if (band && years !== null) {
    const upper = band.max ?? band.min + OPEN_RANGE_YEARS
    const label =
      band.max === null ? `at least ${band.min}` : `${band.min}–${band.max}`
    // A stated "N+ years" is the role's level; title-inferred levels are open-ended.
    const ceiling = band.max ?? (band.stated ? band.min : null)
    if (ceiling !== null && ceiling < years - TOO_JUNIOR_YEARS) {
      experience = false
      gaps.push(`Role level (${label} years) is well below your experience`)
    } else if (
      band.min >
      years + (hasResumeAnalysis && band.stated ? 0 : TOO_SENIOR_YEARS)
    ) {
      experience = false
      gaps.push(`Posting asks for ${label} years of experience`)
    } else {
      const distance =
        years < band.min ? band.min - years : Math.max(0, years - upper)
      score += Math.max(0, 10 - 2 * distance)
      if (!distance) reasons.push("Experience fits the posting")
    }
  }
  const reviewable =
    relevant &&
    country &&
    (remote === "remote" || !cityKnown || regionUnknown || locationMatch) &&
    !excluded &&
    mode &&
    experience &&
    !(needsVisa && job.visaSignal === "no")
  return {
    softwareRole,
    category,
    inScope,
    score,
    reasons,
    gaps,
    relevant,
    reviewable,
    eligible:
      reviewable &&
      (locationMatch || remote === "remote") &&
      !(remote === "unknown" && remoteOnly) &&
      (!needsVisa || visa),
  }
}
