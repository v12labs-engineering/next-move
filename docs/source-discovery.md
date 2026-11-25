# Employer source discovery

Discovery expands the shared catalogue from public employer boards. Historical
seed rows are candidates, not evidence of current vacancies. Import, live
validation, activation and complete collection are separate durable stages.

## Operator commands

These commands target the isolated staging database through its checked manifest
and `.env.staging.local`. Report-only is the default. Never paste operator keys
into a terminal argument, browser or report.

```sh
npm run catalog:discover -- import --staging
npm run catalog:discover -- import --staging --apply
npm run catalog:discover -- validate --staging --limit 30
npm run catalog:discover -- expand --staging --apply --limit 30
npm run catalog:discover -- status --staging
npm run catalog:collect -- --staging --ids ashby:example,greenhouse:example
```

`expand` validates a bounded batch and activates passing boards automatically.
The CLI bypasses the scheduled cooldown, but cannot override an active expansion
lease or a provider's retry time. It rotates among Ashby, Greenhouse, Lever,
SmartRecruiters and Workday;
it does not filter professions or countries. Geography and profession breadth
must be measured from the resulting listings, not inferred from directory size.
Use `--output` with a new file path to retain a private JSON receipt.

For investigation, `validate --ids kind:board --recheck --apply` can recheck an
explicit empty, missing or reviewable board. It does not override HTTP 429/5xx
backoff. Manual `activate --ids ... --note 'review evidence' --apply` still requires
a persisted verified result less than 24 hours old. Automatic activation is
currently restricted to `APP_ENV=staging`.

## What passes

The validator constructs fixed provider URLs, checks robots policy, reads a live
employer identity, checks it against independent historical naming evidence when
available, and requires usable current listings from that board. It checks
canonical board identity, safe application URLs, descriptions and country data.
It does not fetch arbitrary links from imported CSV cells or job descriptions.
Requests have byte limits, deadlines and provider backoff. A provider access
refusal, ambiguous employer identity, unusable country metadata, missing board
or checked-empty feed remains inactive and retains its outcome for inspection.

Activation adds an enabled employer feed. Jobs become visible only after the
existing collector publishes a complete, token-fenced snapshot. Partial pages
remain unpublished; failures do not replace a previous successful snapshot.

## Scheduled expansion

Apply migrations `202610300003`, `202610300004` and `202610300005` before enabling
`SOURCE_DISCOVERY_ENABLED=true` on the isolated staging project. Configure
`SOURCE_DISCOVERY_BATCH_SIZE` (default 10, permitted 1–50). No new secret is needed.
The six-hour Vercel cron at `/api/cron/jobs` starts a durable workflow that expands
sources before collection. The authenticated operator `/api/catalog/sync` endpoint
also supports expansion. No GitHub collection schedule is used.

A scheduled batch has a 45-second validation budget and a 15-second deadline per
candidate, so it can process fewer than the configured limit. A database lease
prevents concurrent expansion; a one-hour cooldown prevents continuation calls
from repeatedly adding new boards. Refresh backlog above 36 due sources pauses
expansion. The collector chooses due sources before applying its batch limit,
so already-fresh sources cannot starve newly activated boards.
The scheduled workflow processes checkpointed batches in durable steps; errors,
active leases and provider backoff defer affected sources without a tight retry loop.

Results are recorded in `source_expansion_runs`, including processed counts,
validation outcomes and activated IDs. Candidate checks and leases survive
interruptions. A later batch can activate fresh verified checks that were saved
before a crash. All discovery tables and mutation functions are operator-only;
customers cannot import, validate or activate candidates. The separate on-demand
search route can request bounded collection of already-enabled sources.

## Seed provenance

The pinned Open ATS Feed and LastRound directories, revisions, checksums, license
and attribution are defined in `lib/server/catalog/discovery/seeds.ts`. Downloads
must match their SHA-256 hashes and CSV schema. Imports are idempotent by source
identity and origin observation. Multiple directories can support the same board
without duplicating it. Open ATS Feed has no per-row live-check timestamp, which
is stored as unknown; a Git revision date is not substituted. LastRound's actual
historical row date remains historical evidence only.

