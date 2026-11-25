# Alexandria in core job sourcing

Historical staging record. Migration `202611110068_application_followup.sql`
retires the Alexandria job sources and preserves their published jobs and run
history. The verification scripts described below were removed with the job integration.

Refresh jobs searched seven Firecrawl Alexandria providers, then continued
direct ATS collection. Searches used saved roles and countries. Each provider
ran in a separate workflow step with retries disabled.

## Configuration

Apply migrations `202611110065_alexandria_job_search.sql` and
`202611110066_alexandria_providers.sql`, then
`202611110067_alexandria_pagination.sql` before enabling the updated workflow.
Set `FIRECRAWL_API_KEY` server-side and `ON_DEMAND_SEARCH_ENABLED=true`.
`ALEXANDRIA_SEARCH_ENABLED=false` disables Alexandria while retaining ATS sourcing.
The local environment and staging database are configured. The hosted deployment
still needs the updated application build; this task does not deploy it.

## Provider contracts and bounds

| Provider | Capability | Per-run collection bound | Reserved credits |
| --- | --- | --- | ---: |
| Workable | jobs/search | 4 searches, 20 public details | 8 |
| TheirStack | jobs/search | 3 pages × 5 full postings | 300 |
| Crustdata | jobs/search | 3 pages × 3 full postings | 270 |
| BlitzAPI | jobs/search | 3 pages × 5 cards + public details | 150 |
| Built In | jobs/search + jobs/job | 3 page/detail segments, 15 paid details | 90 |
| SmartRecruiters | jobs/search_jobs + jobs/get_job | 3 query/detail segments, 15 paid details | 90 |
| Y Combinator | companies/job_search | 3 pages × 5 cards + public details | 15 |

Reservations use undiscounted documented prices, without assuming free allowances.
The maximum is 923 reserved credits per full run, with a shared 2,000-credit UTC-day
default. The migration preserves explicitly customized daily limits. Actual billed
credits can be lower; broader-provider receipts retain the API-reported total.
Provider control rows allow cost ceilings/backoffs, and directory `enabled` flags
allow individual providers to be disabled. Global `alexandria_search_control.enabled`
is the kill switch. Old Workable reservations and new provider reservations share
one atomic budget lock. Replays and ambiguous crashed attempts cannot repurchase
an already reserved provider attempt. No automatic terms acceptance or purchase.

The broader providers share a collector deadline of seven minutes, capped before
the existing eight-minute search lease. Workable retains its smaller collector.
All paid calls, including Workable, acquire a database-backed rate slot immediately
before sending. Slots are spaced seven seconds apart across workers/accounts.
Waiting workers hold no database locks and recheck the lease. Other applications
using the same Firecrawl team can still consume its shared quota.

Only explicit HTTP 429 responses are retried, at most twice per logical request.
`Retry-After` supports seconds and HTTP dates; missing values use a 60-second
cooldown. Cooldown is persisted globally so all our workers observe it. A delay
that exceeds the run deadline stops collection and leaves a resumable position.
Network failures and 5xx responses are never automatically replayed because they
may already have been billed. Payment errors retain the one-day backoff; exhausted
429 retries use a short provider backoff in addition to the shared cooldown.
Receipts distinguish logical requests from `rateRetries`.

TheirStack advances page numbers; Crustdata and BlitzAPI use opaque cursors;
Built In advances pages; YC uses `next_offset`. SmartRecruiters has no additional
search pages, so it scans remaining cards and moves across saved-role queries.
Built In and YC also progress through saved queries when a search is exhausted.
No matching criteria are loosened to increase counts.

The `alexandria_search_cursors` table stores position by provider, saved scope and
UTC day. Remaining Built In/SmartRecruiters cards are retained with their detail
offset, avoiding another paid search or skipping cards if source ordering changes.
Cursor changes commit atomically with job publication. A single active run owns
each scope/provider cursor; replay returns the original receipt without advancing
it or spending again. A later eligible Refresh jobs resumes it, while a new UTC day starts
from the newest postings. Pending cards remain operator-only and are stripped from
publication receipts. Exhausted cursors do not reserve another paid attempt.

This is deeper bounded discovery, not an exhaustive crawl of millions of jobs.
A run advances up to three pages or detail segments per provider; subsequent runs
continue from the saved position. Every publication remains an incomplete catalog
observation (`complete=false`) and never retires unseen jobs.

## Evidence, publication and matching

