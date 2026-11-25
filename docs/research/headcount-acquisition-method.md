# How Headcount Labs acquires jobs: public evidence

Research date: 1 November 2026. User direction: learn the acquisition method and build on our own collector; **no Headcount API integration**. This is public documentation research, not access to Headcount's production code or systems.

## What is actually disclosed

Headcount reads three source classes: employer ATS boards, multi-employer job boards and company career sites. It merges multiple postings into one canonical job while retaining each source, posting URL and application URL. Employer identity stays separate from the ATS platform identity. [Source model](https://headcountlabs.com/docs/ats-vs-job-boards/).

Its data-team guide describes the following acquisition paths. The guide is primary evidence of what Headcount publicly reports, not independent confirmation that every production adapter implements every detail. [ATS acquisition guide](https://headcountlabs.com/guides/ats-public-job-apis/).

| Source | Publicly described method |
|---|---|
| Greenhouse / Lever / Ashby | Employer-specific documented public JSON feeds; compensation options differ. |
| SmartRecruiters | Public Posting API, paginated by employer. |
| Workday | Career-site CXS JSON POST endpoint, requiring tenant, datacenter and site. Partition searches by facets around the reported 2,000-result cap; fetch details for exact dates/locations. |
| Oracle Recruiting Cloud | Career site's unauthenticated `recruitingCEJobRequisitions` endpoint, requiring host/site identity. |
| SAP SuccessFactors | Career-site sitemaps/search pages; some sites expose `/services/recruiting/v1/jobs`. |
| iCIMS | Public portal search/detail pages rather than a universal documented public feed. |
| Recruitee / Personio | Public JSON offers / XML feeds. |

The same guide describes finding board identifiers through employer career links, crawl archives such as Common Crawl, job-board apply backlinks and tested company-name guesses. Those are general acquisition techniques in its guide; it does not disclose the precise mix or scale used by Headcount internally. It warns about migrated boards, hidden jobs, rate limits and incomplete source fields.

There is also explicit evidence of structured page extraction: Headcount's APS Career Portal page says it reads public pages containing schema.org JSON-LD, with per-job detail URLs. Thus “ATS APIs instead of scraping” is not a universal binary: their documented model combines feeds, career-site JSON endpoints and structured HTML/page extraction. [APS adapter description](https://headcountlabs.com/platforms/apscareerportal/).

## Refresh, closure and quality

The FAQ claims daily board rereads and discovery throughout the day, while acknowledging some boards remain unread for over 30 days and their jobs are marked stale. A declared cadence is not evidence every board completes on schedule. It says duplicates retain original source links and unknown fields stay unknown. [FAQ](https://headcountlabs.com/faq/).

Headcount defines “last read” as completion of the board reader. Its verification process opens original postings and checks fields; blocked or browser-built pages can be recorded as unchecked rather than counted as passes. Closed jobs drop out after a later read confirms closure. These are observable quality semantics; the docs do not reveal its production retry scheduler or rendering strategy. [Verification](https://headcountlabs.com/verification/).

Descriptions and other fields distinguish source-supplied, derived, omitted and extraction-failed states. It preserves source-posted dates separately from first collection and last completed fetch. This supports provenance-aware normalization, but does not reveal the actual location/compensation parsing or duplicate matching algorithms. [Field dictionary](https://headcountlabs.com/docs/fields/).

## What is not open or verified

The linked [job-postings repository](https://github.com/HeadcountLabs/job-postings) holds documentation, dataset samples and consumer query examples. It does not supply the production source discovery, collector adapters, scheduler or deduplication engine. No public production collector was located in this research; this is not proof that none exists elsewhere.

Undisclosed details include initial employer seeds, discovery ranking, per-source budgets, browser usage, proxies, worker/concurrency design, retries, exact refresh prioritization, deduplication rules and the evaluation set behind quality claims. Consumer instructions for syncing from the Headcount API do **not** establish its internal acquisition architecture.

No provider endpoint was live-probed in this task, no new boards were enabled and no vacancy/source count was measured. Published examples are dated demonstrations, not current availability guarantees.

## What applies to our own collector

These are proposed improvements, not claims about Headcount internals:

1. Keep our existing Greenhouse, Lever and Ashby public-API readers. Their implementation is already in [feeds.ts](../../lib/server/catalog/feeds.ts); the task is to broaden coverage and discovery, not replace browser collection with APIs from scratch.
2. Grow the durable employer directory from attributed seeds plus bounded career-link/archive/apply-link discovery; validate board ownership and endpoint response before activation. A known board is not proof it has current vacancies.
3. Add documented feeds such as SmartRecruiters, Recruitee and Personio where measured candidate demand warrants them. Separately scope Workday/Oracle career-site endpoints, SAP and iCIMS page readers; unauthenticated endpoints are not equivalent to supported public APIs.
4. Prefer structured data: documented JSON/XML, then validated career-site JSON, then JobPosting JSON-LD or specific HTML extraction. Use browser rendering only where a tested source needs it. Preserve platform/employer access rules and existing public-network guards.
5. Preserve original ATS IDs, canonical employer identity, locations and source links. Retain source-posted and observed times separately; distinguish updates from new jobs. Treat cross-source deduplication as a tested matching problem rather than lowercasing titles.
6. Schedule from durable source health and due times; reuse current leases/checkpoints/backoff. Only a complete validated inventory can close missing jobs. A partial search slice must never expire an employer's whole catalogue.
7. Measure newly relevant jobs and source freshness, not only directory size. Prioritize a small set of missing provider/employer journeys, with fixture tests for pagination, caps, unknown fields, moved boards and confirmed closure.

No Headcount account, API, MCP connection, data import or application-code change is needed for these recommendations.
