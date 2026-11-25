import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { load } from "cheerio"
import { publicApplicationUrl } from "@/lib/applications/url"
import {
  discoverEmployerLinks,
  linkDiscoveryOrigin,
} from "@/lib/server/catalog/discovery/links"
import { CandidateStore } from "@/lib/server/catalog/discovery/store"
import type { CatalogPosting } from "@/lib/server/catalog/feeds"
import type { SourceCandidate } from "@/lib/server/catalog/discovery/seeds"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { publishedCareerLinks } from "../lib/career-links.mjs"
import { probeEmployerCareers } from "../lib/employer-careers-probe.mjs"
import { probeEmployerSites } from "../lib/employer-site-probe.mjs"
import { makeRegistryJobScraper } from "../lib/registry-job-scraper.mjs"
import { registryFirecrawlPosting } from "../lib/registry-firecrawl-publication.mjs"
import {
  readEmployerJobMetadata,
  type JobObservation,
} from "../lib/employer-job-metadata.mjs"

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    limit: { type: "string", default: "150" },
    kind: { type: "string", default: "careers" },
    scope: { type: "string", default: "all" },
    "domain-limit": { type: "string", default: "600" },
  },
})
const limit = Number(values.limit)
const domainLimit = Number(values["domain-limit"])
const scheduled = values.kind === "hourly"
const careersLimit = Number(process.env.INDIA_REGISTRY_CAREERS_BATCH ?? 5000)
const mapLimit = Number(process.env.INDIA_REGISTRY_MAP_BATCH ?? 24)
const mapSeed = process.env.INDIA_REGISTRY_MAP_SEED
const oneTime = values.kind === "once"
const careerDiscovery = values.kind === "career-discovery"
if ((oneTime || careerDiscovery) && (!values.project || values.scope !== "all"))
  throw new Error(
    "Use --project <local-compose-project> for the one-time scan of all registry leads"
  )
if (
  (!values.project && process.env.PGHOST !== "db") ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 5000 ||
  !["careers", "website", "hourly", "once", "career-discovery"].includes(
    values.kind!
  ) ||
  (scheduled &&
    (values.project ||
      !Number.isSafeInteger(domainLimit) ||
      domainLimit < 1 ||
      domainLimit > 2000 ||
      !Number.isSafeInteger(careersLimit) ||
      careersLimit < 1 ||
      careersLimit > 5000 ||
      !Number.isSafeInteger(mapLimit) ||
      mapLimit < 0 ||
      mapLimit > 100 ||
      (mapSeed && !publicApplicationUrl(mapSeed)))) ||
  !["all", "directory", "maps", "hyderabad", "nationwide"].includes(
    values.scope!
  )
)
  throw new Error(
    "Use --project <local-compose-project> for link checks or --kind hourly in the local scheduler"
  )

const mapScrape =
  scheduled && mapLimit && process.env.REGISTRY_FIRECRAWL_URL
    ? makeRegistryJobScraper({
        mapEndpoint: new URL(process.env.REGISTRY_FIRECRAWL_URL),
        preferCareerLinks: true,
      })
    : null

const root = fileURLToPath(new URL("../../", import.meta.url))
function database(sql: string, variables: Record<string, string> = {}) {
  return execFileSync(
    values.project ? "docker" : "psql",
    [
      ...(values.project
        ? [
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
          ]
        : []),
      "-U",
      "postgres",
      "-d",
      "india_employer_registry",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
      ...Object.entries(variables).flatMap(([key, value]) => [
        "-v",
        `${key}=${value}`,
      ]),
    ],
    { input: sql, encoding: "utf8", cwd: root, maxBuffer: 12_000_000 }
  )
}
type Link = {
  url: string
  kind: "careers" | "website"
  registration_id: string
  evidence_source: string
  legal_name: string
}
type Company = Pick<Link, "registration_id" | "legal_name">
type Result = {
  url: string
  kind: Link["kind"]
  registration_id: string
  status: "public" | "restricted" | "deferred" | "unverified"
  reason: string
  careers: string[]
  candidates: SourceCandidate[]
  jobs: JobObservation[]
  mapChecked: boolean
  mapAttempted?: boolean
  mapError?: boolean
  mapPostings?: CatalogPosting[]
}
const authPath =
  /(?:^|\/)(?:log[-_]?in|sign[-_]?in|sso|authenticate|candidate-login)(?:[/.?_-]|$)/i
