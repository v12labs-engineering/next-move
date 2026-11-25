# Workable sourcing pilot

Historical staging comparison using Firecrawl Alexandria Workable `jobs/search`.
The command below was retired with the Alexandria job integration.
Run with Node 24:

```sh
npm run catalog:pilot-workable -- --user-id YOUR_ACCOUNT_UUID
```

Set `FIRECRAWL_API_KEY` in `.env.local` or the process environment. Staging
Supabase credentials come from the verified `.env.staging.local` manifest.
Select a single real account explicitly; the script will not choose among test
profiles. Provider terms, if requested by Firecrawl, must be handled in its
dashboard. A missing key writes a blocked report with null new-job counts.

Default limits: four search requests (estimated eight Firecrawl credits at the
published two-credit price), twenty public posting detail reads, seven-day
posting window. Override with `--days 30`, `--max-searches 1..10`, or
`--max-details 1..50`. Search scopes rotate through role/country pairs before
continuing cursors. Paid requests never retry automatically. Actual billing may
differ; `searchCreditsEstimate` is not a billing receipt. Public detail fetching
uses the existing bounded fetcher's retry policy. `--baseline-only` makes no
Firecrawl calls.

Report: `.local-data/workable-pilot-report.json` (gitignored, mode 0600).
No registrations, ingestion writes, migrations, scheduled jobs, applications or
messages. Only role/country/date queries go to Firecrawl, never the resume.

## Measurement

Baseline scans the staging catalogue using stable ID pagination, hydrates archived
descriptions, filters active postings by the same role/country/date scope, and
uses the existing `matchJob` function for reviewable and eligible counts. It
counts distinct posting URLs (Workable shortcode aliases collapse). It is a
catalogue snapshot, not a simultaneous refresh of every source; it does not
establish live availability or market-wide coverage.

Search results must have published state and explicit recent date/country/title
match. Search cards alone never count as additional relevant jobs. The pilot
reads their public Workable pages and requires matching JobPosting structured
identity, description, posting date, and valid expiry when provided. Failed reads,
missing JSON-LD, schema differences, quality failures and exhausted detail budget
remain unresolved. JSON-LD validation establishes observed posting evidence, not
successful application or employer receipt.

Known URLs are existing jobs. Matching normalized company/title/country with a
catalogue row or an earlier pilot result is a possible duplicate and is excluded
from incremental counts. This deliberately conservative check can undercount
separate requisitions. Different company aliases can still evade it. Catalogue
identity checks include inactive/older rows in target countries, avoiding counting
rediscovered known jobs as new. Search observations never expire unseen jobs.

`newReviewable` means new, verified, recent jobs passing the app's reviewable
filters. `newEligible` additionally passes its stricter location/sponsorship gates.
Unknown sponsorship stays unknown. Neither count predicts interview success.
`searchTruncated` and unresolved counts describe unmeasured work. Failed partial
runs must not be presented as completed comparisons.

## Verification

```sh
node --import tsx --test tests/workable-pilot.test.ts
npm run typecheck
npx eslint lib/server/catalog/workable-pilot.ts scripts/pilot-workable.mjs tests/workable-pilot.test.ts
```

Official contracts checked November 11, 2026:
- https://alexandria.firecrawl.dev/workable
- https://docs.firecrawl.dev/features/alexandria

Live provider/schema and incremental supply verification still require an
account key and a successful run; fixtures do not establish those outcomes.

## Live attempt — November 11, 2026

Used the existing Growth Engine credential in process memory, without copying it
into this repo. Staging profile scope: Lead Software Engineer, Senior Software
Engineer and Member Technical Staff; Netherlands, Germany, United States; seven
days. Baseline: 444 distinct posting URLs, 206 reviewable, 32 eligible.

The first Workable search returned HTTP 402; no provider results were returned.
A subsequent read-only Firecrawl credit-usage request succeeded and reported
-15 remaining credits against 1,000 plan credits. The comparison is blocked by
account funding, not a measured zero-result search. New match counts are null in
the private report. Search credit estimates are not billing receipts. No
catalogue writes or automatic paid retries occurred.

## Successful live pilot — November 11, 2026, 05:59 UTC

A user-supplied replacement credential was used only in the runner process.
Four Alexandria Workable search calls completed successfully. The seven-day
profile scope and baseline remained unchanged.

| Measure | Observed |
| --- | ---: |
| Existing catalogue reviewable postings | 206 |
| Existing catalogue eligible postings | 32 |
| Unique Workable search results | 31 |
| Results passing initial role/country/date scope | 26 |
| Public posting details checked | 20 |
| Possible duplicate observations excluded | 9 |
| Additional reviewable postings | 7 |
| Additional eligible postings (subset of seven) | 5 |
| Scoped results not verified due to detail budget | 6 |

The five additional eligible results under the app's current matching rules:
Portless — Senior Software Engineer (Germany); Seez — Senior Full-Stack Engineer
(Germany); Worth AI — Senior Software Engineer (US); Sharetec — Senior Software
Engineer (US); Worth AI — Senior Software Engineer - Full Stack (US).
Two additional reviewable but not eligible results were Software Engineer at
Onodrim Industries, one in the Netherlands and one in Germany. Country variants
are retained, so seven postings do not establish seven distinct requisitions.

Possible duplicates in this sample were repeated company/title/country results,
including US city variants. These were excluded conservatively. Different title
variants at one employer may still represent overlapping requisitions. Eligibility
is the app's rule output, not independent verification of work authorization or
remote-from-home permission.

Searches: Lead Software Engineer in Netherlands (5), Germany (5), US (20), and
Senior Software Engineer in Netherlands (5), with overlap between queries.
The US query has more pages; other role/country pairs were not all queried.
This bounded sample does not measure exhaustive coverage. Baseline is an existing
catalogue snapshot, not a concurrent refresh of its sources. No catalogue writes.
Search cost estimate: eight credits; actual charged credits were not measured.
Private per-posting evidence and links: `.local-data/workable-pilot-report.json`.

Recommendation: the pilot demonstrates additional supply and supports a next
integration step with the same verification, budget and duplicate controls.
Do not extrapolate the sample into market-wide coverage or schedule unbounded
collection based on these results.
