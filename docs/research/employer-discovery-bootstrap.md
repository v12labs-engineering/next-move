# Employer and career-site discovery: bootstrap research

Research date: 2026-10-30. Scope: discovering source identities and employer career sites, separately from fetching jobs from a known board. This is research and a proposed implementation sequence, not a deployed discovery service. No jobs were published, no source was enabled, no paid service was purchased, and no bulk live crawl was run.

## Recommendation

Bootstrap a persistent source directory from attributed historical board lists, then grow it through focused URL-index discovery, employer-site career links, supported search APIs and inbound employer submissions. Validate candidates against the live source before classifying them as current. Broad coverage also requires employer-domain seeds outside the three startup-heavy ATS families.

Common Crawl should supply historical URL candidates; it cannot establish that a role is open today. Search should find missing sources rather than become a per-user scraping dependency. Employer domains, ATS boards, career sites and vacancies need distinct identities because one employer can have several career sites or change platforms. These are proposed design conclusions, not measurements of the whole job market.

## 1. A usable initial board directory exists

The author-published [LastRound ATS directory](https://github.com/fyrosofttech/lastroundai-hiring-data/blob/2816bfadd65b7bbec23701dd036bcc7496c729db/ats-directory/README.md) contains `ats_vendor`, `company_name`, `board_slug` and `last_crawled`. Its metadata declares CC BY 4.0 and requests attribution to LastRound AI plus a link to its pay-transparency study. Its [METHOD.txt](https://github.com/fyrosofttech/lastroundai-hiring-data/blob/2816bfadd65b7bbec23701dd036bcc7496c729db/ats-directory/METHOD.txt) says the boards were discovered through public APIs, explicitly calls the list incomplete and notes disappearing boards. The precise upstream discovery algorithm is not published in these files.

I fetched and parsed the actual [CSV](https://github.com/fyrosofttech/lastroundai-hiring-data/blob/2816bfadd65b7bbec23701dd036bcc7496c729db/ats-directory/lastroundai-ats-company-directory-2026-08.csv) at commit `2816bfadd65b7bbec23701dd036bcc7496c729db` (repository head observed during research), rather than relying only on its advertised count:

| Measured property of that file | Result |
| --- | ---: |
| CSV size reported by GitHub | 442,356 bytes |
| Parsed data records | 9,935 |
| Unique `(ats_vendor, board_slug)` pairs | 9,935 |
| Ashby / Greenhouse / Lever pairs | 2,856 / 4,966 / 2,113 |
| Empty company names or board slugs | 0 |
| Records with an unexpected field count | 0 |
| Historical check dates | July 11, July 12, July 17 and August 1, 2026 |

The parser handled quoted fields and quoted newlines. These counts describe historical directory records, not independently identified employers, live boards, open jobs, geographic reach, market coverage or candidate relevance. A company can occur under more than one vendor. There is no country or profession field in this dataset. Treat rows as unverified candidates and retain the original row/date/license provenance. Its dataset license is not a blanket license for each employer's job content.

## 2. Common Crawl can expand the URL frontier

### CDX: narrow URL-pattern lookups

The [Common Crawl Index Server](https://index.commoncrawl.org/) searches archived URL records and asks clients to use the columnar index for bulk filtering. The linked [pywb CDX API](https://pywb.readthedocs.io/en/latest/manual/cdxserver_api.html) supports exact, prefix, host and domain matching. It reads the index, not archived page bodies. For example, `jobs.ashbyhq.com/linear/*` is a prefix lookup for historical URLs. It does not search arbitrary HTML or find all pages containing the word “careers”.

For candidate discovery, narrow host/prefix queries can reveal board slugs in familiar ATS URL paths. Exclude reserved paths and validate results rather than assuming the first path segment always identifies an employer. A `limit` caps returned records; it does not make a sample an exhaustive list. Use pagination where supported. This is a design inference from the documented URL interfaces.

### URL Index: bulk filtering and distinct hosts/paths

The [Common Crawl URL Index](https://commoncrawl.org/url-index) is Parquet metadata with host, registered domain, path, response status, fetch time and WARC pointers. It supports SQL-style analysis through Athena, Spark or local tools such as DuckDB. It is free to access; computation and cloud query services can cost money. Partition and filter before reading. Broad `*.com` CDX requests are not an appropriate substitute for this bulk interface.

An initial offline job could select distinct ATS hosts and candidate first path segments from one crawl partition. The same metadata can identify career-looking paths on ordinary employer domains, including local-language path patterns. That is candidate generation, not a complete content classifier. WARC retrieval or a current fetch is needed to inspect page content. No full-index query or cloud job was executed in this research.

### WAT and WARC: inspect links and page content selectively

[Common Crawl's format documentation](https://commoncrawl.org/get-started) distinguishes raw WARC response data, WAT JSON metadata including HTML outlinks, and WET extracted plaintext. WAT can supply edges from employer sites to ATS boards; WARC can reveal embedded board links or scripts. Processing all WAT files is a large data operation, so start with selected domains/partitions rather than promising a cheap global link scan.

The [crawl inventory](https://index.commoncrawl.org/collinfo.json) observed during research listed `CC-MAIN-2026-43` as the October index, with capture dates October 5–18. That archive date is not current job availability. [Common Crawl's FAQ](https://commoncrawl.org/faq) says it samples the web, does not generally archive entire sites and does not execute JavaScript. This creates missing-source risk for newer, dynamic and poorly linked career sites. It also requests sequential, spaced CDX calls, backoff and no proxy networks; use the bulk index for broad work.

## 3. Discover the career surface on an employer's own site

For each verified employer domain, the proposed bounded crawler should:

1. Read its robots rules and advertised sitemap locations.
2. Inspect the homepage/footer and career-looking links, with multilingual labels and paths.
3. Follow a bounded set of same-employer career pages and explicit ATS links/iframes. Inspect embedded board configuration when present.
4. Prefer a documented structured board interface when detected; otherwise inspect job-detail JSON-LD before adding a site-specific parser.
5. Preserve evidence for the relationship between the employer, career page and detected board; avoid accepting a name/slug collision as proof of ownership.

The [Sitemaps protocol](https://sitemaps.org/protocol.html) supports sitemap indexes and announcing sitemap locations in `robots.txt`. Its `lastmod` field is optional and describes page modification, not necessarily job publication or continued availability. Sitemaps list candidate URLs; they are not hiring guarantees.

[Google's JobPosting documentation](https://developers.google.com/search/docs/appearance/structured-data/job-posting) provides a common structured representation with fields such as hiring organization, location, posted date and expiration. An employer may publish this directly in job-detail HTML. Its presence is useful extraction evidence, not permission or proof the employer has maintained it accurately. Google's Indexing API is a publishing notification interface, not a third-party employer/job discovery API.

Record source-specific access and reuse decisions separately. [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309) defines robots behavior and explicitly says these rules are not access authorization. Neither robots allowance nor a historical Common Crawl copy establishes all downstream commercial content rights. Redirect/DNS/private-network restrictions are also necessary when fetching untrusted candidate URLs; these are application requirements, not capabilities supplied by the data sources.

## 4. Search is useful, but current API availability matters

| Option | Verified current documentation | Implication |
| --- | --- | --- |
| Google Custom Search JSON API | [Official overview](https://developers.google.com/custom-search/v1/overview) says closed to new customers; existing customers must transition by January 1, 2027. | Do not propose a new dependency on its historical free allowance. |
| Bing Search APIs | [Microsoft lifecycle notice](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) says retired August 11, 2025 and unavailable for new signup. | Legacy Bing Web Search integrations are not a current bootstrap plan. Grounding is a different product. |
| Brave Web Search API | [Official documentation](https://api-dashboard.search.brave.com/app/documentation/web-search) supports `site:` queries and language/freshness filters. | A candidate to evaluate for bounded country/profession/local-language discovery. Requires an account/key and plan/terms review; no API call was made. |

Potential query families include ATS host plus region/profession, employer name plus career terms, and local-language equivalents. Save query provenance, URL and discovery date; validate the original site. Search-result counts, date filters and ranking do not establish exhaustive inventory or role-level freshness. A commercial plan for a search API also does not grant rights to every destination page. The search API should be replaceable so a provider change does not require rebuilding the employer directory.

## 5. Reach beyond the initial ATS list

| Seed family | Primary evidence | What it provides and what it does not |
| --- | --- | --- |
| Wikidata organizations and official websites | [Structured data license](https://www.wikidata.org/wiki/Wikidata:Licensing), [P856 official website](https://www.wikidata.org/wiki/Property:P856), [data access](https://www.wikidata.org/wiki/Wikidata:Data_access) | Structured data is CC0; APIs/query services/dumps are available. Domains can seed employer-site discovery. P856 can include former sites, and coverage/accuracy require validation. No measured employer inventory was extracted. |
| India company master data | [OGD catalog](https://www.data.gov.in/catalog/company-master-data), [MCA portal](https://www.mcacdm.nic.in/company-master-details) | Official company names, registration/status, state and industrial-classification context can broaden sector seeds. These pages do not establish a complete domain/ATS directory or current hiring. Resource-specific access and reuse must be checked. |
| NSE listed/SME companies | [Official downloads](https://www.nseindia.com/static/market-data/securities-available-for-trading) | Listed/SME company names are a potential input. Listing does not mean hiring, this misses unlisted employers, and a general data-reuse grant was not established. |
| Employer-submitted career URL/feed | Proposed product workflow, not a discovered dataset | Lets an employer establish its own source relationship and can improve long-tail coverage. Ownership verification, duplicate handling and removal/update controls are still needed. |

An Indian company can hire outside India; a foreign-headquartered employer can hire in Hyderabad. Keep employer identity/headquarters separate from each listing's actual destination. Neither English search nor the three-ATS seed list proves coverage of healthcare, hospitality, education, manufacturing, local firms or regional-language postings. These are gaps to measure, not unsupported claims that every employer in those sectors is absent.

## 6. Proposed free-first implementation sequence

1. **Seed candidates:** import attributed board-directory metadata into a disabled discovery area; retain dataset revision, original date and license. Do not bulk-enable rows or treat historical dates as a new live check.
2. **Validate in bounded batches:** normalize vendor/board identifiers, enforce public-network URL rules and access policy, verify source identity and response schema. Distinguish reachable-empty, reachable-with-jobs, changed, rejected and temporarily unavailable sources. Zero jobs is not proof that a valid employer source should be discarded forever.
3. **Collect approved sources:** use existing lease/checkpoint/backoff and atomic publication contracts, scheduling each approved board when due. A partial search result must never deactivate all missing employer jobs.
4. **Grow the directory:** add a periodic Common Crawl candidate import and bounded employer-site link discovery; use a supported search API only after its budget/terms decision. Focus additional work on measured country/profession gaps while retaining broad product scope.
5. **Add long-tail mechanisms:** accept verified employer career links/feeds and add further ATS/custom adapters where observed candidate volume justifies maintenance.
6. **Measure the funnel:** candidates → deduplicated source identities → validated boards → approved sources → valid vacancies → fresh unique relevant vacancies. Report source/segment rejection rates, costs and lag. No source-count target can substitute for useful vacancy counts.

Potential storage fields: candidate URL, normalized vendor/site, parent employer/domain, discovery mechanism, source URL, dataset/crawl revision, discovered time, historical observation time, live validation time, status/reason, access/reuse decision, country evidence and next check. These are design suggestions; no migration was written.

## Verification and limitations

- Verified by primary documentation and source inspection: Common Crawl index/data-format capabilities, Google/Bing API availability notices, current Brave search operators, sitemap/robots/JobPosting semantics, candidate seed availability and the LastRound license declaration.
- Verified by actual data parsing: the pinned 9,935-row CSV counts, unique vendor/slug pairs, nonempty fields, expected four-column schema and historical dates.
- Attempted one bounded CDX prefix query and one endpoint for each of three listed ATS candidates. The web tool could not access those API URLs. A shell CDX attempt could not resolve the hostname under this environment's network restrictions. These are tool/environment limitations, not evidence of provider outages, removed boards or zero jobs. No live board health, job count or Common Crawl query-result count is claimed.
- Not performed: large archive scans, search-API signup/calls, bulk employer crawling, source activation, job publication, migration/deployment, contact with employers, purchases or measurements of India/global market coverage. All implementation recommendations remain proposals.