const authTitle =
  /^(?:sign in|login|log in|authentication required|access denied)\b/i
const compact = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bpvt\b/g, "private")
    .replace(/\bltd\b/g, "limited")
    .replace(/[^\p{L}\p{N}]/gu, "")

async function check(link: Link, mapChecked = false): Promise<Result> {
  const base = {
    url: link.url,
    kind: link.kind,
    registration_id: link.registration_id,
    careers: [] as string[],
    candidates: [] as SourceCandidate[],
    jobs: [] as JobObservation[],
    mapChecked,
  }
  const safe = publicApplicationUrl(link.url)
  if (!safe)
    return {
      ...base,
      status: "unverified",
      reason: "URL is outside public HTTPS rules",
    }
  if (authPath.test(new URL(safe).pathname))
    return { ...base, status: "restricted", reason: "Sign-in URL" }
  let examined: Pick<Result, "status" | "reason" | "careers"> | undefined
  const jobDetails = new Set<string>()
  const jobs: JobObservation[] = []
  let careerPage: URL | undefined
  let careerJobLinks: string[] | undefined
  function collectJobs(page: URL, html: string) {
    jobs.push(
      ...readEmployerJobMetadata(
        page,
        html,
        compact,
        compact(link.legal_name),
        new Date()
      )
    )
  }
  const observed = await discoverEmployerLinks([safe], {
    maxPages: 1,
    maxMs: 8_000,
    sameSiteRedirects: true,
    inspectKnownBoards: true,
    inspectPage(page, html, links) {
      const $ = load(html)
      const title = $("title").text().trim()
      const headings = $("h1")
        .map((_, el) => $(el).text().trim())
        .get()
      if (
        authPath.test(page.pathname) ||
        authTitle.test(title) ||
        headings.some((value) => authTitle.test(value))
      ) {
        examined = {
          status: "restricted",
          reason: "Sign-in or access restriction page",
          careers: [],
        }
      } else if (
        /cloudflare|just a moment|request rejected|attention required|domain (?:is )?for sale|domain parking/i.test(
          title
        )
      ) {
        examined = {
          status: "unverified",
          reason: "Challenge or parked domain",
          careers: [],
        }
      } else if (
        link.evidence_source.startsWith("Overture Maps") &&
        !compact($("footer, address, [itemprop='address']").text()).includes(
          compact(link.legal_name)
        )
      ) {
        examined = {
          status: "unverified",
          reason:
            "Map-listed domain lacks legal company confirmation on the site",
          careers: [],
        }
      } else {
        examined = {
          status: "public",
          reason: "Public page reached",
          careers:
            link.kind === "website"
              ? publishedCareerLinks(page, $).slice(0, 12)
              : [],
        }
        if (scheduled && link.kind === "careers") {
          careerPage = page
          if (mapChecked)
            careerJobLinks = $("a[href]")
              .map((_, anchor) => $(anchor).attr("href"))
              .get()
          collectJobs(page, html)
          for (const value of links) {
            const url = URL.parse(value)
            if (
              url &&
              url.origin === page.origin &&
              /\/(?:jobs?|vacanc(?:y|ies)|positions?)\/[^/]+\/?$/i.test(
                url.pathname
              )
            )
              jobDetails.add(url.href)
          }
        }
      }
    },
  })
  if (examined) {
    if (examined.status !== "public" || !scheduled || link.kind !== "careers")
      return { ...base, ...examined }
    let detailAccessDeferred = false
    if (!observed.candidates.length && !jobs.length && jobDetails.size) {
      const details = await discoverEmployerLinks([...jobDetails].slice(0, 3), {
        maxPages: 1,
        maxMs: 8_000,
        sameSiteRedirects: true,
        inspectPage: collectJobs,
      })
      detailAccessDeferred = details.errors.some(({ reason }) =>
        /HTTP (401|403|429|503)/.test(reason)
      )
    }
    const result = {
      ...base,
      ...examined,
      candidates: observed.candidates,
      jobs,
    }
    if (
      !mapChecked ||
      !mapScrape ||
      !careerPage ||
      detailAccessDeferred ||
      jobs.length
    )
      return result
    try {
      const mapped = await mapScrape({
        url: careerPage.href,
        company: link.legal_name,
        careerJobLinks,
      })
      return {
        ...result,
        mapAttempted: true,
        mapPostings: mapped.jobs.flatMap((job) => {
          const posting = registryFirecrawlPosting(job)
          return posting ? [posting] : []
        }),
        jobs: mapped.jobs.map((job) => ({
          url: job.url,
          title: job.title,
          city: null,
          postedAt: job.postedAt,
          method: "firecrawl_map",
          evidenceUrl: job.evidence,
          countries: job.countries,
        })),
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          firecrawlMapError:
            error instanceof Error ? error.message : "Mapping failed",
          url: careerPage.href,
        })
      )
      return { ...result, mapAttempted: true, mapError: true }
    }
  }
  const reason = observed.errors[0]?.reason ?? "Public page was not confirmed"
  const status = /HTTP (401|403)|robots rules exclude/.test(reason)
    ? "restricted"
    : /HTTP (429|5[0-9]{2})|timed out|timeout|fetch failed|time budget/i.test(
          reason
        )
      ? "deferred"
      : "unverified"
  return { ...base, status, reason }
}

