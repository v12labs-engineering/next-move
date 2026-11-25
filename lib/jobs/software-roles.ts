/** Product scope, independent of any candidate's stack or seniority. */
function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.net\b/g, "dotnet")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const excludedTitle =
  /\b(executive assistant|administrative assistant|personal assistant|assistant to|office of|cto office|chief of staff|sales|pre sales|presales|marketing|recruiter|recruiting|recruitment|talent acquisition|human resources|hr|account executive|account manager|customer success|business development|business analyst|data analyst|data scientist|product manager|product owner|project manager|program manager|scrum master|designer|ux|ui designer|technical writer|support|help desk|service desk|technician|civil|mechanical|electrical|electronics|hardware|construction|manufacturing|industrial|chemical|biomedical|structural|controls engineer|process engineer|data center|datacenter|facilities|field service|content developer|content writer|network engineer|network administrator|system administrator|systems administrator|real estate)\b/

const softwareTitle =
  /\b(swe|sde)\b|\b(software|java|javascript|typescript|python|golang|go|rust|ruby|php|c[+#]{1,2}|dotnet|node\.?js|react|angular|vue|salesforce|sap|front ?end|back ?end|full ?stack|web|mobile|ios|android|firmware|embedded software|game|games|unity|unreal|ai|ml|machine learning|artificial intelligence|llm|data|analytics|etl|elt|databricks|snowflake|spark|pyspark|hadoop|talend|informatica|dbt|airflow|bi|business intelligence|database|cloud|devops|devsecops|site reliability|application security|product security|security software|test automation|automation test|qa automation|quality assurance automation)\s+(\w+\s+){0,2}(engineer|engineering|developer|development|programmer|architect)\b|\bapplications? (developer|development|programmer|architect)\b|\b(devops|devsecops|sre)\b|\b(software|software development)\s+(manager|director|lead|intern|internship)\b|\b(sdet|software development engineer in test)\b/

// These titles span several disciplines. Require description evidence of the
// work itself, rather than the employer being a software company or using Excel.
const ambiguousTitle =
  /\b(cto|chief technology officer|chief technical officer|engineer|engineering|developer|development|programmer|architect|technical lead|tech lead|member of technical staff|mts|technical fellow|engineering fellow|qa|quality assurance|test automation)\b|\b(vp|vice president|head|director|chief) (of )?technology\b/
const softwareWork =
  /\b(software (development|engineering|engineers|systems|products|applications|architecture|delivery|platforms?|teams)|production software|saas platform|develop(ing)? software|build(ing)? (\w+\s+){0,2}(software|apis|data pipelines?)|typescript|javascript|reactjs|react\.js|node\.?js|kubernetes|ci cd|distributed systems|test automation|automated software test(s|ing)?|data pipelines?|etl|data warehous\w*|lakehouse|pyspark|databricks|airflow|dbt|talend|informatica)\b/

// These specialist titles omit "engineer" but can describe application and
// platform implementation. Require work specific to the named discipline;
// employer boilerplate about AI or software does not establish engineering.
const specialistRoles: readonly (readonly [RegExp, RegExp])[] = [
  [
    /\bconsultant\b.*\bdotnet\b|\bdotnet\b.*\bconsultant\b/,
    /\b(?:design|designing|develop|developing)(?: \w+){0,8} applications? (?:using|with) (?:c#(?=\s|$)|dotnet\b|aspdotnet\b)/,
  ],
  [
    /\bconsultant\b.*\bpower platforms?\b|\bpower platforms?\b.*\bconsultant\b/,
    /\bdevelop(?:ing)?(?: \w+){0,10} (?:business solutions|applications|apps) (?:using|with) (?:microsoft )?power platforms?\b|\bbuild(?:ing)?(?: \w+){0,5} (?:applications|apps) (?:using|with) power apps\b/,
  ],
  [
    /\bapplied ai specialist cloud full ?stack\b/,
    /\b(?:design|designing) and (?:build|building) cloud native (?:and hybrid )?applications\b|\b(?:ci cd|gitops) pipelines\b/,
  ],
  [
    /\btechnical consultant ai integration\b/,
    /\bdevelop(?:ing)? connectors\b|\bbuild(?:ing)? (?:retrieval augmented generation )?rag pipelines\b/,
  ],
  [
    /\bpackage consultant sap application extensions\b/,
    /\b(?:rap|abap) programming\b|\bside by side application (?:design and )?development\b/,
  ],
  [
    /\bpackage consultant sap btp\b/,
    /\bconfigur(?:e|ing) and build(?:ing)? (?:solutions leveraging sap ai core|process automation solutions using sap build)\b/,
  ],
  [
    /\bpackage consultant servicenow\b/,
    /\bintegrating servicenow with other systems\b/,
  ],
]

function specialistWork(title: string) {
  if (/\b(functional|finance|financial|accounting)\b/.test(title))
    return undefined
  return specialistRoles.find(([pattern]) => pattern.test(title))?.[1]
}

export function softwareRoleTitleScope(
  title: string
): "included" | "excluded" | "needs_description" {
  const value = normalized(title)
  if (excludedTitle.test(value)) return "excluded"
  if (softwareTitle.test(value)) return "included"
  return ambiguousTitle.test(value) || specialistWork(value)
    ? "needs_description"
    : "excluded"
}

export function isSoftwareRole(title: string, description = ""): boolean {
  const scope = softwareRoleTitleScope(title)
  if (scope !== "needs_description") return scope === "included"
  const evidence = specialistWork(normalized(title)) ?? softwareWork
  return evidence.test(normalized(description))
}

export function isEarlyCareerPosting(title: string) {
  return /\b(intern|internship|apprentice|apprenticeship|graduate|fresher|trainee|entry level|new grad)\b/.test(
    normalized(title)
  )
}