TheirStack and Crustdata supply full indexed descriptions and posting dates.
They are indexed observations, not a new verification that the employer is still
accepting applications. Known closed TheirStack postings are excluded.
BlitzAPI's AI summary is never used as a description: its allowlisted public
LinkedIn page must pass the existing identity and full-description parser.
Built In and SmartRecruiters require full provider detail responses with matching
identity. YC requires public JobPosting structured data with an exact posting date;
relative `lastActive` timestamps do not establish freshness. Workable retains its
public JobPosting verification. Public detail requests allow only known provider
hosts, with redirects refused.

All rows require an explicit job country, relevant software title, full description,
posting date in the previous 30 days, and no known expired validity date. Employer
headquarters never substitute for job location. Existing sponsorship parsing and
profile matching remain authoritative; a source hit is not automatically relevant.
Descriptions are archived and readback-checked before scoped catalog publication.

Publication excludes existing URLs and normalized company/title/country duplicates
across all catalog sources. This deliberately conservative heuristic can undercount
separate requisitions. Unseen jobs are never expired by these partial searches.
Alexandria is excluded from the scheduled full-inventory collector.

## Reproduce the broader comparison

```sh
node --import tsx scripts/verify-alexandria-broad.mjs --user-id ACCOUNT_UUID --report-file .local-data/alexandria-pagination-verification.json
```

This staging-only verification snapshots existing added-provider IDs and the
30-day catalog size, then runs the six additional providers through core collection,
archive, publication and matching. Only previously absent catalog IDs count as new.
The publisher checks duplicates against every existing source, including prior
Workable results. It checks reservation counts, new-row/receipt agreement and
unchanged receipts after replay. The private result
is `.local-data/alexandria-broad-verification.json`. This compares incremental yield
against the current catalog, not a simultaneous recrawl of existing sources. Full baseline reviewable/eligible totals are reported as unavailable when not
measured; the new-job counts remain verified against existing IDs and catalog
deduplication. The script does not dispatch matching/application workflows or
submit applications.

