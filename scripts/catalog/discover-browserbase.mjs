import { open, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs, parseEnv } from "node:util"
import { discoverWithBrowserbase } from "../../lib/server/catalog/discovery/browserbase.ts"
import { browserbaseCareerRenderer } from "../../lib/server/catalog/discovery/browserbase-render.ts"
import { CandidateStore } from "../../lib/server/catalog/discovery/store.ts"
import { scanCatalog } from "../../lib/server/catalog/read.ts"
import { stagingContext } from "../lib/staging.mjs"
import { worldwideDiscoveryBatch } from "../../lib/server/catalog/discovery/worldwide.ts"

async function main() {
  const { values } = parseArgs({
    options: {
      staging: { type: "boolean" },
      apply: { type: "boolean" },
      queries: { type: "string" },
      worldwide: { type: "boolean" },
      batch: { type: "string" },
      output: { type: "string" },
      "browserbase-env": { type: "string" },
      "max-urls": { type: "string", default: "50" },
      "max-browsers": { type: "string", default: "0" },
      "max-cost-usd": { type: "string", default: "1" },
    },
  })
  if (
    !values.staging ||
    (!values.queries && !values.worldwide) ||
    !values.output
  )
    throw new Error(
      "Use --staging and either --queries <public-query-file> or --worldwide --batch <index>, plus --output <new-private-report.json>; --apply imports candidates only"
    )
  if (
    (values.worldwide && values.queries) ||
    (values.worldwide && values.batch === undefined) ||
    (!values.worldwide && values.batch !== undefined)
  )
    throw new Error("Use a query file or an explicit worldwide batch, not both")
  const scope = values.worldwide
    ? worldwideDiscoveryBatch(Number(values.batch))
    : undefined
  const { env } = await stagingContext()
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  // An alternate paid Browserbase project must never change the staging DB
  // target or import unrelated secrets/settings from a development env file.
  const providerValues = values["browserbase-env"]
    ? parseEnv(await readFile(resolve(values["browserbase-env"]), "utf8"))
    : env
  const browserEnv = {
    BROWSERBASE_API_KEY: providerValues.BROWSERBASE_API_KEY,
    BROWSERBASE_PROJECT_ID: providerValues.BROWSERBASE_PROJECT_ID,
  }
  const bytes = scope
    ? Buffer.from(scope.queries.map((row) => row.query).join("\n"))
    : await readFile(resolve(values.queries))
  if (bytes.length > 10000) throw new Error("Query file exceeds 10 KB")
  const queries = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
  const maxBrowsers = Number(values["max-browsers"])
  // Claim the report filename before billable operations, never overwrite prior
  // evidence. A crash leaves an honest in-progress receipt, not a success claim.
  const output = await open(resolve(values.output), "wx", 0o600)
  try {
    await output.writeFile(
      JSON.stringify({
        status: "started",
        startedAt: new Date().toISOString(),
      }) + "\n"
    )
    const store = new CandidateStore(),
      known = new Set()
    await scanCatalog(
      async (after) => {
        let q = store.db
          .from("job_source_directory")
          .select("id")
          .eq("enabled", true)
          .order("id")
          .limit(500)
        if (after) q = q.gt("id", after)
        const result = await q
        if (result.error)
          throw new Error("Cannot read existing source directory")
        return result.data
      },
      (rows) => {
        for (const row of rows) known.add(row.id)
      }
    )
    const result = await discoverWithBrowserbase(queries, {
      apiKey: browserEnv.BROWSERBASE_API_KEY ?? "",
      knownSourceIds: known,
      maxUrls: Number(values["max-urls"]),
      ...(scope ? { maxUrlsPerQuery: scope.maxUrlsPerQuery } : {}),
      maxBrowsers,
      maxCostUsd: Number(values["max-cost-usd"]),
      ...(maxBrowsers > 0
        ? { render: browserbaseCareerRenderer(browserEnv) }
        : {}),
    })
    const report = {
      status: "discovered",
      applied: false,
      measuredAt: new Date().toISOString(),
      ...result,
      ...(scope
        ? {
            scope: {
              ...scope,
              searchedCountries: scope.countries.filter((country) =>
                scope.queries
                  .filter((row) => row.country === country)
                  .every((row) =>
                    result.origin.searches.some(
                      (search) => search.query === row.query
                    )
                  )
              ),
            },
            origin: { ...result.origin, scope },
          }
        : {}),
      note: "Candidates only. Validate and explicitly activate verified boards before collection. Usage reservations are not measured billing.",
    }
    // Save observations before importing so a persistence failure cannot erase
    // provider usage and already observed candidates from the local receipt.
    await output.truncate(0)
    await output.write(JSON.stringify(report, null, 2) + "\n", 0, "utf8")
    if (values.apply && result.candidates.length) {
      const persisted = await store.import(report.origin, result.candidates)
      await output.truncate(0)
      await output.write(
        JSON.stringify({ ...report, applied: true, persisted }, null, 2) + "\n",
        0,
        "utf8"
      )
    }
    console.log(
      JSON.stringify(
        {
          complete: result.complete,
          candidates: result.candidates.map((c) => c.id),
          usage: result.usage,
          stopReasons: result.stopReasons,
          ...(scope ? { scope: report.scope } : {}),
          applied: !!values.apply && result.candidates.length > 0,
          report: resolve(values.output),
        },
        null,
        2
      )
    )
    if (!result.complete) process.exitCode = 1
  } finally {
    await output.close()
  }
}
main().catch(() => {
  console.error(
    "Browserbase discovery failed. Check configuration and the private report; credentials and provider errors were not printed."
  )
  process.exitCode = 1
})
