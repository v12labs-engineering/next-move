import { writeFile } from "node:fs/promises"
import { stagingContext } from "../lib/staging.mjs"
import { supabaseServerClient } from "../../lib/server/supabase-server.ts"
import { scanCatalog } from "../../lib/server/catalog/read.ts"
import { readSourceHealth } from "../../lib/server/catalog/health.ts"
if (process.argv.slice(2).join(" ") !== "--staging")
  throw Error("Use --staging")
const { env } = await stagingContext()
Object.assign(process.env, env)
const db = supabaseServerClient(30_000),
  now = Date.now(),
  providers = new Map()
function provider(id) {
  const kind = id.split(":")[0]
  if (!providers.has(kind))
    providers.set(kind, {
      kind,
      enabledSources: 0,
      failedSources: 0,
      pendingSources: 0,
      neverSuccessful: 0,
      activeLocationRecords: 0,
      urls: new Set(),
      week: new Set(),
      day: new Set(),
      undated: new Set(),
    })
  return providers.get(kind)
}
for (const s of await readSourceHealth(db)) {
  if (!s.enabled) continue
  const p = provider(s.id)
  p.enabledSources++
  p.failedSources += Number(s.failed)
  p.pendingSources += Number(s.pending)
  p.neverSuccessful += Number(!s.last_success_at)
}
await scanCatalog(
  async (after) => {
    let query = db
      .from("job_catalog")
      .select("id,source,url,posted_at")
      .eq("is_active", true)
      .order("id")
      .limit(500)
    if (after) query = query.gt("id", after)
    const r = await query
    if (r.error) throw Error("Catalogue measurement failed")
    return r.data
  },
  (rows) => {
    for (const j of rows) {
      const p = provider(j.source),
        age = now - Date.parse(j.posted_at ?? "")
      p.activeLocationRecords++
      p.urls.add(j.url)
      if (!j.posted_at) p.undated.add(j.url)
      if (age >= 0 && age <= 7 * 86400000) p.week.add(j.url)
      if (age >= 0 && age <= 86400000) p.day.add(j.url)
    }
  }
)
const capacity = await db.rpc("catalog_storage_usage")
if (capacity.error) throw Error("Capacity measurement failed")
const report = {
  measuredAt: new Date(now).toISOString(),
  capacity: capacity.data,
  note: "Distinct exact URLs collapse location variants, not all cross-postings. Counts are observed supply, not personalized matches. Reads are not a transactional snapshot.",
  providers: [...providers.values()].map(
    ({ urls, week, day, undated, ...p }) => ({
      ...p,
      distinctUrls: urls.size,
      posted7dUrls: week.size,
      posted24hUrls: day.size,
      undatedUrls: undated.size,
    })
  ),
}
const output = `.local-data/supply-${Date.now()}.json`
await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ output, ...report }, null, 2))
