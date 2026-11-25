import type { ResumeVariant, TargetCountry } from "@/lib/location/relocation-data"

/**
 * Sharath's candidate profile, distilled from the EU ATS resume. This is the
 * single source of truth used by every job-feed adapter to (a) decide whether a
 * posting is worth keeping and (b) score how well it fits. Keep it in sync with
 * the resume rather than scattering keyword lists across adapters.
 */

/** Senior+ titles only — we never want to surface junior/intern roles. */
const SENIORITY_RE =
  /\b(senior|sr\.?|staff|principal|lead|founding|head of|architect|director of engineering|distinguished)\b/i

/** Titles that disqualify regardless of keywords (wrong discipline/level). */
const NEGATIVE_TITLE_RE =
  /\b(intern|internship|graduate|junior|jr\.?|working student|werkstudent|apprentice|trainee|stage|praktikum|sales|marketing|recruiter|hr |account executive|customer success|support engineer|qa tester|manual test|designer|ux researcher|data entry|bookkeep|accountant|finance manager)\b/i

/** Core stack from the resume — strongest positive signals. */
export const CORE_STACK = [
  "typescript",
  "javascript",
  "react",
  "next.js",
  "nextjs",
  "node",
  "node.js",
  "nodejs",
  "full-stack",
  "fullstack",
  "full stack",
  "frontend",
  "front-end",
  "backend",
  "back-end",
  "platform engineer",
  "platform engineering",
  "software engineer",
  "product engineer",
] as const

/** AI / LLM signals — Sharath's differentiator and top role priority. */
export const AI_SIGNALS = [
  "ai engineer",
  "applied ai",
  "ai systems",
  "llm",
  "genai",
  "gen ai",
  "generative ai",
  "rag",
  "langchain",
  "langgraph",
  "agents",
  "agentic",
  "ml engineer",
  "machine learning engineer",
  "founding engineer",
] as const

/** Secondary stack — supportive, not disqualifying if absent. */
const SECONDARY_STACK = [
  "go",
  "golang",
  "postgres",
  "postgresql",
  "redis",
  "docker",
  "kubernetes",
  "microfrontend",
  "module federation",
  "elasticsearch",
  "mongodb",
  "graphql",
  "rest api",
  "distributed systems",
  "event-driven",
  "real-time",
  "saas",
  "tailwind",
  "angular",
]

export interface ProfileMatch {
  /** Keep the job at all? False = drop it (wrong discipline or too junior). */
  keep: boolean
  /** 0–100 fit score against the profile. */
  fitScore: number
  /** The best-fit resume variant for this role. */
  resumeVariant: ResumeVariant
  /** The normalized role-type label for the UI. */
  roleType: string
  /** Detected seniority for the JobLead record. */
  seniority: "senior" | "staff" | "principal" | "founding" | "lead"
}

function countHits(haystack: string, needles: readonly string[]): number {
  let hits = 0
  for (const n of needles) if (haystack.includes(n)) hits++
  return hits
}

/**
 * Score a posting against Sharath's profile from its title + (optional)
 * description/tags. Engineering-discipline + senior signals are required to
 * keep; AI and core-stack hits drive the score up.
 */
export function matchProfile(
  title: string,
  extra = ""
): ProfileMatch {
  const t = title.toLowerCase()
  const blob = `${t} ${extra.toLowerCase()}`

  const seniorTitle = SENIORITY_RE.test(title)
  const negativeTitle = NEGATIVE_TITLE_RE.test(title)

  const coreHits = countHits(blob, CORE_STACK)
  const aiHits = countHits(blob, AI_SIGNALS)
  const secondaryHits = countHits(blob, SECONDARY_STACK)

  const isEngineering =
    coreHits > 0 ||
    aiHits > 0 ||
    /\b(engineer|developer|swe|software|programmer|architect)\b/i.test(t)

  // Drop: not engineering at all, explicitly junior/wrong-discipline title.
  const keep = isEngineering && !negativeTitle

  // Score: AI is worth the most (top role priority), then core stack, then
  // seniority, then secondary stack. Capped at 100.
  let fitScore = 30
  fitScore += Math.min(aiHits, 3) * 14
  fitScore += Math.min(coreHits, 4) * 8
  fitScore += seniorTitle ? 12 : 0
  fitScore += Math.min(secondaryHits, 4) * 3
  fitScore = Math.min(100, fitScore)

  return {
    keep,
    fitScore,
    resumeVariant: pickResumeVariant(t, aiHits, coreHits),
    roleType: pickRoleType(t, aiHits),
    seniority: pickSeniority(t),
  }
}