const csv = (row: string[]) =>
  row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")

function commit(results: Result[]) {
  const rows = results
    .map((r) =>
      csv([
        r.registration_id,
        r.kind,
        r.url,
        r.status,
        r.reason.slice(0, 300),
        JSON.stringify(r.careers),
        JSON.stringify(r.candidates.slice(0, 12)),
        JSON.stringify(r.jobs),
        String(r.mapChecked),
      ])
    )
    .join("\n")
  return JSON.parse(
    database(`begin;
create temp table registry_checks (
  registration_id text, kind text, url text, status text, reason text,
  careers jsonb, candidates jsonb, jobs jsonb, map_checked boolean
) on commit drop;
copy registry_checks from stdin with (format csv);
${rows}
\\.
update public.registry_company_link as link set status=c.status, checked_at=now(), check_reason=c.reason,
  job_map_checked_at=case when c.map_checked then now() else link.job_map_checked_at end
from registry_checks c where (link.registration_id,link.kind,link.url) = (c.registration_id,c.kind,c.url)
  and (link.status in ('pending','deferred' ${scheduled ? ",'public'" : ""})
    ${oneTime ? "or (link.status='unverified' and link.check_reason='The operation was aborted due to timeout')" : ""});
insert into public.registry_company_link(registration_id,kind,url,evidence_url,evidence_source,employer_key)
select c.registration_id,'careers',dest,c.url,'Link published on verified company website',link.employer_key
from registry_checks c join public.registry_company_link link
  on (link.registration_id,link.kind,link.url) = (c.registration_id,c.kind,c.url)
cross join lateral jsonb_array_elements_text(c.careers) as urls(dest)
where c.kind='website' and c.status='public' and link.status='public'
on conflict (registration_id,kind,url) do nothing;
insert into public.registry_feed_candidate(registration_id,source_id,kind,board,evidence_url)
select c.registration_id, candidate->>'id', candidate->>'kind', candidate->>'board', c.url
from registry_checks c cross join lateral jsonb_array_elements(c.candidates) candidate
where c.status='public' and c.kind='careers'
on conflict (registration_id,source_id) do nothing;
with jobs as (
  insert into public.registry_job_observation as stored
    (registration_id,job_url,title,city,posted_at,source_method,evidence_url,countries)
  select distinct on (c.registration_id, job->>'url')
    c.registration_id,job->>'url',job->>'title',job->>'city',(job->>'postedAt')::timestamptz,
    job->>'method',coalesce(job->>'evidenceUrl',job->>'url'),
    case when job ? 'countries' then array(select jsonb_array_elements_text(job->'countries'))
      else array['India'] end
  from registry_checks c cross join lateral jsonb_array_elements(c.jobs) job
  where c.status='public' and c.kind='careers'
  on conflict (registration_id,job_url) do update set last_seen_at=now(),
    title=excluded.title,city=coalesce(excluded.city,stored.city),
    posted_at=coalesce(excluded.posted_at,stored.posted_at),
    countries=array(select distinct unnest(stored.countries||excluded.countries) order by 1)
  returning first_seen_at,source_method
)
select jsonb_build_object(
  'inserted',count(*) filter (where first_seen_at=now()),
  'mapped',count(*) filter (where first_seen_at=now() and source_method='firecrawl_map')
) from jobs;
commit;
`).trim()
  ) as { inserted: number; mapped: number }
}

