# Systematic employer and career-site discovery

Research date: 2026-10-30. Scope: grow a broad, shared public-job catalogue across professions and destinations by discovering actual employer sources. This report combines primary documentation, pinned open-source implementation review, a parsed historical directory and bounded live HTTP checks. It does not claim worldwide coverage or a deployed discovery service.

## Recommendation

Build a persistent discovery pipeline in front of the existing collector. Start with attributed public board directories and the ATS platforms already supported locally. Grow the directory through Common Crawl URL metadata, verified employer domains and their career links, then custom-site structured data and employer-submitted feeds.

We have enough evidence to make the first implementation concrete. The fastest bootstrap is a historical source-candidate import with live validation, followed by continuous discovery. Purchasing a hosted job catalogue is an optional gap-filling path, not a prerequisite for this design. Public access, candidate-data licensing and commercial job-content reuse remain separate source decisions.

~~~mermaid
flowchart LR
  A[Historical board directories] --> D[Persistent source candidates]
  B[Common Crawl URL metadata] --> D
  C[Employer domains and career links] --> D
  H[Verified employer submissions] --> D
  D --> E[Identity, access and live validation]
  E --> F[Approved source directory]
  F --> G[Due-source collector]
  G --> I[Fresh searchable vacancies]
~~~

Supporting investigations:

- [Established portal acquisition methods](research/job-portal-acquisition.md).
- [Bootstrap datasets, Common Crawl and current search APIs](research/employer-discovery-bootstrap.md).
- [Reusable open-source discovery implementations](research/open-source-discovery.md).
- [Bounded live-check receipt](research/employer-discovery-probes.json).

## 1. What established portals actually do

First-party evidence supports several intake channels operating together:

