# Job Search local Docker Compose

Requires Docker Compose v2, a local Docker engine, and Node.js 24. The gateway
serves the app and Supabase APIs at [127.0.0.1:3302](http://127.0.0.1:3302/sign-in).
Postgres, the Workflow worker endpoints, and the rehearsal route stay off the
host network. The stack generates its own JWT signing key and database passwords
in `.local-data/compose/local.env`. Keep that file alongside the local Docker
volumes and archives.

`APP_PUBLIC_ORIGIN` must match the URL in the browser, including its port.
It is used to validate the origin of signed-in writes through the gateway.

## Start an empty stack

From the repo root, with ports 3302 and 3303 available:

```sh
node deploy/local/init.mjs
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml build app
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml up --wait
```

The stack applies the repository's SQL migrations in filename order, initializes
Workflow Postgres World in its own database, and listens on loopback. It has no
accounts initially. Enter a synthetic address such as `demo@example.test` on
the sign-in page to create a fresh account. [Mailpit](http://127.0.0.1:3303)
captures the link locally. Open it in the same browser. OAuth is outside this
setup.

## Use Ollama for résumé analysis and tailoring

Local Docker Compose sets the shared AI allowance to 2,147,483,647 requests
per 30 days. To apply that setting to an already running stack, run the local
`migrations` service with `run --rm --no-deps migrations` and the Compose
arguments above.

With Ollama running on the Mac, set `LOCAL_OLLAMA_MODEL` in
`.local-data/compose/local.env` to a model shown by `ollama list`. Use a model
that supports structured outputs. Recreate the app service with
`up -d --no-deps app` and the same Compose arguments. For the first setup, build
the app image before starting it. The app uses Ollama through the Docker host
address for onboarding résumé analysis, **Tailor resume only**, and **Tailor
resume and check qualifications**. The last step sends the résumé and job
description in a single request and reports explicitly required qualifications
without supporting résumé evidence. With the setting empty, you can use
**Review manually instead** on the onboarding résumé step.

## Run Auto-apply with Boat

In `.local-data/compose/local.env`, set `LOCAL_APPLICATION_BROWSER_PROVIDER=boat`
and `LOCAL_BOAT_API_KEY`. Set `LOCAL_BROWSER_USE_BASE_URL`,
`LOCAL_BROWSER_USE_MODEL`, and `LOCAL_BROWSER_USE_API_KEY` for the browser
planner. Use an HTTPS model endpoint reachable from the Boat VM. The résumé
model still uses `LOCAL_OLLAMA_MODEL` on the Docker host. Rebuild and recreate
the app with the Compose arguments above.

To stop a stack while keeping its data, use the same Compose arguments with
`down`. Include `--profile catalog-schedule` if you started the scheduler.
Replace `job-search` with the project name the rehearsal printed
if you are stopping a restored stack.

## Refresh the catalog hourly

Start the stack with the catalog scheduler profile:

```sh
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml --profile catalog-schedule up -d --wait
```

The local scheduler calls `/api/cron/jobs` once per minute and immediately on
startup. These are short admission and recovery ticks; they do not download every
feed every minute. With `CATALOG_TASK_SCHEDULER_ENABLED=true`, each feed is admitted
according to its stored collection interval and retry time. Verified India feeds
become due after 55 minutes; the next minute tick admits them, leaving collection
time before the hourly freshness target. Provider outages and rate limits can
still delay completion and appear in source health. Due India feeds have
reserved collection capacity, so a large global sweep cannot hold the shared
refresh lock and delay them. Per-source leases and saved page cursors prevent
duplicate collection and recover interrupted work.

The durable workflows drain ready sources between ticks. After a source
completes, fails, or enters backoff, the same workflow atomically claims and
acknowledges the next ready source and continues collecting. Each new workflow
processes up to 32 segments to bound the amount of event history it can replay.
The next cron tick picks up any remaining ready work from the durable outbox.
India priority and the four-worker limit still apply.

Publication has a function-specific 45-second SQL timeout and a 55-second HTTP
timeout within each worker's 120-second budget. If completed pages leave too
little time, the worker yields and resumes publication without fetching them
again. Confirmed SQL rollbacks enter backoff with at most five consecutive
failed attempts. An ambiguous lost acknowledgement retains the five-minute
lease; recovery after expiry checks committed progress before continuing.

Each minute tick dispatches one matching sweep with `autoApply: false` for all
published jobs, refreshing recommendations without submitting applications.
If matching enqueue fails, collection continues and a later tick retries it.

An admission request has up to three attempts, each with a 12-second deadline,
and short backoff. Longer server `Retry-After` values are saved and respected by
later ticks. Startup and minute ticks share a filesystem lock; a later tick can
recover a lock abandoned by a crash. The runner only sends its credential to the
fixed loopback endpoint and does not log raw response bodies or network errors.

The scheduler stores its latest receipt and consecutive failures in the
`catalog-scheduler-state` volume. Its Docker healthcheck requires a successful
tick in the last three minutes and no subsequent failed tick. This checks
scheduler liveness; the receipt's source freshness and failure counters separately
show provider delays. Failed requests emit `catalog_scheduler_alert` in local
container logs; no external notifications are sent. Inspect `catalog_source_tasks`
and `job_catalog_sources` for source completion, backoff and publication history.

Long-lived local services restart unless explicitly stopped. Docker or laptop
downtime still prevents collection; the immediate startup tick catches up when
the stack is available. The app container has a 4 GiB memory limit. Its
watchdog recycles Next.js after 90 seconds without a healthy response or three
consecutive checks at or above 3 GiB of resident memory. Durable source
checkpoints and leases let cron resume interrupted work. The app and scheduler share
`LOCAL_CATALOG_BUDGET_BYTES` (default 20 GiB), while the database's capacity limit
also remains enforced. `LOCAL_WORKFLOW_WORKER_CONCURRENCY` defaults to eight so
the four bounded source workers leave room for scheduling and matching work.

### Discover and monitor registry career pages

After importing the registry, set `LOCAL_INDIA_REGISTRY_ENABLED=true` in
`.local-data/compose/local.env`. Apply the Map schema to an existing registry,
then build and recreate the local scheduler.

```sh
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml \
  exec -T db psql -U postgres -d india_employer_registry -v ON_ERROR_STOP=1 < deploy/local/india-registry-map.sql
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml --profile catalog-schedule build catalog-scheduler
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml --profile catalog-schedule up -d --no-deps catalog-scheduler
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml --profile catalog-schedule exec -T catalog-scheduler /bin/sh /local/registry-cron.sh
```

Registry discovery runs in its own process at five minutes past each UTC hour.
Its 45-minute timeout and independent lock cannot block minute collection ticks.
Each discovery run checks up to 500 queued website leads, revisits public career
pages, and tries to resolve up to 600 company names without a viable link.
Discovery results and the oldest-first queue persist in Postgres. Adjust
`LOCAL_INDIA_REGISTRY_WEBSITE_BATCH` and `LOCAL_INDIA_REGISTRY_DOMAIN_BATCH`
for the host's capacity. Careers checks take the oldest 5,000 links when
the queue exceeds the per-run limit. Access-restricted links are skipped.
Each hour, the scheduler also rotates through up to 24 verified employer career
links without a connected feed. When the ordinary check finds no job observations,
Firecrawl Local maps links from the live careers page and falls back to the
sitemap when the page has no job links. The registry verifies up to 12 detail
URLs per employer and records recovered jobs in `registry_job_observation`
with `source_method='firecrawl_map'` and the employer evidence URL. The catalog
publishes detail pages with an explicit India location, an employer posting
date within 30 days, and a supported job category. This requires migration
`202611190095_registry_firecrawl_publication.sql`. The Map server runs inside the scheduler
with cloud fallback disabled. Adjust the batch with
`LOCAL_INDIA_REGISTRY_MAP_BATCH` (set to `0` to disable it). For a manual run,
`INDIA_REGISTRY_MAP_SEED` passed through `docker compose exec -e` selects an
already-verified careers URL for the Map batch.

Public ATS feeds with verified India jobs pass catalog validation before the
existing refresh publishes them. Inspect `registry_hourly_run.summary.firecrawl`
for attempts, recovered observations, and `publishedMapIds`. ATS publication
counts are recorded in `catalog_refresh_runs`.

## Run the catalog cron once

To enable the verified India employer boards on a local stack, load the
directory seed before running the cron. Use the current Compose project name.
Reapplying the seed retains source history and schedules.

```sh
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml run --rm --no-deps migrations
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml exec -T db \
  psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 < deploy/local/india-sources.sql
```

The seed includes Amazon India Software Development, India-scoped
SmartRecruiters and Oracle Recruiting feeds, and the Infoparks Kerala vacancy
index. Infopark collection uses the index's 30-day posting window and checks
the application deadline and employer on the individual listing. The two
Oracle feeds use the provider's India search and then read each job's detail.

Use the existing `/api/cron/jobs` endpoint to start the scheduled catalog
workflow on the local stack. If Compose was already running before the cron
secret was added, run initialization again and recreate the app service.
Use your current project name in place of `job-search` as needed.

```sh
node deploy/local/init.mjs
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml up -d --no-deps --wait app
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml exec -T app node --input-type=module - <<'JS'
const result = await fetch("http://127.0.0.1:3000/api/cron/jobs", {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
})
console.log(result.status, await result.json())
if (!result.ok) process.exitCode = 1
JS
```

HTTP 202 means admission/recovery completed, not that every source was collected.
The local response includes `scheduler.mode="source-tasks"`, admitted, recovered,
dispatched and dispatch-error counters, and source health. Check
`catalog_source_tasks` for terminal source results and `job_catalog_sources` for
successful publication counts. Collection respects each feed's retry time and
recent successful checks. Posting dates come from the feeds.

### Recurring India job boards

With the India job-board migrations through
`202611190100_expanded_hourly_firecrawl_boards.sql` applied, build the app and
scheduler images, start the `catalog-schedule` profile, and load the local seed.

```sh
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml --profile catalog-schedule build app catalog-scheduler
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml --profile catalog-schedule up -d --wait
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml exec -T db \
  psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 < deploy/local/india-job-boards.sql
```

The seed enables the recurring board sources with provider-specific polling
intervals. Publisher APIs and RSS feeds supply jobs where available. For
Shipmates, e2eHiring, Technopark, Shine, Cyberpark Kozhikode, and eGig, the app
calls Firecrawl Local from the shared loopback network. The service has no
published port. 4 Day Week uses its public API with `country=India`, and FOSS
United publishes an RSS feed. Each detail must provide evidence of an
India-eligible, dated job. The catalog keeps publisher links and shows
attribution on job rows. Himalayas supplies an update date.

Remote Backend Jobs, Remote Frontend Jobs, and Remote Java Jobs use their
shared publisher API every hour. Each checks up to 250 Asia results and keeps
dated listings with explicit India eligibility. Listings shared by those boards
are assigned to Java first, then Frontend, then Backend.

These Firecrawl boards check their indexes every hour. They read details for
new or changed entries and run a full detail scan within the existing collection
scope once per day. Shipmates and e2eHiring compare job-card text and absolute
dates. Cyberpark Kozhikode compares rendered job cards. eGig checks
employer-posted jobs in the latest 20 results from its public API and verifies
details with Firecrawl. Technopark compares the public index record, and Shine
compares the sitemap timestamp. The daily scan picks up edits absent from the
index. A run's detail checks become a baseline after publication succeeds.

Check each board's latest task in `catalog_source_tasks` and compare its
publication receipt with active rows in `job_catalog` where the source starts
with `indiaboard:`. A completed task can publish zero eligible jobs. Board
feeds are rolling windows, so disappearance from a page does not close a job.
`job_catalog_runs.board_scan_mode` and `catalog_board_detail_checks` show
the scan type and the URLs checked in that run.

## Build and check the India employer directory

The JSON seed files under `deploy/local/india-employers/` retain an evidence URL
for each employer name and any published website or careers link. Save new
observations there before checking their career pages. Then build the directory
and run a bounded scan of a named cohort.

```sh
node --import tsx scripts/india/india-employer-directory.mts build
node --import tsx scripts/india/resolve-india-employer-websites.mts --limit 100
node --import tsx scripts/india/india-employer-directory.mts build
node --import tsx scripts/india/india-employer-directory.mts locate --limit 100
node --import tsx scripts/india/india-employer-directory.mts scan --cohort 'Official employer careers' --limit 44
node --import tsx scripts/india/india-employer-directory.mts status
```

The directory and checks are in `.local-data/india-employer-directory.json`.
The website resolver records every name it processes and saves a website only
when the published page supplies identity evidence. The `locate` pass records
careers links from saved employer pages and keeps park-operated listings in a
separate field. It saves progress after each group of eight. Builds preserve job
checks and reevaluate career links when their input URLs change. Job scans save
after each group of four and revisit entries when their checks are seven days old.
They record page access, source validation, and observed India job links and
dates. The usual validation, activation and collection steps apply before a
source can publish jobs to the catalog.

## Import and enrich the India company registry

Keep the registry in `india_employer_registry`, a separate database in the
existing local PostgreSQL instance. Job collection measures capacity against
the application database. Registry company records retain registration IDs,
legal names, status, region and attribution. Website and careers observations
carry provenance and an independent access status.

```sh
mkdir -p .local-data/india-business-registers
curl --fail --location --output .local-data/india-business-registers/mca-companies-directory-2026-10-18.csv.gz \
  https://zenodo.org/api/records/23485710/files/in-companies-official.csv.gz/content
python3 scripts/india/india-registry.py --project job-search init
python3 scripts/india/india-registry.py --project job-search prune-inactive
python3 scripts/india/india-registry.py --project job-search import \
  .local-data/india-business-registers/mca-companies-directory-2026-10-18.csv.gz \
  --as-of 2026-10-18 --source-url https://zenodo.org/records/23485710 \
  --attribution 'Companies Directory, CC BY 4.0, derived from MCA data under GODL-India' \
  --sha256 173f23fddeea16a49c106f75a9606cafd240367af0ab7f34935876c41177a785
python3 scripts/india/india-registry.py --project job-search enrich
uv run --no-project --with duckdb==2.0.0 python scripts/india/extract-india-place-websites.py \
  .local-data/india-business-registers/overture-india-legal-website-leads.csv
python3 scripts/india/india-registry.py --project job-search enrich-places \
  .local-data/india-business-registers/overture-india-legal-website-leads.csv
node --import tsx scripts/india/check-india-registry-links.mts --project job-search --kind once --limit 2000
python3 scripts/india/india-registry.py --project job-search status
```

The loader streams CSV, gzip or ZIP snapshots and can replay an already imported
checksum. It keeps registrations marked Active and removes companies reported
inactive by a newer import. `prune-inactive` removes historical rows outside
that status from an existing registry. The employer directory joins on a unique legal name. The public
Overture extract reads names, website URLs, states, and place IDs for India.
The join accepts a single website candidate for an active registration with a
unique legal name in the same state. A map lead needs first-party company
identity evidence before the checker follows its careers links. The checker
records sign-in pages and HTTP access refusals as restricted, and backs off
temporary failures. The one-time command drains the website leads and checks
the resulting careers links, saving progress in Postgres. Run it with
`LOCAL_INDIA_REGISTRY_ENABLED=false` so the hourly scheduler only refreshes
existing feeds. Infopark job listings retain their provenance under
`park_listing`. [Overture source and sampling
commands](../../docs/research/2026-11-16-india-registry-enrichment-sources.md)

### Check each employer website for careers pages

```sh
python3 scripts/india/india-registry.py --project job-search init
node --import tsx scripts/india/check-india-registry-links.mts --project job-search --kind career-discovery --limit 1000
```

This one-time pass starts with verified websites. It checks published links,
sitemaps, common paths such as `/carrer`, and careers subdomains. A website
lead needs first-party company identity evidence before the checker saves a
public careers page. Each website's outcome is saved in
`registry_company_link.career_discovery_result`. Rerunning the command picks
up unchecked website leads.

To add more leads from the same national Places release, include place names
without a legal suffix and match a unique company and domain by name and
state. The import records candidate websites for the one-time pass.

```sh
uv run --no-project --with duckdb==2.0.0 python scripts/india/extract-india-place-websites.py --include-brand-names \
  .local-data/india-business-registers/overture-india-all-website-leads.csv
python3 scripts/india/india-registry.py --project job-search enrich-places --match-brand \
  .local-data/india-business-registers/overture-india-all-website-leads.csv
```

## Scrape the verified careers pages once

Use the compose project that contains the registry. Run the HTTP pass first,
then render the queued pages with Playwright. Reuse the same run ID to resume
either pass or read the saved count. The browser pass uses local Chrome or
the executable at `REGISTRY_CHROME_PATH`.

```sh
docker compose --env-file .local-data/compose/local.env -f deploy/local/compose.yml \
  exec -T db psql -U postgres -d india_employer_registry -v ON_ERROR_STOP=1 < deploy/local/india-registry-jobs.sql

JOB_SCRAPE_RUN=$(uuidgen)
node --import tsx scripts/india/scrape-india-careers-jobs.mts --project job-search --run "$JOB_SCRAPE_RUN" --phase http
node --env-file-if-exists=.env.local --import tsx scripts/india/scrape-india-careers-jobs.mts --project job-search --run "$JOB_SCRAPE_RUN" --phase browser
node --import tsx scripts/india/scrape-india-careers-jobs.mts --project job-search --run "$JOB_SCRAPE_RUN" --phase report
```

`registry_scraped_job` holds deduplicated postings and evidence URLs.
`registry_job_scrape_source` records coverage for each careers URL. The count
includes every location observed in source scope. The report counts jobs
with explicit India evidence and those with an unconfirmed country.

### Recover job details from employer sitemaps

With [Firecrawl Local](https://github.com/firecrawl/firecrawl/tree/main/apps/local)
installed, run its local server in a separate terminal.

```sh
FIRECRAWL_CLOUD=off firecrawl-local serve --port 13982
```

Apply `deploy/local/india-registry-jobs.sql` as shown above to add map tracking
to an existing registry. Then reuse the scrape run ID after its browser pass.

```sh
node --import tsx scripts/india/scrape-india-careers-jobs.mts --project job-search --run "$JOB_SCRAPE_RUN" --phase map
```

The map phase checks browser-processed employer sources that yielded zero
postings. It reads up to 12 candidate details per source through the existing
HTTP verifier and saves the observed dates and locations when present. Mapped
URLs alone are leads. Recovered postings carry their original employer
evidence URL, and the source remains partial because a sitemap cannot establish
a complete inventory. `mapChecks` shows how many sources have completed this
phase. Use `--limit` to cap the number of sources in one invocation.
`REGISTRY_FIRECRAWL_URL` can select a different loopback HTTP port.

## Run the backup and restore rehearsal

Install the locked Node dependencies with `npm ci` if needed. Stop any stack
using port 3302 or 3303, then run:

```sh
node deploy/local/rehearse.mjs
```

Use `--no-build` to repeat the drill against the existing local image.

The rehearsal creates a fresh source project, two synthetic accounts, a private
résumé object, and a workflow awaiting a hook. It stops the source, archives the
Postgres cluster, database configuration, and Storage volume, then extracts the
archive into a separate project's empty volumes. It verifies Auth, the protected
profile API, résumé import through the gateway, row-level access, and the file's
SHA-256. It resumes the same
workflow run and checks for one accepted submission at the app's synthetic
employer endpoint. A second resume must be rejected. The test invokes the
synthetic form endpoint directly. It also follows email links through the
app's Auth callback for a restored account and a new account.

The script leaves the source stopped and the restored stack serving locally.
It prints the project names and saves the compressed backup, SHA-256, and
verification result under `.local-data/compose/rehearsal-*/`. The same directory
contains the synthetic email address in `demo-login.txt`. Enter that address
on the sign-in page, then open the new link in the local Mailpit inbox. Test data, logs,
and the archive stay local. The physical archive requires a compatible
PostgreSQL build and platform and the original local configuration. Use it for
this same-stack rehearsal. A Supabase Cloud export, a cross-platform restore,
and an encrypted offsite backup need their own rehearsals before cutover.