const scopeClause = {
  all: "",
  directory: "and l.evidence_source not like 'Overture Maps%'",
  maps: "and l.evidence_source like 'Overture Maps%'",
  hyderabad: "and l.evidence_source like 'Overture Maps Places% Hyderabad.%'",
  nationwide: "and l.evidence_source like 'Overture Maps Places% India.%'",
}[values.scope!]!

const queueOrder =
  values.scope === "nationwide"
    ? "row_number() over (partition by c.region order by l.registration_id,l.url), c.region"
    : "l.registration_id,l.url"

function linkQueue(
  kind: Link["kind"],
  maxLinks: number,
  includePublic = false,
  startedAt?: string
): Link[] {
  return JSON.parse(
    database(
      `select coalesce(jsonb_agg(candidate),'[]'::jsonb) from (
select l.url,l.kind,l.registration_id,l.evidence_source,c.legal_name
from public.registry_company_link l join public.registry_company c using (registration_id)
where l.kind='${kind}' and (l.status='pending'
  or (l.status='deferred' and l.checked_at < now()-interval '30 minutes'
    ${startedAt ? "and l.checked_at < :'started_at'::timestamptz" : ""})
  ${startedAt ? "or (l.status='unverified' and l.check_reason='The operation was aborted due to timeout' and l.checked_at < :'started_at'::timestamptz)" : ""}
  ${includePublic ? "or l.status='public'" : ""})
${scopeClause}
order by ${scheduled ? "l.checked_at nulls first, " : ""}${queueOrder} limit ${maxLinks}
) candidate;`,
      startedAt ? { started_at: startedAt } : {}
    )
  )
}

async function checkByHost<T extends { url: string }>(
  queue: T[],
  visit: (link: T) => Promise<void>,
  concurrency: number
) {
  const byHost = new Map<string, T[]>()
  for (const link of queue) {
    const host = URL.parse(link.url)?.hostname.replace(/^www\./, "") ?? link.url
    const links = byHost.get(host) ?? []
    links.push(link)
    byHost.set(host, links)
  }
  const groups = [...byHost.values()].sort((a, b) => b.length - a.length)
  let groupIndex = 0
  async function worker() {
    while (groupIndex < groups.length) {
      for (const link of groups[groupIndex++]) await visit(link)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length) }, worker)
  )
}

async function checkLinks(queue: Link[], concurrency = 20, mapChecked = false) {
  const counts: Record<string, number> = {}
  const results: Result[] = []
  let newJobObservations = 0
  let mapAttempts = 0
  let mapErrors = 0
  let newMappedJobs = 0
  let mapEligibleIndia = 0
  const publishedMapIds: string[] = []
  async function save() {
    if (!results.length) return
    const batch = results.splice(0)
    const mapped = new Map(
      batch.flatMap((row) => row.mapPostings ?? []).map((job) => [job.id, job])
    )
    const postings = [...mapped.values()]
    if (postings.length) {
      const db = supabaseServerClient(30_000)
      for (let offset = 0; offset < postings.length; offset += 100) {
        const { data, error } = await db.rpc(
          "publish_registry_firecrawl_india",
          {
            p_jobs: postings.slice(offset, offset + 100),
          }
        )
        if (error)
          throw new Error(
            `Firecrawl catalog publication failed: ${error.message}`
          )
        publishedMapIds.push(...data.newIds)
      }
      mapEligibleIndia += postings.length
    }
    const saved = commit(batch)
    newJobObservations += saved.inserted
    newMappedJobs += saved.mapped
  }
  await checkByHost(
    queue,
    async (link) => {
      const result = await check(link, mapChecked)
      if (result.mapAttempted) mapAttempts++
      if (result.mapError) mapErrors++
      counts[result.status] = (counts[result.status] ?? 0) + 1
      results.push(result)
      if (results.length === 50) await save()
    },
    concurrency
  )
  await save()
  return {
    checked: queue.length,
    ...counts,
    newJobObservations,
    ...(mapChecked
      ? {
          mapAttempts,
          mapErrors,
          newMappedJobs,
          mapEligibleIndia,
          publishedNewIndia: publishedMapIds.length,
          publishedMapIds,
        }
      : {}),
  }
}

