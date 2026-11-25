# India job supply: verified high-volume employer feeds

Research date: 17 November 2026. This investigation used official career pages,
their public frontend code, and their public read-only search responses. The
numbers below are provider inventory observations, **not jobs newly added to the
platform**. Database additions require a completed collection and a before/after
comparison of canonical requisition URLs. All implementation and collection for
this task are restricted to local Docker; no Vercel deployment is involved.

## Finding: the previous catalog size was a coverage limit

Accenture alone exposes substantially more India vacancies through its official
career search than the platform's previous catalog contained. The unfiltered
India query reports `total:10000, overMaxHits:"True"`; its Full-time facet reports
25,321 records. The facet count is a provider claim, not an independently
enumerated unique total. The Software Engineering family query reports 9,785
with `overMaxHits:"False"`; its final page at offset 9,700 contains exactly 85
records. These inventories include older vacancies and overlapping job families.
Neither 25,321 nor 9,785 should be described as newly published, fresh, or newly
added jobs. [Official career search](https://www.accenture.com/in-en/careers/jobsearch),
[public search endpoint](https://www.accenture.com/api/accenture/elastic/findjobs).

## Accenture: executable public API contract

The official browser bundle's `fetchFindJobs` function posts FormData to
`/api/accenture/elastic/findjobs`. No account, cookie, credential, or nonpublic API
is required. The public site's CSRF-Token header is empty. The endpoint is allowed
by the robots rules observed during this investigation. Read those rules on each
collection page so subsequent changes are respected.
[Official frontend bundle](https://www.accenture.com/etc.clientlibs/cio-sites/clientlibs/clientlib-rad.lc-715cfc31dc89a7db67c70d56d24cccf3-lc.min.js),
[robots.txt](https://www.accenture.com/robots.txt).

```text
POST https://www.accenture.com/api/accenture/elastic/findjobs
Content-Type: multipart/form-data (FormData generates the boundary)
CSRF-Token: <empty>

startIndex=0
maxResultSize=100
jobKeyword=
jobCountry=India
jobLanguage=en
countrySite=in-en
sortBy=1
searchType=vectorSearch
enableQueryBoost=true
minScore=0.6
getFeedbackJudgmentEnabled=true
useCleanEmbedding=true
score=true
totalHits=true
debugQuery=false
jobFilters=[{"fieldName":"areaOfInterestTitle.keyword","items":["Software Engineering"],"multiSelect":false}]
```

The response contains `data`, `aggregations`, `totalHits`, and
`labelConfigMapping`. Its own sort labels identify `sortBy=1` as `Newest`;
`sortBy=2` is `ProximityLatest`, which must not be substituted for chronological
ordering. A 100-record page was verified, at approximately 1.37 MB. The first 100
and the page at offset 9,900 were monotonically descending by `updateDate`.
Requests use the shared bounded transport, which counts requests, rejects
redirects, limits bytes and duration, and does not cache responses.
[Public endpoint](https://www.accenture.com/api/accenture/elastic/findjobs),
[official frontend bundle](https://www.accenture.com/etc.clientlibs/cio-sites/clientlibs/clientlib-rad.lc-715cfc31dc89a7db67c70d56d24cccf3-lc.min.js).

Each record supplies `requisitionId`, `guid`, `title`, `country`, `location`,
`feedCity`, `areaOfInterest`, `updateDate`, `jobDetailUrl`, full `jobDescription`,
and `qualification`. The canonical URL is
`https://www.accenture.com/in-en/careers/jobdetails?id=<guid>`. The search response
also includes a mutable title query parameter, which the connector drops.
Different requisition IDs frequently share the same title and city but have
different requirements; title/city equality is not sufficient evidence that they
are duplicate vacancies.
[Example official vacancy](https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-5229392-S1919655_en).

### Publication date evidence

On three independently fetched official job pages, `JobPosting.datePosted`
exactly matched the search record's `updateDate`:

| Requisition/guid | API updateDate = JSON-LD datePosted |
| --- | --- |
| [ATCI-5229392-S1919655_en](https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-5229392-S1919655_en) | 2026-11-16T21:10:20.908-08:00 |
| [R00289064_en](https://www.accenture.com/in-en/careers/jobdetails?id=R00289064_en) | 2026-11-16T21:07:12.003-08:00 |
| [AIOC-S01671239_en](https://www.accenture.com/in-en/careers/jobdetails?id=AIOC-S01671239_en) | 2026-11-16T20:52:28.511-08:00 |

This establishes the employer's **stated posting date**, not the original date a
vacancy was created. The connector preserves this date without replacing it with
the collection timestamp. Missing, malformed, and implausibly future dates stay
unknown. The API samples do not supply a validThrough field; the first detail page
does supply a future JSON-LD validThrough, but it is not invented for other jobs.

### Bounded family sources ready for collection

All labels and slugs below were checked using live official filtered queries.
Reported counts are all-age inventory, not unique across families. The family is
a query partition; the catalog still classifies each vacancy from title and
description, and users choose their categories in their profiles.
[Official career search](https://www.accenture.com/in-en/careers/jobsearch),
[public endpoint](https://www.accenture.com/api/accenture/elastic/findjobs).

| Config family | Response slug / source suffix | Reported total | Capped |
| --- | --- | ---: | --- |
| Software Engineering | software-engineering | 9,785 | No |
| Artificial Intelligence (AI) & Data Science | artificial-intelligence-ai-data-science | 2,004 | No |
| Marketing & Communication | marketing-communication | 539 | No |
| Sales & Account Management | sales-account-management | 280 | No |
| Product Development | product-development | 190 | No |
| Creative & Design | creative-design | 172 | No |
| Customer & User Experience | customer-user-experience | 4 | No |
| Cloud | cloud | 150 | No |
| Security | security | 201 | No |
| Technology Platforms | technology-platforms | 5,238 | No |
| Programming Languages | programming-languages | 3,453 | No |

The official Sales & Account Management and Customer & User Experience filter
labels have trailing spaces. The connector uses clean configuration names and
adds those exact spaces to the provider request. Source identity is
`accenture:india-<slug>`, board is `india-<slug>`, company is `Accenture`, and
configuration is `{ "family": "Software Engineering" }`, for example.

### Caps, pagination, and geography

The unfiltered India query's offset-9,900 page still has dates on 5 November 2026,
within the 30-day freshness window. Stopping at 10,000 would silently omit fresh
jobs. The new connector refuses `overMaxHits:"True"` and totals above 10,000.
It reads the entire family inventory instead of claiming freshness alone makes
the cap safe. It checks expected page size, duplicate requisition IDs within a
page, explicit country, requested family membership, URL identity, descending
dates, and a separately fetched preceding record at resumed page boundaries.
The API does not provide a snapshot token, so this cannot promise an immutable
inventory while the employer is changing it.
[Official endpoint](https://www.accenture.com/api/accenture/elastic/findjobs).

For future broad coverage, the official location facet had 21 India city labels.
Hyderabad alone reports 3,637 uncapped. Bengaluru alone is capped; combining
`location.keyword=["Bengaluru"]` with
`yearsOfExperience.keyword=["Experience: 5-10 years"]` reports 4,909 uncapped.
A proposed 25-partition city/experience plan is saved locally but has not been
activated by this research. Other experience partitions still need individual
verification. City counts overlap when a requisition has multiple locations.
The India response also exposes one Buenos Aires facet entry. A country label
does not resolve that contradiction: the connector excludes unverified/non-India
cities from catalog projection while retaining the provider's raw facts.
[Official endpoint](https://www.accenture.com/api/accenture/elastic/findjobs).

## Other verified opportunities

Oracle's official India search points to the existing `eeho.fa.us2.oraclecloud.com`
tenant and site `CX_45001`. A first-page request reported 333 India requisitions
and returned explicit `PrimaryLocationCountry:"IN"` and provider PostedDate
values. This is an existing connector with a catalog-admission gap, not a need to
invent a new provider. A separate audit in this task owns the full inventory and
publication measurement.
[Official Oracle India search](https://careers.oracle.com/en/sites/jobsearch/jobs?location=India&locationId=300000000106947&locationLevel=country&mode=location),
[official recruiting API](https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_45001,limit=20,offset=0,sortBy=POSTING_DATES_DESC,location=India).

Wipro and HCLTech have public SAP SuccessFactors career-search widgets. Wipro's
page exposes companyId `wiprolimitP2`; its official widget asset manifest and
JavaScript are publicly readable. The listing API contract was not completed in
this investigation, so no inventory count or production-ready connector is
claimed. Individual Wipro vacancies provide concrete recent India evidence, for
example the 23 October product-management vacancy and 30 October Hyderabad
administrator/SRE vacancy below.
[Wipro search](https://careers.wipro.com/search/?q=&locationsearch=India),
[HCLTech search](https://careers.hcltech.com/search/?q=&locationsearch=India),
[SAP widget manifest](https://hcm55.sapsf.eu/verp/vmod_3/ui/rmk-jobs-search/resources/asset-manifest-entrypoints.json?tag=b2611m.4),
[Wipro product role](https://careers.wipro.com/job/Chennai-Associate-Product-Manager-AI-Powered-Enterprise-Document-Management-%26-Content-Int-IND-600119/213366-en_US/),
[Wipro Hyderabad role](https://careers.wipro.com/job/Hyderabad-ADMINISTRATOR-L3%28CONTRACT%29-IND-500032/214091-en_US/).

Capgemini's public HTML search displayed “Results 1–25 of 62” for
`locationsearch=India`, with dated India job links. That free-text filter may
undercount locations specified only by city; 62 is not a verified total India
inventory. The exact country filter needs further investigation before using
this source for comprehensive collection.
[Official Capgemini search](https://careers.capgemini.com/search/?q=&locationsearch=India).

## Reproduction artifacts and acceptance evidence

Public responses, source HTML, frontend JavaScript and small read-only probes are
saved under `.local-data/india-high-volume-research/`. Principal artifacts:
`accenture-first.json`, `accenture-first100-newest.json`,
`accenture-offset9900.json`, `accenture-software100.json`,
`accenture-software-tail.json`, `accenture-family-contracts.json`,
`accenture-detail.html`, `accenture-detail-4.html`, `accenture-detail-50.html`,
and `accenture-partition-plan.json`. These are local research evidence, not
catalog-publication receipts.

Implementation is `lib/server/catalog/connectors/accenture.ts`, with fixture tests
in `tests/accenture-connector.test.ts`. All 14 focused tests and focused ESLint
passed. A full strict-reader preflight in the isolated local Docker container
`job-search-accenture-preflight` completed on 17 November 2026 at 09:03:31 UTC:

| Software Engineering family preflight | Observed count |
| --- | ---: |
| Complete pages | 98 |
| Provider records read | 9,785 |
| Eligible distinct canonical requisition URLs | 8,974 |
| Eligible distinct URLs with stated dates in the last 30 days | 6,608 |
| Eligible older records | 2,366 |
| Eligible records with unknown dates | 0 |
| Fresh software category | 6,111 |
| Fresh technical support category | 487 |
| Fresh marketing / product / data categories | 8 / 1 / 1 |
| HTTP requests including robots and page-boundary checks | 293 |

All complete-page, cap, explicit-country, family, URL, descending-order,
page-boundary, and eligible cross-page canonical uniqueness checks passed. The
run took 157 seconds and made no database writes. Its fresh canonical URLs and
counts are saved in
`.local-data/india-high-volume-research/accenture-software-preflight-report.json`.
The receipt explicitly records `complete:true` and `remainingPage:null` from
the completed pagination loop. After that run, the connector gained the same
early-career title exclusion used by existing India employer-site readers,
after raw observation. Rechecking all 6,608 saved fresh titles found no matches,
so the fresh count remains 6,608. The older eligible count above is the original
preflight measurement and was not recomputed after this narrower policy.
These are independently enumerated eligible vacancies from the
[official search endpoint](https://www.accenture.com/api/accenture/elastic/findjobs),
not an extrapolation from headline inventory counts.

Final acceptance requires successful
collection publication in local Docker plus observed before/after unique
canonical-URL counts. Do not report staged rows, provider totals, activated source
counts, or a started collector as jobs actually added.

## Completed local collection

The final local Docker snapshot at 2026-11-17 09:23:14 UTC contains **11,010
unique active India postings**, compared with **892** in the frozen baseline:
**10,118 additional canonical postings**. All have employer-stated dates inside
the unchanged 30-day window. These are additions to this platform, not a claim
that the underlying vacancies were originally created during this run.

| Contributing feeds | Additional unique India postings |
| --- | ---: |
| Accenture, eleven verified families combined | 9,555 |
| Oracle India | 230 |
| Amazon general India | 124 |
| 35 other employer boards | 209 |
| Total | 10,118 |

All 48 reviewed feeds completed successful catalog publication. The 15,585 active
India database rows represent 11,010 unique canonical postings; repeated source
and location rows are excluded. Accenture's 13,977 rows represent 9,555 distinct
requisition IDs, excluding 4,422 overlapping family rows. The title/city heuristic
is not used to merge separately verified requisitions.

The local application and hourly scheduler use the rebuilt images. Recommendation
matching was refreshed, real account reads passed, and full and compact display
deduplication both preserve the 11,010 unique India postings. Compressed
description storage was verified with checksums and enabled locally so the larger
feeds fit the worker's bounded staging size. Sixty focused tests, TypeScript,
changed-file ESLint, production Docker builds, and PostgreSQL scope checks passed.
No Vercel deployment or hosted database was accessed.

Detailed baseline, publication, deduplication, storage, and independent audit
receipts are retained in
`.local-data/rollouts/2026-11-17-india-volume-research/rollout-receipt.json` and
`independent-final-audit.json` in the same directory.
