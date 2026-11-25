# Source connector architecture

## Merged implementation

Source connections and job eligibility have separate entry points:

```text
Source identity + configuration
             |
    connectors/index.ts
             |
    shared provider reader
       /              \
fetchSourcePage    fetchCatalogPage
source facts      configured catalog category projection
       |              |
research policy   existing leased collection and publication
```

`fetchSourcePage(source, page, options)` returns `postings`, `fetched`,
`requests`, and `nextPage`. Its source facts retain other professions, all stated
locations, and unknown descriptions, countries, and posting dates. A source's
explicit query scope still applies. Consumers decide which jobs they want.
`fetchCatalogPage` applies consumer category policy and the existing posting
identity rules. Its default remains software; `FetchOptions.jobCategories`
selects additional supported categories. Scheduled collection requests all eight
categories in `lib/jobs/categories.ts`; each user's profile selections then gate
matching. Source facts remain independent of those selections.

Both entry points use the same registry, source identity checks, bounded HTTP
transport, pagination, and provider readers. The compatibility adapters emit
`RawSourcePosting` observations before catalog eligibility checks; existing
catalog normalization has not been rewritten as part of this merge.

- The registry includes Greenhouse, Ashby, Lever, SmartRecruiters, Workday,
  Recruitee, Workable, Keka, Zoho Recruit, Teamtailor, Personio, Arbeitnow,
  LinkedIn, Amazon, Oracle, Accenture, IBM, and Infopark.
- Direct India employer readers include Amazon's full category search, Oracle's
  date-scoped full-detail inventory, and eleven bounded Accenture family feeds.
  Verified Oracle tenants include JPMorgan Chase, Nokia, and Emerson; the
  30-day detail-date bound is enforced after the provider's day-level search.
  Honeywell is supported but remains disabled pending complete posting content.
  IBM reads the full public search body in a pinned India/30-day window, checks
  exact totals and page boundaries, and uses the provider document ID to order
  otherwise tied results. Search teasers and unknown posting dates are not used.
  Accenture queries that hit the provider result cap fail without publishing.
  Distinct verified requisition IDs survive recommendation deduplication even
  when their titles, cities, and descriptions match; overlapping feeds of the
  same requisition collapse. Title/city fingerprints alone are not identity.
  Specific AI/full-stack and software-platform consultant titles require
  discipline-specific implementation evidence before entering software scope.
  Generic consulting or employer technology keywords do not qualify them.
- Discovery validation uses that registry and its response-format metadata.
  Source admission checks live employer identity and usable posting evidence
  independently of profession. Source activation still does not publish jobs.
- `scripts/lib/registry-job-ats.mts` adapts shared source facts to research
  observations. `registry-job-scraper.mts` uses the same entry point for Infopark.
- Public JSON/RSS feed parsing lives in `connectors/public-feeds.ts`; the
  professional-portal adapter applies India/profession/expiry policy afterward.
  These research feeds are not automatically enabled in the scheduled catalog.

Keka and Zoho host checks now allow their canonical employer domains during
normal validation, while refusing lookalikes and reserved subdomains. Keka
retains multiple cities within a country. Its default career portals use the
official same-origin active-jobs API only after portal markers and the employer
domain match; custom portals retain their GUID-scoped embed API. Incomplete or
duplicate inventories fail without publication. Greenhouse and Lever regional reads
use explicit `config.region` so EU boards stay on EU endpoints.
URL-based research preserves that region automatically; the existing candidate
store does not yet persist it, so scheduled EU sources need explicit source
configuration.

### Adding connections now

For a supported ATS, use an observed career URL, then the existing candidate
import, validation, and activation flow. For a new provider, add a reader beside
the connectors, emit source observations before consumer eligibility, register
it in `connectors/index.ts`, and add fixture tests for identity, raw facts,
pagination, and refusals. Providers with discoverable employer boards also need
canonical identity/URL and trusted-host rules in `source-identity.ts`.

The current database still has source-kind constraints and scoped-search
allow-lists. New scheduled source kinds therefore still require a reviewed
migration. Migration `202611170076_keka_zoho_recruit_sources.sql` adds those two
families; the merge does not apply it to a hosted database.

Migration `202611170077_teamtailor_personio_sources.sql` adds Teamtailor and
Personio to candidate admission, collection and scoped source selection. Their
board identifiers retain the full canonical tenant hostname. Custom domains and
redirects require separate review. Teamtailor reads bounded RSS offset pages and
checks page overlap; Personio validates its XML inventory and reads up to ten
detail pages per call for actual posting dates and explicit location evidence.
Personio's XML `createdAt` is not treated as a posting date.

