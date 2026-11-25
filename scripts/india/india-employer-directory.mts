import { randomUUID } from "node:crypto"
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { parseArgs } from "node:util"
import { load as parseHtml } from "cheerio"
import { z } from "zod"
import { publicApplicationUrl } from "@/lib/applications/url"
import { discoverEmployerLinks } from "@/lib/server/catalog/discovery/links"
import {
  employerCareerLink,
  publishedCareerLinks,
} from "../lib/career-links.mjs"
import {
  probeClient,
  validateCandidate,
} from "@/lib/server/catalog/discovery/validate"
import {
  readEmployerJobMetadata,
  type JobObservation,
} from "../lib/employer-job-metadata.mjs"

const seedDir = new URL("../../deploy/local/india-employers/", import.meta.url)
const dataDir = new URL("../../.local-data/", import.meta.url)
const file = new URL("india-employer-directory.json", dataDir)
const publicUrl = z.string().transform((value, context) => {
  const clean = publicApplicationUrl(value)
  if (!clean) {
    context.addIssue({ code: "custom", message: "Expected a public HTTPS URL" })
    return z.NEVER
  }
  const url = new URL(clean)
  url.hash = ""
  return url.href
})
const observation = z.object({
  name: z.string().trim().min(1).max(300),
  source: z.string().trim().min(1).max(300),
  evidenceUrl: publicUrl,
  region: z.string().trim().min(1).max(300).optional(),
  website: publicUrl.optional(),
  careerUrl: publicUrl.optional(),
  registryId: z.string().trim().min(1).max(80).optional(),
})

const domainLookup = z.object({
  id: z.string(),
  attemptedAt: z.iso.datetime(),
  result: z.enum(["confirmed", "ambiguous", "unresolved"]),
})

type Observation = z.infer<typeof observation>
type Employer = {
  id: string
  name: string
  observations: Observation[]
  checks?: Awaited<ReturnType<typeof checkEmployer>>
  links?: Awaited<ReturnType<typeof locateEmployer>>
  domainLookup?: z.infer<typeof domainLookup>
}
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string", default: "30" },
    cohort: { type: "string" },
  },
})
const [command, extra] = positionals
const limit = Number(values.limit)
if (
  extra ||
  !["build", "scan", "locate", "status"].includes(command) ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 1500
)
  throw new Error(
    "Use build, status, scan, or locate [--limit 1–1500] [--cohort source-name]"
  )

