import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { parseEnv } from "node:util"
import { createClient } from "@supabase/supabase-js"
import { isSoftwareRole, softwareRoleTitleScope } from "../../lib/jobs/software-roles"
import { hydrateCatalogDescriptions } from "../../lib/server/catalog/content"
import { assertStagingTarget } from "../lib/staging.mjs"

// Preview only: no remote mutation. Public listing backups and the exact removal
// plan are private local files. Applying SQL is a separate explicit operator step.
if (!process.argv.includes("--staging")) throw new Error("Use --staging")
const env = parseEnv(await readFile(".env.staging.local", "utf8"))
const config = JSON.parse(await readFile("staging/project.json", "utf8"))
const ref = assertStagingTarget(config, env)
const local = parseEnv(await readFile(".env.local", "utf8"))
if (local.NEXT_PUBLIC_SUPABASE_URL !== env.NEXT_PUBLIC_SUPABASE_URL)
  throw new Error("The application and staging database targets differ")
const db = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: (url, init) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(30000) }),
    },
  }
)
const output = process.argv[process.argv.indexOf("--output") + 1]
if (!process.argv.includes("--output") || !output?.startsWith(".local-data/"))
  throw new Error("Provide a new --output .local-data/<name>.json")
await mkdir(".local-data", { recursive: true })
const measuredAt = new Date().toISOString()
type Row = {
  id: string
  title: string
  description: string
  description_ref?: unknown
  url: string
  [key: string]: unknown
}
const excluded: Row[] = [],
  staged: { run_id: string; id: string; data: Row }[] = []
const catalog: Row[] = [],
  pending: typeof staged = []
let scanned = 0,
  scannedStaged = 0,
  after: string | null = null,
  hydrated = 0
async function rejected(rows: Row[]) {
  const ambiguous = rows.filter(
    (row) => softwareRoleTitleScope(row.title) === "needs_description"
  )
  const hydratedRows = await hydrateCatalogDescriptions(
    db,
    ambiguous as Parameters<typeof hydrateCatalogDescriptions>[1]
  )
  hydrated += ambiguous.length
  let index = 0
  return rows.filter((row) => {
    const description =
      softwareRoleTitleScope(row.title) === "needs_description"
        ? hydratedRows[index++].description
        : row.description
    return !isSoftwareRole(row.title, description)
  })
}
for (;;) {
  let query = db
    .from("job_catalog")
    .select("*")
    .lte("discovered_at", measuredAt)
    .order("id")
    .limit(1000)
  if (after) query = query.gt("id", after)
  const result = await query
  if (result.error)
    throw new Error(`Catalogue scan failed (${result.error.code})`)
  const rows = result.data as Row[]
  if (!rows.length) break
  catalog.push(...rows)
  scanned += rows.length
  after = rows.at(-1)!.id
  if (scanned % 10000 === 0)
    console.log(
      JSON.stringify({ scanned, excluded: excluded.length, hydrated })
    )
}
console.log(JSON.stringify({ scanned, phase: "description_evidence" }))
excluded.push(...(await rejected(catalog)))
for (let offset = 0; ; offset += 1000) {
  const result = await db
    .from("job_catalog_run_items")
    .select("run_id,id,data")
    .order("run_id")
    .order("id")
    .range(offset, offset + 999)
  if (result.error) throw new Error(`Staged scan failed (${result.error.code})`)
  if (!result.data.length) break
  const rows = result.data as typeof staged
  pending.push(...rows)
  scannedStaged += rows.length
}
const rejectedStaged = new Set(await rejected(pending.map((row) => row.data)))
staged.push(...pending.filter((row) => rejectedStaged.has(row.data)))
const references = await Promise.all([
  db.from("account_job_states").select("job_id,status"),
  db.from("resume_drafts").select("id,job_id"),
  db.from("application_runs").select("id,job_id,target_url"),
])
if (references.some((r) => r.error))
  throw new Error("Cannot verify account history references")
const states = references[0].data!
const drafts = references[1].data!
const applications = references[2].data!
const protectedIds = new Set([
  ...states
    .filter((r) => ["interested", "applied"].includes(r.status))
    .map((r) => r.job_id),
  ...drafts.map((r) => r.job_id),
  ...applications.map((r) => r.job_id),
])
const protectedUrls = new Set(applications.map((r) => r.target_url))
const protectedRows = excluded.filter(
  (row) => protectedIds.has(row.id) || protectedUrls.has(row.url)
)
const titles = new Map<string, number>()
for (const row of excluded)
  titles.set(row.title, (titles.get(row.title) ?? 0) + 1)
const summary = {
  projectRef: ref,
  measuredAt,
  scanned,
  excluded: excluded.length,
  scannedStaged,
  excludedStaged: staged.length,
  hydrated,
  protectedExcluded: protectedRows.length,
  protectedTitles: protectedRows.map((row) => ({
    id: row.id,
    title: row.title,
  })),
  topExcludedTitles: [...titles].sort((a, b) => b[1] - a[1]).slice(0, 25),
  referenceCounts: {
    states: states.length,
    drafts: drafts.length,
    applications: applications.length,
  },
  historyFingerprint: createHash("sha256")
    .update(JSON.stringify(references.map((r) => r.data)))
    .digest("hex"),
  policyHash: createHash("sha256")
    .update(await readFile("lib/jobs/software-roles.ts"))
    .digest("hex"),
}
await writeFile(
  output,
  JSON.stringify({ summary, excluded, staged }, null, 2),
  { mode: 0o600, flag: "wx" }
)
console.log(JSON.stringify({ ...summary, backup: output }, null, 2))
