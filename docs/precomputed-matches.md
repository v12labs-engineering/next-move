# Precomputed matching and paginated reads

Apply `202610310011_precomputed_matches.sql` to the intended database before
deploying this reader. Also apply `202610310014_cached_matching_query_plan.sql`
for covering-index availability reads and `202610310015_match_posting_window.sql`
for posting-date filtering. These migrations are additive and need the existing server-only
service-role configuration and Workflow runtime. No credentials or match
results are stored in browser storage.

The software-only policy additionally requires `202611020041_software_role_scope.sql`.
It fences existing matching leases, marks generations stale, and requires the
scorer's `match.softwareRole=true` marker for new recommendations before page
limits and counts are computed. Old unclassified recommendations stay hidden
until rebuilt. Saved/applied history remains available; no catalogue or account
history is deleted. Deploy the shared ingestion/scoring policy with this reader.

The onboarding investigation separately applied `202610310012_matching_query_plan.sql`
and `202610310013_matching_indexed_keys.sql` to staging. Applying the earlier 011 there requires an explicit reviewed
`--include-all` migration plan. Preserve 012/013 and their history; do not repair them away.

## Read path

`GET /api/state` reads the authenticated profile and one `read_account_matches`
RPC. The RPC reads published account scores and joins current job statuses and
listing availability. It does not scan destination catalogues, download
descriptions, score jobs, or query source health. Catalogue coverage comes from
the last completed assessment with its original `assessedAt` timestamp.

The response retains `state.jobs`, `state.trackedCountries` and `state.catalog`.
It adds `generation`, `total`, `offset`, `limit`, `counts`, and `matching` (status, freshness,
completion time and retry time). Consumers must use pagination metadata rather
than infer totals from `state.jobs.length`.

| Parameter | Values / default |
| --- | --- |
| `limit` | 1–200, default 25 |
| `offset` | Nonnegative integer, default 0 |
| `view` | `all` (default), `jobs`, `saved` |
| `country` | Country name or `all` |
| `strict`, `hidden` | `true` or `false`, default `false` |
| `visa` | Sponsorship signal or `all`; work-rights exemptions come from the saved profile |
| `sort` | `score` (API default), `newest` by posting date; ties use job ID |
| `datePosted` | `week` (default, rolling 7 days), `month` (rolling 30 days) |
| `since` | ISO timestamp filtering discovery time |
| `generation` | Optional published generation UUID; a changed generation restarts at offset zero |
| `query` | Case-insensitive substring in title, company, country or city |

The Jobs page requests 25 results per page. Filters and summary counts run on
the server over the complete published match set. Applications reads saved
pages; command search queries the complete score set with a bounded result page.

The Jobs page defaults to Past week and newest posted first. Past month is an
explicit choice; empty results never widen the window automatically. Only source
posting dates within the chosen window qualify for discovery, including the
cutoff and excluding future and unknown dates. Discovery and last-check timestamps
do not reset posting age. The database applies the cutoff on every read, including
totals, counts and pagination, so cached scores age out without a rebuild.
Interested (saved) and applied listings bypass the age cutoff, even when closed
or missing a posting date. Applied jobs still use the existing visibility toggle
on Jobs. The saved/application history view retains all tracked statuses without
an age restriction. Command search uses the week default and keeps saved/applied
listings too. The fresh summary counts postings from the past three days.

The filters themselves do not delete data. Migration `202610310016_catalog_retention.sql`
adds bounded scheduled cleanup of jobs older than 30 days, while preserving every
account's saved/applied jobs, resume drafts and application records. It also
prevents expired new imports and removes whole unreferenced description packs.
See [catalogue retention](catalog-retention.md) for protection rules and storage accounting.

## Refresh path

Profile saves and catalogue refresh completion enqueue durable scoring.
On-demand search completion does the same because its listings are shared.
A sweep traverses all accounts by ID, 100 at a time. Reads of missing or stale
results also schedule an enqueue after the response, recovering missed work.
Scores receive a six-hour coverage refresh even without a content publication;
posting windows and listing availability are checked live. The Jobs page polls while matching is pending or stale.

