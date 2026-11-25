# IBM India public careers search

Verified on 17 November 2026. The final full reader preflight completed at **13:21:03 UTC**, and an offline replay of every saved response completed at **13:21:36 UTC**. This research and connector work did not activate a source, publish catalog jobs, or touch Vercel; the parent rollout owns local Docker publication and its measured additions.

## Verified volume

The official public API reports **2,518 India openings across all posting dates**, versus **2,152 distinct India requisitions dated within the fixed 30-day window ending 2026-11-17T13:20:20.395Z**. We read all **22 pages**, checked every page and boundary, and independently confirmed all 2,152 requisition URLs were unique. The earlier 1,124 figure belongs to a `q=software` keyword search, not the complete India inventory. [Official India search](https://www.ibm.com/in-en/careers/search?field_keyword_05%5B0%5D=India), [software-keyword search](https://www.ibm.com/in-en/careers/search?q=software).

Under the platform's eight profile categories and early-career policy, with the narrowly verified technical-role correction described below, the final preflight accepts **1,029 unique fresh India URLs**: 981 software, 32 data, 8 sales, 1 customer success, and 7 technical support. These are **eligible source previews, not net-new catalog additions**. Cross-source deduplication and publication must determine actual additions.

| Preflight measurement | Result |
| --- | ---: |
| Source pages | 22 |
| Fresh India requisitions observed | 2,152 |
| Eligible unique fresh India URLs | 1,029 |
| Total full-description bytes | 8,050,767 |
| Eligible full-description bytes | 3,876,348 |
| Largest public API response | 451,846 bytes |

The first classification accepted 780 and rejected 1,372 observations. Review of the actual full descriptions identified five narrowly defined technical title families whose work belongs to software. A separately tested correction in `lib/jobs/software-roles.ts` accepts those titles only with matching implementation evidence, while preserving functional-finance and presales exclusions. The complete final live read and offline replay accept **249 more**: 103 `Applied AI Specialist-Cloud FullStack`, 40 `Technical Consultant-AI Integration` (including three capitalization variants), 49 `Package Consultant-SAP Application Extensions`, 29 SAP BTP, and 28 ServiceNow consultant requisitions. The remaining **1,123 observations** do not pass current category and early-career eligibility. The connector itself does not widen the classification rules.

## Public API and evidence

An isolated ordinary browser loaded IBM's public search page and captured its actual search request. No endpoint guessing, account, API key, private API, or authentication bypass was used.

- Widget manifest: [embedded/v2.2/manifest/_buildManifest.js](https://www.ibm.com/marketplace/static/components/search/embedded/v2.2/manifest/_buildManifest.js).
- Widget code: [embedded/v2.2/pages/scoped-no-carbon.js](https://www.ibm.com/marketplace/static/components/search/embedded/v2.2/pages/scoped-no-carbon.js).
- Public search endpoint: `POST https://www-api.ibm.com/search/api/v2`.
- Identity: `appId: "careers"`, `scopes: ["careers2"]`, `lang: "zz"`.
- Country: exact `term` on `field_keyword_05: "India"`.
- Career area: `field_keyword_08`; the browser exposes it as a facet, and it can be null. The connector intentionally does not restrict this provider facet, so profile categories control projection.
- Pagination: `from` plus `size: 100`; response `hits.total` must report an exact `eq` total, and every expected row must be present. The reader refuses timeouts, shard failures, totals exceeding 10,000, duplicates, unsafe URLs, and invalid page boundaries.
- Sorting: `dcdate: "desc"`, followed by the unique public search document `_id: "asc"`. The official widget supplies `_id`, and a live API probe verified this sort and its returned date/ID sort values. Rows and resumed boundaries must be ordered by date and unique identifier. Date/title sorting proved unstable for otherwise identical requisitions and was replaced. `url.keyword` is unmapped and `url` is unsortable analyzed text; neither failed probe is used by the implementation.
- Freshness: `query.bool.filter` contains a `range` on `dcdate`, bounded by the snapshot start and 30 days earlier. The same snapshot timestamp survives durable resume. Every returned date is separately validated; future, missing, malformed, or out-of-window dates fail the snapshot.
- Full text: request the documented `body` field. The API's `description` is a truncated teaser and is not used as the published description. The full indexed body contains responsibilities and qualifications, followed by provider metadata.

IBM's job detail for requisition **142862** has JSON-LD `JobPosting.datePosted = "2026-11-15"`, matching its API `dcdate`. Its complete responsibilities match the full API body. This verifies the employer's stated posting date; it does not establish the original creation time of a possibly republished vacancy. [Official job detail](https://careers.ibm.com/en_US/careers/JobDetail?jobId=142862).

Stable identity is the numeric `jobId`. The reader canonicalizes both observed detail paths to `https://careers.ibm.com/careers/JobDetail?jobId=142862`. Distinct requisitions can share title, city, and text, so downstream deduplication must retain distinct verified job IDs.

## Access policy and failure behavior

The API host's robots resource currently returns `301 → https://www.ibm.com/`, then `303 → https://www.ibm.com/in-*`, then `404`. The connector follows at most five robots redirects and only between the two exact HTTPS IBM hosts. A 4xx robots resource is unavailable under the existing RFC 9309 policy; 429 is preserved as a backoff. Any explicit robots exclusion prevents search. A successful robots response containing HTML, unsafe redirect, server failure, or exhausted redirect chain fails closed. Actual search calls retain the shared client's redirect refusal, bounded bodies, timeouts, and HTTP retry/backoff behavior. [IBM website robots](https://www.ibm.com/robots.txt), [IBM careers robots](https://careers.ibm.com/robots.txt).

The connector accepts only `ibm:india`, kind `ibm`, company `IBM`, board `india`, and empty config. Explicit India country, complete body, strict date, and approved career URL are required. Optional career-area, work-mode, and experience labels may be absent; missing work-mode stays unknown. Country contradictions fail the snapshot.

## Implementation and verification

- Reader: `lib/server/catalog/connectors/ibm.ts`; registered as an employer-site connector, not a multitenant ATS discovery candidate.
- Migration: `supabase/migrations/202611170085_ibm_india_source.sql` registers the kind and fixed scope and adds it to the source pool. It inserts and activates no sources.
- Nine focused connector tests pass, covering the registry route, exact country/date request, full descriptions, profile category projection, resumed pagination, partial/capped results, unsafe identity, malformed and future dates, robots exclusions/redirects/throttling, null metadata, and empty feeds.
- Full TypeScript, focused ESLint, and `git diff --check` pass.
- A separate ephemeral PGlite migration audit passes: no inserted/enabled rows, exact IBM scope accepted, invalid scope rejected, source pool integration present, and all seven existing Oracle tenants preserved.
- The final full live preflight then completed without provider errors or duplicate requisitions, and replaying all exact saved API pages produced the same 1,029 eligible URLs. Earlier runs failed closed on a null career-area label and on unstable date/title page boundaries. Both have regression coverage; no partial snapshot was activated or published. Strict country/date/body/page checks remain intact.

All evidence is under `.local-data/rollouts/2026-11-17-india-expansion-2/ats/ibm/`: `browser-requests.json`, `search-request-base.json`, `india-request.json`, `india-response.json`, `job-142862.html`, `robots-api-chain.json`, `robots-www.txt`, `stable-id-sort-probe.json`, all 43 `api-offset-*-size-*.json` responses (22 pages and 21 preceding boundary checks), `preflight-failure-title-sort.json`, `observations-full.json`, `preflight.mts`, `preflight.json`, `reproject.mts`, `reprojection.json`, and `activation-ready.json`. The activation manifest includes source identity, complete status, completion and snapshot times, page/fetched/accepted/unique counts, category counts, byte measurements, and primary evidence URLs.
