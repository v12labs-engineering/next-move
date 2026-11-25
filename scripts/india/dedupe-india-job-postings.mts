import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { normalizedPosting } from "../lib/registry-job-postings.mjs"

export type IndiaJobObservation = {
  kind: "portal" | "monitored"
  id: string
  source: string
  url: string
  title: string
  company: string
  location: string | null
  postedAt: string | null
  description: string
}

function words(value: string) {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

function phrases(value: string) {
  const tokens = words(value)
  return new Set(
    tokens
      .slice(0, -4)
      .map((_, index) => tokens.slice(index, index + 5).join(" "))
  )
}

function sameSyndicatedPosting(a: IndiaJobObservation, b: IndiaJobObservation) {
  if (
    a.source === b.source ||
    (a.kind === "monitored" && b.kind === "monitored")
  )
    return false
  if (
    a.location &&
    b.location &&
    words(a.location).join(" ") !== words(b.location).join(" ")
  )
    return false
  const days =
    Math.abs(Date.parse(a.postedAt ?? "") - Date.parse(b.postedAt ?? "")) /
    86_400_000
  if (!Number.isFinite(days) || days > 14) return false
  const left = phrases(a.description)
  const right = phrases(b.description)
  if (Math.min(left.size, right.size) < 50) return false
  const common = [...left].filter((phrase) => right.has(phrase)).length
  return common / (left.size + right.size - common) >= 0.9
}

export function dedupeIndiaJobs(observations: IndiaJobObservation[]) {
  const groups = new Map<string, IndiaJobObservation[]>()
  const roles = new Map<string, Set<string>>()
  for (const job of observations) {
    const role = [job.company, job.title]
      .map((value) =>
        value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
      )
      .join("\n")
    const posting = normalizedPosting({
      ...job,
      countries: ["India"],
      evidence: job.url,
      method: "structured_data",
    })
    const key = JSON.stringify([role, posting?.key ?? job.url])
    const group = groups.get(key) ?? []
    group.push(job)
    groups.set(key, group)
    const roleKeys = roles.get(role) ?? new Set<string>()
    roleKeys.add(key)
    roles.set(role, roleKeys)
  }
  const syndicated = new Set<string>()
  for (const keys of roles.values()) {
    if (keys.size !== 2) continue
    const [left, right] = [...keys].sort()
    const a = groups.get(left)!
    const b = groups.get(right)!
    if (a.length !== 1 || b.length !== 1 || !sameSyndicatedPosting(a[0], b[0]))
      continue
    a.push(...b)
    groups.delete(right)
    syndicated.add(left)
  }
  return [...groups].map(([key, observations]) => {
    observations.sort(
      (a, b) =>
        Number(b.kind === "monitored") - Number(a.kind === "monitored") ||
        b.description.length - a.description.length ||
        a.id.localeCompare(b.id)
    )
    const primary = observations[0]
    return {
      job_key: `${primary.kind}:${primary.id}`,
      title: primary.title,
      company: primary.company,
      url: primary.url,
      description: primary.description,
      posted_at: primary.postedAt,
      locations: [
        ...new Set(
          observations.flatMap((job) => (job.location ? [job.location] : []))
        ),
      ].sort(),
      evidence: observations.map(({ kind, id, source, url, location }) => ({
        kind,
        id,
        source,
        url,
        location,
      })),
      match: syndicated.has(key)
        ? "syndicated_description"
        : observations.length > 1
          ? "application_url"
          : null,
    }
  })
}

function main() {
  const {
    values: { project, run },
  } = parseArgs({
    options: { project: { type: "string" }, run: { type: "string" } },
  })
  if (
    !project ||
    !run ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(run)
  )
    throw new Error("Supply --project and --run UUID")
  const root = fileURLToPath(new URL("../../", import.meta.url))
  function db(database: string, input: string) {
    return execFileSync(
      "docker",
      [
        "compose",
        "-p",
        project!,
        "--env-file",
        ".local-data/compose/local.env",
        "-f",
        "deploy/local/compose.yml",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-XAtq",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        cwd: root,
        input,
        encoding: "utf8",
        maxBuffer: 64_000_000,
      }
    ).trim()
  }
  const portals: IndiaJobObservation[] = JSON.parse(
    db(
      "india_employer_registry",
      `
    select coalesce(jsonb_agg(row), '[]') from (
      select 'portal' as kind, j.posting_key as id, j.source_url as source, j.job_url as url,
        j.title, j.company, j.location, j.posted_at as "postedAt", j.description
      from registry_scraped_job j join registry_job_scrape_source s
      on j.run_id=s.run_id and j.source_url=s.url
      where j.run_id='${run}' and cardinality(s.registration_ids)=0
        and countries @> array['India']
    ) row;
  `
    )
  )
  if (!portals.length)
    throw new Error("The run contains no India portal observations")
  const monitored: IndiaJobObservation[] = JSON.parse(
    db(
      "postgres",
      `
    select coalesce(jsonb_agg(row), '[]') from (
      select 'monitored' as kind, id, source, url, title, company, city as location,
        posted_at as "postedAt", description
      from job_catalog where is_active and country='India'
    ) row;
  `
    )
  )

  const jobs = dedupeIndiaJobs([...portals, ...monitored])
  const payload = JSON.stringify(jobs)
  const csv = '"' + payload.replaceAll('"', '""') + '"'
  const stored = JSON.parse(
    db(
      "india_employer_registry",
      `
    begin;
    select pg_advisory_xact_lock(hashtextextended('registry_india_deduped_job:${run}', 0));
    create table if not exists registry_india_deduped_job (
      run_id uuid not null, job_key text not null, title text not null, company text not null,
      url text not null, description text not null, posted_at timestamptz, locations text[] not null,
      evidence jsonb not null, match text, deduped_at timestamptz not null default now(),
      primary key (run_id, job_key)
    );
    create temp table dedupe_input (jobs jsonb) on commit drop;
    copy dedupe_input from stdin csv;
${csv}
\\.
    delete from registry_india_deduped_job where run_id='${run}';
    insert into registry_india_deduped_job
      (run_id,job_key,title,company,url,description,posted_at,locations,evidence,match)
    select '${run}', j.job_key,j.title,j.company,j.url,j.description,j.posted_at,j.locations,j.evidence,j.match
    from dedupe_input d cross join lateral jsonb_to_recordset(d.jobs)
      j(job_key text,title text,company text,url text,description text,posted_at timestamptz,locations text[],evidence jsonb,match text);
    select jsonb_build_object(
      'combinedUnique',count(*),'observations',sum(jsonb_array_length(evidence)),
      'portalUnique',count(*) filter (where evidence @> '[{"kind":"portal"}]'),
      'monitoredUnique',count(*) filter (where evidence @> '[{"kind":"monitored"}]'),
      'crossChannel',count(*) filter (where evidence @> '[{"kind":"portal"},{"kind":"monitored"}]'),
      'syndicated',count(*) filter (where match='syndicated_description')
    ) from registry_india_deduped_job where run_id='${run}';
    commit;
  `
    )
  )
  if (
    stored.combinedUnique !== jobs.length ||
    stored.observations !== portals.length + monitored.length
  )
    throw new Error("Saved deduplication does not account for all observations")
  console.log(
    JSON.stringify({
      run,
      portalObservations: portals.length,
      monitoredObservations: monitored.length,
      ...stored,
    })
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