An existing profile row does not establish that onboarding is complete. If a
worker snapshot fails candidate validation, matching releases that build's lease
and stops without retrying validation, scoring listings, publishing a generation,
or dispatching automatic applications. Existing published scores are retained.
The account must have a valid profile and confirmed destination countries before
a subsequent build can run; missing preferences are never inferred.

Scoring uses the in-app rule scorer (`matchJob` in `lib/matching/index.ts`). Preferences
are hard filters that set `reviewable`/`eligible` to false with a stated gap: target
country and city, excluded companies, work mode (office-attendance wording turns a
"remote" posting into hybrid; `unknown` passes only when all three modes are
selected), an experience band (postings more than 4 years below or 1 year above the
candidate's years, from stated ranges or senior/junior title wording) and a posting
that refuses sponsorship where the candidate needs it. The 0–100 score only ranks
jobs that pass: title 35 (related 30), skills 45 × matched/listed, work authorization
or confirmed sponsorship 10, experience closeness up to 10. All scored jobs are
stored; the reader hides non-reviewable new jobs and keeps saved ones in Saved.

For profiles built from resume analysis, recommendations also require a matching
or related role and at least one reviewed skill supported by the job description.
The scorer excludes conflicting software
specializations, unmet stated minimum experience, and missing skills in
explicit, simple required-skill lists. Reviewed manual profiles keep their
existing scoring rules. This stricter policy favors precision and can leave
thinly described listings out of the results.

`202611230104_resume_grounded_matches.sql` invalidates older recommendations
and applies the same new-listing gate to Jobs and command search before counts
and pagination. Saved history remains readable while the scorer rebuilds.

The complete matching algorithm runs in checkpointed background batches, preserving
description-based skills, experience checks, saved jobs and coverage semantics.
Background workers scan one destination at a time using stable ID cursors. Each
step handles up to 200 listings; database requests are bounded to 30 seconds.
Successful batches survive step retries. Failed builds retain the last complete
generation and permit another attempt after one minute. See the infrastructure
section below for admission limits, temporary storage and recovery.

Score batches stage at most 200 listings per write. The database atomically
publishes only complete generations. Lease tokens fence replaced workers;
profile versions prevent publishing or serving older-preference scores.
A catalogue revision detects changes during a build and queues follow-up work.
Concurrent refreshes reuse the existing lease. Expired leases and cooldowns allow
recovery after dispatch failures. Only service-role functions may write scores;
reads derive ownership from `auth.uid()`.

For an initial backfill or operator recovery, send `POST /api/matches/refresh`
using `Authorization: Bearer <INGESTION_SECRET>`. The 202 response confirms enqueue,
not completion. Monitor `account_match_state` and Workflow runs for publication.

## Verification

`tests/precomputed-matches.test.ts` executes the migration in PGlite and checks
ownership, atomic publication, concurrent claims, profile changes, stale-worker
fencing, live statuses, closed listings, ordering, filtering and pagination beyond
200 records. `tests/match-page.test.ts` verifies repeated reads only request
profile data and the stored page, and rejects invalid pagination before querying.
`tests/matching-worker.test.ts` exercises full scoring, staged publication,
publication replay and incomplete-read failure. Existing account-catalogue tests
verify description evidence and coverage. An isolated browser fixture also checks
pending-state polling, bounded pages, server filters, dismiss/undo, refresh
polling and 390px overflow; it uses synthetic responses and bypasses authentication
only in the disposable fixture, without changing the application's auth gate.

## Staging rollout evidence (2026-10-31)

Migration 011 was applied and its remote history verified alongside the existing
012/013 query fixes. A dedicated authenticated test account used an explicitly
fictional backend profile with eight destinations and the real shared catalogue;
no mocked listings, AI calls or employer submissions were used.

The previous verified release returned 3,184 scored jobs / 3,083,230 bytes in
18.061 seconds. Initial precomputed-release checks published all 3,184 scores,
returned a 25-job page / 28,095 bytes, and measured repeat requests at
0.597–0.794 seconds. The first cold ready-state function request took 4.770
seconds. Chrome showed 25 job rows after 3.318 and 2.080 seconds. Distinct next
pages, country filtering, 390px layout, read-only score permissions and anonymous
access checks passed. These are measured samples, not latency guarantees.

The profile-invalidation check exposed a catalogue statement timeout after
successful initial publication. That finding produced the adaptive batching,
sequential background scans and read-draining repair described above. The first
release's successful ready reads are not evidence that this later refresh check
passed. Final run and deployment evidence is recorded in the ignored
`.local-data/matches-speed-receipt.json` and associated deployment/workflow logs.
Main's automatic deployment is the coordinated release path after verification.

The repaired candidate rebuilt a new profile version and atomically published all
3,184 scores in 136 seconds under the observed load, without a failed workflow
retry. Its ready-page samples were 1.258–1.968 seconds. The initial profile build
can still take minutes; faster cached reads do not remove that first computation.
Local verification passed all 241 tests, TypeScript and lint (three pre-existing
warnings in ignored helpers).

The final Git-deployed alias exposed a separate `read_account_matches` statement
timeout. Migration `202610310014_cached_matching_query_plan.sql` reuses 013's
covering active-country/cursor index to read availability without thousands of
wide catalogue heap lookups. A bounded staging EXPLAIN measured 4.413 seconds
before and 2.203 seconds with the covering lookup (145 heap fetches across 3,184
matches). Ownership, closed/saved jobs, counts and pagination remain covered by
executable tests, including 20,000 unrelated catalogue rows.

After applying 014, the stable staging alias returned repeat 25-job pages in
0.687–0.812 seconds; the first ready read took 3.248 seconds. A Chrome load showed
25 real job rows in 2.980 seconds. The profile-save loading notice also passed a
complete hosted rebuild: saved-profile reassurance remained visible and fresh
results appeared automatically after 98.359 seconds, with no browser errors.
All 245 merged tests, TypeScript and lint passed; detailed final deployment,
subsequent browser measurements and cleanup receipts remain in ignored
`.local-data/matches-speed-receipt.json` and its associated logs.

## Infrastructure changes: scoped rebuilds and bounded workers

Apply additive migrations `202610310023` through `202610310029` before deploying
this worker/reader. These migrations do not rewrite existing score rows. They
retain old complete generations, RLS, policy fencing and profile-version checks.
Existing account/application work in the checkout is independent of this rollout.

- Country content revisions replace global catalogue invalidation. Unchanged
  `last_checked_at` refreshes and lossless description archival do not trigger
  scoring. Changed content, availability and saved-job destinations do. Time-only
  rebuilds now occur after six hours; posting windows, availability, account
  statuses and display freshness are evaluated on reads. Coverage remains an
  explicitly dated assessment, not a live count.
- `matching_capacity.max_workers` defaults to **2**, enforced transactionally in
  Postgres across routes, sweeps and instances. Excess accounts retain `queued_at`.
  One leased Workflow dispatcher revisits queued work every 15 seconds and exits
  when the queue drains. Completion also admits waiting accounts. Expired worker
  claims can be replaced; stale tokens cannot checkpoint or publish. A failed
  dispatcher is recoverable after its five-minute lease through a page poll or
  scheduled sweep. Existing catalogue scheduling remains a recovery backstop.
- Each scoring step handles at most 200 listings. Progress and scored batches
  commit together. Retried steps start at the committed cursor. Finalization
  performs location deduplication and complete-generation publication without
  rescoring. Temporary batch receipts count against the existing storage guard
  and are removed on publication, failure or replacement.
- Auto-apply reads fresh, server-published scores and live listing availability,
  using the past-month discovery window. It queues matching when stale instead
  of rescanning. A durable keyset sweep reaches beyond 1,000 opted-in accounts;
  completing matching also wakes opted-in automation. These checks never relax
  application consent, quotas, employer claims or receipt requirements.
- New score writes share immutable public listing snapshots. Account scores
  remain private. Old JSON rows remain readable. Operators can compact old rows
  with `compact_account_matches(200)` in bounded batches, only with sufficient
  disk headroom; this is not run by the migration. Scheduled catalogue maintenance
  prunes at most 500 unreferenced snapshots. Keep the physical database guard:
  compaction is not a reason to increase allowances or ignore index/TOAST growth.
- Description hydration merges nearby ranges (at most 1 KiB gaps, 128 KiB merged
  range) and shares identical in-flight reads. A single existing block can exceed
  that merge limit, but stays below the existing 512 KiB pack limit. Checksums,
  decompression bounds and exact Content-Range validation remain mandatory.
- Jobs polling uses `/api/matches/status`, with backoff, jitter and no requests
  while the tab is hidden. It reloads the full result page when generation changes
  or matching becomes fresh. Status queries do not execute score filtering/counts.

### Instrumentation and acceptance

`matching_metric` JSON logs expose metadata, hydration, inference, checkpoint,
publication and read durations; rows scanned/scored; cache/range request counts;
queue admission/wait; and complete build time. Build correlation hashes the lease
rather than logging it. Error messages, candidate identities, resume text, URLs
and provider bodies are excluded. Python `matching_inference` events split lock
wait from execution time.

After migration, `node --import tsx scripts/catalog/matching-health.mts --staging` reads
aggregate queue age, active/expired workers, failures, database bytes, and table/
index sizes from the verified staging project. It does not change data. Monitor
queue age alongside build p50/p95, retries, SQL time, inference wait, and growth
of scores/checkpoints/features before changing capacity. Account counts and
completed worker runs alone do not establish acceptable latency.

Local reproducible checks use `tests/matching-capacity.test.ts`,
`tests/matching-worker.test.ts`, `tests/matching-infrastructure.test.ts`,
`tests/auto-apply-infrastructure.test.ts` and `tests/catalog-content.test.ts`. Results on the same synthetic workloads:

| Workload | Before | After |
| --- | --- | --- |
| Five unchanged catalogue checks | 5 rebuild claims | 0 rebuild claims |
| 401 jobs, failed second 200-job batch | 802 rows for a complete restart | 601 processed rows; identical recommendations |
| Two simultaneous readers, 20 adjacent description blocks each | 40 independent cold range reads | 1 shared range read |
| 100 repeated account listing payloads | 46,500 JSON bytes | 15,216 JSON bytes with one shared snapshot |

The retry baseline is the work required by two full passes; the checkpointed
count is observed in the injected-failure test. Storage figures are fixture JSON
payload estimates, **not** measured database/index/TOAST savings. These checks
verify reduced work and correctness, not hosted throughput or production p95.
Staging migration, concurrent hosted rebuilds during collection, and an observed
queue-drain/recovery cycle remain deployment acceptance checks.


## Storage pools and bounded auto-apply (2026-11-01)

Migration `202611010030_matching_storage_pools.sql` (already on main) separates
matching growth from ingestion: account scores, checkpoints, state and shared
listing snapshots use at most 40% of the existing database allowance (160 MiB at
the current 400 MiB). The overall physical database guard remains authoritative.
Operators may lower the service-only `matching_storage_limits` values.
`matching_operational_status` reports pool usage and limits. A full pool rejects
new writes and keeps previous generations; committed checkpoint replays still
succeed. The same migration's feature/title pool, `cache_matching_features` and
`prune_matching_titles` serve only the retired engine and are not called.
`202611010033_rule_scorer.sql` applies after it and restores rule-scored readers.

Auto-apply keeps the best 50 eligible candidates in tracked countries across
200-row pages instead of buffering every page; selection, including ties, is
unchanged.
