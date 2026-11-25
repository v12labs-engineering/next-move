/**
 * Heuristic software/tech classifier.
 *
 * Official sponsor registers (e.g. ~3000 IND recognised sponsors) are mostly
 * NOT software companies — they include banks, hospitals, universities, staffing
 * agencies, machine factories, etc. This narrows a register down to the
 * companies worth crawling for engineering roles.
 *
 * Heuristic-only for now (name + optional website). An LLM second pass can be
 * layered on later for the ambiguous middle.
 */

const SOFTWARE_NAME_SIGNALS = [
  "software",
  "tech",
  "technolog",
  "digital",
  "data",
  "cloud",
  "cyber",
  "ai ",
  " ai",
  "artificial intelligence",
  "machine learning",
  "analytics",
  "platform",
  "systems",
  "solutions",
  "labs",
  "studio",
  "app",
  "web",
  "internet",
  "online",
  "saas",
  "fintech",
  "payments",
  "e-commerce",
  "ecommerce",
  "robotics",
  "automation",
  "computing",
  "interactive",
  "media",
  "games",
  "gaming",
  "network",
  "telecom",
  "semiconductor",
  "engineering",
  "developer",
  "devops",
]

/** Strong negatives: almost never a software product company we'd target. */
const NON_SOFTWARE_SIGNALS = [
  "machinefabriek",
  "staalbouw",
  "bouwbedrijf",
  "ziekenhuis",
  "hospital",
  "clinic",
  "kliniek",
  "university",
  "universiteit",
  "universitair",
  "hogeschool",
  "college",
  "school",
  "gemeente",
  "ministerie",
  "stichting",
  "foundation",
  "kerk",
  "church",
  "restaurant",
  "horeca",
  "hotel",
  "catering",
  "transport",
  "logistiek",
  "shipping",
  "maritime",
  "agro",
  "farm",
  "boerderij",
  "tuinbouw",
  "bakkerij",
  "slagerij",
  "bank",
  "verzekering",
  "insurance",
  "notaris",
  "advocaten",
  "law firm",
  "accountant",
  "uitzendbureau", // staffing agency
  "recruitment",
  "staffing",
  "detachering",
  "schoonmaak", // cleaning
  "beveiliging", // security guards
  "construction",
  "aannemers",
  "installatie",
  "elektro",
  "loodgieter",
  "garage",
  "autobedrijf",
  "supermarkt",
  "retailwinkel",
  "apotheek",
  "pharmacy",
  "tandarts",
  "fysio",
]

/** Domain-level signals (when a website is known). */
const SOFTWARE_TLDS = [".io", ".ai", ".dev", ".tech", ".app", ".cloud", ".software"]
const ATS_HOST_SIGNALS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "smartrecruiters.com",
  "teamtailor.com",
  "recruitee.com",
  "personio.com",
]

export interface SoftwareVerdict {
  isSoftware: boolean
  score: number
  reasons: string[]
}

export function classifyCompany(name: string, website?: string): SoftwareVerdict {
  const reasons: string[] = []
  let score = 0

  const haystack = ` ${name.toLowerCase()} `

  for (const signal of NON_SOFTWARE_SIGNALS) {
    if (haystack.includes(signal)) {
      reasons.push(`name:-${signal.trim()}`)
      score -= 4
    }
  }

  for (const signal of SOFTWARE_NAME_SIGNALS) {
    if (haystack.includes(signal)) {
      reasons.push(`name:+${signal.trim()}`)
      score += 3
    }
  }

  if (website) {
    const host = safeHost(website)
    if (host) {
      for (const tld of SOFTWARE_TLDS) {
        if (host.endsWith(tld)) {
          reasons.push(`tld:+${tld}`)
          score += 4
        }
      }
      for (const ats of ATS_HOST_SIGNALS) {
        if (host.includes(ats) || website.toLowerCase().includes(ats)) {
          reasons.push(`ats:+${ats}`)
          score += 3
        }
      }
    }
  }

  return { isSoftware: score > 0, score, reasons }
}

export function isSoftwareCompany(name: string, website?: string): boolean {
  return classifyCompany(name, website).isSoftware
}

function safeHost(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).host.toLowerCase()
  } catch {
    return null
  }
}
