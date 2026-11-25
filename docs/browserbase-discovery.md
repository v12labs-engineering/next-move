# Browserbase source discovery

The operator pilot discovers employer boards for the existing collector. Browserbase
Search finds public URLs; static career-page inspection extracts supported ATS
links. Optional isolated browsers recover rendered links. Only the existing live
validator can establish employer identity, usable job descriptions and countries.
Search query wording is never location or sponsorship evidence.

Discovery is scoped to the configured isolated staging project. The existing
six-hour catalogue workflow can now run bounded automatic Search after refreshing
existing feeds. The operator commands below remain available for separate pilots.

## Automatic worldwide discovery

Apply only migration `202611040050_automatic_source_discovery.sql` after the
existing discovery/extended ATS migrations, then deploy the new workflow and set
server-only `AUTOMATIC_DISCOVERY_ENABLED=true`, `APP_ENV=staging` and the paid
`BROWSERBASE_API_KEY`. The switch defaults off. No new cron is required. Existing
in-flight workflows retain their deployment; the next cron invocation uses the
new workflow. Disabling the switch stops future automatic Search runs.

Each eligible scheduled refresh selects at most six countries and two public,
generic queries per country. Half the slots prioritize users whose chosen country
has fewer than five fresh reviewable software matches in the past week, followed
by users with unmeasured matching. The other slots rotate through the least
recently attempted destinations, including countries with no users yet. Missing
or stale match calculations are counted as unmeasured rather than zero supply.
Only aggregate country counts leave the database; profiles never enter queries.

All 249 selectable countries and territories participate. Successful searches
cool down a country for seven days; partial attempts retry after six hours.
Role terms vary on later visits. A completed search means the bounded queries
ran, not that the country has jobs. English queries and supported ATS coverage
remain limitations. Posting countries always come from source evidence.

The database enforces **48 Search reservations and $1 of reserved Search usage
per UTC day**, shared by all automatic runs. A reservation of $0.007 is committed
before each request, including failures. At 48 requests the maximum reservation
is $0.336; the lower limit always wins. These are usage estimates, not provider
invoice amounts or a cap on the subscription, application browsers, or manual
discovery commands. Automatic discovery creates **zero browser sessions** and
uses no proxy, model or CAPTCHA budget. Settings can only be lowered:

```sql
update public.automatic_discovery_settings
set daily_search_limit = 24, daily_budget_milliusd = 250
where singleton;
```

A global fenced lease prevents overlapping discovery. A four-hour run cooldown,
workflow request keys and unique query reservations prevent retry spending.
Uncertain reservations are retained rather than refunded. Provider throttling
persists its retry time; authorization/payment refusals back off for a day.
A run crossing midnight stops spending until a later run. Sixteen MiB of storage
headroom is required under the existing catalogue capacity budget.

At most one directly observed, previously unknown supported board enters intake
per query. Each observation and its provenance are saved atomically. Up to twelve
pending candidates, including saved work from interrupted runs, receive bounded
live checks. Automatic activation additionally requires dated software postings
within the collection window (30 days), excludes future dates, and retains the
existing employer identity, country and description checks. Existing collector
rules still require a complete source snapshot before publication. New sources
get a bounded collection attempt in the same refresh; partial inventories resume
through the existing collector. A discovery failure retains existing snapshots.

Service-only receipts distinguish searches, source activation and publication:

```sql
select * from public.automatic_discovery_days order by day desc limit 7;
select id, status, started_at, finished_at, result
from public.automatic_discovery_runs order by started_at desc limit 10;
select country, last_searched_at, next_attempt_at
from public.automatic_discovery_countries order by last_attempt_at nulls first;
```

The enclosing `catalog_refresh_runs.result.discovery` contains the saved receipt.
Search responses are bounded and customer identities/credentials are excluded.
Run/query history expires after 14 days; daily reservations remain for 90 days.
Source provenance remains in the existing source ledger.

On 4 November 2026 migration 050 was applied only to the isolated staging
database. Readback verified the 48-request/$1 defaults and service-only access.
A two-country live canary (UAE prioritized, Afghanistan rotating) completed four
Search requests, reserved $0.028, checked two candidates and activated one
Salesforce Workday source. Replaying its request key returned the identical saved
receipt without additional spending. Activation is not a published-job count.
All 642 release tests, TypeScript, lint, production build and function-bundle
checks passed. The latest application fixes were preserved and their 101 affected regressions
passed. Deployment `dpl_3sAiQoAnV4dwcbdgogND3o3nQxxr` was promoted to the
live staging alias after its sign-in page returned HTTP 200. The automatic flag
is enabled for its production environment; the next six-hour cron uses this code.