| Portal | Documented mechanism | Useful pattern |
| --- | --- | --- |
| Indeed | Employers can request aggregation from a career site or ATS; existing ATS integrations take precedence. | Accept known-source submissions and verify their jobs. [Official help](https://www.indeed.com/help/employers/articles/what-is-aggregation?co=US&hl=en). |
| LinkedIn | Job Wrapping explicitly supports scraping, XML and API. Setup asks for source URL, employer identity and expected open-job count. | Maintain an explicit source record and completeness evidence. [Official setup](https://www.linkedin.com/help/linkedin/answer/a1306845). |
| Jooble | Its crawler indexes public company sites, job boards and government resources; publishers can also submit a URL or XML feed. | Combine automated discovery with cooperative source onboarding. [Official explanation](https://jooble.org/how-jooble-works). |
| ZipRecruiter | Partners provide a full XML snapshot; stable reference numbers determine adds, changes and removals. | Only infer closures from a complete, successful source snapshot. [Feed contract](https://www.ziprecruiter.com/partner/documentation/feed-import/). |

These documents establish working acquisition patterns. They do not disclose a universal global employer-seeding algorithm, nor establish that most job portals use an identical system. Partner APIs that send jobs into a portal are not general APIs to retrieve that portal's inventory.

## 2. Concrete initial directories are available

The strongest stack-aligned bootstrap is [Open ATS Feed](https://github.com/veresk06/open-ats-feed/tree/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/docs/data). We fetched and parsed all six committed CSVs at that September 5, 2026 revision: **18,164 board rows**, including **11,309 across Greenhouse, Ashby and Lever**, the ATS families already supported locally. The remaining rows cover Breezy, Recruitee and Teamtailor and need additional adapters. Its repository carries an [MIT licence](https://github.com/veresk06/open-ats-feed/blob/01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108/LICENSE); retain applicable notices. Recorded posting counts describe the old snapshot, not present vacancies.

These are candidate source identities for revalidation, not an automatic increase in our live catalogue. Multiple boards can represent the same employer, and region/host support still needs validation. The [detailed source audit](research/open-source-discovery.md) records per-file counts and code limits.

We also independently fetched and parsed the [LastRound AI ATS directory](https://github.com/fyrosofttech/lastroundai-hiring-data/blob/2816bfadd65b7bbec23701dd036bcc7496c729db/ats-directory/README.md) at pinned revision 2816bfadd65b7bbec23701dd036bcc7496c729db. The two lists can overlap; their counts must not be added without canonical deduplication.

| Property | Observed |
| --- | ---: |
| Historical vendor/board records | 9,935 |
| Unique vendor/board pairs | 9,935 |
| Greenhouse | 4,966 |
| Ashby | 2,856 |
| Lever | 2,113 |
| File size | 442,356 bytes |

The records contain employer name, ATS vendor, board slug and historical check date. Dates span July 11 through August 1, 2026; no current country or profession coverage is established. A vendor/board pair is not necessarily a distinct employer, and a historical record is not an open vacancy.

Attribution: LastRound AI, [Job Posting Pay Transparency Study](https://lastroundai.com/blog/salary-transparency-study-2026), directory declared [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Preserve source revision, attribution and historical observation date when importing candidates. This declaration does not grant blanket rights to employers' descriptions. The author's own limitations require live revalidation.

### Small live validation

Three deliberately selected historical seed entries were checked once against public endpoints on 2026-10-30:

| Seed label | Public endpoint result | Boundary |
| --- | --- | --- |
| HealthSherpa / Ashby / healthsherpa | HTTP 200; one returned posting | One board response at one time. |
| HealtheConnections / Greenhouse / healtheconnections | HTTP 200; three returned postings | One board response at one time. |
| Health Services Advisory Group, Inc. / Lever / hsag | HTTP 200; one returned posting | Request deliberately limited to one; not a board total. |

This validates a small part of the path from historical candidate to a responding board with postings. It does not establish full-directory liveness, employer-ownership precision, posting accuracy, candidate relevance, geographic coverage or a representative success rate. No source was enabled and no job was published to our portal. Exact URLs and request bounds are in the [receipt](research/employer-discovery-probes.json).

## 3. Continuous discovery: several complementary channels

### A. Common Crawl ATS URL harvesting

Hosted ATS URLs encode source identities: path-based boards for platforms such as Ashby/Greenhouse/Lever, and tenant subdomains for others. Query historical URL metadata, extract canonical vendor/site candidates, retain archive/capture provenance, deduplicate, then perform current source validation.

The [Common Crawl URL Index](https://commoncrawl.org/url-index) supports bulk analytical filtering. The [CDX server](https://index.commoncrawl.org/) supports narrower URL lookups and explicitly discourages broad bulk requests. This is URL-index discovery; CDX does not search every page body for arbitrary career-related text. Neither index is a live-jobs feed.

Our bounded check read the current collection list and queried one host prefix in CC-MAIN-2026-43. Page-count metadata returned HTTP 200 with two index pages; fetching the first page once returned HTTP 504. No candidate count is inferred from that failed page. This supports making discovery resumable and keeping the shared CDX service off the critical path for customer requests. For larger sweeps, evaluate official bulk-index access or a tested range-reader with strict size and response validation. No bulk scan or cloud query was run.

### B. Employer domains to career sites

Start from documented employer websites rather than inventing domains from company names. Read allowed homepage/footer/sitemap links, follow a bounded career path, inspect ATS links/iframes/embedded configuration and retain the link chain that associates employer with board. Support local-language career vocabulary and multiple regional boards.

Broader domain seeds can come from [Wikidata organization websites](https://www.wikidata.org/wiki/Property:P856), licensed company directories, official sector/employer sources and employer submissions. Wikidata structured data is [CC0](https://www.wikidata.org/wiki/Wikidata:Licensing); accuracy still requires checking. India's [company master-data catalogue](https://www.data.gov.in/catalog/company-master-data) supplies organization context, not a complete website or hiring directory. Headquarters must remain separate from job destination.

### C. Historical structured-job domains

[Web Data Commons](https://webdatacommons.org/structureddata/2024-12/stats/schema_org_subsets.html) publishes a JobPosting subset derived from October 2024 Common Crawl, including domain lookup/statistics files. Those files can propose custom career domains without initially downloading the multi-gigabyte posting corpus. They include aggregators and historical sites, so classify the source, exclude inappropriate types, resolve current career surfaces and validate access/use conditions. The publisher lists 63,320 hosts for that historical subset; this is not a count of current direct employers or live jobs. No WDC dataset was downloaded or independently counted here.

Known sites can expose job-detail [JobPosting structured data](https://developers.google.com/search/docs/appearance/structured-data/job-posting) and [sitemaps](https://www.sitemaps.org/protocol.html). Extract current facts from those pages with provenance. Sitemap lastmod is not necessarily a posting date or a confirmation that applications remain open.

### D. Public hiring lists and inbound submissions

Review source licences, extract actual career/ATS links from public lists and preserve where each link came from. These lists complement other channels; they often overrepresent technical or early-career employers. Do not sum list counts without canonical deduplication.

Later, let verified employers submit their career URL or feed. This follows documented portal acquisition patterns and reaches employers the automated channels miss. An ownership-verification and source-claim flow should precede publication changes; employer identity must not be taken from arbitrary submitted text.

### E. Supported search APIs for residual gaps

Use search for unresolved domains and undercovered segments after cheaper discovery paths. Do not build a new dependency on obsolete Google/Bing APIs: [Google Custom Search](https://developers.google.com/custom-search/v1/overview) is closed to new customers with an existing-customer transition deadline, and [Bing Search APIs](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) retired in 2025. A current provider such as [Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search) needs its own terms/budget evaluation. No search-provider account or paid API call was made.

## 4. Implementations worth adapting

### Freehire's own discovery engine

This is [strelov1/freehire](https://github.com/strelov1/freehire), separate from the original personal job-search toolkit. At pinned revision 8f41c56537434d843d48e69f25ceb12a04fc91cc:

- [Common Crawl harvester](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/commoncrawl.go): archive URL to board-candidate extraction.
- [Employer-domain resolver](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-ats/resolve.go): homepage/career-link traversal and ATS detection.
- [Public-list harvester](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/scripts/harvest_boards.py): existing hiring links to candidates.
- [Board validation](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/cmd/harvest-boards/main.go): live probing, optional employer/posting corroboration, failure accounting and pending insertion.
- [Persistent board lifecycle](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/internal/ingest/boardcatalog/catalog.go): pending/active/rejected/retired states.

Its [MIT licence](https://github.com/strelov1/freehire/blob/8f41c56537434d843d48e69f25ceb12a04fc91cc/LICENSE) supports selected code reuse with notices. Port bounded components into our existing TypeScript/Postgres contracts. Do not import its technical-role filters, permissive probe defaults or assumptions that truncated discovery is complete. Its hosted employer database is not bundled simply by cloning the code.

### Smaller Node-based alternative

[open-ats-feed](https://github.com/veresk06/open-ats-feed) implements the same core discovery idea with Node scripts and historical board data. Its range-based archive harvester and shared token parser are particularly relevant to our stack; the [open-source investigation](research/open-source-discovery.md) records the pinned revision, independently parsed CSV counts, inspected code and limitations. The CSV arithmetic is verified; current liveness is not. Upstream code needs response-size, partial-run and public-listing checks before adaptation. This smaller source-directory/harvester is the preferred first implementation reference, with Freehire supplying the wider employer-domain layer.

Other investigated sources have narrower utility: Outscal OpenJobs is a gaming/tech directory; Elliott Dehn's Open Jobs contains historical seeds and crawler design but its own README records an October 10, 2026 shutdown. Details and licences are in the same investigation. Do not depend on a frozen dataset for current vacancies.

## 5. Fit with our current application

Current local source inspection, not a claim about live deployment:

| Existing component | Reuse | Required change |
| --- | --- | --- |
| [catalog/directory.ts](../lib/server/catalog/directory.ts) | Existing ATS URL recognition and disabled candidates. | Add discovery inputs independent of already-ingested jobs; retain method, evidence, revision and state. |
| [catalog/feeds.ts](../lib/server/catalog/feeds.ts) | Ashby, Greenhouse and Lever parsers/collection. | Probe candidates through a shared canonical recognizer; keep regional host/site distinctions. |
| [catalog/sync.ts](../lib/server/catalog/sync.ts) | Leases, page cursors, durable backoff, full publication. | Replace small-subset completion as a global freshness signal; schedule all due sources fairly. |
| [sponsor-sources/enrich.ts](../lib/server/sponsor-sources/enrich.ts) | Career-link traversal ideas and HTML parsing. | Its website resolver accepts guessed domains after a successful fetch; that is insufficient employer-identity evidence. |
| [sponsor-sources/pipeline.ts](../lib/server/sponsor-sources/pipeline.ts) | Some source/extraction utilities. | Legacy software-company filters and sponsorship assumptions are unsuitable for broad discovery. Keep the new path provider-neutral. |
| [account-store.ts](../lib/server/account-store.ts) | Explainable account-specific matching and ownership. | Larger inventory needs indexed candidate retrieval and recall checks; current scans have a request-time budget. |

## 6. Proposed discovery contract

Keep employer/domain, career surface, canonical source and vacancy identities distinct. One employer can have multiple boards, switch ATS or hire in several countries.

Every candidate should retain: original URL and evidence URL; discovery method and source revision; original observation date; normalized provider/site/region; expected employer or known posting evidence where available; live validation status/time; schema and access-policy result; reason codes; next attempt and bounded attempt history. Multiple discovery observations should merge into one source identity without losing provenance.

Suggested states: discovered, awaiting-validation, verified-with-jobs, verified-empty, needs-review, deferred, rejected and retired. Schema-valid empty is different from nonexistent; 429/timeout/403 is different from empty. Reachability is different from established employer identity and from approval for commercial use.

For already-reviewed source families, an explicit source policy can permit automatic promotion after required identity/schema checks and a complete first collection. Unresolved identity, access or adapter behavior stays reviewable. This would change the current disabled-by-default workflow and needs an explicit implementation decision; this report does not enable it.

Network work must use public-network URL/DNS/redirect validation, bounded bodies/pages/time, clear crawler identity, robots handling and per-provider/host throttling. Never bypass authentication/CAPTCHA or copy refusal workarounds as a discovery strategy. Preserve source licence decisions and required attribution; rechecking a licensed list does not erase its obligations.

## 7. Concrete implementation sequence and verification

1. **Candidate import and validation.** Add durable candidate/observation storage and a report-only import/probe command. Import the pinned Open ATS Feed supported-platform rows plus the attributed LastRound directory as historical candidates, deduplicate across inventories and against existing sources, and validate bounded batches on our three supported ATS families. Keep invalid, empty, blocked, unsupported and deferred outcomes visible. Verification: importer fixtures for quoting/malformed fields/deduplication; canonical identity fixtures; safe network boundaries; no source activation or catalogue writes in report-only mode.
2. **First approved-source collections.** Connect validated candidates to the existing source directory under reviewed policies. Verification: real staged source snapshots, valid location/description fields, deduplication, public-listed filtering, partial-page preservation, closure semantics, lease fencing and candidate relevance. Capacity is bounded by observed host limits and free allowances, not by imported row count.
3. **Continuous discovery.** Add resumable Common Crawl candidate harvesting and employer-domain traversal, with fair per-method budgets. Verification: checkpoint/resume, archive timestamp preservation, explicit partial states, URL/tenant parsing, multilingual links, redirects and ownership evidence; measure overlap and new-source yield.
4. **Broader source classes.** Add custom-site JobPosting/sitemap extraction and ATS adapters according to observed gaps, including regional and non-technical hiring. Verification: actual diverse source samples, original-language preservation, location confidence and rejected-record diagnostics. Keep unsupported destinations selectable with accurate coverage.
5. **Operational scale.** Separate due-source dispatch from long page work; wake retries when due; report backlog age and healthy-source coverage. Add indexed serving as inventory grows. Verification: largest expected directory fits measured freshness/latency budgets without starvation or silently truncated recommendations.

Before bulk activation, report the complete funnel: imported candidates -> distinct sources -> identity-validated sources -> approved sources -> successfully collected sources -> valid vacancies -> distinct fresh vacancies -> relevant vacancies for candidate segments. Compare costs and elapsed time by discovery method. Do not set a job-volume promise from source-directory totals or extrapolate from the three seed checks.

### Capacity and cost boundary

Seed-list parsing is a small offline metadata task; probing and recurring job fetches create the ongoing workload. If all 11,309 supported-platform candidates eventually became approved sources and each were checked four times per day, that would mean **45,236 source checks per day before pagination, retries or discovery work**. This is illustrative arithmetic, not an observed load or a selected service promise. Job-body size, provider limits, active/empty-board mix, database publication and customer query cost must be measured before assigning that cadence.

Prioritize active-demand sources and rotate baseline checks across the remaining directory; give empty/rarely changing sources an appropriate cadence without losing them. Keep provider budgets, bytes, requests and backlog visible. Common Crawl data access is public, while bulk-query compute or an optional search API may cost money. No paid compute or allowance increase is part of this research. Source expansion should proceed in measured batches instead of enabling the entire worklist under the current small-batch scheduler.

## Research outcome

The acquisition approach is established, concrete source candidates exist, and reusable implementations are available. The recommended first slice is the attributed candidate importer plus live validator, integrated with the current source-directory contract. This research verifies feasibility for a small sample; it does not complete source expansion. No source enablement, bulk ingestion, application submission, migration, deployment or purchase was performed.