### Scope and completion

Raw does not mean an unlimited scrape. Amazon and Oracle use explicit source
configuration; LinkedIn reads bounded search windows; Workday refuses inventories
at its 2,000-result cap. Failures retain prior completed research pages as partial
results, and a page cursor reaching `null` describes only that configured query.
Missing facts remain missing. No new sources are activated or collected by
changing the code alone.

The sections below describe the broader target design. Generic config-backed
storage, standalone normalization stages, cross-source fingerprint precedence,
two-run expiry, and automatic source pausing remain future work.

## Target design

Goal: adding a job source should be **one file plus one registry line** for a new platform, and **zero code** for a new employer on a platform we already support.

## Why the current setup doesn't scale

Adding a source touches 5–7 places today:

| Concern | Where it lives now |
|---|---|
| Kind union | `CatalogSource.kind` in `feeds.ts`, `boardKinds` in `source-identity.ts` |
| Dispatch | `if (source.kind === …)` chain in `fetchCatalogPage` (`feeds.ts`) |
| Identity and URL parsing | `boardIdentity`, `publicBoardUrl`, `boardFromUrl` in `source-identity.ts` |
| DB allow-list | `check (kind in (…))` plus per-kind board checks, a new migration each time (0060, 0074, 0075) |
| Posting shape | `CatalogPosting` (app), `ScrapedPosting` and `JobObservation` (scripts), portal feed kinds in `professional-job-portals.mts` |
| ATS parsing | Implemented twice: `lib/server/catalog/*` and `scripts/lib/registry-job-ats.mts` |
| Normalization | Mixed into each fetcher (country aliases, India location regexes inside the Greenhouse parser) |

So the scripts pipeline and the app catalog have already drifted apart. Every new source makes that worse.

## Model: three separate things

```
Connector (code)    one per platform or protocol: greenhouse, lever, workday, darwinbox,
                    himalayas, rss, jsonld-careers, infopark, naukri-browser
Source (data)       one row per thing to collect: connector + config + policy
                    (greenhouse/{board:"razorpay"}, rss/{url, mapping}, himalayas/{country:"IN"})
Pipeline (shared)   fetch → normalize → filter → identify/dedupe → persist → expire → health
```

A connector only knows how to read its platform. It knows nothing about countries, roles, visas, dedupe or storage.

## Connector contract

```ts
// lib/server/sources/contract.ts
export type ConnectorFamily = "ats" | "board" | "feed" | "employer-site" | "park"

export interface Connector<Config> {
  id: string                                  // "greenhouse"; stored on source rows
  family: ConnectorFamily
  config: z.ZodType<Config>                   // validates source.config jsonb
  identity(config: Config): { key: string; publicUrl: string }
  matchUrl?(url: URL): Config | null          // careers URL → config (discovery hook)
  transport: "http" | "browser"
  limits: { requestsPerMinute: number; maxPages: number }
  policy: { termsUrl?: string; robots: "respect" | "api"; attribution?: string }
  fetchPage(
    ctx: FetchContext,                        // budgeted fetch/browser, signal, clock, logger
    config: Config,
    cursor: string | null
  ): Promise<{ postings: RawPosting[]; next: string | null; complete: boolean }>
}

// What every connector emits: raw facts, no interpretation
export interface RawPosting {
  externalId: string | null
  url: string                                 // canonical apply/detail URL
  title: string
  company: string                             // as stated by the source
  employerUrl?: string                        // feeds discovery when known
  locations: string[]                         // raw strings, normalized centrally
  workplace?: string                          // raw ("Remote", "Hybrid", …)
  postedAt?: string | null
  expiresAt?: string | null
  descriptionHtml?: string
  descriptionText?: string
  salaryText?: string                         // "12–18 LPA", "$120k"
  experienceText?: string                     // "4-6 yrs"
  raw?: Record<string, unknown>               // kept for re-normalization
}
```

Registry:

```ts
// lib/server/sources/connectors/index.ts
export const connectors = {
  greenhouse, lever, ashby, workday, smartrecruiters, recruitee, workable,
  oracle, amazon, linkedin, infopark, arbeitnow,
  himalayas, remotive, jobicy, remoteok, rss,
} satisfies Record<string, Connector<any>>
export type ConnectorId = keyof typeof connectors
```

`fetchCatalogPage` reduces to `connectors[source.connector].fetchPage(...)`.

## Shared pipeline (connector-agnostic)

