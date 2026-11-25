# Fresh job sourcing at useful volume

Researched 6 November 2026 against current repository code and primary sources.
This document combines the initial read-only staging snapshot and acquisition
research with subsequent implementation and rollout receipts, explicitly marked
below. The research alone does not establish throughput or increased
recommendations. No registration, purchase or partner contact was performed. Preserve the previously
clarified direction: build our direct collector, without a Headcount API
integration (see [prior decision](headcount-acquisition-method.md)).

## Recommendation

Grow a continuously maintained employer directory through several discovery
channels, then collect each verified source independently. Prioritize **new,
distinct software vacancies useful to current candidate segments**, not source
count or refreshed row count. The measured baseline below points first to source
failures and uneven provider coverage. Missing dates are not the dominant loss
in the currently active inventory.

### Measured staging baseline

Read-only receipt: `.local-data/sourcing-audit-2026-11-06.json`, captured at
15:11:43 UTC on 6 November. This is a point-in-time catalogue observation, not
an independent check of every employer page. Counts include location variants;
they are neither unique global vacancies nor candidate-specific matches.

| Provider | Enabled sources | Active listing-location records | Posted within 7 days |
| --- | ---: | ---: | ---: |
| Ashby | 3,056 | 4,231 | 1,024 |
| Greenhouse | 2,626 | 2,821 | 660 |
| Lever | 1,548 | 971 | 249 |
| SmartRecruiters | 16 | 94 | 24 |
| Workday | 21 | 527 | 182 |
| Arbeitnow | 1 | 314 | 302 |
| LinkedIn | 0 | 0 | 0 |
| Total | 7,268 | 8,958 | 2,441 |

Only three active records lacked posting dates, all Greenhouse. All six most
recent scheduled refreshes ended `partial`; that means some collection remained
incomplete, not that every source failed. Their discovery stages completed 72
search requests and activated five sources total. Activation is not publication:
the newest Centific Workday source had a paused run with `Invalid Workday detail
path`. Database use was 333,182,643 bytes (about 318 MiB), against the collector's
default 400 MiB budget. Increasing collection volume must account for this headroom.

The evidence supports repairing failed Workday/SmartRecruiters paths, measuring
their complete collection yield, and expanding those underrepresented source
families before another broad increase in Ashby/Greenhouse/Lever directory size.
The snapshot alone cannot establish why every partial batch failed or how many
new candidate matches the repairs will produce.

### Source options and their practical constraints