## Run a bounded pilot

Existing server-only `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` and staging
Supabase credentials are used. `--browserbase-env .env.local` selects the paid
Browserbase project requested for this pilot: only the two Browserbase fields
are read from that file; the verified staging database target is preserved.
Without that flag, provider credentials come from the staging configuration.
Use public segment terms in the query file, never candidate identities or resume text.

```sh
npm run catalog:discover-browserbase -- --staging \
  --queries scripts/catalog/browserbase-discovery-queries.txt \
  --browserbase-env .env.local \
  --output .local-data/browserbase-preview.json
```

For the worldwide country plan, use:

```sh
npm run catalog:discover-worldwide -- --staging --batch 0 \
  --browserbase-env .env.local --output .local-data/browserbase-worldwide-0.json
```

There are 21 numbered batches (`0` through `20`), covering every one of the app's
249 countries and territories exactly once. Batches start with geographically
varied markets across every populated continent; that ordering is a bootstrap
choice, not inferred demand or measured market size. Each batch contains up to
12 countries and 24 Search queries across all five supported employer ATS families.
At most two new URLs per query are admitted, leaving space for every country
within the 50-URL bound. Known enabled boards and duplicate boards do not consume
those slots. A `searchedCountries` receipt means both bounded queries completed,
even when they returned no useful board; it does not mean jobs were found there.

The receipt includes the requested batch, actual searches, admitted URL counts,
and next batch index. Advance that index explicitly; there is no automatic
wraparound for the operator command. `--queries` and `--worldwide` are mutually
exclusive. A partial country/query run remains partial. The first two worldwide
batches issued 48 Search requests across 24 countries with a combined conservative
reservation of $0.336 and no browser sessions. Failed static pages were recorded;
all 48 Search requests completed, retaining 41 distinct candidate boards.

English queries are a starting point, not a multilingual coverage claim. Listings
retain source text and must pass the same actual country, posting-date, description
and software-role checks. Full-board collection can add jobs in countries outside
the original search query; it never assigns a query's country to a posting.

This previews candidates without importing, enabling sources or publishing jobs.
The command reads enabled source IDs to skip existing boards. Search is fixed to
Parallel fast with no automatic retries. Limits per invocation are 30 queries,
50 candidate URLs, one static page per URL and ten minutes total. Robots resources
are additional requests. Provider responses and page bodies are size-bounded.
Repeated job URLs from the same known ATS board consume one discovery slot.

Browser sessions default to **zero**. Explicit `--max-browsers 10` enables at most
ten sequential attempts. Each has a provider-enforced 120-second lifetime, no
proxy, CAPTCHA solver, recording, saved application context or model inference.
The browser only navigates/reads, blocks non-GET requests, checks public addresses
and robots restrictions, guards redirects and releases its session in `finally`.
A refusal or ambiguous browser failure stops further browser attempts while
preserving direct/static discoveries. These limits do not establish universal
access or successful rendering. The inherited network guard also documents the
remote browser's separate DNS-resolution limitation.

`--max-cost-usd` defaults to 1 and cannot exceed 1. Each Search request reserves
$0.007; each browser attempt reserves $0.004 before it starts. Failed and ambiguous
requests keep their reservation. This conservative arithmetic uses the published
generic Search meter and two minutes at $0.12/hour. It is a **usage reservation,
not measured billing or an account-wide spending cap**; confirm prices before
future runs. Provider subscription charges are separate. Repeated invocations
have independent budgets, separate from the automatic discovery ledger above.

An output path is mandatory and must not exist. The command writes a private
receipt before paid operations, then records observed candidates, search request
IDs, source provenance, errors, sessions and usage before any import. A partial
run exits nonzero but preserves its observed candidates. A crash may leave a
`started` receipt and consumes an unknown portion of its bounded usage.

## Import, validate, activate, collect

Adding `--apply` to a fresh invocation imports candidates only. It does not imply
successful validation or increase published jobs. To avoid paying to repeat a
preview, reuse its observed ATS URLs with the existing `catalog:discover links`
command, retaining the preview receipt as provenance, or explicitly import its
saved candidates/origin through `CandidateStore.import`.

Use exact IDs from the report, in bounded batches:

```sh
npm run catalog:discover -- validate --staging --apply --limit 20 --ids 'SOURCE_IDS'
npm run catalog:discover -- activate --staging --apply --limit 20 --ids 'VERIFIED_SOURCE_IDS' \
  --note 'Reviewed live employer identity and usable public job evidence for the discovery pilot.'
npm run catalog:collect -- --staging --ids 'ACTIVATED_SOURCE_IDS'
```

