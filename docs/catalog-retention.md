# Catalogue retention

Apply `202610310015_match_posting_window.sql` and
`202610310016_catalog_retention.sql` before releasing these readers and workers.
Also apply `202610310017_catalog_revision_safe_update.sql`; it makes the existing
match-revision trigger target its singleton primary key explicitly, satisfying
the hosted safe-update guard during catalogue deletion without disabling it.
The existing Git-triggered staging deployment remains the release path.

Jobs defaults to the past seven days, with an explicit past-30-days option. New
discovery excludes unknown/future posting dates. Saved and applied jobs bypass
age filtering; the Applications history retains tracked jobs of every age.

## Physical cleanup

The six-hour Vercel `/api/cron/jobs` workflow runs bounded cleanup before source
collection. The operator `/api/catalog/sync` endpoint also runs cleanup before
collection or durable enqueue. Scheduled cleanup outcomes are stored in the final
`catalog_refresh_runs.result.preparation.cleanup`; operator responses include
`cleanup` directly. Each preparation deletes up to eight 500-job batches and four
32-pack batches within a 20-second loop budget. Individual operations retain
their transport deadline. An unfinished cleanup reports `moreJobs`/`morePacks`
and resumes during a later preparation.

Only source `posted_at` strictly older than 30 rolling days is eligible. The
30-day boundary, unknown dates and future dates remain untouched. A listing is
protected if any account has an interested/saved or applied status, a resume
draft, or any application run (including cancelled, submitted, paused and
uncertain outcomes). An application target URL also protects the matching listing
when its `job_id` is absent. No application record, packet, receipt, draft or
profile is deleted. Scores and unsaved/dismissed statuses of deleted listings
cascade through their existing foreign keys.

Protection is checked globally using service-only functions. Short table locks
prevent racing status/reference edits while each batch deletes rows; foreign keys
remain intact. Missing permissions or lock timeouts fail the batch. Cleanup is
idempotent, bounded and serialized with a transaction advisory lock.

Collectors exclude expired new observations before uploading descriptions. The
database filters checkpointed and scoped publications as well, rechecks pending
snapshots at publication, and guards direct inserts against old-job reimports.
Existing retained jobs can still refresh and receive source closure updates.
These filters do not infer a posting date from a refresh timestamp.

## Description storage

Only whole packs with no catalogue or staged-collection reference are deleted.
Mixed packs remain intact to preserve saved jobs' original text. A 24-hour grace
period protects new uploads. A database claim marks a pack unavailable for new
references before storage deletion. The claim uses a 15-minute lease and token;
stale acknowledgements cannot finalize replacement claims. Failed object deletion
keeps the ledger entry for retry after lease expiry. Ledger bytes are released
only after the storage API confirms removal. These object-byte counts are separate
from database space; deleting rows alone does not shrink allocated Postgres files.

For the explicitly verified isolated staging database, a resumable operator run is:

```sh
node --import tsx scripts/catalog/cleanup-catalog.mts --staging --apply
```

It verifies the project, writes a private receipt to
`.local-data/catalog-retention-receipt.json`, and reports committed batch counts.
The ten-minute budget preserves progress and reports incomplete work honestly.
Compare saved/applied, draft and application fingerprints before and after a first
run. Check remaining eligible rows and broken references, then use ordinary
`VACUUM (ANALYZE, TRUNCATE, SKIP_LOCKED)` and measure allocated space separately.
Compaction requires a measured temporary-space and lock budget; row-count savings
must never be presented as measured disk savings.

`tests/catalog-retention.test.ts` executes the SQL protection rules, date boundary,
reimport guard, cross-account preservation, shared and staged pack protection,
claim fencing and storage-failure behavior in isolated fixtures.
