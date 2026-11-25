import {
  fetchLinkedInPage,
  linkedinQuerySchema,
} from "../lib/server/catalog/linkedin.ts"
import { supabaseServerClient } from "../../lib/server/supabase-server.ts"
import { redact } from "../lib/staging.mjs"

const args = process.argv.slice(2)
function value(flag) {
  const i = args.indexOf(flag)
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) return undefined
  return args[i + 1]
}
async function main() {
  for (let i = 0; i < args.length; i++) {
    if (["--staging", "--apply"].includes(args[i])) continue
    if (
      !["--keywords", "--location", "--country"].includes(args[i]) ||
      !value(args[i])
    )
      throw new Error(
        "Use --keywords, --country, optional --location, --staging and --apply"
      )
    i++
  }
  const query = linkedinQuerySchema.parse({
    keywords: value("--keywords"),
    country: value("--country"),
    location: value("--location") ?? value("--country"),
  })
  if (!value("--location")) query.location = query.country
  const apply = args.includes("--apply")
  if (apply && !args.includes("--staging"))
    throw new Error("--apply requires the verified --staging target")
  const source = {
    id: "linkedin",
    kind: "linkedin",
    company: "LinkedIn public jobs",
    board: null,
    config: { queries: [query] },
  }
  // Preview is read-only: never insert a successful-looking result on failure.
  const preview = await fetchLinkedInPage(source, 1)
  let registered = false
  if (apply) {
    if (!preview.jobs.length)
      throw new Error(
        "No usable public listings were observed; source was not enabled"
      )
    const { stagingContext } = await import("../lib/staging.mjs")
    const { env } = await stagingContext()
    for (const [key, value] of Object.entries(env)) process.env[key] = value
    const result = await supabaseServerClient().rpc(
      "configure_linkedin_source",
      { p_query: query }
    )
    if (result.error) throw result.error
    registered = true
  }
  console.log(
    JSON.stringify(
      {
        query,
        registered,
        published: false,
        observed: preview.jobs.length,
        requests: preview.requests,
        samples: preview.jobs
          .slice(0, 5)
          .map(({ title, company, country, url, posted_at }) => ({
            title,
            company,
            country,
            url,
            postedAt: posted_at,
          })),
        note: "Public search observations only. Registration enables later scheduled collection; preview does not publish jobs.",
      },
      null,
      2
    )
  )
}
main().catch((error) => {
  console.error(
    redact(error?.message ?? "LinkedIn collection failed", process.env)
  )
  process.exitCode = 1
})