Only complete successful source snapshots publish. Failed, capped, throttled or
partial inventories preserve previous publications. Some large Workday boards
exceed the existing 2,000-result reader limit and require partitioning work;
discovery does not remove that limit. Current Workday identity policy also excludes
three-digit `wd` hosts. Unsupported URLs remain evidence for future adapters.

Migrations `202611010035` and `202611010036` are prerequisites for new ATS families.
Before enabling sources on any deployment, verify that its collector contains
the corresponding readers. Source/task ledger migrations 039/040 remain separate
and are not needed for this pilot. The Browserbase discovery CLI needs no new
migration. Preserve source-specific access/provenance policies from
[source discovery](source-discovery.md).

## Verification and measured results

```sh
node --import tsx --test tests/browserbase-discovery.test.ts tests/source-discovery.test.ts tests/source-expansion.test.ts
npm run typecheck
npm run lint
npm test
npm run build
```

The first live Search preview on 4 November 2026 succeeded across six queries.
The staging-configured Browserbase project returned HTTP 402 at session creation.
At the user's direction, rendering was retested with `.env.local`: its API key
matched staging, but its project ID differed. Both the example.com check and a
public Airwallex career-page inspection completed; provider readback confirmed
both sessions `COMPLETED`, with zero proxy bytes. The career page exposed no new
supported ATS board identity, so these browser tests are not counted as added
job supply. No Browserbase plan was changed. Two additional Search queries for
indexed SmartRecruiters postings completed with zero browser attempts.

The initial import correctly failed against staging's old board constraint.
Existing migrations 035 and 036 were subsequently applied together in a guarded
transaction to the manifest's isolated staging project, with their exact SQL in
migration history. Readback verified both versions, expanded board constraints
and source-search support. Unrelated pending migrations were left unapplied.

The eight Search queries yielded 30 distinct supported board candidates. All 30
were imported and checked; 14 passed live validation and were explicitly activated.
The existing hosted collector's Git deployment was checked to contain the ATS
readers before activation. Eight small inventories completed locally; the other
six larger inventories remain enabled but have not published a first snapshot
in this pilot. Search/validation counts do not include those as available jobs.

Completed collection added **35 distinct active job URLs**, verified in Postgres:
30 in India and 5 in Singapore. Six have posting dates in the preceding seven
days (three in each country). These are catalogue additions before personal
matching; no claim of 35 new suitable jobs for every account is made.

Live Workday continuation pages returned `total: 0` alongside nonempty postings,
while offset zero consistently returned the full inventory count. The old reader
rejected every second page. Two new regressions failed before the correction.
The reader now rechecks the bounded first-page count for such continuations,
counts that extra request and retains cap/completeness checks before detail reads.
All four affected small boards resumed from their saved cursors and completed.
Only their diagnosed application-error deferrals were cleared; provider backoff
and staged page data were preserved.

Verification after the correction: 626 full-suite tests passed, plus the focused
59-test source/discovery/worker run; TypeScript, ESLint, formatting and the production
build/function-bundle audit passed. Operational receipts remain ignored under
`.local-data/browserbase-*`. The Workday reader fix is prepared as a single-file
release over the previously deployed commit. Automatic approval review initially
rejected the production-targeted release pending explicit authorization. The user
subsequently explicitly approved deploying this fix to the live staging app.
Deployment `dpl_8RVPmuSEuSF6XXbY3opKCv3F3Cyx` built in the existing production
environment and was promoted to <https://job-search-chi-amber.vercel.app> after
its sign-in page returned HTTP 200. The isolated source artifact contains only
`lib/server/catalog/additional-ats.ts` over the previously deployed commit;
concurrent application-form edits were excluded. A live scoped collection then
advanced the same Workday run from page 10 to page 20 (next page 21), with no error.
The existing six-hour cron now resolves to this reader. The next scheduled
invocation was observed at 17:30:45 IST on 4 November 2026: refresh
`c18682ed-534a-4c86-ac28-0cfa3157be1e`, workflow `wrun_41M6K6XQ5XAGXG09GDF3ZF57NA`.
Readback showed it running with 389 source snapshots published; this is refresh
progress, not 389 new vacancies or a completed scheduled run. Browserbase discovery
itself was operator-only at that point; automatic discovery is described above.

The isolated single-file preview is
<https://job-search-lqfukbmn2-v12labs-projects.vercel.app>. Its sign-in page returned
HTTP 200 through authenticated Vercel access, and its public Supabase target was
verified against the isolated staging manifest before collection. A scoped hosted
Rockwell collection checkpointed ten pages (50 upstream postings, 69 counted HTTP
requests), with no error and next page 11. It remains a partial staged inventory;
its five accepted observations are excluded from the 35 published URLs above.
This verifies hosted continuation beyond the former failure at page two without
claiming complete collection. Preview verification did not change the production
alias; the subsequently approved live release is recorded above.