function mapQueue(): Link[] {
  return JSON.parse(
    database(
      `
select coalesce(jsonb_agg(candidate),'[]'::jsonb) from (
  select l.url,l.kind,l.registration_id,l.evidence_source,c.legal_name
  from public.registry_company_link l join public.registry_company c using(registration_id)
  where l.kind='careers' and l.status='public'
    and lower(c.company_status)='active'
    ${
      mapSeed
        ? "and l.url=:'seed'"
        : `
      and (l.job_map_checked_at is null or l.job_map_checked_at < now()-interval '1 day')
      and not exists (select 1 from public.registry_feed_candidate f
        where f.registration_id=l.registration_id and f.evidence_url=l.url and f.result='connected')
    `
    }
    ${scopeClause}
  order by l.job_map_checked_at nulls first,l.registration_id,l.url limit ${mapLimit}
) candidate;
`,
      mapSeed ? { seed: mapSeed } : {}
    )
  )
}

type CareerDiscoverySite = Company & { url: string; status: string }

function careerDiscoveryQueue(): CareerDiscoverySite[] {
  return JSON.parse(
    database(`
select coalesce(jsonb_agg(site),'[]'::jsonb) from (
  select l.registration_id,c.legal_name,l.url,l.status
  from public.registry_company_link l join public.registry_company c using(registration_id)
  where l.kind='website' and l.status<>'restricted'
    and l.career_discovery_checked_at is null and lower(c.company_status)='active'
    and (l.check_reason is distinct from 'Discovery HTTP 429'
      or l.checked_at < now()-interval '30 minutes')
  order by case
    when l.status<>'public' then 2
    when exists (select 1 from public.registry_company_link careers
      where careers.registration_id=l.registration_id and careers.kind='careers' and careers.status='public') then 1
    else 0
  end,l.registration_id,l.url
  limit ${limit}
) site;
`)
  )
}

async function discoverRegistryCareers() {
  type Outcome = Awaited<ReturnType<typeof probeEmployerCareers>> & {
    site: CareerDiscoverySite
  }
  const startedAt = database("select clock_timestamp();").trim()
  console.log(JSON.stringify({ startedAt }))
  for (let batch = 1; ; batch++) {
    const queue = careerDiscoveryQueue()
    if (!queue.length) break
    const outcomes: Record<string, number> = {}
    const pending: Outcome[] = []
    const totals = { checked: 0, websitesVerified: 0, careersVerified: 0 }
    function save() {
      if (!pending.length) return
      const rows = pending
        .splice(0)
        .map(({ site, result, websiteEvidence, links }) =>
          csv([
            site.registration_id,
            site.url,
            result,
            websiteEvidence ?? "",
            JSON.stringify(links),
          ])
        )
      const result = JSON.parse(
        database(`begin;
create temp table career_checks (
  registration_id text, website text, result text, website_evidence text, links jsonb
) on commit drop;
copy career_checks from stdin with (format csv);
${rows.join("\n")}
\\.
with completed as (
  update public.registry_company_link site
  set career_discovery_checked_at=now(),
    career_discovery_result=c.result,
    status=case when c.website_evidence<>'' then 'public'
      when site.status='pending' and c.result='website_unavailable' then 'deferred'
      when site.status='pending' then 'unverified' else site.status end,
    checked_at=case when site.status='pending' or c.website_evidence<>'' then now() else site.checked_at end,
    check_reason=case when c.website_evidence<>'' then 'Legal company identity corroborated at ' || c.website_evidence
      when site.status='pending' then c.result else site.check_reason end
  from career_checks c
  where (site.registration_id,site.kind,site.url)=(c.registration_id,'website',c.website)
    and site.status<>'restricted' and site.career_discovery_checked_at is null
  returning site.registration_id,site.employer_key,site.status,c.website_evidence,c.links
), saved as (
  insert into public.registry_company_link as stored
    (registration_id,kind,url,evidence_url,evidence_source,employer_key,status,checked_at,check_reason)
  select distinct on (c.registration_id, l.url) c.registration_id,'careers',l.url,l.evidence,l.method,
    c.employer_key,'public',now(),'Public employer careers page confirmed'
  from completed c cross join lateral jsonb_to_recordset(c.links) l(url text,evidence text,method text)
  where c.status='public'
  order by c.registration_id,l.url,l.evidence
  on conflict (registration_id,kind,url) do update set status='public',checked_at=excluded.checked_at,
    check_reason=excluded.check_reason,evidence_url=excluded.evidence_url,evidence_source=excluded.evidence_source
  where stored.status<>'public'
  returning registration_id
)
select jsonb_build_object(
  'checked',(select count(*) from completed),
  'websitesVerified',(select count(*) from completed where website_evidence<>''),
  'careersVerified',(select count(*) from saved)
);
commit;
`)
      )
      totals.checked += result.checked
      totals.websitesVerified += result.websitesVerified
      totals.careersVerified += result.careersVerified
    }
    await checkByHost(
      queue,
      async (site) => {
        const result = await probeEmployerCareers({
          url: site.url,
          legalName: site.legal_name,
          registrationId: site.registration_id,
          verified: site.status === "public",
        })
        pending.push({ site, ...result })
        outcomes[result.result] = (outcomes[result.result] ?? 0) + 1
        if (pending.length === 40) save()
      },
      128
    )
    save()
    console.log(JSON.stringify({ batch, ...totals, outcomes }))
  }
  console.log(JSON.stringify({ completedAt: new Date().toISOString() }))
}

