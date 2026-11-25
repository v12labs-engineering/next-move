# Catalogue operations

Customer requests read and match listings; they never launch ingestion or expose
operator credentials. Resume/profile data stays in the account path. Candidate
destination demand is aggregated inside Postgres and only influences source
priority. Collection includes all listing languages and professions; candidate
recommendations still require role relevance.

## Apply and verify

Apply `202610290006_catalog_collection.sql` and
`202610290007_catalog_backoff.sql` after the preceding migrations.
Use the existing `npm run staging:migrate` dry run and `npm run staging:apply`
for the isolated staging project. Test this migration before production rollout.
The new collector requires it; a missing migration fails instead of silently
falling back to the old collector. Existing catalogue IDs and saved history stay
intact. New source snapshots are staged until complete and published atomically.

```sh
npm run catalog:audit -- --staging
npm run catalog:collect -- --staging
npm run catalog:sources -- --staging
```

Without `--staging`, commands use explicit process environment configuration:
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. They do not implicitly
load `.env.local`. Audit is read-only and includes all 249 selectable destinations,
zero observed-supply rows, original title inventory, explicit English experience
requirements, unknown language classification, source status and recent runs.
It does not infer missing classifications or estimate a share of the job market.
Per-candidate relevant supply is available in `/api/state` after authentication.
Audit excludes resumes, candidate identities and individual preferences.

`--output path.json` saves a report and refuses to overwrite an existing file.
Store private operational exports under ignored `.local-data/`, never in Git.

## Expand sources

The [candidate importer and live validator](source-discovery.md) add pinned public
directory observations, bounded validation batches and automatic activation of
verified boards in isolated staging. The existing authenticated collection
endpoint can expand sources before refreshing jobs, with a global lease,
cooldown and refresh-backlog guard. Activation still requires a successful live
check; publication still requires a complete collection snapshot.

`job_source_directory` is the operator-maintained source directory. The migration
enables the existing eight sources. Source links to known Ashby, Greenhouse and
Lever employer boards discovered during collection become disabled directory
candidates with the original URL as provenance. They are not treated as verified
supply or fetched automatically. Adding an ATS adapter does not discover all
employers on that platform.

An operator can add a verified board or enable a discovered one using the
service-role database connection after checking its identity, source access,
reuse conditions and scope. Source IDs are `ashby:<board>`,
`greenhouse:<board>` and `lever:<site>`; arbitrary URLs are not accepted. The
current Lever adapter targets the global host; EU-hosted Lever sites require a
separate adapter and are not silently redirected to the global host.

Arbeitnow follows the source's page continuation until completion, rather than
stopping at three pages. Lever uses offset/limit pagination. Employer Ashby and
Greenhouse feeds return whole-board responses. Unknown geography and malformed
responses remain explicit rejected postings or failed pages. A page error
preserves the previous successful catalogue and the durable page checkpoint.

## Scheduling and recovery

Vercel is the sole scheduled collection runner. `vercel.json` calls
`GET /api/cron/jobs` every six hours at `0 */6 * * *` (00:00, 06:00,
12:00 and 18:00 UTC / 05:30, 11:30, 17:30 and 23:30 IST).
The GitHub Actions collection workflow has been removed; GitHub still runs CI.
The existing `v12labs-projects` team was verified on 2026-11-02 to have an active
Pro plan. This cadence requires Pro or Enterprise; Hobby permits daily jobs only.
No plan upgrade or budget increase is part of this change.

Set a server-only `CRON_SECRET` of at least 32 random characters in the Vercel
production environment. Vercel supplies it as `Authorization: Bearer <secret>`.
Also configure the existing Supabase URL and service-role key on Vercel, and
apply the collector, durable-refresh (`202610300007`) and retention migrations
before deployment. The cron always uses Vercel Workflow, independently of
`CATALOG_DURABLE_REFRESH_ENABLED`. That flag still controls the separate operator
`/api/catalog/sync` endpoint. The existing Supabase database and description bucket
continue storing listings and checkpoints; this change moves scheduling and
execution to Vercel without migrating storage.

The cron endpoint only claims the shared refresh lease and starts or reuses a
workflow. HTTP 202 with `accepted=true, complete=false` confirms admission, not
completed scraping. Cleanup, match-snapshot pruning, optional bounded source
expansion and feed collection execute in durable steps. Preparation outcomes are
stored in the final refresh result and logged on Vercel. Scheduled scraping refreshes matching but does not launch automatic applications;
the separate application sweep owns submission. No external scheduler,
local daemon, new scraping service or GitHub trigger credential is required.
`scripts/catalog/trigger-catalog.mjs` remains an optional manual staging diagnostic.