### Worldwide follow-up after the approved release

Worldwide batches 0 and 1 searched 24 countries (48 requests) and retained 41
distinct candidate board identities. Forty were live-checked; one existing
candidate was skipped because it was not due. Seventeen passed. Other
boards remained empty, deferred, capped or in review. Historical employer-label
conflicts were preserved; search text did not override them.

The 17 verified boards were enabled on isolated staging after the reader release.
Eleven exposed inventories of at most 130 postings were collected completely;
the remaining six larger inventories are enabled for the existing collector but
have not published their initial snapshot in this run. The completed inventories
added 84 listing/location rows and **80 distinct active job URLs**. A read-only
Postgres anti-join against active listings from other sources confirmed all 80
URLs were additional active supply. Different URLs may still cross-post the
same vacancy; this is URL deduplication, not a universal vacancy identity claim.

| Actual country from postings | Distinct URLs | Posted in past 7 days |
| --- | ---: | ---: |
| Argentina | 4 | 1 |
| Australia | 15 | 2 |
| Brazil | 1 | 0 |
| Canada | 4 | 0 |
| Germany | 2 | 1 |
| India | 9 | 6 |
| Portugal | 5 | 4 |
| United Kingdom | 15 | 6 |
| United States | 28 | 4 |

Country totals can exceed global distinct URLs because one vacancy can list more
than one country. The global seven-day count is 24 URLs. Counts precede personal
matching and exclude future-dated postings. Original descriptions were archived
through the existing verified reader/object path; storage budgets were unchanged.
The measured physical database size was about 289 MiB against the configured
400 MiB collection ceiling.

The same read measured 7,198 distinct active URLs checked in the preceding seven
days across 102 countries. This snapshot includes ordinary expiry/cleanup and is
not an additive sum of earlier snapshots. The 249-country plan is a search target,
not a claim that all 249 have observed jobs. Twenty-four destinations have been
searched by this new worldwide mode; the remaining 225 have not.

The worldwide change passed all **629 tests** in an isolated copy of the committed
baseline plus the catalogue changes. The concurrent working-tree version had
three application-computer test failures attributable to its separate edits in
`lib/server/applications/computer-agent.ts`; those edits were preserved and were
neither copied into verification nor included in the deployed Workday artifact.
TypeScript, focused ESLint and formatting checks passed for the worldwide code.
Private receipts are `browserbase-worldwide-{batch-*,validation,inventories,collection,supply}-2026-11-04.json`
and `browserbase-worldwide-isolated-tests.log` under `.local-data/`.

Count newly published jobs separately from refreshed observations and location
variants. The improvement metric is incremental, dated, deduplicated jobs that
pass each account's matching rules. Country inventory and successful source
validation alone do not establish sufficient supply for users.

### Immediate automatic run and verified publication — 4 November 2026

At the operator's request, one completed canary cooldown was cleared with an exact
run/timestamp guard. Daily request and money reservations were unchanged. The
new cycle searched Germany, Australia, India, Åland Islands, Albania and Algeria:
12 successful Search calls, five candidates checked and one Momentive source
activated. Today’s automatic ledger ended at 16 requests and $0.112 reserved.

Both that new source and the earlier Salesforce canary source were collected to
completion. Salesforce published 248 new distinct URLs; Momentive published 3.
A saved before snapshot and an independent read-only SQL anti-join agreed on
**251 additional active job URLs across 32 actual posting countries**, including
119 URLs dated within the preceding seven days. Previously existing URLs were
excluded, even when inactive; these are catalogue additions before matching.
The full country CSV and verification receipts remain under ignored
`.local-data/worldwide-now-20261104-*`.

Collection reproduced a blank Workday employer name on an Account Executive
posting. The reader now avoids detail hydration for summary titles already
classified as excluded, retaining raw inventory counts. Software and ambiguous
titles still require detail identity checks. The new regression failed before
the fix, the saved/live failing page passed afterward, and all 647 release tests,
TypeScript, lint and the production bundle audit passed. The fix was promoted as
`dpl_EAuXctYnNqiSy2eU618RzMRzf4s3`, preserving newer live application code.
A later Salesforce list-schema failure was kept strict; repeated exact live
reads passed, one guarded retry resumed its cursor, and the 311-page snapshot
then completed. No incomplete snapshot was included in the additions count.