function pickResumeVariant(
  t: string,
  aiHits: number,
  coreHits: number
): ResumeVariant {
  if (/\bfounding\b/.test(t)) return "Founding Engineer"
  if (/\b(solutions architect|technical consultant|solution architect|consultant)\b/.test(t)) {
    return "AI Solutions Architect / Technical Consultant"
  }
  if (aiHits > 0 && aiHits >= coreHits) return "Applied AI Engineer"
  return "Staff Product Engineer / Full-Stack"
}

function pickRoleType(t: string, aiHits: number): string {
  if (/\bfounding\b/.test(t)) return "Founding Engineer"
  if (/\bstaff\b/.test(t)) return "Staff Engineer"
  if (/\b(ai engineer|applied ai|ml engineer|machine learning|llm|genai)\b/.test(t) || aiHits >= 2) {
    return "AI / Applied AI Engineer"
  }
  if (/\b(solutions architect|technical consultant|solution architect)\b/.test(t)) {
    return "Solutions Architect / Consultant"
  }
  if (/\b(platform|infrastructure|devops|sre)\b/.test(t)) return "Platform Engineer"
  if (/\b(full-?stack|product engineer)\b/.test(t)) return "Senior Full-Stack / Product Engineer"
  if (/\b(frontend|front-end|react)\b/.test(t)) return "Senior Frontend Engineer"
  if (/\b(backend|back-end|node)\b/.test(t)) return "Senior Backend Engineer"
  return "Senior Software Engineer"
}

function pickSeniority(
  t: string
): "senior" | "staff" | "principal" | "founding" | "lead" {
  if (/\bfounding\b/.test(t)) return "founding"
  if (/\bprincipal|distinguished\b/.test(t)) return "principal"
  if (/\bstaff\b/.test(t)) return "staff"
  if (/\blead|head of\b/.test(t)) return "lead"
  return "senior"
}

/** City/keyword hints mapping a free-text location to a target country. */
export const COUNTRY_LOCATION_HINTS: Record<TargetCountry, string[]> = {
  Germany: ["berlin", "munich", "münchen", "munchen", "hamburg", "frankfurt", "cologne", "köln", "koln", "stuttgart", "düsseldorf", "dusseldorf", "germany", "deutschland"],
  Netherlands: ["amsterdam", "rotterdam", "eindhoven", "utrecht", "the hague", "den haag", "netherlands", "nederland", "holland"],
  Ireland: ["dublin", "cork", "galway", "ireland"],
  Sweden: ["stockholm", "gothenburg", "göteborg", "goteborg", "malmö", "malmo", "sweden", "sverige"],
  Denmark: ["copenhagen", "københavn", "kobenhavn", "aarhus", "denmark", "danmark"],
  Spain: ["madrid", "barcelona", "valencia", "málaga", "malaga", "seville", "spain", "españa", "espana"],
  Portugal: ["lisbon", "lisboa", "porto", "portugal"],
  Poland: ["warsaw", "warszawa", "kraków", "krakow", "wrocław", "wroclaw", "gdańsk", "gdansk", "poznań", "poznan", "poland", "polska"],
  France: ["paris", "lyon", "toulouse", "bordeaux", "nantes", "lille", "france"],
  Finland: ["helsinki", "espoo", "tampere", "finland", "suomi"],
  Australia: ["sydney", "melbourne", "brisbane", "perth", "canberra", "adelaide", "australia"],
  Japan: ["tokyo", "osaka", "fukuoka", "kyoto", "yokohama", "japan"],
  UAE: ["dubai", "abu dhabi", "sharjah", "uae", "united arab emirates"],
}

/** Resolve a free-text location string to a target country, or null. */
export function countryFromLocation(location: string): TargetCountry | null {
  const loc = location.toLowerCase()
  for (const [country, hints] of Object.entries(COUNTRY_LOCATION_HINTS)) {
    if (hints.some((h) => loc.includes(h))) return country as TargetCountry
  }
  return null
}

/** EU/EEA target countries we prioritize for relocation. */
export const EU_COUNTRIES: TargetCountry[] = [
  "Germany",
  "Netherlands",
  "Ireland",
  "Sweden",
  "Denmark",
  "Spain",
  "Portugal",
  "Poland",
  "France",
  "Finland",
]