Overlapping cron/operator triggers reuse the same refresh. An enqueue error or
workflow-ID persistence error returns a failure while retaining the lease:
an uncertain enqueue may already be executing. A later trigger can reclaim an
expired lease; old workers cannot publish after losing ownership. Vercel Cron
does not retry failed HTTP invocations, so inspect runtime logs and
`catalog_refresh_runs` for failed/partial/interrupted runs. After fixing a failure,
use Vercel's Cron Jobs dashboard to trigger another authenticated invocation.
Workflow step retries and source backoff handle failures after admission.

Cron registration requires a production deployment. This repository's isolated
staging app uses a Vercel production deployment; ordinary preview deployments do
not receive cron. Verify the new path in the deployed Cron Jobs dashboard, invoke
it once, follow the returned workflow/refresh IDs to a terminal state, and inspect
`job_catalog_runs` for actual source results. Observe a later scheduled invocation
separately. A local build or HTTP 202 does not establish hosted delivery or
successful collection. Deploying the workflow removal on the default branch also
stops future GitHub scheduling; cancel any old in-flight Actions collection run
during cutover. The unused GitHub variable/trigger secret can then be retired.

Sources successfully checked in the last 5.5 hours are skipped. The source-health
UI uses a six-hour freshness target. Scheduled delivery and processing time are
best effort, so a six-hour trigger is not a six-hour freshness guarantee.
Source limits, pagination and outages can delay it further.

Workers take source leases with a new token per attempt. Every successful page
persists its continuation and records counts, renewing the lease. Expired leases
can be reclaimed; old tokens cannot checkpoint or publish. Partial work resumes
at the saved page; a worker deadline pauses safely. Retry handles temporary
network errors, 429 and server errors with bounded backoff and Retry-After.
Long Retry-After values pause collection for a later scheduled attempt.
Deferral persists `retry_at` so subsequent callers cannot immediately retry a
throttled source. Missing or invalid retry guidance uses a 15-minute fallback.

Priority gives two slots to candidate destination demand for every rotating
oldest-source slot. Demand comes only from observed source countries; no
unobserved geography or profession coverage is invented. A baseline sweep still
visits sources lacking observed candidate demand.

## Read the evidence

`job_catalog_runs` stores fetched/rejected raw postings, accepted location
records, duplicates by stable listing ID, actual HTTP requests, attempts, page
cursor and timestamps. Completed runs add new/content-updated/expired counts.
Location variants mean accepted records can exceed raw postings. Coverage
collapses variants by job URL within each country. Raw counts are not unique
global vacancies or candidate-relevant matches.

Paused runs and source errors are unfinished work. Successful runs establish
completion of that source's exposed inventory, not a complete country's labour
market. Upstream pagination can change while it is being read. Failed attempts
are recorded; prior run history is not backfilled from overwritten source state.

Request-side matching scans stable IDs without the former 3,000-row cutoff,
scores each page against the account's confirmed profile, and drops unrelated
unsaved listings from the response. If scanning exceeds the request budget,
it returns an explicit retry error instead of an incomplete recommendation list.
The scan requests listing metadata through an authenticated, RLS-preserving
Postgres function in pages of 1,000, continues until an
empty page even when the server returns fewer rows, then fetches description
evidence for relevant and saved listings in batches of 100. All destination
records still contribute to coverage; unrelated descriptions do not consume the
request's transfer budget. Description-based skill and experience scoring remains
part of the final match. Source-health loading precedes the bounded listing scan.
The shared title-relevance gate runs before full scoring; description batches of
100 are fetched with at most four concurrent reads. The complete metadata scan
has a one-minute budget, and the authenticated state route allows up to two
minutes for source health, scanning and description evidence on the free tier.
Broad profiles can still take tens of seconds; these controls are finite limits,
not a low-latency service guarantee. **Reload saved matches** reloads this stored
catalogue. **Refresh jobs** separately starts a bounded background check of
verified boards using saved roles/countries; see [on-demand operations](on-demand-search.md).
Original-language title matching is Unicode-aware, but cross-language title
translation and comprehensive occupation aliases are not claimed. Benchmark
these gaps before setting useful-supply targets.

With the local production build configured for staging, run
`node scripts/verify/verify-catalog.mjs --browser` for the generated-profile API/browser
check (requires locally installed Chrome). It creates temporary synthetic nurse
and backend-engineer accounts, uses only real catalogue jobs, and deletes the QA
accounts in `finally`. It never invokes resume AI, sends email or submits an
employer application. A browser screenshot is written under `.local-data/`.

Monitor growing run history, paused staging rows and request time before scaling.
The free-allowance capacity and six-hour scheduling need observed runs; neither a
workflow file nor passing local tests verifies them.

## Public feed fetching