async function findCompanySites() {
  const companies: Company[] = JSON.parse(
    database(`
select coalesce(jsonb_agg(candidate),'[]'::jsonb) from (
  select c.registration_id,c.legal_name
  from public.registry_company c
  where lower(c.company_status)='active'
    and (c.discovery_checked_at is null or c.discovery_checked_at < now()-interval '30 days')
    and not exists (
      select 1 from public.registry_company_link l
      where l.registration_id=c.registration_id and l.kind in ('website','careers')
        and l.status in ('pending','public','deferred')
    )
  order by c.discovery_checked_at nulls first,c.registration_id limit ${domainLimit}
) candidate;
`)
  )
  const counts: Record<string, number> = {}
  for (let offset = 0; offset < companies.length; offset += 12) {
    const results = await Promise.all(
      companies.slice(offset, offset + 12).map(async (company) => {
        const matches = await probeEmployerSites(company.legal_name)
        const status =
          matches.length === 1
            ? "confirmed"
            : matches.length
              ? "ambiguous"
              : "unresolved"
        counts[status] = (counts[status] ?? 0) + 1
        return {
          ...company,
          status,
          website: matches.length === 1 ? matches[0].website : null,
        }
      })
    )
    database(
      `
begin;
create temp table company_probes on commit drop as
select * from jsonb_to_recordset(:'results'::jsonb) as r(registration_id text,status text,website text);
update public.registry_company c set discovery_checked_at=now(),discovery_result=r.status
from company_probes r where c.registration_id=r.registration_id;
insert into public.registry_company_link(registration_id,kind,url,evidence_url,evidence_source,employer_key)
select c.registration_id,'website',r.website,r.website,'Company website identity verified from published page',c.name_key
from company_probes r join public.registry_company c using(registration_id)
where r.status='confirmed'
on conflict(registration_id,kind,url) do nothing;
commit;
`,
      { results: JSON.stringify(results) }
    )
  }
  return { checked: companies.length, ...counts }
}

type RegistryCandidate = SourceCandidate & { registration_id: string }