| Channel | Verified interface and freshness semantics | Proposed use |
| --- | --- | --- |
| Ashby employer boards | Public board feed includes descriptions, multiple locations and `publishedAt`, explicitly the **last** publication time. It returns currently published postings; `isListed=false` is direct-link-only. [API](https://developers.ashbyhq.com/docs/public-job-posting-api) | Expand verified employer coverage now. Keep first observation stable across republication; do not count each publication timestamp change as a new vacancy. |
| Greenhouse employer boards | Public GET endpoints require no authentication. List examples show `updated_at`; the individual-job example also exposes `first_published`. The list is all posts for a known board. [API](https://docs.greenhouse.io/job-board.html) | Audit missing dates. Where a list lacks `first_published`, test bounded detail enrichment and cache verified dates. Never substitute `updated_at` for first publication. |
| Lever employer boards | Published jobs are public and third-party scraping is explicitly contemplated. Global and EU hosts, employer scope, and `skip`/`limit` pagination are documented. `createdAt` is not documented in the reviewed public README. [API](https://github.com/lever/postings-api) | Add EU coverage only with explicit host identity. Preserve unknown dates unless employer detail evidence establishes them; the current parser's optional field is not a date guarantee. |
| SmartRecruiters | Employer listings paginate using `offset`/`limit` and `totalFound`; full details may require the returned `ref`. `releasedDate` means posting release. [Endpoints](https://developers.smartrecruiters.com/docs/endpoints), [fields](https://developers.smartrecruiters.com/docs/objects) | Expand the existing adapter with validated employers in underserved segments; measure detail-request cost and actual endpoint access. |
| Recruitee XML | Official help documents employer XML feeds. Current Careers API documentation introduces token enforcement by **10 February 2027** and explicitly excludes XML feeds from that token's scope. [Feed URLs](https://support.recruitee.com/en/articles/8213076-faq-api), [authentication](https://docs.recruitee.com/reference/authentication-1) | Implemented and live-tested on 7 November 2026 using XML, with strict syntax checks and provider-supplied dates. |
| Employer career pages | `JobPosting` JSON-LD defines original `datePosted`, expiry `validThrough`, employer identity and job identifiers. Sitemaps carry page-change signals, not necessarily posting dates. [Google specification](https://developers.google.com/search/docs/appearance/structured-data/job-posting) | Read structured HTML after ATS detection fails. Crawl known employer job URLs, extracting evidence before using a browser. Google Indexing API is a publishing mechanism, not a job inventory feed. |
| Arbeitnow | Existing keyless feed aggregates several ATS sources; the owner also documents a separate UK endpoint. No numeric rate limit or freshness SLA was established in the reviewed article. [Owner documentation](https://www.arbeitnow.com/blog/job-board-api) | Measure incremental UK/European supply against direct ATS overlap. Keep source provenance; do not assume every returned creation timestamp is the employer's original date. |
| Ashby partner feed | Dedicated JSON/XML feeds contain opted-in employers' jobs and are updated hourly. Provisioning requires a partner arrangement; it is not an open directory of all customers. [Partner feed](https://developers.ashbyhq.com/docs/dedicated-partner-job-feeds) | Strong longer-term cooperative distribution channel. Approval, participating employers and commercial terms are unverified; no outreach is included here. |
| Adzuna | Search requires credentials, returns description snippets, and its current terms require licensing for ongoing commercial product use after evaluation. Limits are account-specific. [Search](https://developer.adzuna.com/docs/search), [terms](https://developer.adzuna.com/docs/terms_of_service) | Optional future licensed coverage experiment, not the next free ingestion dependency. Snippets alone are insufficient for grounded matching and tailoring. |
| Remotive | Public API listings are delayed 24 hours, require attribution/linkback, and cannot be used to collect signups/emails to show a listing. [API terms](https://remotive.com/remote-jobs/api) | Poor fit for immediate freshness and the current signed-in listing experience. Do not automatically integrate it. |

### Discovery channels to combine

1. **Refresh the attributed directory seeds already supported.** Import deltas
   into candidates, retain provenance, validate live employer identity and jobs,
   then activate. Historic directory counts are not current job counts.
2. **Find employer career pages for measured gaps.** Allocate bounded search
   across country/city and software-role segments, then follow employer-owned ATS
   links. Record rejected, already-known and newly verified candidates separately.
3. **Use archive indexes for new board identifiers.** Common Crawl's URL Index
   supports bulk URL queries; its CDXJ indexes expose historical captures per
   crawl. Extract board candidates and validate them live. Archive timestamps
   cannot prove a job is open or freshly published. Start with bounded host
   queries, not a corpus download. [URL Index](https://www.commoncrawl.org/url-index),
   [CDXJ Index](https://commoncrawl.org/cdxj-index).
4. **Accept employer-submitted career/feed URLs.** Reuse the same verification
   queue. For longer-term volume, pursue explicit opt-in ATS distribution such
   as the documented Ashby partner feed.

These are proposed acquisition strategies. No method above proves worldwide
coverage, source access rights, or a fixed number of daily new jobs.

## Freshness and collection design

Keep source publication, first observation, last successful observation, and
source update times distinct. The existing feed parser uses Ashby `publishedAt`,
Greenhouse `first_published`, and optional Lever `createdAt`; missing values stay
null. The product's posting-age filters exclude unknown dates from new discovery.
Continue measuring **accepted-but-undated jobs by provider** as adapters expand;
the current baseline does not justify a broad date-enrichment project. Any future
source-date enrichment must be bounded,
checkpointed and evidence-backed; failed detail reads leave the date unknown.

Proposed scheduling: retain six-hour priority refresh as the initial target;
consider one-to-two-hour checks only for sources with observed useful new-job
yield after measuring capacity. Give low-yield sources a slower rotation and
keep a reserved discovery budget. One slow or throttled source must not prevent
other due sources from being collected. Use existing source leases, durable
cursors and backoff; a higher cron frequency alone does not solve backlog.

For snapshot feeds, compare stable source IDs and content hashes locally and
hydrate details only when required. This reduces writes/detail requests, not
necessarily upstream list traffic. The public employer feeds reviewed here do
not establish a universal delta cursor or webhook. Only completed inventory
reads can expire absent jobs; partial searches cannot establish absence.

Deduplicate exact canonical ATS identities first and retain source aliases.
Track location variants separately. Never merge solely on employer plus title:
those can describe different requisitions. Reposting and rediscovery do not
reset first-seen time or inflate new-job counts.

## Small implementation sequence and verification

1. **Extend the measured baseline.** Report enabled/due/failed/never-successful sources,
   completed refresh age, unique jobs posted in 24 hours/7 days/30 days, unknown
   dates, accepted-to-visible losses and storage/request budgets by provider.
2. **Repair demonstrated parser losses.** Reproduce Workday/SmartRecruiters failures
   against source responses, add regression fixtures, and recover affected sources
   without compromising fences, checkpoints or snapshot closure. Measure visible
   relevant-job gain separately from merely updating rows.
3. **Pilot diverse acquisition.** Add a small validated cohort from existing ATS
   discovery plus one new structured source family (Recruitee XML is a candidate),
   and compare their unique useful yield and cost with existing sources.
4. **Observe a week before scaling.** Record daily new canonical jobs, duplicate
   share, date availability, verified open rate, failed-source rate, collection
   completion lag and useful matches per target segment. A seven-day measurement
   is proposed, not an outcome already observed.

Required checks for implementation: repeated collection adds no duplicate jobs;
republication does not create a new vacancy; unknown/update-only dates never
become fresh posting dates; pagination resumes safely; a partial or failed
inventory cannot close missing jobs; removed jobs retire after complete evidence;
multi-location variants preserve existing saved/application IDs. Live acceptance
must follow runs to terminal receipts and sample original employer pages. Passing
parser fixtures or receiving HTTP 202 is insufficient evidence of increased supply.

## Repairs verified in this checkout

Two demonstrated blockers were repaired in `lib/server/catalog/additional-ats.ts`:

- Workday's valid `/job/<requisition>` paths no longer require a location slug.
  A read-only replay of Centific's previously failing page 2 returned five fetched
  postings, zero accepted software-location records and continuation to page 3.
  Passing this page unblocks continuation; it is not evidence of new jobs published.
- SmartRecruiters `videos` sections are excluded from textual-description parsing.
  Other sections still require valid text. This matches the provider's
  [PostingDetails schema](https://developers.smartrecruiters.com/docs/objects),
  where videos contain `title` and `urls`. A read-only Netcompany page 21 replay
  returned five fetched postings, one accepted record and continuation to page 22.

Both regression tests failed before their fixes. All 32 tests across
`additional-ats`, `catalog-fetch`, `source-discovery` and `catalog-sync` passed
afterward, along with repository TypeScript and ESLint checks. Unsafe Workday
paths and malformed SmartRecruiters text remain rejected. No remote migration,
publication, deployment or full-source recovery was performed. Other observed
issues, including Workday responses missing `externalPath`, still need diagnosis;
these two repairs do not establish that the next scheduled cycle will complete.

## Executable recovery and measurement

- `node --import tsx scripts/catalog/recover-catalog.mjs --staging` previews up to ten
  paused sources affected by the two repaired parser failures. Add `--apply` to
  resume their checkpoints, bounded to fifteen minutes and ten batches. Source
  leases, provider backoff, storage limits and atomic publication remain enforced.
  Every batch is saved in an ignored private receipt; incomplete work exits nonzero.
- `node --import tsx scripts/catalog/measure-supply.mjs --staging` saves provider counts,
  distinct exact job URLs, publication windows, pending/failed sources and storage
  usage. Exact URLs collapse location variants but not every cross-posting. Reads
  are not a transactional snapshot and do not measure personalized relevance.
- `node --import tsx scripts/catalog/pilot-recruitee.mjs` evaluates the captured public
  feed responses in `.local-data/recruitee-pilot-raw.json`. It is an evaluation
  utility, not a production adapter; the raw evidence is not committed.

The three-employer Recruitee pilot found 23 postings, six software roles, two
software roles published within thirty days, and none within seven days. This
sample supports technical feasibility but not prioritizing Recruitee for immediate
fresh supply. Custom employer domains in posting URLs need identity corroboration
before automatic activation; publication versus republication semantics remain
unverified. No Recruitee source was activated.

## Rollout on 6 November 2026

The parser fixes and operator utilities passed 795 tests, TypeScript, ESLint,
production build and function-bundle checks. Deployment
`dpl_3J93pEkCk8RramHjgcpBEhwFzrJD` is READY and aliased to
https://job-search-chi-amber.vercel.app (the isolated staging app's Vercel production
slot). CLI uploaded the local checkout; the displayed base commit `94d636a` does
not include the uncommitted sourcing changes. Hosted sign-in returned 200 and
unauthenticated `/api/cron/jobs` returned 401.

Bounded live recovery confirmed completed Netcompany and Centific snapshots:
Netcompany published 27 records including 23 new, and Centific published two
records, both new. These are listing records, not personalized-match gains.
Other selected SmartRecruiters sources required further paginated continuation.
The six-hour schedule and existing resource budgets remain unchanged.

Final bounded recovery receipt: `.local-data/source-recovery-1793983137833.json`.
Grab subsequently completed with 56 published records, including 44 new. The
three completed sources therefore added 69 listing records in total. Devoteam
and NCS remained pending when the bounded run ended (exit 2); their durable page
checkpoints are retained for subsequent scheduled collection. No increased supply
is claimed from their unpublished staging rows. Source expansion, adaptive
scheduling, and a production Recruitee adapter remain follow-on work, not deployed
features of this rollout.

## Multi-channel acquisition implementation on 6 November

The portal comparison in [job-portal-acquisition.md](job-portal-acquisition.md)
documents employer/ATS feeds, direct submissions, partner distribution and public
career-site crawling. Our immediate implementation adds another way to discover
employer boards; it does not establish partnerships or mirror a portal's entire
inventory. Common Crawl is our chosen public discovery input, not a claim about
Indeed's, Jooble's or Tsenta's internal technology.

`lib/server/catalog/discovery/archive.ts` reads one bounded Common Crawl index
block per invocation. It supports Ashby, global Greenhouse/Lever, SmartRecruiters
and Workday URL partitions. Unsupported regional hosts are not collapsed into
global boards. The index collection is pinned in the continuation cursor; the
page is read in full before advancing, without a row limit that could skip
employers. Limits are two MB, 5,000 rows and sixty seconds. Failed, malformed,
oversized or throttled requests produce no successful continuation receipt.

Candidates retain observed URLs and content-hashed discovery provenance. Archive
timestamps never become posting dates or live-check dates. Imports use the
existing idempotent candidate/observation tables; importing cannot activate a
source or publish a vacancy. Existing live validation, activation, collection,
publication and subsequent scheduled refresh remain responsible for those steps.

Operator examples (each command handles one page):

```sh
npm run catalog:discover -- archive --partition ashby --output .local-data/archive-preview.json
npm run catalog:discover -- archive --staging --apply --partition ashby --index CC-MAIN-2026-43 --page 0 --output .local-data/archive-applied.json
npm run catalog:discover -- archive --staging --apply --resume .local-data/archive-applied.json --output .local-data/archive-next.json
```

Available partitions: `ashby`, `greenhouse`, `greenhouse-legacy`, `lever`,
`smartrecruiters`, `smartrecruiters-careers`, `workday`. A null `nextCursor` ends
that partition. Start a different partition explicitly. Applying a continuation
from an unimported preview is rejected. Preserve the applied receipt until the
next import succeeds; if a chunk succeeds but its acknowledgement is lost,
replaying that page is safe. This is an operator intake, not a newly scheduled
monthly archive job. Existing scheduled source maintenance handles enabled boards.

Both Ashby pages in `CC-MAIN-2026-43` were imported into isolated staging, adding
142 previously absent candidate boards (84 on page zero, 58 on page one).
Page-zero receipt: `.local-data/archive-ashby-import.json`; continuation receipt:
`.local-data/archive-ashby-page1-import.json`. The initial page was successfully
downloaded and reviewed, then imported from that saved response after a redundant
download returned 504. The second page succeeded through the new CLI's applied
continuation path. Provider availability is intermittent: SmartRecruiters careers
queries and a Workday continuation also returned 504. Errors were not treated as
empty directories or complete scans.

The bounded live pilot validated 36 of the new candidates: eight passed current
employer identity and dated-software-listing checks, five were missing, and 23
needed review (including sources with no postings inside the collection window).
All eight activated sources completed collection. They added 18 listing-location
records representing **17 distinct exact job URLs**, all with source publication
dates within thirty days and four within seven days. Exact URL deduplication does
not establish unique requisitions across separate cross-postings. Ashby's date is
the last publication timestamp, so this does not prove first-ever publication.
The Armadin Forward Deployed Engineer employer page was also read successfully
and its title matched. Final receipt: `.local-data/archive-pilot-final.json` at
18:26:57 UTC. Collection receipts: `.local-data/archive-collection.json` and
`.local-data/archive-collection-batch2.json`. These are measured staging additions,
not a worldwide coverage estimate or evidence of personalized-match gains.

Verification: the new parser/pagination/import tests and existing discovery tests
passed (15 tests). Repository typecheck and lint passed. The full suite ran 800
tests: 795 passed in the restricted sandbox; five failed solely on localhost
`listen EPERM`. All seven tests in that socket-test file passed on the permitted
rerun outside the sandbox. The database regression verifies recovery after an
import commits but its receipt is lost, zero duplicate observations on replay,
and refusal to activate an archive-only candidate.

Next acquisition work should prioritize additional enterprise ATS coverage,
an employer career/feed submission path into this same validation queue, and
opt-in partner feeds. New source activation should remain tied to measured
useful-job yield and collection capacity. Search-result totals and archive URL
counts are not fresh-job counts.

## Automated discovery and public ATS rollout — 7 November 2026

The six-hour scheduled workflow now attempts three archive blocks before the
regular refresh, then validates a bounded, rotating provider batch. It saves
archive cursors atomically with candidate imports, respects provider cooldowns,
and admits at most 12 archive attempts per UTC day. A large refresh backlog no
longer disables candidate expansion. New sources require live employer identity,
usable country/description evidence and dated software postings within 30 days.
They are collected before the remaining due sources. Existing paid Search
queries rotate through Recruitee and Workable without increasing the request or
spend budget. See [operating controls](../catalog-operations.md#public-feed-fetching).

A manually triggered live acceptance run against isolated staging
`zcaqbiejkvgqxsbrncty` produced these measured results:

- Recruitee archive page 0 imported **90 new employer candidates** and persisted
  page 1 of `CC-MAIN-2026-43` as the continuation. These are unvalidated addresses,
  not 90 active employers or jobs.
- Workable and Ashby archive requests returned HTTP 504. Both attempts were
  recorded as failures with retained cursors and retry delays.
- Ten separately observed employer links were imported and checked against their
  current feeds. Eight passed the recent-software-posting requirement; BasisPath
  and Ensera Design had no qualifying dated jobs and remained unenabled.
- Complete collection from Bally's Intralot, Constructive Dialogue Institute,
  GIGA Storage, Payter, SeQura, STRYPES, TransPerfect and Bask Health published
  **30 new location records representing 16 distinct URLs**. **Five distinct
  URLs** had provider publication dates within seven days (seven location
  records). These are measured supply, not guarantees of candidate relevance.

Ignored operator receipts are `.local-data/scheduled-discovery-pilot.json` and
`.local-data/scheduled-discovery-migration-receipt.json`. The acceptance run was
operator-triggered; it is not evidence that a future cron invocation has fired.
Recruitee uses its public XML feed, avoiding the upcoming JSON token requirement.
Workable's documented public feed repeats some shortcodes by country; the reader
merges those variants and rejects conflicting content. Both readers require
complete responses and retain explicit provider publication dates.