Scheduled discovery runs every six hours through the existing `/api/cron/jobs`
durable workflow. With `APP_ENV=staging` and `AUTOMATIC_DISCOVERY_ENABLED=true`,
each cycle performs three archive attempts before collection, then validates up
to `SOURCE_DISCOVERY_BATCH_SIZE` candidates (default 14, 120-second budget).
The queue prioritizes never-validated candidates and rotates providers between
cycles. A large collection backlog no longer disables expansion. Newly enabled
sources are collected first. Scheduled collection never submits applications.

Apply `202611070060_public_ats_readers.sql` and
`202611070061_scheduled_archive_discovery.sql` before deploying this release.
The source-pool migration preserves the installed version, including whether
LinkedIn support has been installed. If staging history contains unrelated
unapplied migrations, inspect it and apply only these two; do not blindly use
`--include-all` to enable unrelated features.

Archive intake covers Ashby, both Greenhouse hosts, Lever, both SmartRecruiters
hosts, Workday, Recruitee and Workable. `archive_discovery_channels` stores each
partition's pinned index and next page; `archive_discovery_runs` stores small
receipts. Candidate imports and cursor movement commit together, and repeated
request keys cannot repeat an admitted request. SQL permits at most 12 attempts
per UTC day. Failures retain the cursor with a 1–24 hour partition cooldown;
HTTP 429 also pauses the provider. Completed partitions check for a newer index
weekly. A 16 MiB capacity headroom check skips discovery when storage is tight.

Archives supply employer addresses, not current listings. Candidates must pass
live employer, description, country and dated-software-posting validation before
automatic activation. Existing publication and matching date windows still
apply. Paid Search also rotates queries for the new ATS families within its
unchanged 48-request/$1 daily limits.

Recruitee uses the [documented public XML feed](https://support.recruitee.com/en/articles/8213076-faq-api),
which is excluded from the [February 2027 Careers API token requirement](https://docs.recruitee.com/reference/authentication-1).
XML must be complete and well formed; custom career domains are accepted only
as links explicitly supplied by the employer's feed, never fetched as discovery
endpoints. Workable uses its [documented published-jobs feed](https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page)
at the canonical public widget endpoint. Repeated Workable shortcodes merge
country variants; conflicting posting content fails the snapshot. Neither
reader invents publication dates or silently truncates a large inventory.

Collectors fetch public ATS feeds directly over HTTP. Parsing, source leases,
page checkpoints, complete-snapshot publication, storage reservations and
provider backoff remain server-side. Collection results expose `newRecords`,
`updatedRecords` and `expiredRecords` separately from observed listing-location records.

## Free-tier description storage

Migrations `202610310005` through `202610310010` keep searchable job metadata in
Postgres and store original public descriptions as Brotli blocks in immutable,
SHA-256-addressed packs in the existing `job-catalog-content-v1` public bucket.
Each pack is at most 512 KiB; the operator ledger reserves at most 768 MiB total.
Only public job text enters these objects. Service-role uploads are required.
Matching, resume tailoring and application preparation restore and verify the
original UTF-8 text through the same reader, including bounded HTTP range reads.

Deploy compatible readers before archiving. Set `CATALOG_CONTENT_ENABLED=true`
for full collectors; scoped discovery always archives before publishing.
Then run `node --import tsx scripts/catalog/archive-catalog-descriptions.mts --apply --readers-ready`.
The staging-only helper uploads and reads back each pack, verifies every block,
then clears database text with an original-content checksum compare-and-swap.
It preserves IDs and discovery/check timestamps. Six disjoint keyset batches
run concurrently, attachments use 16-row checksum-protected transactions, and a 450 MiB maintenance ceiling stays below the free database
allowance. The normal collection guard remains 400 MiB.

Watch the ignored backfill receipt and run ordinary `VACUUM (ANALYZE, TRUNCATE,
SKIP_LOCKED) public.job_catalog` as needed and after completion to reclaim dead
TOAST pages. Do not use a large `VACUUM FULL` without accounting for its temporary
copy. Verify no nonempty raw descriptions remain, every reference points to a
ready pack, catalogue rows remain intact, and original profile match results are
unchanged before wider discovery. If ordinary vacuum leaves a sparse TOAST relation, inspect its actual live chunks
and budget its temporary copy before compaction. PostgreSQL 17 supports
`VACUUM (FULL, PROCESS_MAIN false, SKIP_LOCKED) public.job_catalog` to compact only
the associated TOAST relation. In the verified staging migration it contained
zero live chunks, so the temporary copy was empty. Never infer this from stale
`n_live_tup` estimates. Recheck record counts and profile matches afterward.
Existing readers cannot be rolled back to a version lacking reference hydration
after text has been moved.