The pinned Open ATS Feed revision now also includes 2,334 Teamtailor and 2,444
Recruitee employer boards. All 4,778 rows passed checksum, schema and canonical
identity checks on 17 November 2026. These are historical candidates, not current
hiring counts. Recruitee uses the existing connector; Teamtailor needs migration
`202611170077`. The same migration adds Personio, for which no CSV exists at
this pinned revision. `scripts/catalog/expanded-employer-career-seeds.txt` contains six
observed employer URLs for an India-oriented validation pilot.

After staging migration, preview and import through the existing commands:

```sh
npm run catalog:discover -- import --staging --directory open-ats-feed
npm run catalog:discover -- import --staging --directory open-ats-feed --apply
npm run catalog:discover -- links --staging --file scripts/catalog/expanded-employer-career-seeds.txt
npm run catalog:discover -- links --staging --file scripts/catalog/expanded-employer-career-seeds.txt --apply
npm run catalog:discover -- expand --staging --apply --limit 30
```

Full candidate import is idempotent and does not activate sources. The bounded
expansion step rotates provider families; repeated batches are needed to work
through a directory. Inspect its receipts, then collect activated sources and
measure distinct fresh India vacancies before reporting a volume increase.

Teamtailor's [documented RSS feed](https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide)
supports offset pagination. Personio documents its
[public XML feed](https://support.personio.de/hc/en-us/articles/207576365-Integrate-jobs-from-Personio-into-your-website-via-XML).
Personio collection also reads bounded job details: XML creation dates and city
labels alone cannot establish posting freshness or country. The initial live
Cuculus sample returned seven postings and two India software rows, all older
than 30 days; it verifies the reader without establishing fresh job gains.

Public [source credits](/data-source-credits.txt) preserve LastRound AI CC BY 4.0
attribution and the Open ATS Feed MIT notice. Provenance and technical validation
do not establish commercial source-use permission for every employer. Commercial
launch source-use review remains a separate release requirement.

## Verification

`npm test`, `npm run lint`, `npm run typecheck` and a production build cover parsing,
provider identity checks, country interpretation, leases, retries, RLS,
idempotency, activation and atomic publication. Tests use a local PostgreSQL
engine for database invariants and bounded HTTP fixtures for refusal cases.

```sh
SOURCE_DISCOVERY_QA_BASE_URL=https://job-search-staging.vercel.app \
  npm run catalog:verify-discovery -- --browser
```

The end-to-end verifier reads actual published jobs, creates disposable synthetic
accounts, checks authenticated API matching and rendered job links for all three
providers, tests private discovery access denial, and deletes those accounts in
`finally`. It submits no applications and makes no AI calls. Its exact-title
profiles verify data integration; they do not measure recommendation quality or
coverage for every profession. Private receipts and screenshots are saved under
`.local-data/`. A successful manual endpoint invocation is not evidence that the
next scheduled run has occurred.

## Full imported-directory sweep

```sh
npm run catalog:discover-all -- --staging --limit 200 --workers 4
npm run catalog:discover-all -- --staging --apply --limit 200 --workers 4 \
  --output .local-data/discovery-full-sweep.json
npm run catalog:discover-all -- --staging --apply \
  --resume .local-data/discovery-full-sweep.json
npm run catalog:refresh-expanded -- --staging --apply \
  --watch-sweep .local-data/discovery-full-sweep.json \
  --output .local-data/discovery-full-refresh.json
```

The plan is read-only. The sweep freezes the IDs that have never received a live
validation result. A batch contains at most 300 candidates and runs up to four
workers per provider. Requests share origin pacing; an HTTP 429 pauses further
work for that provider until its retry time. Each check and passing activation
is persisted individually. The manifest supports resumption; PostgreSQL remains
the authority for completed checks, leases and source activation. Existing
review outcomes are not silently overridden. A deferred result means the live
check could not establish a usable board; it is never treated as a pass.

Migrations `202610300006`–`202610300014` add operator-only capacity controls,
durable refresh state, and an active-source index for snapshot publication.
The default catalogue growth budget is 400 MiB. Capacity checks reserve room for
staging and publication through atomic Postgres reservations. Admission holds a
short lock; the write consumes its reservation. Reservations expire after five
minutes if a worker dies. They pause collection
without deleting existing listings or applicant history. Validation and source
activation can continue independently of job storage. Only an operator can
change `catalog_capacity_control.budget_bytes`; the collector also respects
`CATALOG_DATABASE_BUDGET_BYTES` as a preflight limit.

The dedicated Vercel `/api/cron/jobs` endpoint always starts or reuses a durable
refresh workflow and returns HTTP 202 with `accepted=true, complete=false`.
Enqueueing is distinct from collection success. It reports the refresh ID and
returns before maintenance or scraping. The operator `/api/catalog/sync` endpoint
also supports durable refresh with `CATALOG_DURABLE_REFRESH_ENABLED=true`. Both
paths share the same refresh lease; no additional secret is required.

A refresh freezes the due-source IDs, placing already-published sources first
(oldest successful observation first), followed by unmeasured sources. It
processes up to 100 sources per durable
step with four feed downloads and a queue for database snapshot writes,
checkpoints pages, and retries healthy pending pages
in bounded steps. Failed, leased or throttled feeds do not block other sources.
A global refresh lease prevents duplicate starts and fences expired workers;
step IDs prevent duplicate progress accounting after replay. A cycle stops at
six hours or the storage guard. The operator ledger records completed, partial,
paused and failed outcomes separately. Source-specific errors and retry times
remain in the collection ledger. Periodic triggers do not guarantee every feed
can meet a freshness target when providers are unavailable or resources run out.

The source-priority query uses validated directory country assignments instead
of rescanning the historical catalogue for every batch. Those assignments are
priority hints, not published-supply counts. A source index keeps complete-snapshot
expiry bounded to the source being refreshed. Live scale testing also exposed
write contention; network concurrency is retained while database snapshot writes
are queued within each collection invocation. Tests reproduce overlapping writes
without that queue and verify the corrected call path.

An authenticated operator can add `?sources=ashby:board,greenhouse:board` to the
existing synchronization endpoint for a bounded refresh of up to 100 enabled
canonical sources. A currently leased durable refresh is reused rather than
replaced by a scoped request. Customer access remains denied.

Unchanged postings retain their stored descriptions, first-discovery time and
manual sponsorship evidence; only their fresh observation and active state are
updated. Posting dates are compared as timestamps, so equivalent `Z` and
`+00:00` representations do not produce false content changes. Tests also cover
real description/date changes, complete-snapshot closure and reopening.

The large-sweep client bounds database transport requests to 30 seconds and
retries transient storage failures only at the durable batch boundary (at most
five consecutive failures with backoff). It reselects unfinished candidates from
Postgres; provider 429/5xx backoff and existing review decisions stay intact.
Queue indexes and a narrow deferred-row projection avoid repeated JSON-filter
scans while restoring provider throttles.

The completed 2026-10-30 sweep and the free-tier capacity limit are recorded in
[the staging evidence](../staging/README.md#complete-imported-candidate-sweep-2026-10-30).
The user chose to retain the free tier. Do not raise storage budgets or change
billing to bypass a paused collection. Activated-source counts and published-job
counts must be reported separately.

## On-demand status

**Find fresh jobs** now starts a customer-authenticated background refresh scoped
to saved roles and destination countries. Existing matches stay available while
complete source snapshots are collected and matching results update. Requests,
scope reuse, dispatch ownership, progress and free-tier limits are persisted in
Postgres. **Reload matches** remains read-only. Operators and the existing
scheduler retain their separate refresh paths. See
[on-demand operations](on-demand-search.md) for migration 016, quotas and evidence.
This searches a bounded set of verified boards; general web discovery is not
implemented by this feature.

## Employer career links and additional ATS readers

Apply additive migrations `202611010035_extended_ats_discovery.sql` and
`202611010036_extended_ats_search.sql` before using the new source families.
Neither migration enables a source, inserts vacancies, changes billing or raises
the storage budget. The scheduled collector and customer-scoped search use the
same readers after a source has passed validation and activation.

Discover candidates from observed HTTPS career URLs, one per line:

```sh
# Read-only report; works without database credentials.
npm run catalog:discover -- links --file scripts/catalog/employer-career-seeds.txt
# Persist candidates only in isolated staging, then validate explicit identities.
npm run catalog:discover -- links --file scripts/catalog/employer-career-seeds.txt --staging --apply
npm run catalog:discover -- validate --staging --apply --ids 'smartrecruiters:boschgroup,workday:aamc.wd5.myworkdayjobs.com~AAMC'
npm run catalog:discover -- activate --staging --apply --ids 'smartrecruiters:boschgroup,workday:aamc.wd5.myworkdayjobs.com~AAMC' --note 'Reviewed live employer identity and public posting evidence for staging'
npm run catalog:collect -- --staging --ids 'smartrecruiters:boschgroup,workday:aamc.wd5.myworkdayjobs.com~AAMC'
```

The seed file contains two observed examples, not an exhaustive employer list.
Replace or extend the input with real employer sites. Discovery reads at most 20
inputs and three same-origin pages per employer under a 60-second budget. It
extracts recognized ATS links from anchors, frames and embedded URL strings,
without executing JavaScript. A direct supported ATS URL becomes a candidate
without a discovery fetch. Follow-up validation is mandatory. Lookalike hosts,
credentials, non-HTTPS URLs, private-address destinations, automatic redirects,
excluded robots paths and oversized responses are refused. Use final canonical
career URLs when a website redirects. Browser-only sites remain undiscovered.

Observed link origins are immutable hashes of the input and candidate set;
their revision is not a Git commit. `historical_checked_at` remains null.
`license=not-established` records that observing a link grants no content-reuse
permission. Imports do not guess company names, enable boards or invent jobs.
Existing validated source identity is retained on duplicate imports.

SmartRecruiters uses the documented public Posting API list and detail GETs.
The API host's blanket crawler robots rule is not used as the access contract
for these exact documented endpoints; career-page discovery still honors robots.
No credentials are sent, public visibility is required, and HTTP 401/403/429 stop
or defer validation/collection. Detail URLs are reconstructed from validated
company and numeric posting IDs; response `ref` links are not fetched.

Workday uses the JSON endpoints called by its public career site, not a
documented public Workday API. Board identity is
`tenant.wdN.myworkdayjobs.com~SiteName`; site case is preserved. Validation
corroborates the detail's site ID, external posting URL and live hiring-organization
identity. It does not require career-page HTML: some Workday sites serve a JSON
SPA redirect instead. Unknown employer facts do not pass.

Both readers fetch at most five posting summaries and five detail records per
page, checkpoint pagination and bound each page to 45 seconds. They retain source
posting dates, descriptions and country evidence; Workday's relative `postedOn`
text never becomes a fabricated exact date. Explicit additional country/location
variants survive independently; unspecified additional countries are omitted.
Work arrangements remain unknown when not established. Failed details,
incomplete pages and provider errors do not produce complete empty snapshots.
Large SmartRecruiters boards may need several bounded collection invocations;
reruns resume the durable page cursor. A pending scan is not a failed or completed
publication. Customer-scoped searches can publish observed matches independently
without expiring unobserved employer jobs.

**Workday limit:** boards reporting 2,000 or more results are explicitly rejected
before detail collection. They need a durable facet-partitioned scan, which is
not implemented by this version. Do not mark a capped board complete or expire
missing jobs from it. Common Crawl import and arbitrary JavaScript rendering are
also not added here. This version expands discovery through bounded career links
and five supported ATS families, without a Headcount API/MCP/data dependency.

Local verification includes provider fixtures, link discovery, hostname/redirect
guards, identity drift, result caps and real Postgres migration/activation/scoped
search tests. Bounded public checks on 2026-11-01 read five SmartRecruiters Bosch
Group listings and all four returned AAMC Workday listings; NVIDIA demonstrated
the capped-board rejection. These checks did not persist or publish jobs, prove
full Bosch-board completion, apply hosted migrations or establish scheduled
delivery. Source/job totals change; these are check results, not live inventory.

## LinkedIn public jobs collection

Apply `202611010037_linkedin_collection.sql` after migrations 035/036 before
deploying the updated readers. It adds source configuration and an operator-only
registration RPC, and makes publication preserve unseen LinkedIn jobs. It neither
enables a source nor inserts jobs by itself. The existing storage reservations,
account isolation, retention and ATS complete-inventory expiry remain in force.

Preview a bounded search without database credentials or writes:

```sh
npm run catalog:linkedin -- --keywords 'Software Engineer' --country IN --location 'Hyderabad, Telangana, India'
```

After a preview observes usable public listings, register that query in isolated
staging and run collection:

```sh
npm run catalog:linkedin -- --keywords 'Software Engineer' --country IN --location 'Hyderabad, Telangana, India' --staging --apply
npm run catalog:collect -- --staging --ids linkedin
```

Registration is idempotent and permits at most eight explicit keyword/location/
country queries. It refuses configuration edits during an unfinished catalogue
run, preserving the meaning of saved page cursors. The registration command does
not publish preview results. Enabled queries enter scheduled collection and can
participate in profile-scoped refresh. Query roles and locations are operator
inputs; no resume, applicant identity or LinkedIn account session is sent.

The scraper reads the public guest job-search HTML and corresponding public
detail HTML. It extracts the observed title, company, description, stated
location and exact posting date when present. Relative ages do not become exact
dates. Query country is a filter, never a substitute for location evidence.
Work arrangement and sponsorship remain unknown without supporting evidence.
Canonical LinkedIn job URLs and one source identity deduplicate overlapping
queries. Tracking parameters are discarded.

Each page contains at most 25 cards, uses a 45-second aggregate deadline and
paces requests one second apart. Pagination advances by the actual returned
card count. Each query stops once its offset reaches 75 (a final page may bring
the total to at most 99 observations); a run is bounded to eight such windows.
These are search observations, not an exhaustive LinkedIn inventory. Jobs absent
from subsequent windows are not marked closed. A successful window retains
`last_complete=false` while using the normal source refresh cadence. Existing
posting-age retention and stale-observation filtering continue to apply.

HTTP 401/403/429/999, login/challenge pages, redirects, oversized bodies,
unrecognized markup and mismatched job identities stop the page and preserve
previous publications. Individual postings without explicit country evidence or
usable descriptions are skipped and counted as rejected observations; their
absence never implies closure. HTTP/network failures persist backoff
through the existing collector. There is no automatic request retry, login,
cookie/token import, proxy rotation or challenge-solving path. This collector
adds job ingestion; it does not implement LinkedIn Easy Apply.

Verification uses fixtures matching the observed search/detail HTML structure, canonical IDs, query
overlap, request pacing boundaries, pagination, unknown fields, access refusals,
RLS-protected configuration and Postgres publication without unseen-job expiry.
Read-only live checks and previews must be reported separately from source
registration, hosted migration, publication and deployment.

On 2026-11-01, individual unauthenticated search and detail reads returned usable
HTML. The integrated CLI preview exposed postings without explicit countries;
those are now skipped rather than assigned the query's country. A subsequent
preview received HTTP 429 and stopped. No further live retry, source registration
or job publication was performed after that response. End-to-end live preview
completion therefore remains unverified; access can vary by environment.
