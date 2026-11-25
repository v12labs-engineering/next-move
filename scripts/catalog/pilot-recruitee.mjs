import { readFile, writeFile } from "node:fs/promises"
import { load } from "cheerio"
import { isSoftwareRole } from "../../lib/jobs/software-roles.ts"

// Evaluate captured public feed evidence without registering unverified sources.
const inputs = JSON.parse(
  await readFile(".local-data/recruitee-pilot-raw.json", "utf8")
)
const now = Date.now()
const rows = inputs.map((input) => {
  const response = input["/api/feeds/offers.xml"]
  if (response?.status !== 200)
    return { host: input.host, status: response?.status }
  const $ = load(response.body, { xml: true })
  if ($("offers").length !== 1) throw new Error("Unexpected feed root")
  const jobs = $("offers > offer")
    .toArray()
    .map((node) => {
      const get = (key) => $(node).children(key).text().trim()
      const description = load(
        get("description") + "\n" + get("requirements")
      ).text()
      const published = get("published_at")
      const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(published)
        ? published.replace(" ", "T").replace(" UTC", "Z")
        : null
      return {
        id: get("id"),
        title: get("title"),
        company: get("company_name"),
        url: get("careers_url"),
        country: get("country_code"),
        publishedAt: date,
        software: isSoftwareRole(get("title"), description),
        descriptionCharacters: description.length,
      }
    })
  const software = jobs.filter((j) => j.software)
  return {
    host: input.host,
    observedOffers: jobs.length,
    softwareOffers: software.length,
    softwarePublished7d: software.filter(
      (j) =>
        j.publishedAt &&
        Date.parse(j.publishedAt) <= now &&
        Date.parse(j.publishedAt) >= now - 7 * 86400000
    ).length,
    softwarePublished30d: software.filter(
      (j) =>
        j.publishedAt &&
        Date.parse(j.publishedAt) <= now &&
        Date.parse(j.publishedAt) >= now - 30 * 86400000
    ).length,
    jobs: software,
  }
})
const report = {
  measuredAt: new Date().toISOString(),
  mode: "captured-public-feed-evaluation",
  note: "Publication time is provider-reported; original versus republication semantics remain unverified. No source activation or catalogue writes.",
  rows,
}
await writeFile(
  ".local-data/recruitee-pilot-report.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 }
)
console.log(JSON.stringify(report, null, 2))