1. **Fetch.** `source-worker.ts` keeps its lease, budgets and receipts and calls the connector through `FetchContext`. Connector `limits` set per-host rate limits.
2. **Normalize.** One module, `normalize/`: location → `{country, city, region}` (India aliases: Bangalore→Bengaluru, Gurgaon→Gurugram, NCR, "Remote - India", `IND`), workplace, dates, salary (LPA/CTC/currency), experience range, HTML→text.
3. **Filter.** Software-role scope, country scope and freshness (30 days), from per-source policy plus global config.
4. **Identify and dedupe.** Each posting gets a `posting_key` (connector + externalId or canonical URL) and a `job_fingerprint` (normalized company + title + city). When fingerprints match across sources, precedence decides which record wins: employer ATS > employer site > park > board > feed.
5. **Persist.** The existing snapshot and retention path writes `CatalogPosting`. Visa signal and sponsorship are computed here, not in connectors.
6. **Expire.** A posting missing from 2 consecutive complete runs is expired. Partial runs never expire anything.
7. **Health.** Per-source counters: fetched, kept, deduped, India share, errors, last success. A source auto-pauses after N consecutive failures.

## Discovery is pluggable too

```ts
export interface Discoverer {
  id: string                                   // "registry-mca", "aggregator-employers", "careers-link-sniff"
  discover(ctx): AsyncIterable<{ connector: ConnectorId; config: unknown; evidence: string }>
}
```

- Careers-page sniffing tries every connector's `matchUrl`. A new ATS connector therefore makes discovery recognize that ATS automatically, which replaces `boardFromUrl`.
- Board and feed postings that carry `employerUrl` or company names are emitted as employer leads, which lets aggregators feed ATS discovery.
- Codex's registry, site-probe and careers-probe scripts become discoverers that insert `sources` rows in a `proposed` state. Validation (`discovery/validate.ts`) promotes them to `active`.

## Storage changes

```sql
alter table catalog_sources
  add column connector text,           -- replaces kind; validated in app against the registry
  add column config jsonb not null default '{}',
  add column policy jsonb not null default '{}',
  add column state text not null default 'active';  -- proposed | active | paused | retired
-- drop the kind/board check constraints; zod on connector.config is the gate
```

After the one-time backfill (`kind`/`board` → `connector`/`config`), adding a connector needs no migration.

**One store:** postings from every path (app worker, scripts, browser) go through this pipeline into the catalog. The local `india_employer_registry` Postgres stays as a research and lead database only. Its output is `sources` rows, not postings.

## Adding a source after this lands

| Case | Work |
|---|---|
| New employer on a supported ATS | None. Discovery or a manual insert creates a `sources` row. |
| New RSS/JSON feed with standard fields | None. Add a row with `connector: "rss"` and a field mapping in `config`. |
| New platform (Darwinbox, Keka, Technopark) | One connector file, one registry line, one contract test |
| Login or CAPTCHA board | Connector with `transport: "browser"`. `FetchContext` supplies Browserbase and the CAPTCHA worker. |

Contract test kit: `runConnectorContract(connector, syntheticResponses)` asserts config validation, identity stability, pagination termination, URL safety (https, no credentials) and a non-empty `RawPosting` mapping. Every connector gets this test for free.

## Migration plan

0. **Prerequisite:** Codex's uncommitted catalog and scripts work lands on a branch. This refactor touches the same files.
1. **Contract and registry.** Add `contract.ts`, `RawPosting`, the `normalize/` module and the registry. Wrap the existing fetchers as connectors without changing behavior. `fetchCatalogPage` dispatches through the registry. Existing tests must pass unchanged.
2. **Storage.** Add `connector`/`config`/`policy`/`state` columns, backfill them, switch reads over, then drop the kind check constraints.
3. **Pipeline extraction.** Move normalization, filtering and visa logic out of the fetchers into shared stages. Add `job_fingerprint` dedupe and source precedence.
4. **Unify scripts.** Port `professional-job-portals.mts` feeds (Himalayas, Remotive, Jobicy, RemoteOK, RSS) and `registry-job-ats.mts` to connectors. Scripts become thin CLIs over the same pipeline. Delete the duplicate ATS parsers.
5. **Discovery interface.** Wrap the registry and careers probes and aggregator employer extraction as discoverers that write `proposed` sources.
6. **Prove it.** Add Darwinbox, Zoho Recruit, Keka and Technopark as connectors. Each should take one file. If any needs more, fix the contract.

## Decisions to confirm

- The catalog in Supabase is the single system of record for postings. The India registry DB is for leads only.
- Connector IDs are free text validated in the app, not a DB enum.
- Source precedence for duplicate postings: employer ATS > employer site > park > board > feed.
