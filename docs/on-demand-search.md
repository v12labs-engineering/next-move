# On-demand job search

The Jobs page loads stored matches first. **Refresh jobs** admits a durable
background check using the account's saved roles and destination countries.
Changing a display filter does not change that saved scope. **Reload saved matches**
remains a read-only action. Existing rows stay visible during live collection and
while updated matches are computed.

`POST /api/job-search` accepts only `{}`. It requires a verified account, a valid
saved profile, same-origin JSON and `ON_DEMAND_SEARCH_ENABLED=true`. The database
constructs its canonical scope from that account's profile and saved countries;
the caller cannot supply crawl URLs, source IDs or another account's identity.
`GET /api/job-search` returns only the current account's matching scope and safe
progress fields. Both responses are private/no-store. Neither response contains
operator errors, credentials, another account's identity, or a resume.

## Durable work and limits

Migration `202610300016` adds operator-only run, dispatch, step, request and
control ledgers. Customer functions bind reads/writes to `auth.uid()`. Shared
scope rows contain only normalized roles and countries, not resume or contact
data. Global admission is serialized in Postgres:

- At most 12 new shared runs per UTC day and one active run.
- At most three admitted requests per account per UTC day, one hour apart.
- Identical scopes share a recent run for one hour; an account repeating its
  current request adds no quota usage or duplicate work.
- A run plans at most 96 boards in batches of eight, using direct public-feed HTTP
  requests and two source fetches in parallel. The eight-minute worker budget
  can pause a run before every board finishes.
- Each source publishes at most 100 relevant listing-location observations and
  1 MiB of stored metadata. Public provider responses are capped at 15 MB and
  collection at three pages per board. Unseen IDs take priority over existing IDs.
- A worker checks its total time budget before each batch and stops after eight
  minutes. Active status expires after ten minutes, including lost starts.

These limits bound the feature's additional work. Other application usage and existing scheduler activity still
consume the same platform allowances. The existing 400 MiB storage guard remains
unchanged. Capacity rejection pauses live collection, preserves committed
snapshots, and is shown as a free-limit pause. It never triggers an upgrade.

The API checks the lower of the server/database storage guards before admitting
new work. A full catalogue returns `blocked: storage_limit` without consuming a
search request. Status polling displays this condition even without an existing
run, disables collection and checks for recovered capacity once per minute.
Saved-match reload remains available. Admission checks are advisory; atomic
storage reservations still protect publication against concurrent growth.

Apply migration `202610300017` before releasing the scoped collector. It adds an
operator-only metadata read for up to 100 explicitly selected sources. A small
on-demand pair reads only those two boards' directory, health, lease and backoff
rows; it does not download the full source directory or global demand data.
The ordinary unscoped collector keeps its existing demand-priority behavior.

`claim_job_search_dispatch` admits one dispatcher. Polling can recover an
unconfirmed enqueue after two minutes. A replaced dispatch token fences late
workers before further work. The workflow is pinned to its deployment and stores
its source plan before collection. Source progress is keyed in Postgres so step
replay cannot double-count publication. The existing source leases also dedupe
overlapping work with scheduled collection.

Old request logs and unreferenced terminal runs are pruned after seven days
during admission. An account's latest run remains available for status hydration.
Listing history, saved jobs, resumes and existing applicant data are not pruned.

## Source selection and publication

The planner queries enabled Ashby, Greenhouse and Lever boards with saved-country
evidence and no active lease/backoff or scope check in the last hour. Employer
size does not exclude a board. Up to 32 slots prioritize observed relevant titles;
up to 64 explore activated boards without title evidence. Remaining slots can use
known relevant boards. Country slots and exploration rotate by request hour.
Exploration is a coverage attempt, not a claim of a relevant vacancy.

Migration `202610310006` adds scoped discovery publication. The existing parsers
filter actual titles and locations against the saved roles and countries. Scoped
observations only add/update observed rows: they never expire unobserved listings
or mark a board's full inventory healthy. Pagination cursors, per-scope checks,
provider backoff, dispatch fencing and replay-safe counters are durable. A run
reports partial when any board fails or remains unfinished.

Public feed requests target supported ATS URLs. Profile/resume data and database
credentials remain on the server. Descriptions are verified into the existing
free object bucket before publication; see the catalogue storage procedure.

Progress separates newly discovered catalogue IDs from updated observations.
Profile matches are counted only after matching catches up and only when their
original `seenAt` is within this run. **Show N new matches** filters those results;
refreshing an old row cannot make it new. The default list order is newly
discovered, with best-match sorting still available.

The browser polls compact status every 15 seconds while active, pauses requests
when hidden, and serially refreshes matching results when publication advances.
An assessment timestamp detects publication newer than the initial catalogue
read, including completion during a slow page load. The status distinguishes
source publication from a still-running match update and shows the next allowed
request time in the browser's local timezone. Search status survives reload
through backend state; browser storage is not used for durable progress.

## Verification

`npm test` covers admission/ownership and dispatch/step fencing in real Postgres
via PGlite, scope reuse, quotas, changed profiles, stale runs, source exclusions,
title/country selection, response/snapshot caps and rejection of partial
publication. Existing catalogue tests cover atomic new/changed/closed/reopened
posting publication.

`node --import tsx scripts/verify/verify-on-demand-search.mjs` targets only the isolated
staging manifest. It creates and deletes generated accounts, uses real catalogue
jobs, checks live API authorization/deduplication, browser continuity and reload,
and records actual publication versus a capacity-limited outcome separately.
It submits no applications and invokes no AI. Private receipts/screenshots are
written under ignored `.local-data/`.

Use `--saved-profile-scope` only with the confirmed account baseline receipt. This
copies only role, country and location preferences into generated QA accounts;
identity, resume, saved history and application settings are not copied. Measure
real account outcomes separately against its pre-run IDs and first-discovery time.
