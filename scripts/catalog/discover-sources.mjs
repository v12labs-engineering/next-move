import { validSourceId } from "../../lib/server/catalog/source-identity.ts"
import {
  discoverEmployerLinks,
  linkDiscoveryOrigin,
} from "../../lib/server/catalog/discovery/links.ts"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CandidateStore } from "../../lib/server/catalog/discovery/store.ts"
import {
  archiveResume,
  discoverArchivePage,
} from "../../lib/server/catalog/discovery/archive.ts"
import {
  downloadDirectory,
  seedDirectories,
} from "../../lib/server/catalog/discovery/seeds.ts"
import { scanCatalog } from "../../lib/server/catalog/read.ts"
import { redact } from "../lib/staging.mjs"

const args = process.argv.slice(2)
const [command = "import"] = args
const flags = new Set([
  "--staging",
  "--apply",
  "--recheck",
  "--limit",
  "--ids",
  "--note",
  "--output",
  "--directory",
  "--file",
  "--partition",
  "--index",
  "--page",
  "--resume",
])
for (let i = 1; i < args.length; i++) {
  if (!flags.has(args[i])) throw new Error("Unknown source-discovery option")
  if (!["--staging", "--apply", "--recheck"].includes(args[i])) i++
}
function value(flag) {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`${flag} requires a value`)
  return args[index + 1]
}
async function main() {
  if (
    ![
      "import",
      "links",
      "archive",
      "validate",
      "activate",
      "expand",
      "status",
    ].includes(command)
  )
    throw new Error(
      "Use import, links, archive, validate, activate, expand or status"
    )
  const apply = args.includes("--apply")
  const archiveFlags = ["--partition", "--index", "--page", "--resume"]
  if (command !== "archive" && archiveFlags.some((flag) => args.includes(flag)))
    throw new Error("Archive cursor options require the archive command")
  const limit = Number(value("--limit") ?? 20)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Limit must be 1–500")
  const ids = value("--ids")?.split(",")
  if (args.includes("--recheck") && (!ids?.length || command !== "validate"))
    throw new Error("--recheck requires explicit candidate IDs for validation")
  if (ids?.some((id) => !validSourceId(id)))
    throw new Error("Invalid candidate IDs")
  if (args.includes("--staging")) {
    const { stagingContext } = await import("../lib/staging.mjs")
    const { env } = await stagingContext()
    for (const [key, entry] of Object.entries(env)) process.env[key] = entry
  }
  let report
  if (command === "archive") {
    if (
      ["--limit", "--ids", "--directory", "--file", "--recheck", "--note"].some(
        (flag) => args.includes(flag)
      )
    )
      throw new Error(
        "Archive reads a complete bounded index page; use --partition, --index, --page or --resume"
      )
    if (apply && !args.includes("--staging"))
      throw new Error(
        "Archive intake currently supports --apply only with --staging"
      )
    const resume = value("--resume")
    let cursor
    if (resume) {
      if (
        ["--partition", "--index", "--page"].some((flag) => args.includes(flag))
      )
        throw new Error("Use either --resume or an explicit archive cursor")
      const bytes = await readFile(resolve(resume))
      if (bytes.length > 4_000_000)
        throw new Error("Archive receipt is too large")
      cursor = archiveResume(JSON.parse(bytes.toString("utf8")), apply)
    } else {
      cursor = {
        partition: value("--partition"),
        index: value("--index"),
        page: Number(value("--page") ?? 0),
      }
    }
    const result = await discoverArchivePage(cursor)
    // Advance only after every import chunk succeeds. Replaying a failed page
    // is safe: the origin and candidate observations are idempotent.
    const persisted =
      apply && result.candidates.length
        ? await new CandidateStore().import(result.origin, result.candidates)
        : null
    report = {
      command,
      applied: apply,
      ...result,
      persisted,
      note: "Archived employer candidates only. Validation, activation and complete live collection are required before publishing jobs.",
    }
  } else if (command === "links") {
    const path = value("--file")
    if (!path)
      throw new Error(
        "links requires --file containing 1–20 HTTPS career URLs, one per line"
      )
    const bytes = await readFile(resolve(path))
    if (bytes.length > 32000) throw new Error("Career URL file is too large")
    const inputs = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
    const result = await discoverEmployerLinks(inputs)
    const origin = linkDiscoveryOrigin(inputs, result.candidates)
    report = {
      command,
      applied: apply,
      ...result,
      origin,
      persisted:
        apply && result.candidates.length
          ? await new CandidateStore().import(origin, result.candidates)
          : null,
      note: "Observed candidates only. Run validation and activation before collection; no vacancies are inferred.",
    }
    if (!result.complete) process.exitCode = 1
  } else if (command === "import") {
    const directoryName = value("--directory")
    if (
      directoryName &&
      !["open-ats-feed", "lastround"].includes(directoryName)
    )
      throw new Error("Unknown pinned directory")
    const directories = seedDirectories.filter(
      (d) => !directoryName || d.format === directoryName
    )
    const store = apply ? new CandidateStore() : null
    const all = new Set(),
      receipts = []
    for (const directory of directories) {
      const parsed = await downloadDirectory(directory)
      for (const candidate of parsed.candidates) all.add(candidate.id)
      const persisted = store
        ? await store.import(directory, parsed.candidates)
        : null
      receipts.push({
        directory: directory.id,
        revision: directory.revision,
        sha256: directory.sha256,
        license: directory.license,
        attribution: directory.attribution,
        attributionUrl: directory.attributionUrl,
        rows: parsed.rows,
        distinctSources: parsed.distinctSources,
        persisted,
      })
      console.error(
        `Directory checked: ${directory.format}${directory.kind ? "/" + directory.kind : ""} (${parsed.rows} historical records)`
      )
    }
    report = {
      command,
      applied: apply,
      distinctSources: all.size,
      receipts,
      note: "Historical candidates only. Import does not enable sources or publish jobs.",
    }
  } else {
    const store = new CandidateStore()
    if (command === "expand") {
      if (ids?.length)
        throw new Error(
          "Expansion selects a balanced due batch; use validate for explicit IDs"
        )
      report = {
        command,
        applied: apply,
        ...(await store.expand({ limit, apply, force: true })),
      }
    } else if (command === "validate") {
      const result = await store.validate({
        limit,
        ids,
        apply,
        recheck: args.includes("--recheck"),
      })
      const counts = {}
      for (const row of result.results) {
        const status = row.result?.status ?? "skipped"
        counts[status] = (counts[status] ?? 0) + 1
      }
      report = { command, applied: apply, ...result, counts }
      if (!result.complete) process.exitCode = 1
    } else if (command === "activate") {
      // Activation is explicit, bounded and requires a fresh persisted validation.
      const selected = await store.list({ limit, ids, status: "verified" })
      if (ids && selected.length !== new Set(ids).size)
        throw new Error(
          "Every requested candidate must have a successful validation"
        )
      const note = value("--note")
      if (apply && (!note || note.trim().length < 10))
        throw new Error(
          "Activation requires --note with the source review decision"
        )
      report = {
        command,
        applied: apply,
        selected: selected.map((c) => c.id),
        sources: apply
          ? await store.activate(
              selected.map((c) => c.id),
              note
            )
          : [],
        note: "Activation enables collection; only a complete successful collection publishes listings.",
      }
    } else {
      const counts = {}
      let total = 0
      await scanCatalog(
        async (after) => {
          let query = store.db
            .from("source_candidates")
            .select("id,status")
            .order("id")
            .limit(500)
          if (after) query = query.gt("id", after)
          const response = await query
          if (response.error) throw response.error
          return response.data
        },
        (page) => {
          for (const row of page) {
            counts[row.status] = (counts[row.status] ?? 0) + 1
            total++
          }
        }
      )
      const origins = await store.db
        .from("source_discovery_origins")
        .select("id,metadata,imported_at")
      if (origins.error) throw origins.error
      report = { command, total, counts, origins: origins.data }
      const batches = await store.db
        .from("source_expansion_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(10)
      if (batches.error) throw batches.error
      report.recentExpansionBatches = batches.data
    }
  }
  report.measuredAt = new Date().toISOString()
  const output = value("--output")
  if (output)
    await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => {
  console.error(
    redact(error?.message ?? "Source discovery failed.", process.env),
    { type: error?.code ?? error?.name ?? "Error" }
  )
  process.exitCode = 1
})