function employerId(name: string) {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(".", "")
    .replace(
      /(?:\s+(?:private|pvt|limited|ltd|llp|inc|incorporated|llc|plc))+\s*$/u,
      ""
    )
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

async function save(employers: Employer[]) {
  await mkdir(dataDir, { recursive: true })
  const next = new URL(`.india-employers-${randomUUID()}.json`, dataDir)
  await writeFile(
    next,
    JSON.stringify({ version: 1, employers }, null, 2) + "\n"
  )
  await rename(next, file)
}

async function load(): Promise<Employer[]> {
  const snapshot = JSON.parse(await readFile(file, "utf8"))
  if (snapshot.version !== 1 || !Array.isArray(snapshot.employers))
    throw new Error("Unexpected India employer directory format")
  return snapshot.employers
}

async function build() {
  let previous: Employer[] = []
  try {
    previous = await load()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const saved = new Map(previous.map((employer) => [employer.id, employer]))
  const grouped = new Map<string, Employer>()
  for (const filename of (await readdir(seedDir))
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const rows = observation
      .array()
      .parse(JSON.parse(await readFile(new URL(filename, seedDir), "utf8")))
    for (const row of rows) {
      const id = employerId(row.name)
      if (!id) throw new Error(`Unusable employer name in ${filename}`)
      const employer = grouped.get(id) ?? {
        id,
        name: row.name,
        observations: [],
      }
      if (
        !employer.observations.some(
          (value) => JSON.stringify(value) === JSON.stringify(row)
        )
      )
        employer.observations.push(row)
      grouped.set(id, employer)
    }
  }
  const employers = [...grouped.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
  const domainResults = new Map<string, z.infer<typeof domainLookup>>()
  try {
    const raw = await readFile(
      new URL("india-employer-domain-probes.json", dataDir),
      "utf8"
    )
    for (const entry of domainLookup.array().parse(JSON.parse(raw)))
      domainResults.set(entry.id, entry)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  for (const employer of employers) {
    employer.domainLookup = domainResults.get(employer.id)
    const old = saved.get(employer.id)
    if (!old) continue
    employer.checks = old.checks
    if (
      JSON.stringify(locateInputs(old)) ===
      JSON.stringify(locateInputs(employer))
    )
      employer.links = old.links
  }
  await save(employers)
  return employers
}

function careerInputs(employer: Employer) {
  const career = employer.observations.flatMap((row) =>
    row.careerUrl ? [row.careerUrl] : []
  )
  const websites = employer.observations.flatMap((row) =>
    row.website ? [row.website] : []
  )
  return [
    ...new Set([
      ...career.filter((url) => !isParkSite(url)),
      ...(employer.links?.careerPages.map((page) => page.url) ?? []),
      ...career.filter(isParkSite),
      ...websites,
    ]),
  ].slice(0, 2)
}

const isParkSite = (target: string) =>
  new URL(target).hostname === "infopark.in"

function locateInputs(employer: Employer) {
  return [
    ...new Set(
      employer.observations.flatMap((row) =>
        [
          row.website,
          row.careerUrl && !isParkSite(row.careerUrl)
            ? row.careerUrl
            : undefined,
        ].filter((url): url is string => Boolean(url))
      )
    ),
  ].slice(0, 3)
}

async function locateEmployer(employer: Employer) {
  const inputs = locateInputs(employer)
  const careerPages = new Map<
    string,
    { url: string; evidenceUrl: string; basis: "seed" | "website_link" }
  >()
  for (const row of employer.observations)
    if (row.careerUrl && !isParkSite(row.careerUrl))
      careerPages.set(row.careerUrl, {
        url: row.careerUrl,
        evidenceUrl: row.evidenceUrl,
        basis: "seed",
      })

  const websites = employer.observations.flatMap((row) =>
    row.website ? [row.website] : []
  )
  const checked = inputs.length
    ? await discoverEmployerLinks(inputs, {
        maxPages: 1,
        maxMs: 12_000,
        sameSiteRedirects: true,
        inspectPage(page, html) {
          const $ = parseHtml(html)
          if (
            /domain (is )?for sale|buy this domain|domain parking/i.test(
              $("title").text()
            )
          )
            throw new Error("Website appears to be a parked domain")
          for (const url of publishedCareerLinks(page, $))
            if (!careerPages.has(url))
              careerPages.set(url, {
                url,
                evidenceUrl: page.href,
                basis: "website_link",
              })
        },
      })
    : null

  const verifiedSites = (checked?.checked ?? []).filter(
    (target) =>
      websites.some(
        (site) =>
          new URL(target).hostname.replace(/^www\./, "") ===
          new URL(site).hostname.replace(/^www\./, "")
      ) &&
      !checked?.errors.some(
        (error) => error.url === target && /parked domain/.test(error.reason)
      )
  )
  return {
    attemptedAt: new Date().toISOString(),
    inputs,
    reachableWebsitePages: verifiedSites,
    careerPages: [...careerPages.values()].slice(0, 12),
    parkCareers: employer.observations.flatMap((row) =>
      row.careerUrl && isParkSite(row.careerUrl) ? [row.careerUrl] : []
    ),
    errors: checked?.errors ?? [],
  }
}

const read = probeClient()
async function checkEmployer(employer: Employer) {
  const inputs = careerInputs(employer)
  const observedCareerLinks = new Set<string>()
  const jobs = new Map<string, JobObservation>()
  const checkTime = new Date()
  function observe(job: JobObservation) {
    jobs.set(job.url, job)
  }
  const inspect = (page: URL, html: string, links: string[]) => {
    for (const job of readEmployerJobMetadata(
      page,
      html,
      employerId,
      employer.id,
      checkTime
    ))
      observe(job)
    for (const link of links)
      if (!inputs.includes(link) && employerCareerLink(page, link))
        observedCareerLinks.add(link)
  }
  const evidence = employer.observations.flatMap((row) =>
    row.source === "Official employer careers" &&
    row.careerUrl &&
    new URL(row.careerUrl).origin === new URL(row.evidenceUrl).origin
      ? [row.evidenceUrl]
      : []
  )
  const first = await discoverEmployerLinks(
    [...new Set([...inputs, ...evidence])].slice(0, 4),
    {
      maxPages: 1,
      maxMs: 12_000,
      inspectPage: inspect,
      sameSiteRedirects: true,
    }
  )
  const follow = [...observedCareerLinks]
    .filter((link) => !first.checked.includes(link))
    .slice(0, 2)
  const second =
    follow.length > 0
      ? await discoverEmployerLinks(follow, {
          maxPages: 1,
          maxMs: 8_000,
          inspectPage: inspect,
          sameSiteRedirects: true,
        })
      : null
  const checked = [...new Set([...first.checked, ...(second?.checked ?? [])])]
  const candidates = new Map(
    [...first.candidates, ...(second?.candidates ?? [])].map((candidate) => [
      candidate.id,
      candidate,
    ])
  )
  const sources = []
  for (const candidate of [...candidates.values()].slice(0, 2)) {
    const result = await validateCandidate(
      { ...candidate, expected_company: employer.name },
      read,
      checkTime,
      AbortSignal.timeout(12_000),
      {
        config:
          candidate.kind === "smartrecruiters" ? { country: "IN" } : undefined,
        observeJobs: (postings) => {
          for (const job of postings)
            if (job.country === "India")
              observe({
                url: job.url,
                title: job.title,
                city: job.city,
                postedAt: job.posted_at,
                method: "ats",
                sourceId: candidate.id,
              })
        },
      }
    )
    sources.push({
      id: candidate.id,
      evidenceUrl: candidate.evidence_url,
      ...result,
    })
  }
  return {
    checkedAt: new Date().toISOString(),
    inputs,
    checked,
    careerLinks: [...observedCareerLinks].slice(0, 15),
    sources,
    jobs: [...jobs.values()],
    errors: [...first.errors, ...(second?.errors ?? [])],
  }
}

async function scan(employers: Employer[]) {
  const expired = Date.now() - 7 * 86_400_000
  const due = employers.filter(
    (employer) =>
      careerInputs(employer).length &&
      (!values.cohort ||
        employer.observations.some((row) => row.source === values.cohort)) &&
      (!employer.checks || Date.parse(employer.checks.checkedAt) < expired)
  )
  due.sort(
    (a, b) =>
      Number(b.observations.some((row) => row.careerUrl)) -
      Number(a.observations.some((row) => row.careerUrl))
  )
  const selected = due.slice(0, limit)
  for (let offset = 0; offset < selected.length; offset += 4) {
    await Promise.all(
      selected.slice(offset, offset + 4).map(async (employer) => {
        employer.checks = await checkEmployer(employer)
      })
    )
    await save(employers)
  }
  return employers
}

async function locate(employers: Employer[]) {
  const due = employers.filter(
    (employer) =>
      !employer.links &&
      locateInputs(employer).length &&
      (!values.cohort ||
        employer.observations.some((row) => row.source === values.cohort))
  )
  const batch = due.slice(0, limit)
  for (let offset = 0; offset < batch.length; offset += 8) {
    await Promise.all(
      batch.slice(offset, offset + 8).map(async (employer) => {
        employer.links = await locateEmployer(employer)
      })
    )
    await save(employers)
    if ((offset + 8) % 40 === 0 || offset + 8 >= batch.length)
      console.error(
        `Career link checks ${Math.min(offset + 8, batch.length)}/${batch.length}`
      )
  }
  return employers
}

async function run() {
  if (command === "status") return load()
  await mkdir(dataDir, { recursive: true })
  const lock = new URL("india-employer-directory.lock", dataDir)
  const handle = await open(lock, "wx")
  try {
    await handle.writeFile(`${process.pid}\n`)
    if (command === "build") return build()
    const employers = await load()
    return command === "locate"
      ? await locate(employers)
      : await scan(employers)
  } finally {
    await handle.close()
    await unlink(lock)
  }
}

const employers = await run()
const cohorts: Record<string, number> = {}
for (const employer of employers)
  for (const source of new Set(employer.observations.map((row) => row.source)))
    cohorts[source] = (cohorts[source] ?? 0) + 1
const seenJobs = new Set(
  employers.flatMap(
    (employer) => employer.checks?.jobs.map((job) => job.url) ?? []
  )
)
console.log(
  JSON.stringify(
    {
      employers: employers.length,
      observations: employers.reduce(
        (total, employer) => total + employer.observations.length,
        0
      ),
      withCareerUrl: employers.filter((employer) =>
        employer.observations.some((row) => row.careerUrl)
      ).length,
      withCompanyWebsite: employers.filter((employer) =>
        employer.observations.some((row) => row.website)
      ).length,
      careerLinkChecks: employers.filter((employer) => employer.links).length,
      websiteNameProbes: employers.filter((employer) => employer.domainLookup)
        .length,
      processedEmployers: employers.filter(
        (employer) => employer.links || employer.domainLookup
      ).length,
      withDirectCareerLink: employers.filter(
        (employer) =>
          employer.links?.careerPages.length ||
          employer.observations.some(
            (row) => row.careerUrl && !isParkSite(row.careerUrl)
          )
      ).length,
      withPublicUrl: employers.filter(
        (employer) => careerInputs(employer).length
      ).length,
      attempted: employers.filter((employer) => employer.checks).length,
      withJobEvidence: employers.filter(
        (employer) => employer.checks?.jobs.length
      ).length,
      distinctObservedIndiaJobUrls: seenJobs.size,
      cohorts,
    },
    null,
    2
  )
)
