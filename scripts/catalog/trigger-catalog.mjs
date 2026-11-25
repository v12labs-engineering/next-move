import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

/** Trigger ingestion without granting the runner database access. */
export async function triggerCatalog(secret, transport = fetch) {
  const config = JSON.parse(
    await readFile(new URL("../../staging/project.json", import.meta.url), "utf8")
  )
  if (
    config.environment !== "staging" ||
    config.appUrl !== "https://job-search-chi-amber.vercel.app"
  )
    throw new Error(
      "The manifest does not identify the approved staging collector."
    )
  if (!secret || secret.length < 32)
    throw new Error("The collector trigger secret is not configured.")
  const deadline = Date.now() + 300000
  const expansionBatches = []
  for (let attempt = 0; attempt < 10; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining < 65000) break
    const response = await transport(
      new URL("/api/catalog/sync", config.appUrl),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(270000, remaining)),
      }
    )
    if (!response.ok) throw new Error(`Collector HTTP ${response.status}`)
    const result = await response.json()
    if (result.expansion?.batchId) expansionBatches.push(result.expansion)
    if (
      result.accepted === true &&
      result.complete === false &&
      result.ok === true &&
      typeof result.refresh?.id === "string" &&
      ["queued", "running"].includes(result.refresh.status)
    )
      return { ...result, batches: attempt + 1, expansionBatches }
    if (
      typeof result.ok !== "boolean" ||
      typeof result.complete !== "boolean" ||
      !Array.isArray(result.results)
    )
      throw new Error("Unexpected collector response.")
    if (result.ok && result.complete)
      return { ...result, batches: attempt + 1, expansionBatches }
    // Continue checkpointed batches, never retry errors, active leases or backoff.
    if (
      !result.ok ||
      (!result.results.some((source) => source.pending) &&
        !(
          Number.isSafeInteger(result.remainingSources) &&
          result.remainingSources > 0
        )) ||
      result.results.some(
        (source) =>
          source.error ||
          source.reason === "backoff" ||
          source.reason === "leased"
      )
    )
      break
  }
  throw new Error(
    "Collection is unfinished; inspect source status and retry/backoff in staging."
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  triggerCatalog(process.env.JOB_CATALOG_TRIGGER_SECRET)
    .then((result) => {
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            complete: result.complete,
            batches: result.batches,
            sources: result.enabledSources,
            results: result.results.map(
              ({ source, count, skipped, reason }) => ({
                source,
                count,
                skipped,
                reason,
              })
            ),
            ...(result.expansion ? { expansion: result.expansion } : {}),
            expansionBatches: result.expansionBatches,
            ...(result.accepted
              ? { accepted: true, refresh: result.refresh }
              : {}),
          },
          null,
          2
        )
      )
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