Official contracts: [TheirStack](https://alexandria.firecrawl.dev/theirstack),
[Crustdata](https://alexandria.firecrawl.dev/crustdata),
[BlitzAPI](https://alexandria.firecrawl.dev/blitzapi),
[Built In](https://alexandria.firecrawl.dev/builtin-com),
[SmartRecruiters](https://alexandria.firecrawl.dev/smartrecruiters-com),
[YC](https://alexandria.firecrawl.dev/ycombinator-com).

## Paginated staging verification — November 11, 2026

Migration 067 was applied transactionally. Two bounded expanded passes used the
same saved profile and 30-day window, without loosening matching rules:
`ad4029e2-c341-4c9a-bf8e-1e52ab2bf833` and
`c53b95c5-c359-4f6b-837b-1900a035c5e5`.

| Provider | Additional jobs | Additional reviewable | Additional eligible |
| --- | ---: | ---: | ---: |
| TheirStack | 16 | 2 | 0 |
| Crustdata | 14 | 8 | 2 |
| BlitzAPI | 17 | 9 | 0 |
| Built In | 8 | 7 | 0 |
| SmartRecruiters | 9 | 3 | 3 |
| YC | 0 | 0 | 0 |
| **Total beyond the earlier 14** | **64** | **29** | **5** |

The earlier run plus these additions totals 78 catalog jobs, 33 reviewable and
6 eligible under the existing rules. These are Alexandria additions, not totals
for the entire existing catalog. All 64 added IDs are distinct from each other
and from the previous 14. All 64 archived descriptions passed readback.

TheirStack's saved page advanced from 3 to 6 between runs, while Crustdata and
BlitzAPI resumed their opaque cursors. Built In and SmartRecruiters each performed
one search plus 15 detail calls in the second pass, retaining remaining cards for
the next eligible Refresh. YC advanced its scan offset and role/country queries
but produced no accepted postings in these passes. The first pass respected two
legacy backoffs; the second completed all six providers. No new 429s occurred,
and no rate retries were needed. Retry-After and retry bounds were tested using
controlled HTTP responses and executable Postgres pacing tests.

Successful API responses reported 250 billed credits across the two passes,
versus 1,650 conservatively reserved credits. Replaying the second run left its
receipts unchanged and retained exactly six reservations. A verification-only
assertion initially expected six reservations even for deferred providers; it
was corrected, and the first pass was separately validated against its publication
receipts before being marked partial. No paid calls were repeated for that repair.

Aggregate evidence: `.local-data/alexandria-pagination-verification.json`;
per-pass evidence: `.local-data/alexandria-pagination-pass1.json` and
`.local-data/alexandria-pagination-pass2.json`. The full baseline relevance totals
remain unmeasured; the verified outcome is incremental new jobs after catalog
deduplication. Neither pass submitted applications or dispatched matching sweeps.

Validation: 69 regression tests passed; additional focused checks verified the
final migration's zero-request checkpoint publication and removal of pending cards
from receipts. TypeScript, targeted lint, production build and bundle limits passed.
The generated Workflow routes use the SDK's `max` duration; the second live helper
run took about 5.5 minutes, so hosted deployment must support the configured
seven-minute collector budget. Hosted execution/deployment was not tested here.

## Broader-provider staging result — November 11, 2026

Run `6d9e9069-a61d-4daf-9957-dad309c5ce1b` used the saved three roles and
Netherlands/Germany/United States, with a 30-day window. Migration 066 was
applied transactionally and recorded in staging history without replaying
unrelated migration gaps.

| Added provider | New catalog jobs | Reviewable | Eligible under existing rules |
| --- | ---: | ---: | ---: |
| TheirStack | 5 | 0 | 0 |
| Crustdata | 3 | 0 | 0 |
| BlitzAPI | 2 | 1 | 0 |
| Built In | 3 | 2 | 0 |
| SmartRecruiters | 1 | 1 | 1 |
| YC | 0 | 0 | 0 |
| **Total** | **14** | **4** | **1** |

Fifteen accepted observations produced fourteen new rows after cross-source
deduplication. All fourteen archived descriptions were retrieved and verified.
Each provider's new-row count equals its publication receipt. Replaying all six
collectors left receipts unchanged and retained exactly six reservations (305
credits). Successful API responses reported 45 billed credits for this run;
free allowances covered TheirStack and Crustdata. Contract probes are separate.

Built In and SmartRecruiters hit HTTP 429 during detail collection. Already
verified postings were retained and the two providers backed off. YC returned
no postings for the selected rotating role/country query. These first-page
results are a partial sample, not the yield of the entire advertised index.

The consistent small baseline snapshot contained 4,306 active postings in the
30-day country window and no preexisting rows from the six newly enabled
providers. Full baseline relevance totals could not be measured: wide REST
reads and a full SQL export timed out. The final check uses an ID snapshot plus
the core publisher's whole-catalog duplicate exclusion, so the incremental
14/4/1 counts are verified; no percentage uplift is claimed. Earlier failed
baseline attempts made no paid comparison searches.

Validation: 64 sourcing, matching, archive and database tests passed, plus
TypeScript, targeted lint, production build and function-bundle checks. This
exercised the normal collection/publication helper against staging and compiled
the hosted workflow; it did not exercise a newly deployed hosted browser flow.
The Vercel application has not been redeployed.

## Earlier Workable staging verification — November 11, 2026

Migration 065 was applied alone and recorded transactionally in staging history.
The general migration dry run found unrelated historical gaps; those migrations
were not replayed. Staging lacks the optional source-task ledger, so the new
migration also supports the older schema and always guards `job_catalog_runs`.
Both schema shapes pass executable Postgres tests.

The real core collector made four searches and verified eighteen observations.
The publication wrapper excluded one existing duplicate and published seventeen
new catalogue rows, with `complete=false`. All seventeen archived descriptions
were subsequently retrieved and verified. The current account's matching rules
classified thirteen as reviewable and eleven as eligible. This run used the
core thirty-day window, so these counts are not directly comparable to the
seven-day pilot. The bounded collector reported twenty-three unverified scoped
cards; it does not claim exhaustive coverage.

Replaying the same core run left the publication receipt unchanged and retained
exactly one eight-credit reservation. Verification receipt is stored privately at
`.local-data/alexandria-core-verification.json`. This exercised core collection,
archive/readback, publication and rule matching against staging, not a hosted
browser workflow or an automatic application. No application was submitted by
the verification script.

Run the same staging-only check with an explicit account:

```sh
node --import tsx scripts/verify-alexandria-core.mjs --user-id ACCOUNT_UUID
```

The production build, TypeScript check, lint, sourcing regression tests and the
additional older-schema migration test passed. The local server environment is
configured; the hosted Vercel deployment has not been changed by this task.

Rate-limit reference: [Firecrawl team limits](https://docs.firecrawl.dev/rate-limits).
