import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs, parseEnv } from "node:util"
import { loadProfessionalPortals } from "../lib/professional-job-portals.mjs"
import { employerHost } from "../lib/registry-job-postings.mjs"
import {
  makeRegistryJobScraper,
  type RegistryJobSource,
  type SourceScrape,
} from "../lib/registry-job-scraper.mjs"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    run: { type: "string" },
    phase: { type: "string", default: "http" },
    limit: { type: "string", default: "0" },
    concurrency: { type: "string" },
    "professional-portals": { type: "boolean" },
  },
})
const run = values.run
const phase = values.phase
const mapPhase = phase === "map"
const limit = Number(values.limit)
const networkFallback = phase === "browser" || mapPhase
const concurrency = Number(values.concurrency ?? (networkFallback ? 8 : 96))
if (
  !values.project ||
  !run ||
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(run) ||
  !["http", "browser", "map", "report"].includes(phase!) ||
  !Number.isSafeInteger(limit) ||
  limit < 0 ||
  !Number.isSafeInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > (networkFallback ? 20 : 160)
)
  throw new Error(
    "Supply --project, --run UUID and --phase http, browser, map or report"
  )

const root = fileURLToPath(new URL("../../", import.meta.url))
const professional = Boolean(values["professional-portals"])
if (mapPhase && professional)
  throw new Error("Firecrawl Map is available for employer careers pages")