async function connectFeeds() {
  const candidates: RegistryCandidate[] = JSON.parse(
    database(`
select coalesce(jsonb_agg(candidate),'[]'::jsonb) from (
  select f.registration_id,f.source_id as id,f.kind,f.board,f.evidence_url,
    c.legal_name as expected_company,null as historical_checked_at
  from public.registry_feed_candidate f join public.registry_company c using(registration_id)
  where f.next_attempt_at <= now()
    and exists (select 1 from public.registry_company_link l
      where l.registration_id=f.registration_id and l.kind='careers'
        and l.status='public' and l.url=f.evidence_url)
  order by f.next_attempt_at,f.source_id,f.registration_id limit 50
) candidate;
`)
  )
  if (!candidates.length) return { considered: 0, activated: [] as string[] }
  const db = supabaseServerClient(30_000)
  const store = new CandidateStore(db)
  const ids = [...new Set(candidates.map((c) => c.id))]
  const current = await db
    .from("job_source_directory")
    .select("id")
    .in("id", ids)
    .eq("enabled", true)
    .contains("countries", ["India"])
  if (current.error) throw current.error
  const connected = new Set(current.data.map((source) => source.id))
  const activated: string[] = []
  const byId = new Map<string, RegistryCandidate>()
  for (const candidate of candidates) {
    if (!connected.has(candidate.id) && !byId.has(candidate.id))
      byId.set(candidate.id, candidate)
  }
  if (byId.size) {
    const pending = [...byId.values()]
    await store.import(
      linkDiscoveryOrigin(
        pending.map((c) => c.evidence_url),
        pending
      ),
      pending
    )
    const validation = await store.validate({
      ids: [...byId.keys()],
      limit: byId.size,
      apply: true,
      maxMs: 240_000,
      candidateMs: 12_000,
    })
    for (const row of validation.results) {
      if (
        row.result?.status === "verified" &&
        row.result.countries.includes("India")
      ) {
        await store.activate(
          [row.id],
          "Local India registry source with a public careers link and live provider validation for India jobs."
        )
        connected.add(row.id)
        activated.push(row.id)
      }
    }
  }
  const results = candidates.map((c) => ({
    registration_id: c.registration_id,
    source_id: c.id,
    result: connected.has(c.id)
      ? "connected"
      : "awaiting public India feed validation",
  }))
  database(
    `
update public.registry_feed_candidate f
set result=r.result,next_attempt_at=case when r.result='connected' then 'infinity'::timestamptz else now()+interval '1 hour' end
from jsonb_to_recordset(:'results'::jsonb) as r(registration_id text,source_id text,result text)
where (f.registration_id,f.source_id)=(r.registration_id,r.source_id);
`,
    { results: JSON.stringify(results) }
  )
  return { considered: candidates.length, matched: connected.size, activated }
}

if (scheduled) {
  const id = randomUUID()
  const claimed = database(
    `
begin;
select pg_advisory_xact_lock(927451310);
update public.registry_hourly_run set finished_at=now(),summary='{"interrupted":true}'::jsonb
where finished_at is null and started_at <= now()-interval '50 minutes';
insert into public.registry_hourly_run(id)
select :'id'::uuid where not exists (select 1 from public.registry_hourly_run where finished_at is null)
returning id;
commit;
`,
    { id }
  ).trim()
  const summary: Record<string, unknown> = {}
  if (claimed === id) {
    try {
      const mapLinks = mapScrape ? mapQueue() : []
      const mappedSources = new Set(
        mapLinks.map((link) => JSON.stringify([link.registration_id, link.url]))
      )
      if (mapScrape) {
        summary.firecrawl = await checkLinks(mapLinks, 4, true)
        console.log(JSON.stringify({ firecrawl: summary.firecrawl }))
      }
      summary.websites = await checkLinks(linkQueue("website", limit))
      console.log(JSON.stringify({ websites: summary.websites }))
      summary.careers = await checkLinks(
        linkQueue("careers", careersLimit, true).filter(
          (link) =>
            !mappedSources.has(JSON.stringify([link.registration_id, link.url]))
        )
      )
      console.log(JSON.stringify({ careers: summary.careers }))
      summary.feeds = await connectFeeds()
      console.log(JSON.stringify({ feeds: summary.feeds }))
      summary.domains = await findCompanySites()
    } catch (error) {
      summary.failed = true
      throw error
    } finally {
      database(
        `update public.registry_hourly_run set finished_at=now(),summary=:'summary'::jsonb where id=:'id'::uuid;`,
        { id, summary: JSON.stringify(summary) }
      )
      console.log(JSON.stringify({ id, ...summary }))
    }
  } else {
    console.log(JSON.stringify({ skipped: "A local registry run is active" }))
  }
} else if (careerDiscovery) {
  await discoverRegistryCareers()
} else if (oneTime) {
  const startedAt = database("select clock_timestamp();").trim()
  console.log(JSON.stringify({ startedAt }))
  for (const kind of ["website", "careers"] as const) {
    for (let batch = 1; ; batch++) {
      const queue = linkQueue(kind, limit, false, startedAt)
      if (!queue.length) break
      const result = await checkLinks(queue, 80)
      console.log(JSON.stringify({ kind, batch, ...result }))
    }
  }
  console.log(JSON.stringify({ completedAt: new Date().toISOString() }))
} else {
  const kind = values.kind as Link["kind"]
  console.log(
    JSON.stringify(
      { kind, ...(await checkLinks(linkQueue(kind, limit))) },
      null,
      2
    )
  )
}