const portals = new Map(
  professional
    ? loadProfessionalPortals().map((portal) => [portal.url, portal])
    : []
)
if (
  professional &&
  phase === "browser" &&
  !process.env.TWOCAPTCHA_API_KEY?.trim()
) {
  for (const filename of [".env.production.local", ".env.local"]) {
    const file = new URL("../../" + filename, import.meta.url)
    if (!existsSync(file)) continue
    const key = parseEnv(readFileSync(file, "utf8")).TWOCAPTCHA_API_KEY?.trim()
    if (!key) continue
    process.env.TWOCAPTCHA_API_KEY = key
    break
  }
}
function db(input: string) {
  return execFileSync(
    "docker",
    [
      "compose",
      "-p",
      values.project!,
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
      "india_employer_registry",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { cwd: root, input, encoding: "utf8", maxBuffer: 12_000_000 }
  ).trim()
}
function report() {
  return JSON.parse(
    db(`
select jsonb_build_object(
  'run', '${run}',
  'sources',(select count(*) from registry_job_scrape_source where run_id='${run}'),
  'jobs',(select count(*) from registry_scraped_job where run_id='${run}'),
  'india',(select count(*) from registry_scraped_job where run_id='${run}' and countries @> array['India']),
  'countriesUnknown',(select count(*) from registry_scraped_job where run_id='${run}' and cardinality(countries)=0),
  'outcomes',(select jsonb_object_agg(outcome,n) from (
    select outcome,count(*) n from registry_job_scrape_source where run_id='${run}' group by outcome
  ) x),
  'browserChecks',(select count(*) from registry_job_scrape_source where run_id='${run}' and render_attempted),
  'mapChecks',(select count(*) from registry_job_scrape_source s where run_id='${run}' and to_jsonb(s) @> '{"map_attempted":true}')
);
`)
  )
}

function reconcileListings() {
  db(`
with matches as (
  select distinct on (listing.posting_key)
    listing.posting_key as redundant_key, detail.posting_key as keep_key,
    listing.location,listing.countries
  from registry_scraped_job listing
  join registry_scraped_job detail on detail.run_id=listing.run_id and detail.job_url=listing.job_url
    and lower(detail.title)=lower(listing.title)
    and (detail.location=listing.location or detail.location is null or listing.location is null)
  where listing.run_id='${run}' and listing.method='listing' and detail.method in ('ats','structured_data','job_detail')
  order by listing.posting_key,
    array_position(array['ats','structured_data','job_detail'],detail.method),detail.posting_key
), merged as (
  select keep_key,min(location) as location,
    coalesce(array_agg(distinct country) filter (where country is not null),'{}') as countries
  from matches left join lateral unnest(countries) country on true group by keep_key
), enriched as (
  update registry_scraped_job job set location=coalesce(job.location,m.location),
    countries=array(select distinct country from unnest(job.countries||m.countries) country order by country)
  from merged m where job.run_id='${run}' and job.posting_key=m.keep_key
  returning job.posting_key
)
delete from registry_scraped_job job using matches m
where job.run_id='${run}' and job.posting_key=m.redundant_key
  and m.keep_key in (select posting_key from enriched);
`)
}

const csv = (row: string[]) =>
  row
    .map((value) => `"${value.replaceAll("\u0000", "").replaceAll('"', '""')}"`)
    .join(",")
type Result = SourceScrape & { url: string }
const pending =
  phase === "browser"
    ? "not s.render_attempted and s.outcome in ('render_pending','captcha')"
    : mapPhase
      ? `not s.map_attempted and s.render_attempted and s.listings_observed=0
        and s.outcome in ('no_verified_jobs','partial')
        and coalesce(s.reason,'') !~* '(HTTP (401|403|429|503)|robots|challenge|captcha|sign-in)'`
      : "s.outcome='pending'"
function commit(results: Result[]) {
  const rows = results.map((row) =>
    csv([
      row.url,
      row.outcome,
      (row.reason ?? "").slice(0, 400),
      String(row.pages),
      JSON.stringify(
        row.jobs.map((job) => ({
          posting_key: job.key,
          job_url: job.url,
          title: job.title,
          company: job.company,
          location: job.location,
          countries: job.countries,
          posted_at: job.postedAt,
          description: job.description,
          evidence_url: job.evidence,
          method: job.method,
        })),
        (_key, value) =>
          typeof value === "string"
            ? value.replaceAll("\u0000", "").toWellFormed()
            : value
      ),
    ])
  )
  return JSON.parse(
    db(`begin;
create temp table scraped_sources (
  url text,outcome text,reason text,pages integer,jobs jsonb
) on commit drop;
copy scraped_sources from stdin with (format csv);
${rows.join("\n")}
\\.
with checked as (
  update registry_job_scrape_source s
  set outcome=${mapPhase ? "case when c.outcome='no_verified_jobs' then s.outcome else c.outcome end" : "c.outcome"},
    reason=${mapPhase ? "left(concat_ws('; ',nullif(c.reason,''),s.reason),400)" : "nullif(c.reason,'')"},
    pages_read=s.pages_read+c.pages,
    listings_observed=greatest(s.listings_observed,jsonb_array_length(c.jobs)),checked_at=now(),
    render_attempted=s.render_attempted or ${phase === "browser" ? "true" : "false"}
    ${mapPhase ? ",map_attempted=true" : ""}
  from scraped_sources c
  where s.run_id='${run}' and s.url=c.url and (${pending})
  returning s.url,c.jobs
), observations as (
  select c.url as source_url,p.*
  from checked c cross join lateral jsonb_to_recordset(c.jobs)
    p(posting_key text,job_url text,title text,company text,location text,countries text[],
      posted_at timestamptz,description text,evidence_url text,method text)
), saved as (
  insert into registry_scraped_job as stored
    (run_id,posting_key,source_url,job_url,title,company,location,countries,posted_at,description,evidence_url,method)
  select distinct on (posting_key) '${run}',posting_key,source_url,job_url,title,company,
    location,countries,posted_at,description,evidence_url,method
  from observations
  order by posting_key, case method when 'ats' then 0 when 'structured_data' then 1 when 'job_detail' then 2 else 3 end,
    length(description) desc,source_url
  on conflict (run_id,posting_key) do update set
    (source_url,title,company,evidence_url,method)=(
      select case when prefer_new then excluded.source_url else stored.source_url end,
        case when prefer_new then excluded.title else stored.title end,
        case when prefer_new then excluded.company else stored.company end,
        case when prefer_new then excluded.evidence_url else stored.evidence_url end,
        case when prefer_new then excluded.method else stored.method end
      from (
        select array_position(array['ats','structured_data','job_detail','listing'],excluded.method)
          <= array_position(array['ats','structured_data','job_detail','listing'],stored.method) as prefer_new
      ) preference
    ),
    location=coalesce(excluded.location,stored.location),
    countries=array(select distinct country from unnest(stored.countries||excluded.countries) country order by country),
    posted_at=coalesce(stored.posted_at,excluded.posted_at),
    description=case when length(excluded.description)>length(stored.description) then excluded.description else stored.description end
  returning posting_key
)
select jsonb_build_object('checked',(select count(*) from checked),'written',(select count(*) from saved));
commit;
`)
  )
}

if (phase === "report") {
  console.log(JSON.stringify(report(), null, 2))
} else {
  if (phase === "http" && professional) {
    const rows = [...portals.values()].map((portal) =>
      csv([
        portal.url,
        portal.company,
        portal.skip?.outcome ?? "pending",
        portal.skip?.reason ?? "",
      ])
    )
    db(`begin;
create temp table portal_sources (url text, company text, outcome text, reason text) on commit drop;
copy portal_sources from stdin with (format csv);
${rows.join("\n")}
\\.
insert into registry_job_scrape_source(run_id,url,company,registration_ids,outcome,reason,checked_at)
select '${run}',url,company,'{}',outcome,nullif(reason,''),case when outcome <> 'pending' then now() end
from portal_sources where not exists(select 1 from registry_job_scrape_source where run_id='${run}')
on conflict do nothing;
commit;
`)
  } else if (phase === "http")
    db(`
insert into registry_job_scrape_source(run_id,url,company,registration_ids)
select '${run}',l.url,string_agg(distinct c.legal_name,' / ' order by c.legal_name),
  array_agg(distinct c.registration_id order by c.registration_id)
from registry_company_link l join registry_company c using(registration_id)
where l.kind='careers' and l.status='public' and lower(c.company_status)='active'
  and not exists (select 1 from registry_job_scrape_source where run_id='${run}')
group by l.url on conflict do nothing;
`)
  if (!report().sources) throw new Error("The job scrape has no seeded URLs")
  const scopeMismatch = db(`select exists(
    select 1 from registry_job_scrape_source where run_id='${run}' and (cardinality(registration_ids)=0) <> ${professional}
  );`)
  if (scopeMismatch === "t")
    throw new Error("Use the same source options when resuming a run")
  const scrape = makeRegistryJobScraper({
    mapEndpoint: mapPhase
      ? new URL(process.env.REGISTRY_FIRECRAWL_URL ?? "http://127.0.0.1:13982")
      : undefined,
  })
  const browser =
    phase === "browser"
      ? await (
          await import("../lib/registry-job-browser.mjs")
        ).openRegistryJobBrowser()
      : null
  console.log(
    JSON.stringify({ run, phase, startedAt: new Date().toISOString() })
  )
  let processed = 0
  try {
    for (let batch = 1; !limit || processed < limit; batch++) {
      const size = limit ? Math.min(1000, limit - processed) : 1000
      const queue: RegistryJobSource[] = JSON.parse(
        db(`
select coalesce(jsonb_agg(s),'[]'::jsonb) from (
  select url,company from registry_job_scrape_source s where run_id='${run}' and (${pending})
  order by case
    when company in ('Himalayas','Remote OK','We Work Remotely','Hasjob','Remotive','Jobicy','FzlOps','Remote Gig')
      and cardinality(registration_ids)=0 then 0
    when url like 'https://www.amazon.jobs/%' or url like 'https://fa-etbm-saasfaprod1.fa.ocs.oraclecloud.com/%' then 0
    when url like 'https://jobs.lever.co/%' or url like '%/carrer%' or url like '%/join-our-team/' then 1
    else 2 end,md5(url)
  limit ${size}
) s;
`)
      )
      if (!queue.length) break
      const groups = new Map<string, RegistryJobSource[]>()
      for (const source of queue) {
        const host = employerHost(new URL(source.url))
        const group = groups.get(host) ?? []
        group.push(source)
        groups.set(host, group)
      }
      const work = [...groups.values()].sort((a, b) => b.length - a.length)
      let cursor = 0
      const buffer: Result[] = []
      let bufferedJobs = 0
      const outcomes: Record<string, number> = {}
      const totals = { checked: 0, written: 0 }
      function flush() {
        if (!buffer.length) return
        const committed = commit(buffer.splice(0))
        totals.checked += committed.checked
        totals.written += committed.written
        bufferedJobs = 0
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, work.length) }, async () => {
          while (cursor < work.length)
            for (const source of work[cursor++]) {
              const portal = portals.get(source.url)
              if (professional && !portal)
                throw new Error("Portal is missing from the run configuration")
              const result = await scrape(
                { ...source, portal },
                browser?.render
              )
              buffer.push({ url: source.url, ...result })
              outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1
              bufferedJobs += result.jobs.length
              if (buffer.length >= 30 || bufferedJobs >= 200) flush()
            }
        })
      )
      flush()
      processed += queue.length
      console.log(JSON.stringify({ batch, ...totals, outcomes }))
    }
  } finally {
    await browser?.close()
  }
  if (!mapPhase) reconcileListings()
  console.log(
    JSON.stringify({
      ...report(),
      phase,
      phaseFinishedAt: new Date().toISOString(),
    })
  )
}
